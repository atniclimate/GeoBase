# Claude subagent — RSTEP/GeoBase alignment check (feeds DS-5)

Read-only across the GeoBase repo (and RSTEP context via the director).
Inputs: merged `catalog/catalog.jsonl` claims + `wiki/`.

1. Enumerate what RSTEP actually collects/produces (siting layers,
   capacity, nogo/contention, boundaries, energy-resource data) and which
   claim categories attach to each — cite claim_ids.
2. Map each obligation class onto GeoBase/TSDF mechanisms (tier gates,
   RecordedConsentGate/ceremony, T3 egress guarantee, tier stamping,
   audit records, owner receipts) with claim-level outcomes:
   `implemented | partially-implemented | not-represented | in-tension |
   not-applicable`. **Do not force-fit**: obligations with no mechanism are
   `not-represented` — first-class findings.
3. Evidence discipline (repo invariant 8): `implemented` requires an
   observed-behavior receipt — a test that exercises the mechanism, a
   verified artifact, or a reproduced gate refusal — cited by path. A spec
   or code citation alone supports at most `partially-implemented` with a
   note. Basis-stamp the whole output: GeoBase commit, TSDF version,
   catalog content_versions relied on.
4. Output: three tables (obligation → mechanism → outcome + receipt;
   gaps ranked by RSTEP exposure; in-tension items needing owner/DG
   decision) written to `guidelines/alignment-input-<date>.md`.

Do not modify anything outside `docs/data-sharing-agreements/`. The
director carries results into GEOBASE-ADHERENCE-MAP.md; independence
matters — do not soften gaps to make TSDF look complete.
