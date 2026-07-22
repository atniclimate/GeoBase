#!/usr/bin/env python3
"""Generate per-Nation display pages from the merged corpus state.

Reads: sources/nations.json, sources/coverage-matrix.jsonl,
sources/register.jsonl (+ register-status events for effective status),
catalog/catalog.jsonl, corpus/MANIFEST.jsonl, provenance/access-log.jsonl.
Writes: wiki/nations/<nation_id>.md + wiki/nations/README.md (index).

Every page is DRAFT and carries the mandatory non-discovery notice
(COLLECTION-CHARTER.md §8). Regenerate any time with:
    python tools/nation_pages.py
"""
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "wiki" / "nations"

DRAFT = ("> **DRAFT — machine-assembled reference page.** Nothing here is "
         "confirmed by the Nation it concerns. Ratification path: RSTEP "
         "Tribal Advisory Board review, direct outreach to each Nation, "
         "Tribal IRB review where one exists (PLAN.md).\n>\n"
         "> **Non-discovery is not evidence of absence.** \"Not found "
         "online\" means only that this review did not locate a published "
         "copy — many instruments are held by custodians and unpublished "
         "by sovereign choice.\n")


def load_jsonl(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    nations = json.loads((ROOT / "sources/nations.json").read_text(encoding="utf-8"))["nations"]
    coverage = {r["nation_id"]: r for r in load_jsonl(ROOT / "sources/coverage-matrix.jsonl")}
    register = load_jsonl(ROOT / "sources/register.jsonl")
    log = load_jsonl(ROOT / "provenance/access-log.jsonl")
    catalog = load_jsonl(ROOT / "catalog/catalog.jsonl")

    eff = {r["source_id"]: r["status"] for r in register}
    for e in sorted((e for e in log if e.get("action") == "register-status"),
                    key=lambda x: x["ts"]):
        if e.get("source_id") in eff:
            eff[e["source_id"]] = e["new_state"]

    reg_by_nation = defaultdict(list)
    for r in register:
        if r.get("nation_id"):
            reg_by_nation[r["nation_id"]].append(r)
    eff_review = {}
    for e in sorted((e for e in log if e.get("action") == "review"),
                    key=lambda x: x["ts"]):
        eff_review[(e.get("doc_id"), e.get("content_version"))] = e.get("new_state")
    # director corrections are authoritative readings; pages must surface them
    corrections = defaultdict(list)
    for e in sorted((e for e in log if e.get("action") == "correction"
                     and e.get("doc_id")), key=lambda x: x["ts"]):
        corrections[(e.get("doc_id"), e.get("content_version"))].append(e)

    MODALS = ["must-shall", "should-recommended", "may-permissive", "descriptive"]
    MODAL_WORDS = {"must": "must-shall", "shall": "must-shall",
                   "may": "may-permissive", "should": "should-recommended"}
    legal_statuses = sorted({c.get("legal_status") for c in catalog
                             if c.get("legal_status")},
                            key=len, reverse=True)

    def corrected_segment(notes):
        """Machine-applied supersession convention: a correction event only
        changes a displayed value when its notes contain an explicit
        'Corrected reading' marker; enum values are read ONLY from the text
        after that marker. Mentions elsewhere in the note (context, rejected
        readings, 'no correction issued for ...') never supersede anything."""
        import re
        m = list(re.finditer(r"corrected reading[:\s]", notes, re.IGNORECASE))
        return notes[m[-1].end():] if m else None

    def corrected_value(segment, current, tokens, word_map=None):
        if not segment:
            return None
        found = None
        for tok in tokens:
            if tok != current and (f"'{tok}'" in segment or f"`{tok}`" in segment):
                found = tok
        if not found and word_map:
            import re
            for m in re.finditer(r"(?:modal|reading)\s+is\s+'?([a-z-]+)'?", segment):
                mapped = word_map.get(m.group(1), m.group(1))
                if mapped in tokens and mapped != current:
                    found = mapped
        return found
    cat_by_nation = defaultdict(list)
    for c in catalog:
        c["_review"] = eff_review.get((c["doc_id"], c.get("content_version")),
                                      c.get("review_state"))
        if c.get("nation_id"):
            cat_by_nation[c["nation_id"]].append(c)

    OUT.mkdir(parents=True, exist_ok=True)
    index_rows = []
    for n in nations:
        nid, name = n["nation_id"], n["name"]
        cov = coverage.get(nid, {})
        rows = reg_by_nation.get(nid, [])
        cats = cat_by_nation.get(nid, [])
        claims = sum(len((c.get("requirements") or {}).get("claims") or []) for c in cats)
        lines = [f"# {name}", "", DRAFT,
                 f"- **Coverage status (DS-1 gate):** `{cov.get('status', 'n/a')}`",
                 f"- **Register entries:** {len(rows)} · **Cataloged documents:** "
                 f"{len(cats)} · **Extracted claims:** {claims}", ""]
        if rows:
            lines += ["## Sources on record", "",
                      "| Source | Title | Status | URL |", "|---|---|---|---|"]
            for r in sorted(rows, key=lambda x: x["source_id"]):
                lines.append(f"| {r['source_id']} | {r.get('title','')} | "
                             f"`{eff[r['source_id']]}` | {r.get('url','')} |")
            lines.append("")
        if cats:
            lines += ["## Cataloged instruments (machine-extracted, DRAFT)", ""]
            for c in sorted(cats, key=lambda x: x["doc_id"]):
                corr = corrections.get((c["doc_id"], c.get("content_version")), [])
                # record-level corrected legal_status (last correction wins)
                ls_now, ls_from = c.get("legal_status"), None
                # claim-level corrections: claim_id -> (corrected_modal|None, event_id)
                corrected_claims = {}
                for e in corr:
                    notes = e.get("notes") or ""
                    seg = corrected_segment(notes)
                    if seg is None:
                        continue  # narrative-only correction: blockquote only
                    ls = corrected_value(seg, c.get("legal_status"), legal_statuses)
                    if ls:
                        ls_now, ls_from = ls, e["event_id"]
                    for k in (c.get("requirements") or {}).get("claims") or []:
                        cid = k.get("claim_id")
                        # full claim_id required, and only when the event
                        # actually declares a corrected reading
                        if cid and cid in notes:
                            m = corrected_value(seg, k.get("modal"), MODALS,
                                                MODAL_WORDS)
                            if m:
                                corrected_claims[cid] = (m, e["event_id"])
                if ls_from:
                    ls_cell = (f"~~`{c.get('legal_status')}`~~ **`{ls_now}`** "
                               f"(corrected by {ls_from})")
                else:
                    ls_cell = f"`{c.get('legal_status')}`"
                head = (f"### {c.get('title', c['doc_id'])}\n\n"
                        f"- instrument: `{c.get('instrument_type')}` · legal status: "
                        f"{ls_cell} · review: `{c.get('_review')}`\n"
                        f"- source: {c.get('source_url','')}\n")
                lines.append(head)
                for e in corr:
                    note = (e.get("notes") or "").replace("|", "\\|")
                    lines.append(f"> **Director correction {e['event_id']}** "
                                 f"(authoritative reading; the catalog record is "
                                 f"never edited): {note}\n")
                cl = (c.get("requirements") or {}).get("claims") or []
                if cl:
                    lines += ["| Claim | Modal | Requirement | Conditions | Cite | TSDF |",
                              "|---|---|---|---|---|---|"]
                    for k in cl:
                        req = (k.get("claim") or "").replace("|", "\\|")
                        cond = (k.get("conditions") or "").replace("|", "\\|")
                        cid = k.get("claim_id")
                        if cid in corrected_claims:
                            m, ev = corrected_claims[cid]
                            modal = (f"~~`{k.get('modal')}`~~ **`{m}`** "
                                     f"(corrected by {ev})" if m else
                                     f"~~`{k.get('modal')}`~~ (superseded by {ev})")
                            # the recorded prose expresses the superseded
                            # reading; the correction above is authoritative
                            req = (f"~~{req}~~ **superseded — corrected "
                                   f"reading in {ev} above**")
                            if cond:
                                cond = f"~~{cond}~~"
                        else:
                            modal = f"`{k.get('modal')}`"
                        lines.append(f"| {cid} | {modal} | {req} "
                                     f"| {cond} | {k.get('cite','')} | "
                                     f"`{k.get('tsdf_outcome','')}` |")
                    lines.append("")
                else:
                    nr = (c.get("requirements") or {}).get("none_reason")
                    lines.append(f"_No partner-facing claims extracted. Reason: {nr}_\n")
        else:
            lines += ["## Cataloged instruments", "",
                      "_None yet. See coverage status above; searches for this "
                      "Nation are logged in the provenance chain._", ""]
        (OUT / f"{nid}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        index_rows.append((nid, name, cov.get("status", "n/a"), len(rows), len(cats), claims))

    idx = ["# Per-Nation reference pages (DRAFT)", "", DRAFT,
           "Generated by `tools/nation_pages.py` from the merged register, "
           "coverage matrix, and catalog. Regenerate after every merge.", "",
           "| Nation | Coverage | Sources | Cataloged | Claims |", "|---|---|---|---|---|"]
    for nid, name, st, nr, nc, ncl in index_rows:
        idx.append(f"| [{name}]({nid}.md) | `{st}` | {nr} | {nc} | {ncl} |")
    (OUT / "README.md").write_text("\n".join(idx) + "\n", encoding="utf-8")
    print(f"wrote {len(index_rows)} nation pages + index to {OUT}")


if __name__ == "__main__":
    main()
