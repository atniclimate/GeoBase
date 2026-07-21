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
        eff_review[e.get("doc_id")] = e.get("new_state")
    cat_by_nation = defaultdict(list)
    for c in catalog:
        c["_review"] = eff_review.get(c["doc_id"], c.get("review_state"))
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
                head = (f"### {c.get('title', c['doc_id'])}\n\n"
                        f"- instrument: `{c.get('instrument_type')}` · legal status: "
                        f"`{c.get('legal_status')}` · review: `{c.get('_review')}`\n"
                        f"- source: {c.get('source_url','')}\n")
                lines.append(head)
                cl = (c.get("requirements") or {}).get("claims") or []
                if cl:
                    lines += ["| Claim | Modal | Requirement | Conditions | Cite | TSDF |",
                              "|---|---|---|---|---|---|"]
                    for k in cl:
                        req = (k.get("claim") or "").replace("|", "\\|")
                        cond = (k.get("conditions") or "").replace("|", "\\|")
                        lines.append(f"| {k.get('claim_id')} | `{k.get('modal')}` | {req} "
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
