# ds3-d — DS-3 cataloging, round-3 non-Nation cleared documents

Working root: C:\dev\GeoBase\docs\data-sharing-agreements. Your lane:
`ds3-d` (registered in lanes.json). Follow prompts/codex-ds3-catalog.md —
it binds you in full (COLLECTION-CHARTER.md §8, catalog/catalog.schema.json
v3, parse events with parent_event = the clear event, faithful modals,
honest none_reason / tsdf_mapping / review_state).

DS-2 gate basis for this slice: the round-3 sensitivity screen
reviews/gate-audits/ds2-round3-clearance-screen-2026-07-21.md (32/32
sha256-verified, integrity clean).

Assigned doc_ids (16 — all EFFECTIVE clearance `cleared`, non-Nation-
authored; verify each clear event in provenance/access-log.jsonl before
parsing; the clear event ids are listed):

- bl-022 (ev-director-0144) — OR SB 841 overview page
- bl-023 (ev-director-0145) — OR SB 835 overview page
- bl-028 (ev-director-0146) — ISDEAA, 25 USC ch. 33
- bl-029 (ev-director-0147) — IHCIA, 25 USC ch. 18
- bl-030 (ev-director-0148) — EO 13175 (archives.gov 1998 EO page: catalog ONLY EO 13175, note the page carries other EOs)
- bl-032 (ev-director-0149) — NIH NOT-OD-22-214
- inst-001 (ev-director-0155) — Berkeley IDS libguide
- inst-002 (ev-director-0156) — tribalresilienceactions data-sovereignty page
- inst-009 (ev-director-0159) — USET health resolutions page
- inst-010 (ev-director-0160) — USIDN Indigenous Data Governance brief
- inst-016 (ev-director-0163) — EPA Exchange Network tribal FAQ
- inst-017 (ev-director-0164) — USGS tribal-related guidance for authors
- inst-018 (ev-director-0165) — USGS Survey Manual 500.6
- inst-019 (ev-director-0166) — JHU CIH Data Sharing Agreement resource page
- r3-002 (ev-director-0169) — RCW 43.376 FULL chapter text
- r3-003 (ev-director-0170) — RCW 70.02 FULL chapter text

Notes:
- r3-002/r3-003 replace the near-empty index reads of rcw-43-376 /
  rcw-70-02 (those earlier records produced 0 claims). Extract the operative
  obligations now — 43.376 government-to-government duties; 70.02 tribal
  public-health-authority and data-disclosure provisions relevant to Tribes.
  Do NOT catalog unrelated 70.02 medical-records minutiae exhaustively:
  scope claims to provisions touching Tribes, tribal health authorities, or
  intergovernmental data sharing, and say so in the record notes.
- Guidance pages / libguides / FAQ pages are `guidance` or scholarship-like
  legal_status, usually none_reason or thin claims — be honest, don't force.
- Read reviews/gate-audits/ds3-gate-2026-07-21.md before writing claims:
  the gate found a may→must modal upgrade (since corrected); do not repeat
  that defect class. Preserve qualifiers; never broaden covered parties.

Slices: catalog/catalog.ds3-d.jsonl + provenance/access-log.ds3-d.jsonl
(event ids ev-ds3-d-NNNN, real UTC ts). Finish with
`python tools/merge_validate.py validate` clean + lane report
reviews/lane-reports/ds3-d-2026-07-21.md (records, unknown counts, theme
patterns, flags). Touch nothing else.
