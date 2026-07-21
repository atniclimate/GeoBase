#!/usr/bin/env python3
"""Synthetic end-to-end lifecycle drill for the DSA corpus gate tooling.

Runs in a temp sandbox (DSA_ROOT): discover -> register -> fetch (staged) ->
human clear -> parse -> catalog -> human review -> summarize -> takedown
event -> transitive tombstone transaction -> Nation-bound coverage gate,
asserting `merge_validate.py` passes/fails exactly where the charter says it
should — including negative cases (parse-before-clearance, machine clear of
a Nation doc, tampered bytes, robots-forbidden fetch, fetch of an
unapproved source, unregistered lane slice, machine takedown, transaction
refusal while findings or remnants exist, cross-Nation coverage-evidence
reuse). Run before every phase launch:

    python tools/lifecycle_selftest.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REAL_ROOT = HERE.parent
TOOL = HERE / "merge_validate.py"
PASSED = 0


def run(root, *args):
    env = dict(os.environ, DSA_ROOT=str(root))
    return subprocess.run([sys.executable, str(TOOL), *args],
                          capture_output=True, text=True, env=env)


def check(cond, label, detail=""):
    global PASSED
    if not cond:
        print(f"FAIL: {label}\n{detail}")
        sys.exit(1)
    PASSED += 1
    print(f"  ok: {label}")


def expect(root, mode, ok, label):
    r = run(root, mode)
    check((r.returncode == 0) == ok, label,
          f"  rc={r.returncode}\n  stdout:\n{r.stdout}\n  stderr:\n{r.stderr}")


def jl(path, *recs):
    with path.open("a", encoding="utf-8", newline="\n") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


def pop_line(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="dsa-selftest-"))
    try:
        for d in ("sources", "corpus", "provenance", "catalog", "summaries"):
            (tmp / d).mkdir()
        for rel in ("sources/register.schema.json", "corpus/manifest.schema.json",
                    "provenance/access-log.schema.json", "catalog/catalog.schema.json",
                    "sources/coverage.schema.json", "sources/baseline-inventory.schema.json",
                    "sources/nations.json", "lanes.schema.json"):
            shutil.copy(REAL_ROOT / rel, tmp / rel)
        (tmp / "lanes.json").write_text(json.dumps(
            {"lanes": [{"lane": "test", "status": "active", "hosts": ["example.org"]}]}),
            encoding="utf-8")
        (tmp / "sources" / "atni-roster-status.json").write_text(json.dumps(
            {"status": "pending", "receipt": None}), encoding="utf-8")

        expect(tmp, "validate", True, "empty sandbox validates clean")

        log = tmp / "provenance" / "access-log.test.jsonl"
        reg = tmp / "sources" / "register.test.jsonl"
        man = tmp / "corpus" / "MANIFEST.test.jsonl"
        cat = tmp / "catalog" / "catalog.test.jsonl"

        # NEGATIVE: slice for a lane the registry doesn't know (fail-closed)
        rogue = tmp / "sources" / "register.rogue.jsonl"
        rogue.write_text("", encoding="utf-8")
        expect(tmp, "validate", False, "NEGATIVE: unregistered lane slice rejected even when empty")
        rogue.unlink()

        # discover + register (approved => needs publication-intent evidence)
        jl(log, {"event_id": "ev-test-0001", "ts": "2026-07-21T18:00:00Z",
                 "actor": "codex/gpt-5.6-terra", "lane": "test", "action": "discover",
                 "url": "https://example.org/policy"})
        jl(reg, {"source_id": "src-example-policy", "url": "https://example.org/policy",
                 "title": "Example Research Code", "entity": "Example Nation",
                 "nation_id": "nez-perce", "layer": "nation", "lane": "test",
                 "status": "approved", "discovered_via": "selftest",
                 "discover_event": "ev-test-0001", "baseline_id": "bl-001",
                 "official_source": True,
                 "publication_intent": "linked from official codes page"})
        expect(tmp, "validate", True, "discover + approved register record with intent evidence")

        # fetch: bytes on disk, hashed
        payload = b"%PDF-1.4 synthetic policy document for lifecycle drill"
        sha = hashlib.sha256(payload).hexdigest()
        cv = f"v1-{sha[:8]}"
        (tmp / "corpus" / "example-nation" / "example-research-code").mkdir(parents=True)
        lp = f"corpus/example-nation/example-research-code/{cv}.pdf"
        (tmp / lp).write_bytes(payload)
        fetch = {"event_id": "ev-test-0002", "ts": "2026-07-21T18:01:00Z",
                 "actor": "codex/gpt-5.6-terra", "lane": "test", "action": "fetch",
                 "url": "https://example.org/policy.pdf", "http_status": 200,
                 "robots_ok": True, "robots_evidence": "https://example.org/robots.txt allow *",
                 "user_agent": "ATNI-GeoBase-PolicyCorpus/1.0", "terms_ok": True,
                 "terms_check": "public gov doc, no ToS restriction",
                 "sha256": sha, "content_type": "application/pdf",
                 "size_bytes": len(payload), "local_path": lp,
                 "source_id": "src-example-policy", "doc_id": "example-research-code",
                 "content_version": cv}
        jl(log, fetch)
        jl(man, {"doc_id": "example-research-code", "content_version": cv,
                 "local_path": lp, "source_id": "src-example-policy",
                 "source_url": "https://example.org/policy.pdf", "sha256": sha,
                 "size_bytes": len(payload), "content_type": "application/pdf",
                 "retrieved_at": "2026-07-21T18:01:00Z", "fetch_event": "ev-test-0002",
                 "nation_authored": True})
        expect(tmp, "validate", True, "fetched + manifested (staged state)")

        # NEGATIVE: parse while staged
        jl(log, {"event_id": "ev-test-0003", "ts": "2026-07-21T18:02:00Z",
                 "actor": "codex/gpt-5.6-sol", "lane": "test", "action": "parse",
                 "url": lp, "doc_id": "example-research-code", "content_version": cv,
                 "parent_event": "ev-test-0002"})
        expect(tmp, "validate", False, "NEGATIVE: parse before clearance is rejected")
        pop_line(log)

        # NEGATIVE: non-human clear of nation_authored doc
        jl(log, {"event_id": "ev-test-0004", "ts": "2026-07-21T18:02:30Z",
                 "actor": "codex/gpt-5.6-terra", "lane": "test", "action": "clear",
                 "url": lp, "doc_id": "example-research-code", "content_version": cv,
                 "parent_event": "ev-test-0002", "notes": "screen clean"})
        expect(tmp, "validate", False, "NEGATIVE: machine clear of Nation-authored doc rejected")
        pop_line(log)

        # human clear, then parse + catalog
        jl(log,
           {"event_id": "ev-test-0005", "ts": "2026-07-21T18:03:00Z",
            "actor": "human/patrick", "lane": "test", "action": "clear",
            "url": lp, "doc_id": "example-research-code", "content_version": cv,
            "parent_event": "ev-test-0002", "notes": "screen clean; owner clearance"},
           {"event_id": "ev-test-0006", "ts": "2026-07-21T18:04:00Z",
            "actor": "codex/gpt-5.6-sol", "lane": "test", "action": "parse",
            "url": lp, "doc_id": "example-research-code", "content_version": cv,
            "parent_event": "ev-test-0005"})
        jl(cat, {"doc_id": "example-research-code", "content_version": cv,
                 "parse_event": "ev-test-0006", "title": "Example Research Code",
                 "issuing_entity": "Example Nation", "entity_type": "tribal-nation",
                 "nation_id": "nez-perce", "instrument_type": "research-code",
                 "legal_status": "enacted-current",
                 "covered_parties": "external researchers", "covered_data": "research outputs",
                 "source_id": "src-example-policy",
                 "source_url": "https://example.org/policy.pdf", "sha256": sha,
                 "local_path": lp,
                 "requirements": {"claims": [
                     {"claim_id": "example-research-code:c1", "category": "publication-approval",
                      "claim": "Researchers must obtain Tribal review before publication",
                      "modal": "must-shall", "conditions": "applies to research conducted under permit",
                      "cite": "§4(b)"}], "none_reason": None},
                 "tsdf_mapping": {"outcome": "partially-mapped", "closest_tiers": ["T2"],
                                  "notes": "publication review not a tier construct"},
                 "review_state": "machine-extracted", "status": "cataloged"})
        expect(tmp, "validate", True, "clear -> parse -> catalog chain accepted")

        # human review + summarize (summary artifact must exist)
        summary = tmp / "summaries" / "example-research-code.md"
        summary.write_text("# Example Research Code\nclaim example-research-code:c1\n",
                           encoding="utf-8")
        jl(log,
           {"event_id": "ev-test-0007", "ts": "2026-07-21T18:05:00Z",
            "actor": "human/patrick", "lane": "test", "action": "review",
            "url": "catalog/catalog.jsonl", "doc_id": "example-research-code",
            "content_version": cv, "new_state": "human-reviewed",
            "notes": "claims verified against §4"},
           {"event_id": "ev-test-0008", "ts": "2026-07-21T18:06:00Z",
            "actor": "codex/gpt-5.6-sol", "lane": "test", "action": "summarize",
            "url": lp, "doc_id": "example-research-code", "content_version": cv,
            "parent_event": "ev-test-0006",
            "artifact_path": "summaries/example-research-code.md"})
        expect(tmp, "validate", True, "review + summarize (artifact verified on disk)")

        # NEGATIVE: tamper with stored bytes
        (tmp / lp).write_bytes(payload + b" TAMPERED")
        expect(tmp, "validate", False, "NEGATIVE: tampered corpus bytes detected")
        (tmp / lp).write_bytes(payload)

        # NEGATIVE: robots-forbidden fetch record
        jl(log, dict(fetch, event_id="ev-test-0009", ts="2026-07-21T18:07:00Z",
                     robots_ok=False))
        expect(tmp, "validate", False, "NEGATIVE: robots_ok=false fetch is a finding")
        pop_line(log)

        # NEGATIVE: fetch of a source that is not effectively approved
        jl(reg, {"source_id": "src-unvetted", "url": "https://example.org/other",
                 "title": "Unvetted Doc", "entity": "Example Nation",
                 "layer": "nation", "lane": "test", "status": "candidate",
                 "discovered_via": "selftest", "discover_event": "ev-test-0001"})
        jl(log, dict(fetch, event_id="ev-test-0010", ts="2026-07-21T18:07:10Z",
                     source_id="src-unvetted", doc_id="unvetted-doc",
                     url="https://example.org/other.pdf",
                     local_path="corpus/example-nation/unvetted-doc/v1-00000000.pdf",
                     content_version="v1-" + sha[:8], sha256=sha))
        expect(tmp, "validate", False, "NEGATIVE: fetch of non-approved source rejected")
        pop_line(log)
        pop_line(reg)

        # NEGATIVE: machine-actor takedown; transaction fail-closed on findings
        jl(log, {"event_id": "ev-test-0011", "ts": "2026-07-21T18:07:30Z",
                 "actor": "codex/gpt-5.6-terra", "lane": "test", "action": "takedown",
                 "url": "https://example.org/policy.pdf",
                 "doc_id": "example-research-code", "content_version": cv,
                 "notes": "unauthorized drill"})
        expect(tmp, "validate", False, "NEGATIVE: takedown by non-human actor rejected")
        r = run(tmp, "takedown", "example-research-code")
        check(r.returncode != 0, "NEGATIVE: takedown transaction fail-closed while findings exist",
              r.stdout + r.stderr)
        pop_line(log)

        expect(tmp, "merge", True, "two-phase merge of validated slices")
        expect(tmp, "validate", True, "post-merge state validates clean")

        # takedown: human event; transaction refuses until bytes AND summary are gone
        jl(log, {"event_id": "ev-test-0012", "ts": "2026-07-21T18:08:00Z",
                 "actor": "human/patrick", "lane": "test", "action": "takedown",
                 "url": "https://example.org/policy.pdf",
                 "doc_id": "example-research-code", "content_version": cv,
                 "notes": "Nation requested removal (drill)"})
        r = run(tmp, "takedown", "example-research-code")
        check(r.returncode != 0 and "REFUSING" in r.stdout,
              "NEGATIVE: transaction refuses while corpus bytes remain", r.stdout)
        (tmp / lp).unlink()
        r = run(tmp, "takedown", "example-research-code")
        check(r.returncode != 0 and "summaries/example-research-code.md" in r.stdout,
              "NEGATIVE: transaction refuses while the summary remains", r.stdout)
        summary.unlink()
        r = run(tmp, "takedown", "example-research-code")
        check(r.returncode == 0, "takedown transaction tombstoned after transitive cleanup",
              r.stdout + r.stderr)
        expect(tmp, "merge", True, "post-takedown merge (takedown event into shared log)")
        expect(tmp, "validate", True, "post-takedown state validates clean")

        # redaction: correction event alone does NOT redact; the transaction does
        r = run(tmp, "redact", "ev-test-0002", "url,notes,terms_check")
        check(r.returncode != 0, "NEGATIVE: redaction refused without a human correction event",
              r.stdout + r.stderr)
        jl(log, {"event_id": "ev-test-0013", "ts": "2026-07-21T18:09:00Z",
                 "actor": "human/patrick", "lane": "test", "action": "correction",
                 "url": "provenance/access-log.jsonl", "parent_event": "ev-test-0002",
                 "notes": "Nation requested URL redaction (drill)"})
        expect(tmp, "merge", True, "merge correction event into shared log")
        r = run(tmp, "redact", "ev-test-0002", "url,notes,terms_check")
        check(r.returncode == 0, "redact transaction rewrote the merged record",
              r.stdout + r.stderr)
        merged_log = (tmp / "provenance" / "access-log.jsonl").read_text(encoding="utf-8")
        fetch_line = next(l for l in merged_log.splitlines() if '"ev-test-0002"' in l)
        check("policy.pdf" not in fetch_line and "[REDACTED:ev-test-0013]" in fetch_line,
              "sensitive URL physically gone from the retained fetch record", fetch_line)
        slice_log = log.read_text(encoding="utf-8")
        slice_line = next(l for l in slice_log.splitlines() if '"ev-test-0002"' in l)
        check("policy.pdf" not in slice_line and "[REDACTED:ev-test-0013]" in slice_line,
              "sensitive URL physically gone from the lane slice too", slice_line)
        man_texts = man.read_text(encoding="utf-8") + \
            (tmp / "corpus" / "MANIFEST.jsonl").read_text(encoding="utf-8")
        check("policy.pdf" not in man_texts,
              "sensitive URL gone from merged + slice manifests", man_texts)

        # crash recovery: restore the original line in the slice (simulating a
        # crash between renames) — validate must fail loudly, and re-running
        # the same redact command must heal it
        redacted_slice = log.read_text(encoding="utf-8")
        crashed = redacted_slice.replace(slice_line,
                                         json.dumps(fetch, sort_keys=True))
        log.write_text(crashed, encoding="utf-8")
        expect(tmp, "validate", False,
               "NEGATIVE: interrupted redaction detected as partially-redacted record")
        r = run(tmp, "redact", "ev-test-0002", "url,notes,terms_check")
        check(r.returncode == 0, "idempotent redact re-run heals the partial state",
              r.stdout + r.stderr)
        expect(tmp, "validate", True, "post-heal state validates clean")
        expect(tmp, "validate", True, "post-redaction state validates clean")

        # coverage: Nation-bound evidence required
        expect(tmp, "coverage", False, "NEGATIVE: coverage gate fails without matrix + roster receipt")
        nations = json.loads((tmp / "sources" / "nations.json").read_text(encoding="utf-8"))["nations"]
        cov = tmp / "sources" / "coverage-matrix.jsonl"
        sweeps = []
        for k, n in enumerate(nations):
            sweeps.append({"event_id": f"ev-test-2{k:03d}", "ts": f"2026-07-21T18:{10 + k // 60:02d}:{k % 60:02d}Z",
                           "actor": "codex/gpt-5.6-terra", "lane": "test", "action": "search",
                           "url": f"query: {n['name']} data sovereignty policy",
                           "nation_id": n["nation_id"]})
        jl(log, *sweeps)
        (tmp / "sources" / "atni-roster-status.json").write_text(json.dumps(
            {"status": "deferred-by-owner",
             "receipt": "selftest synthetic deferral 2026-07-21"}), encoding="utf-8")
        jl(tmp / "sources" / "baseline-inventory.jsonl",
           {"baseline_id": "bl-001", "title": "Example Research Code",
            "entity": "Example Nation", "report_section": "tribal-governance"})

        # NEGATIVE: one generic/wrong-Nation event reused for every row
        cov.write_text("", encoding="utf-8")
        jl(cov, *[{"nation_id": n["nation_id"],
                   "status": "found" if n["nation_id"] == "nez-perce" else "searched-not-found",
                   "search_events": ["ev-test-2000"],
                   "source_ids": ["src-example-policy"] if n["nation_id"] == "nez-perce" else None}
                  for n in nations])
        expect(tmp, "coverage", False, "NEGATIVE: cross-Nation reuse of one search event rejected")

        # correct per-Nation evidence
        cov.write_text("", encoding="utf-8")
        jl(cov, *[{"nation_id": n["nation_id"],
                   "status": "found" if n["nation_id"] == "nez-perce" else "searched-not-found",
                   "search_events": [f"ev-test-2{k:03d}"],
                   "source_ids": ["src-example-policy"] if n["nation_id"] == "nez-perce" else None}
                  for k, n in enumerate(nations)])
        expect(tmp, "coverage", True, "coverage gate passes with Nation-bound evidence, roster receipt, baseline closure")

        print(f"\nLIFECYCLE SELFTEST PASSED ({PASSED} checks)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
