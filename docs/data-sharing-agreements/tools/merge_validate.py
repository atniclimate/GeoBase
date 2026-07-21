#!/usr/bin/env python3
"""Deterministic gate validator / slice merger for the DSA corpus.

Usage (from docs/data-sharing-agreements/, or with DSA_ROOT set):
    python tools/merge_validate.py validate            # whole-population validation
    python tools/merge_validate.py merge               # validate, then two-phase merge of lane slices
    python tools/merge_validate.py coverage            # validate + DS-1 coverage/baseline gate
    python tools/merge_validate.py takedown <doc_id>   # director-only tombstone transaction (fail-closed)
    python tools/merge_validate.py redact <event_id> <field,...>  # director-only redaction, evidenced by a human correction event

Requires: jsonschema (Draft 2020-12).

Enforced: JSON Schema conformance for every record; key uniqueness; FK and
event-type closure with doc/version matching and child-after-parent
ordering; per-lane monotonic event sequence vs timestamps; disk byte/hash/
size verification (local and raw); path containment inside the project;
event-computed clearance with a legal transition table ('removed' is
terminal); human-actor requirements (clear of Nation-authored docs, review
upgrades, reject, takedown, archive-auth); robots/terms prohibitions;
fetch gating on effective register approval + publication-intent evidence;
archive-host authorization; lane registry + per-lane host allowlists +
5-second per-host spacing; Nation-bound coverage evidence; baseline
inventory closure. State transitions are append-only access-log events;
the sole sanctioned edit of a merged file is the takedown transaction,
which runs the full integrity suite first and refuses while any corpus
bytes, summaries, or claim citations for the target remain.
Exit codes: 0 clean, 1 findings, 2 usage/config error.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover
    print("ERROR: the 'jsonschema' package is required (pip install jsonschema)")
    sys.exit(2)


def get_root():
    env = os.environ.get("DSA_ROOT")
    return Path(env).resolve() if env else Path(__file__).resolve().parent.parent


FILES = {
    "register": ("sources", "register", "sources/register.schema.json"),
    "manifest": ("corpus", "MANIFEST", "corpus/manifest.schema.json"),
    "log": ("provenance", "access-log", "provenance/access-log.schema.json"),
    "catalog": ("catalog", "catalog", "catalog/catalog.schema.json"),
}
COVERAGE_SCHEMA = "sources/coverage.schema.json"
LANES_SCHEMA = "lanes.schema.json"
BASELINE_SCHEMA = "sources/baseline-inventory.schema.json"
STATE_ACTIONS = {"clear", "restrict", "reject", "takedown"}
CLEARANCE_RESULT = {"clear": "cleared", "restrict": "restricted-review",
                    "reject": "rejected", "takedown": "removed"}
CLEARANCE_TRANSITIONS = {
    "staged": {"cleared", "restricted-review", "rejected", "removed"},
    "cleared": {"restricted-review", "rejected", "removed"},
    "restricted-review": {"cleared", "rejected", "removed"},
    "rejected": {"removed"},
    "removed": set(),  # terminal
}
HUMAN_ACTIONS = {"reject", "takedown", "archive-auth"}
NETWORK_ACTIONS = {"probe", "fetch", "refetch"}
REGISTER_STATUSES = {"candidate", "approved", "fetched", "excluded-gated",
                     "excluded-ambiguous", "excluded-terms", "dead",
                     "unresolved-baseline", "duplicate"}
MIN_HOST_GAP_S = 5.0
SEQ_RE = re.compile(r"^ev-.*-(\d+)$")


class Ctx:
    def __init__(self, root):
        self.root = root
        self.findings = []
        self.schemas = {}
        self.data = {}

    def err(self, where, msg):
        self.findings.append(f"{where}: {msg}")

    def schema(self, rel):
        if rel not in self.schemas:
            p = self.root / rel
            if not p.exists():
                self.err(rel, "schema file missing")
                self.schemas[rel] = None
            else:
                doc = json.loads(p.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(doc)
                self.schemas[rel] = Draft202012Validator(doc)
        return self.schemas[rel]


def load_jsonl(ctx, path):
    records = []
    if not path.exists():
        return records
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            ctx.err(f"{path.name}:{i}", f"invalid JSON ({e})")
            continue
        if not isinstance(obj, dict):
            ctx.err(f"{path.name}:{i}", "record is not a JSON object")
            continue
        records.append((path, i, obj))
    return records


def key_of(kind, r):
    if kind == "register":
        return r.get("source_id")
    if kind == "log":
        return r.get("event_id")
    if kind == "catalog" and r.get("status") == "withdrawn":
        return (r.get("doc_id"), "__tombstone__")
    return (r.get("doc_id"), r.get("content_version"))


def classify_duplicate(merged, other):
    """'equal' | 'stale-redacted' (differs only in fields the authoritative
    copy has redacted — a partially-completed redaction) | 'conflict'."""
    if merged == other:
        return "equal"
    masked = {f for f, v in list(merged.items()) + list(other.items())
              if isinstance(v, str) and v.startswith("[REDACTED:")}
    if masked:
        a = {f: v for f, v in merged.items() if f not in masked}
        b = {f: v for f, v in other.items() if f not in masked}
        if a == b:
            return "stale-redacted"
    return "conflict"


def lane_of_slice(path, stem):
    parts = path.name.split(".")
    if len(parts) == 3 and parts[0] == stem and parts[2] == "jsonl":
        return parts[1]
    return None


def safe_rel(ctx, where, p):
    """Reject absolute paths and root escapes; return resolved Path or None."""
    if p is None:
        return None
    pp = Path(p)
    if pp.is_absolute() or ".." in pp.parts:
        ctx.err(where, f"path not allowed (absolute or ..): {p}")
        return None
    resolved = (ctx.root / pp).resolve()
    try:
        resolved.relative_to(ctx.root)
    except ValueError:
        ctx.err(where, f"path escapes project root: {p}")
        return None
    return resolved


def host_of(url):
    try:
        u = urlparse(url or "")
    except ValueError:
        return None
    if u.scheme in ("http", "https") and u.hostname:
        return u.hostname.lower().rstrip(".")
    return None


def ts_seconds(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def event_order(r):
    return (r.get("ts") or "", r.get("event_id") or "")


def collect(ctx):
    lanes_doc = {"lanes": []}
    lanes_path = ctx.root / "lanes.json"
    if lanes_path.exists():
        try:
            lanes_doc = json.loads(lanes_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            ctx.err("lanes.json", f"invalid JSON ({e})")
        else:
            v = ctx.schema(LANES_SCHEMA)
            if v:
                for e in v.iter_errors(lanes_doc):
                    ctx.err("lanes.json", f"schema: {e.message}")
    else:
        ctx.err("lanes.json", "lane registry missing")
    ctx.lanes = {ln.get("lane"): ln for ln in lanes_doc.get("lanes", [])
                 if isinstance(ln, dict)}
    host_owner = {}
    for name, ln in ctx.lanes.items():
        if ln.get("status") != "active":
            continue
        for h in ln.get("hosts", []):
            h = str(h).lower().rstrip(".")
            if h in host_owner:
                ctx.err("lanes.json", f"host '{h}' active in lanes "
                        f"'{host_owner[h]}' and '{name}'")
            host_owner[h] = name

    for kind, (sub, stem, schema_rel) in FILES.items():
        d = ctx.root / sub
        merged_path = d / f"{stem}.jsonl"
        merged = load_jsonl(ctx, merged_path)
        slices = []
        for p in sorted(d.glob(f"{stem}.*.jsonl")) if d.exists() else []:
            if p.name == f"{stem}.jsonl":
                continue
            lane = lane_of_slice(p, stem)
            if lane is None:
                ctx.err(p.name, "slice filename must be <stem>.<lane>.jsonl")
                continue
            if lane not in ctx.lanes:
                ctx.err(p.name, f"lane '{lane}' not registered in lanes.json (fail-closed)")
            recs = load_jsonl(ctx, p)
            if kind == "log":
                for path, i, r in recs:
                    if r.get("lane") != lane:
                        ctx.err(f"{path.name}:{i}",
                                f"record lane '{r.get('lane')}' != slice lane '{lane}'")
            slices.extend(recs)

        validator = ctx.schema(schema_rel)
        seen = {}
        for path, i, r in merged + slices:
            if validator:
                for e in validator.iter_errors(r):
                    loc = "/".join(str(p) for p in e.absolute_path) or "<record>"
                    ctx.err(f"{path.name}:{i}", f"schema: {loc}: {e.message}")
            k = key_of(kind, r)
            if k is None or k == (None, None):
                continue
            if k in seen:
                verdict = classify_duplicate(seen[k][2], r)
                pp, pi, _ = seen[k]
                if verdict == "conflict":
                    ctx.err(f"{path.name}:{i}", f"key conflict {k}: differs from {pp.name}:{pi}")
                elif verdict == "stale-redacted":
                    ctx.err(f"{path.name}:{i}",
                            f"partially-redacted record {k}: an unredacted copy remains "
                            "— re-run the redact transaction to complete it")
            seen.setdefault(k, (path, i, r))
        ctx.data[kind] = {"merged_path": merged_path, "merged": merged,
                          "slices": slices, "by_key": seen}
    # tombstones may exist only in the merged catalog (director transaction)
    for path, i, r in ctx.data["catalog"]["slices"]:
        if r.get("status") == "withdrawn":
            ctx.err(f"{path.name}:{i}",
                    "tombstones may not appear in worker slices — use the takedown transaction")


def uniq(ctx, kind):
    """Deduplicated records (first occurrence per key) — merged+slice overlap safe."""
    return list(ctx.data[kind]["by_key"].values())


def compute_states(ctx):
    log = [r for _, _, r in uniq(ctx, "log")]
    log.sort(key=event_order)
    # per-lane monotonic sequence vs timestamp (backdating resistance)
    by_lane = {}
    for r in log:
        m = SEQ_RE.match(r.get("event_id") or "")
        if m and r.get("ts"):
            by_lane.setdefault(r.get("lane"), []).append((int(m.group(1)), r))
    for lane, items in by_lane.items():
        items.sort(key=lambda x: x[0])
        prev = None
        for _seq, r in items:
            if prev and (r.get("ts") or "") < (prev.get("ts") or ""):
                ctx.err(r.get("event_id", "?"),
                        f"lane '{lane}' sequence/timestamp inversion vs {prev.get('event_id')} "
                        "(events must be appended in time order)")
            prev = r

    clearance_hist = {}
    review = {}
    reg_hist = {}
    for r in log:
        a = r.get("action")
        actor = str(r.get("actor", ""))
        if a in HUMAN_ACTIONS and not actor.startswith("human/"):
            ctx.err(r.get("event_id", "?"),
                    f"{a} events require a human/* actor (owner/designee authorization)")
            continue
        if a in STATE_ACTIONS and r.get("doc_id"):
            keys = [(r["doc_id"], r.get("content_version"))]
            if a == "takedown" and not r.get("content_version"):
                keys = [k for k in ctx.data["manifest"]["by_key"] if k[0] == r["doc_id"]] or keys
            for k in keys:
                hist = clearance_hist.setdefault(k, [])
                prev_state = hist[-1][1] if hist else "staged"
                new_state = CLEARANCE_RESULT[a]
                if new_state not in CLEARANCE_TRANSITIONS.get(prev_state, set()):
                    ctx.err(r.get("event_id", "?"),
                            f"illegal clearance transition {prev_state} -> {new_state} for {k}")
                    continue
                hist.append((event_order(r), new_state))
        elif a == "review" and r.get("doc_id"):
            if r.get("new_state") in ("human-reviewed", "needs-human-review", "machine-extracted"):
                if r["new_state"] == "human-reviewed" and not actor.startswith("human/"):
                    ctx.err(r.get("event_id", "?"), "review→human-reviewed requires a human/* actor")
                else:
                    review[(r["doc_id"], r.get("content_version"))] = r["new_state"]
            else:
                ctx.err(r.get("event_id", "?"), f"invalid review new_state '{r.get('new_state')}'")
        elif a == "register-status" and r.get("source_id"):
            if r.get("new_state") in REGISTER_STATUSES:
                reg_hist.setdefault(r["source_id"], []).append(
                    (event_order(r), r["new_state"]))
            else:
                ctx.err(r.get("event_id", "?"), f"invalid register-status '{r.get('new_state')}'")
    ctx.clearance_hist = clearance_hist
    ctx.review = review
    ctx.reg_hist = reg_hist
    ctx.log_sorted = log


def effective_clearance(ctx, key):
    hist = ctx.clearance_hist.get(key, [])
    return hist[-1][1] if hist else "staged"


def clearance_at(ctx, key, order_key):
    state = "staged"
    for ok, st in ctx.clearance_hist.get(key, []):
        if ok <= order_key:
            state = st
    return state


def register_status_at(ctx, source_id, initial, order_key):
    state = initial
    for ok, st in ctx.reg_hist.get(source_id, []):
        if ok <= order_key:
            state = st
    return state


def cross_checks(ctx):
    root = ctx.root
    events = {r.get("event_id"): r for _, _, r in uniq(ctx, "log")}
    sources = {r.get("source_id"): r for _, _, r in uniq(ctx, "register")}
    manifests = ctx.data["manifest"]["by_key"]

    nations = set()
    npath = root / "sources" / "nations.json"
    if npath.exists():
        nations = {n["nation_id"] for n in
                   json.loads(npath.read_text(encoding="utf-8")).get("nations", [])}

    def parent_edge(w, r, allowed_actions, match_doc=True, match_cv=True):
        pe = events.get(r.get("parent_event"))
        if pe is None:
            ctx.err(w, f"parent_event {r.get('parent_event')} not found in access log")
            return
        if pe.get("action") not in allowed_actions:
            ctx.err(w, f"parent_event action '{pe.get('action')}' not in {sorted(allowed_actions)}")
        if match_doc and pe.get("doc_id") != r.get("doc_id"):
            ctx.err(w, "parent_event doc_id mismatch")
        if match_cv and pe.get("content_version") != r.get("content_version"):
            ctx.err(w, "parent_event content_version mismatch")
        if (pe.get("ts") or "") > (r.get("ts") or ""):
            ctx.err(w, f"event timestamp precedes its parent {pe.get('event_id')}")

    human_auth_archive = {}
    for r in ctx.log_sorted:
        if r.get("action") == "archive-auth" and r.get("source_id"):
            human_auth_archive.setdefault(r["source_id"], []).append(event_order(r))

    net_by_host = {}
    for path, i, r in uniq(ctx, "log"):
        w = f"{path.name}:{i}"
        a = r.get("action")
        if a in ("fetch", "refetch"):
            if r.get("robots_ok") is False:
                ctx.err(w, "fetch recorded with robots_ok=false — charter forbids the fetch itself")
            if r.get("terms_ok") is False:
                ctx.err(w, "fetch recorded with terms_ok=false — charter forbids the fetch itself")
            sid = r.get("source_id")
            src = sources.get(sid)
            if src is not None:
                eff = register_status_at(ctx, sid, src.get("status"), event_order(r))
                if eff != "approved":
                    ctx.err(w, f"fetch of source {sid} whose effective register status is '{eff}' (must be approved)")
            h = host_of(r.get("url")) or host_of(r.get("final_url"))
            if h and (h == "archive.org" or h.endswith(".archive.org")):
                auth = [ok for ok in human_auth_archive.get(sid, []) if ok <= event_order(r)]
                if not auth:
                    ctx.err(w, "archive fetch without a prior human archive-auth event for this source (charter §3)")
        if a in ("clear", "restrict", "reject"):
            parent_edge(w, r, {"fetch", "refetch"})
        elif a == "parse":
            parent_edge(w, r, {"clear"})
        elif a in ("summarize", "summary-attach"):
            parent_edge(w, r, {"parse"})
        elif a == "correction" and r.get("parent_event") not in events:
            ctx.err(w, f"correction target event {r.get('parent_event')} not found")
        elif a == "takedown" and r.get("parent_event") and r["parent_event"] not in events:
            ctx.err(w, f"takedown target event {r['parent_event']} not found")
        elif a == "review":
            if (r.get("doc_id"), r.get("content_version")) not in manifests:
                ctx.err(w, "review target doc_id+content_version has no manifest record")
        elif a == "supersede":
            if (r.get("doc_id"), r.get("new_state")) not in manifests:
                ctx.err(w, "supersede new_state must be an existing content_version of the doc")

        if a in ("parse", "summarize"):
            key = (r.get("doc_id"), r.get("content_version"))
            state = clearance_at(ctx, key, event_order(r))
            if state != "cleared":
                ctx.err(w, f"{a} of {key} while effective clearance was '{state}'")
        if a in ("summarize", "summary-attach"):
            ap = safe_rel(ctx, w, r.get("artifact_path"))
            if ap is not None and not ap.exists():
                doc_tombstoned = any(
                    t.get("doc_id") == r.get("doc_id") and t.get("status") == "withdrawn"
                    for _, _, t in ctx.data["catalog"]["merged"])
                if not doc_tombstoned:
                    ctx.err(w, f"artifact_path missing on disk: {r.get('artifact_path')}")
        if a == "clear":
            key = (r.get("doc_id"), r.get("content_version"))
            m = manifests.get(key)
            if m and m[2].get("nation_authored") and not str(r.get("actor", "")).startswith("human/"):
                ctx.err(w, "clear of a nation_authored document requires a human/* actor")
        if a in NETWORK_ACTIONS:
            h = host_of(r.get("url"))
            hf = host_of(r.get("final_url"))
            lane = ctx.lanes.get(r.get("lane"))
            for hh in filter(None, {h, hf}):
                if lane is None:
                    ctx.err(w, f"network event from unregistered lane '{r.get('lane')}'")
                elif hh not in {str(x).lower().rstrip(".") for x in lane.get("hosts", [])}:
                    ctx.err(w, f"host '{hh}' not in lane '{r.get('lane')}' allowlist")
                sec = ts_seconds(r.get("ts"))
                if sec is not None:
                    net_by_host.setdefault(hh, []).append((sec, r.get("event_id"), w))

    for h, items in net_by_host.items():
        items.sort()
        for (t1, e1, _), (t2, _e2, w2) in zip(items, items[1:]):
            if t2 - t1 < MIN_HOST_GAP_S:
                ctx.err(w2, f"host '{h}' hit {t2 - t1:.1f}s after {e1} (charter minimum {MIN_HOST_GAP_S:.0f}s)")

    for path, i, r in uniq(ctx, "register"):
        w = f"{path.name}:{i}"
        de = r.get("discover_event")
        if de and de not in events:
            ctx.err(w, f"discover_event {de} not in access log")
        elif de and events[de].get("action") != "discover":
            ctx.err(w, f"discover_event {de} has action '{events[de].get('action')}', expected 'discover'")
        nid = r.get("nation_id")
        if nid and nations and nid not in nations:
            ctx.err(w, f"nation_id '{nid}' not in sources/nations.json")
        eff = register_status_at(ctx, r.get("source_id"), r.get("status"),
                                 ("￿", "￿"))
        if eff == "approved" and not (r.get("publication_intent") and r.get("official_source") is not None):
            ctx.err(w, "approved sources require publication_intent evidence and an official_source determination")

    for path, i, r in uniq(ctx, "manifest"):
        w = f"{path.name}:{i}"
        fe = r.get("fetch_event")
        ev = events.get(fe)
        if ev is None:
            ctx.err(w, f"fetch_event {fe} not in access log")
        else:
            if ev.get("action") not in ("fetch", "refetch"):
                ctx.err(w, f"fetch_event action is '{ev.get('action')}', expected fetch/refetch")
            for f in ("source_id", "doc_id", "content_version", "sha256", "local_path"):
                if ev.get(f) != r.get(f):
                    ctx.err(w, f"fetch_event {f} mismatch (event={ev.get(f)!r} manifest={r.get(f)!r})")
        if r.get("source_id") and r["source_id"] not in sources:
            ctx.err(w, f"source_id {r['source_id']} not in register")
        cv, sh = r.get("content_version"), r.get("sha256")
        if cv and sh and not cv.endswith(sh[:8]):
            ctx.err(w, "content_version hash suffix does not match sha256")
        key = (r.get("doc_id"), r.get("content_version"))
        state = effective_clearance(ctx, key)
        lp = r.get("local_path")
        if lp and not lp.replace("\\", "/").startswith("corpus/"):
            ctx.err(w, f"local_path must live under corpus/: {lp}")
        fpath = safe_rel(ctx, w, lp)
        if fpath and fpath.exists():
            if state in ("rejected", "removed"):
                ctx.err(w, f"file present but effective clearance is '{state}' — bytes must be deleted")
            data = fpath.read_bytes()
            if hashlib.sha256(data).hexdigest() != sh:
                ctx.err(w, f"disk bytes hash mismatch for {lp}")
            if len(data) != r.get("size_bytes"):
                ctx.err(w, f"disk size {len(data)} != size_bytes {r.get('size_bytes')} for {lp}")
        elif fpath and state not in ("rejected", "removed"):
            ctx.err(w, f"manifest path missing on disk: {lp} (clearance '{state}')")
        rp = r.get("raw_path")
        if rp:
            rf = safe_rel(ctx, w, rp)
            if rf and rf.exists():
                if state in ("rejected", "removed"):
                    ctx.err(w, f"raw bytes present but effective clearance is '{state}' — must be deleted")
                data = rf.read_bytes()
                if hashlib.sha256(data).hexdigest() != r.get("raw_sha256"):
                    ctx.err(w, f"raw bytes hash mismatch for {rp}")
                if len(data) != r.get("raw_size_bytes"):
                    ctx.err(w, f"raw size {len(data)} != raw_size_bytes {r.get('raw_size_bytes')} for {rp}")
            elif rf and state not in ("rejected", "removed"):
                ctx.err(w, f"raw_path missing on disk: {rp}")

    corpus_dir = root / "corpus"
    known_paths = set()
    for _, _, r in uniq(ctx, "manifest"):
        for f in ("local_path", "raw_path"):
            if r.get(f):
                known_paths.add((root / r[f]).resolve())
    if corpus_dir.exists():
        for f in corpus_dir.rglob("*"):
            if f.is_dir() or f.name in ("README.md", "manifest.schema.json"):
                continue
            if f.name == "MANIFEST.jsonl" or lane_of_slice(f, "MANIFEST"):
                continue
            if f.resolve() not in known_paths:
                ctx.err(f.relative_to(root).as_posix(), "corpus file has no manifest record")

    tombstoned = {r.get("doc_id") for _, _, r in ctx.data["catalog"]["merged"]
                  if r.get("status") == "withdrawn"}
    ctx.tombstoned = tombstoned
    for path, i, r in uniq(ctx, "catalog"):
        w = f"{path.name}:{i}"
        if r.get("status") != "withdrawn" and r.get("doc_id") in tombstoned:
            continue
        if r.get("status") == "withdrawn":
            te = r.get("takedown_event")
            if te not in events or events.get(te, {}).get("action") != "takedown":
                ctx.err(w, "tombstone takedown_event must reference a takedown event")
            continue
        key = (r.get("doc_id"), r.get("content_version"))
        m = manifests.get(key)
        if m is None:
            ctx.err(w, f"no manifest record for {key}")
        else:
            for f in ("source_id", "source_url", "sha256", "local_path"):
                if m[2].get(f) != r.get(f):
                    ctx.err(w, f"manifest {f} mismatch for {key}")
        state = effective_clearance(ctx, key)
        if state != "cleared":
            ctx.err(w, f"catalog record for {key} but effective clearance is '{state}'")
        pe = events.get(r.get("parse_event"))
        if pe is None:
            ctx.err(w, f"parse_event {r.get('parse_event')} not in access log")
        elif pe.get("action") != "parse" or pe.get("doc_id") != r.get("doc_id") \
                or pe.get("content_version") != r.get("content_version"):
            ctx.err(w, "parse_event does not match this doc_id+content_version")
        if r.get("source_id") and r["source_id"] not in sources:
            ctx.err(w, f"source_id {r['source_id']} not in register")
        nid = r.get("nation_id")
        if nid and nations and nid not in nations:
            ctx.err(w, f"nation_id '{nid}' not in sources/nations.json")
        if ("unknown" in (str(r.get("covered_parties", "")).lower(),
                          str(r.get("covered_data", "")).lower())
                and r.get("review_state") != "needs-human-review"):
            ctx.err(w, "covered_parties/covered_data 'unknown' requires review_state=needs-human-review")


def check_coverage(ctx):
    root = ctx.root
    npath = root / "sources" / "nations.json"
    cpath = root / "sources" / "coverage-matrix.jsonl"
    if not cpath.exists():
        ctx.err("coverage", "sources/coverage-matrix.jsonl not found — DS-1 gate artifact missing")
        return
    nations = {n["nation_id"] for n in
               json.loads(npath.read_text(encoding="utf-8")).get("nations", [])}
    validator = ctx.schema(COVERAGE_SCHEMA)
    events = {r.get("event_id"): r for _, _, r in uniq(ctx, "log")}
    sources = {r.get("source_id"): r for _, _, r in uniq(ctx, "register")}
    seen = {}
    for path, i, r in load_jsonl(ctx, cpath):
        w = f"{path.name}:{i}"
        if validator:
            for e in validator.iter_errors(r):
                ctx.err(w, f"schema: {e.message}")
        nid = r.get("nation_id")
        if nid in seen:
            ctx.err(w, f"duplicate coverage row for '{nid}'")
        seen[nid] = r
        if nid not in nations:
            ctx.err(w, f"nation_id '{nid}' not in denominator")
        if r.get("status") != "not-yet-searched":
            if not r.get("search_events"):
                ctx.err(w, f"status '{r.get('status')}' requires search_events evidence")
            for ev in r.get("search_events") or []:
                e = events.get(ev)
                if e is None:
                    ctx.err(w, f"search event {ev} not in access log")
                elif e.get("action") not in ("search", "probe"):
                    ctx.err(w, f"event {ev} is '{e.get('action')}', expected search/probe")
                elif e.get("nation_id") != nid:
                    ctx.err(w, f"event {ev} nation_id '{e.get('nation_id')}' does not match row '{nid}' — evidence must be Nation-specific")
        if r.get("status") == "found":
            sids = r.get("source_ids") or []
            if not sids:
                ctx.err(w, f"'found' row for '{nid}' must link register source_ids")
            for sid in sids:
                src = sources.get(sid)
                if src is None:
                    ctx.err(w, f"source_id {sid} not in register")
                elif src.get("nation_id") != nid:
                    ctx.err(w, f"source {sid} nation_id '{src.get('nation_id')}' does not match row '{nid}'")
    for nid in sorted(nations - set(seen)):
        ctx.err("coverage", f"no coverage row for '{nid}'")
    incomplete = [nid for nid, r in seen.items() if r.get("status") == "not-yet-searched"]
    if incomplete:
        ctx.err("coverage", f"{len(incomplete)} Nation(s) not-yet-searched: {', '.join(sorted(incomplete)[:5])}…")
    roster = json.loads((root / "sources" / "atni-roster-status.json").read_text(encoding="utf-8"))
    if roster.get("status") == "pending":
        ctx.err("coverage", "ATNI roster expansion pending — expand nations.json or record owner deferral in sources/atni-roster-status.json")
    elif roster.get("status") not in ("expanded", "deferred-by-owner"):
        ctx.err("coverage", f"invalid atni-roster-status '{roster.get('status')}'")
    elif not roster.get("receipt"):
        ctx.err("coverage", "atni-roster-status requires a receipt (who decided, when)")

    # baseline inventory closure
    bpath = root / "sources" / "baseline-inventory.jsonl"
    if not bpath.exists():
        ctx.err("coverage", "sources/baseline-inventory.jsonl missing — baseline lane deliverable (see baseline-inventory.md)")
        return
    bval = ctx.schema(BASELINE_SCHEMA)
    inv = {}
    for path, i, r in load_jsonl(ctx, bpath):
        w = f"{path.name}:{i}"
        if bval:
            for e in bval.iter_errors(r):
                ctx.err(w, f"schema: {e.message}")
        bid = r.get("baseline_id")
        if bid in inv:
            ctx.err(w, f"duplicate baseline_id '{bid}'")
        inv[bid] = r
    claimed = {}
    for _, _, r in uniq(ctx, "register"):
        bid = r.get("baseline_id")
        if bid:
            if bid not in inv:
                ctx.err(r.get("source_id", "?"), f"baseline_id '{bid}' not in baseline inventory")
            elif bid in claimed:
                ctx.err(r.get("source_id", "?"), f"baseline_id '{bid}' claimed by both {claimed[bid]} and {r.get('source_id')}")
            else:
                claimed[bid] = r.get("source_id")
    for bid in sorted(set(inv) - set(claimed)):
        ctx.err("coverage", f"baseline item '{bid}' ({inv[bid].get('title')}) has no register disposition")


def merge(ctx):
    staged = []
    for kind, info in ctx.data.items():
        merged_keys = {key_of(kind, r) for _, _, r in info["merged"]}
        additions = []
        tombstoned = getattr(ctx, "tombstoned", set())
        for _p, _i, r in info["slices"]:
            if (kind == "catalog" and r.get("status") != "withdrawn"
                    and r.get("doc_id") in tombstoned):
                continue
            k = key_of(kind, r)
            if k not in merged_keys:
                additions.append(r)
                merged_keys.add(k)
        if not additions:
            continue
        mp = info["merged_path"]
        existing = mp.read_text(encoding="utf-8") if mp.exists() else ""
        if existing and not existing.endswith("\n"):
            existing += "\n"
        body = existing + "".join(
            json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in additions)
        tmp = mp.with_suffix(".jsonl.tmp")
        tmp.write_text(body, encoding="utf-8", newline="\n")
        staged.append((tmp, mp, len(additions)))
    for tmp, mp, n in staged:
        tmp.replace(mp)
        print(f"merged {n} record(s) into {mp.relative_to(ctx.root).as_posix()}")
    if not staged:
        print("nothing to merge")


def takedown_remnants(ctx, doc_id):
    """Files and citations that must be gone before the tombstone lands."""
    remnants = []
    corpus = ctx.root / "corpus"
    if corpus.exists():
        remnants += [p.relative_to(ctx.root).as_posix() for p in corpus.rglob("*")
                     if p.is_file() and f"/{doc_id}/" in ("/" + p.relative_to(ctx.root).as_posix())]
    for sub in ("summaries", "wiki", "guidelines"):
        d = ctx.root / sub
        if not d.exists():
            continue
        for p in d.rglob("*.md"):
            rel = p.relative_to(ctx.root).as_posix()
            if p.stem == doc_id or p.stem.startswith(doc_id + "."):
                remnants.append(rel)
            elif f"{doc_id}:c" in p.read_text(encoding="utf-8", errors="replace"):
                remnants.append(f"{rel} (cites {doc_id} claim ids)")
    return remnants


def takedown(ctx, doc_id):
    events = [r for _, _, r in uniq(ctx, "log")
              if r.get("action") == "takedown" and r.get("doc_id") == doc_id
              and str(r.get("actor", "")).startswith("human/")]
    if not events:
        print(f"ERROR: no human-authorized takedown event for '{doc_id}' in the "
              "access log — append the event (human/* actor) first")
        sys.exit(2)
    remnants = takedown_remnants(ctx, doc_id)
    if remnants:
        print(f"REFUSING tombstone — remove these first (charter §7 is transitive):")
        for x in remnants:
            print(f"  {x}")
        sys.exit(1)
    ev = sorted(events, key=event_order)[-1]
    mp = ctx.data["catalog"]["merged_path"]
    kept, removed_titles = [], []
    for _, _, r in ctx.data["catalog"]["merged"]:
        if r.get("doc_id") == doc_id and r.get("status") != "withdrawn":
            removed_titles.append((r.get("title"), r.get("issuing_entity")))
        else:
            kept.append(r)
    if not removed_titles:
        print(f"no live catalog records for '{doc_id}' (nothing to tombstone)")
        return
    title, entity = removed_titles[0]
    tomb = {"doc_id": doc_id, "title": title, "issuing_entity": entity,
            "status": "withdrawn", "takedown_event": ev["event_id"],
            "notes": ev.get("notes") or "takedown"}
    tmp = mp.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n"
                           for r in kept + [tomb]), encoding="utf-8", newline="\n")
    tmp.replace(mp)
    print(f"tombstoned {len(removed_titles)} catalog record(s) for '{doc_id}' "
          f"(evidence: {ev['event_id']}); corpus, summaries, and citation scan were clean")


REDACT_ALWAYS = {"notes", "robots_evidence", "terms_check", "user_agent"}
REDACT_URLISH = {"url", "final_url"}


def redact(ctx, event_id, fields):
    """Physically replace sensitive free-text fields of a merged log record
    with a sentinel, evidenced by a prior human correction event. Fields that
    participate in FK/hash closure are never redactable; url/final_url of a
    fetch are redactable only once the document's bytes are removed/rejected
    (the charter's post-takedown case), and the matching manifest source_url/
    final_url are redacted in the same transaction so cross-checks hold."""
    target = None
    for _, _, r in uniq(ctx, "log"):
        if r.get("event_id") == event_id:
            target = r
            break
    if target is None:
        print(f"ERROR: event {event_id} not found in the access log")
        sys.exit(2)
    corrections = [r for _, _, r in uniq(ctx, "log")
                   if r.get("action") == "correction"
                   and r.get("parent_event") == event_id
                   and str(r.get("actor", "")).startswith("human/")
                   and r.get("notes")]
    if not corrections:
        print(f"ERROR: no human correction event targeting {event_id} — append one "
              "(action=correction, parent_event=<target>, notes=<reason>) first")
        sys.exit(2)
    corr = sorted(corrections, key=event_order)[-1]
    sentinel = f"[REDACTED:{corr['event_id']}]"
    bad = [f for f in fields if f not in REDACT_ALWAYS | REDACT_URLISH]
    if bad:
        print(f"ERROR: field(s) not redactable (FK/hash closure): {bad}")
        sys.exit(2)
    doc_key = (target.get("doc_id"), target.get("content_version"))
    if (REDACT_URLISH & set(fields)) and target.get("action") in ("fetch", "refetch"):
        state = effective_clearance(ctx, doc_key)
        tombed = target.get("doc_id") in getattr(ctx, "tombstoned", set())
        if state not in ("removed", "rejected") and not tombed:
            print(f"ERROR: url/final_url of a fetch are redactable only after the "
                  f"document's bytes are removed/rejected (state '{state}')")
            sys.exit(1)

    staged = []  # (tmp, path, changed) — two-phase: write all tmps, then rename all

    def apply(path, kinds_fields):
        recs = load_jsonl(Ctx(ctx.root), path)  # fresh parse, findings discarded
        changed = 0
        out = []
        for _, _, r in recs:
            key = r.get("event_id") or (r.get("doc_id"), r.get("content_version"))
            if key in kinds_fields:
                for f in kinds_fields[key]:
                    if r.get(f) is not None and r[f] != sentinel:
                        r[f] = sentinel
                        changed += 1
            out.append(r)
        if changed:
            tmp = path.with_suffix(".jsonl.tmp")
            tmp.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n"
                                   for r in out), encoding="utf-8", newline="\n")
            staged.append((tmp, path, changed))
        return changed

    def all_paths(kind):
        """Merged file + every lane slice — redaction must leave no copy of
        the sensitive value in any retained provenance file."""
        d, stem, _ = (ctx.root / FILES[kind][0], FILES[kind][1], None)
        paths = [ctx.data[kind]["merged_path"]]
        if d.exists():
            paths += [p for p in sorted(d.glob(f"{stem}.*.jsonl"))
                      if p.name != f"{stem}.jsonl"]
        return paths

    if not any(r.get("event_id") == event_id
               for _, _, r in ctx.data["log"]["merged"]):
        print(f"ERROR: {event_id} not present in the MERGED log (merge slices first); "
              "slices are lane-owned — redact after merge")
        sys.exit(1)
    n = 0
    for p in all_paths("log"):
        n += apply(p, {event_id: fields})
    m = 0
    if (REDACT_URLISH & set(fields)) and target.get("action") in ("fetch", "refetch"):
        mf = [f for f in ("source_url", "final_url") if "url" in fields or f in fields]
        for p in all_paths("manifest"):
            m += apply(p, {doc_key: mf or ["source_url", "final_url"]})
    if not staged:
        print(f"nothing to redact — {event_id} already carries the sentinel everywhere")
        return
    for tmp, path, _ in staged:  # rename phase: all tmps written before any lands
        tmp.replace(path)
    print(f"redacted {n} field(s) on {event_id} (+{m} manifest field(s)) across "
          f"{len(staged)} file(s) — sentinel {sentinel}; re-run validate to confirm closure. "
          "The transaction is idempotent: if it is ever interrupted, validate reports "
          "'partially-redacted record' and re-running the same command completes it.")


def run_validate(ctx, with_coverage):
    collect(ctx)
    compute_states(ctx)
    cross_checks(ctx)
    if with_coverage:
        check_coverage(ctx)
    if ctx.findings:
        print(f"FINDINGS ({len(ctx.findings)}):")
        for f in ctx.findings:
            print(f"  {f}")
        return False
    print("validation clean")
    return True


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("validate", "merge", "coverage", "takedown", "redact"):
        print(__doc__)
        sys.exit(2)
    mode = sys.argv[1]
    ctx = Ctx(get_root())
    if mode == "redact":
        if len(sys.argv) != 4:
            print("usage: merge_validate.py redact <event_id> <field,field,...>")
            sys.exit(2)
        collect(ctx)
        compute_states(ctx)
        cross_checks(ctx)
        # Tolerate only partial-redaction findings — those are exactly what an
        # idempotent redact re-run heals; everything else fails closed.
        blocking = [f for f in ctx.findings if "partially-redacted record" not in f]
        if blocking:
            print(f"REFUSING redaction — {len(blocking)} integrity finding(s) "
                  "must be resolved first (fail-closed):")
            for f in blocking:
                print(f"  {f}")
            sys.exit(1)
        redact(ctx, sys.argv[2], [f.strip() for f in sys.argv[3].split(",") if f.strip()])
        sys.exit(0)
    if mode == "takedown":
        if len(sys.argv) != 3:
            print("usage: merge_validate.py takedown <doc_id>")
            sys.exit(2)
        doc_id = sys.argv[2]
        collect(ctx)
        compute_states(ctx)
        cross_checks(ctx)
        # Tolerate only the target doc's expected mid-takedown states: its
        # catalog record pending tombstone, and its already-deleted summary
        # artifact (the tombstone this transaction writes will exempt them).
        def expected_mid_takedown(f):
            if f"catalog record for ('{doc_id}'," in f and "effective clearance is 'removed'" in f:
                return True
            if "artifact_path missing on disk" in f and f"/{doc_id}" in f:
                return True
            return False
        blocking = [f for f in ctx.findings if not expected_mid_takedown(f)]
        if blocking:
            print(f"REFUSING takedown transaction — {len(blocking)} integrity "
                  "finding(s) must be resolved first (fail-closed):")
            for f in blocking:
                print(f"  {f}")
            sys.exit(1)
        takedown(ctx, doc_id)
        sys.exit(0)
    ok = run_validate(ctx, with_coverage=(mode == "coverage"))
    if not ok:
        sys.exit(1)
    if mode == "merge":
        merge(ctx)
    sys.exit(0)


if __name__ == "__main__":
    main()
