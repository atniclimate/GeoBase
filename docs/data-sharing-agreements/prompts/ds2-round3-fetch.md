# DS-2 Round 3 — probe + acquisition of APPROVED register rows (lane: ds2-round3)

Working root: C:\dev\GeoBase\docs\data-sharing-agreements (all paths below relative to it).

MANDATORY FIRST READS: ../../AGENTS.md (if present), COLLECTION-CHARTER.md
(binding), corpus/manifest.schema.json, provenance/access-log.schema.json,
sources/register.schema.json, lanes.json (lane `ds2-round3` = YOUR host
allowlist), prompts/ds2-wave-b-fetch.md (the wave-B contract — it governs
this round too, with the deltas below).

## Deltas from the wave-B contract

1. Your lane is `ds2-round3`. Write ONLY suffixed slices:
   `provenance/access-log.ds2-round3.jsonl`, `corpus/MANIFEST.ds2-round3.jsonl`,
   `sources/register.ds2-round3.jsonl` (new candidate registrations only).
   Event ids: `ev-ds2-round3-XXXX`, monotonic, ts = real UTC now (never backdate).
2. PROBE BEFORE FETCH for every assigned row (most lack wave-A probes):
   record a `probe` event (HEAD or ranged GET). Non-200 after redirects →
   `register-status` `dead` (404/410) or log-and-skip (other 4xx/5xx per
   wave-B retry rules). A redirect landing OFF your host allowlist → do NOT
   fetch; record probe + note for director.
3. All 51 rows below carry effective status `approved` (director events
   ev-director-0089..0139 in provenance/access-log.jsonl — verify per row).
4. HTML landing/TOC pages (e.g. code portals, program pages): fetch the page
   itself as the artifact, and REGISTER linked instrument documents (PDFs,
   operative chapters) as new `candidate` rows + `discover` events in your
   register slice for director approval — do NOT fetch those this round.
5. Layers: rows include Nation-official sites, WA/OR state legislature,
   federal (uscode/archives/NIH/BIA/DOI/EPA/USGS/ONC/ACF), intertribal
   (USET, NPAIHB, atniclimate GitHub), and open-access academic. Charter
   applies identically to all: robots + terms before bytes, 5s/host (or
   Crawl-delay if larger), UA exactly
   `ATNI-GeoBase-PolicyCorpus/1.0 (reuben@atnitribes.org; data-sovereignty research)`.
   If terms restrict automated retrieval → `register-status` `excluded-terms`, no fetch.
   Default-refuse on any ambiguity — record and move on; never improvise scope.
6. GitHub rows (src-inst-005/006): fetch the canonical raw/codeload
   representation of the named tree (e.g. codeload tarball of the pinned
   path or the rendered page) — record exactly what you stored in notes.
   github.com and codeload.github.com are in your allowlist.
7. NO parsing/summarization/analysis. Documents land staged; clearance is
   the director/owner's.

## Assigned rows (51)

- `src-r3-001` | Confederated Tribes of the Umatilla Indian Reservation | https://ctuir.org/departments/office-of-legal-counsel/codesstatuteslaws/
- `src-r3-002` | Washington State Legislature | https://app.leg.wa.gov/RCW/default.aspx?cite=43.376&full=true
- `src-r3-003` | Washington State Legislature | https://app.leg.wa.gov/RCW/default.aspx?cite=70.02&full=true
- `src-bl-001` | Confederated Tribes of the Umatilla Indian Reservation | https://ctuir.org/media/qrrloxze/constitution-and-bylaws-thru-amendment-18-2021.pdf
- `src-bl-003` | Confederated Tribes of Warm Springs Reservation of Oregon | https://warmsprings-nsn.gov/wp-content/uploads/2016/03/const.pdf
- `src-bl-005` | Confederated Tribes of Grand Ronde | https://www.grandronde.org/services/tribal-government/constitution/
- `src-bl-006` | Confederated Tribes of the Colville Reservation | https://www.colvilletribes.com/tribal-law-and-order-code
- `src-bl-008` | Suquamish Tribe | https://suquamish.nsn.us/home/tribal-government/constitution-and-bylaws/
- `src-bl-009` | Suquamish Tribe | https://suquamish.nsn.us/home/tribal-government/tribal-code/
- `src-bl-010` | Nisqually Indian Tribe | https://www.nisqually-nsn.gov/government/tribal-code/
- `src-bl-014` | Confederated Tribes and Bands of the Yakama Nation | https://yakama.com/programs/natural-resources/water-resources/water-code/
- `src-bl-022` | Oregon Legislative Assembly | https://olis.oregonlegislature.gov/liz/2025R1/Measures/Overview/SB841
- `src-bl-023` | Oregon Legislative Assembly | https://olis.oregonlegislature.gov/liz/2025R1/Measures/Overview/SB835
- `src-bl-028` | United States Congress | https://uscode.house.gov/view.xhtml?path=/prelim@title25/chapter33&edition=prelim
- `src-bl-029` | United States Congress | https://uscode.house.gov/view.xhtml?path=/prelim@title25/chapter18&edition=prelim
- `src-bl-030` | President of the United States | https://www.archives.gov/federal-register/executive-orders/1998.html#13175
- `src-bl-032` | National Institutes of Health | https://grants.nih.gov/grants/guide/notice-files/NOT-OD-22-214.html
- `src-bl-036` | Office of the National Coordinator for Health Information Technology | https://www.healthit.gov/isa/uscdi-data-class/tribal-affiliation
- `src-bl-037` | Office of the National Coordinator for Health Information Technology | https://www.healthit.gov/isa/uscdi-data-element/tribal-affiliation
- `src-bl-038` | Bureau of Indian Affairs | https://www.bia.gov/service/tribal-consultations/tribal-data-priorities
- `src-bl-039` | U.S. Department of the Interior | https://www.doi.gov/sites/doi.gov/files/indigenous-knowledge-handbook.pdf
- `src-bl-040` | U.S. Department of the Interior | https://www.doi.gov/sites/doi.gov/files/doi-tribal-consultation-plan.pdf
- `src-bl-041` | Bureau of Indian Affairs | https://www.bia.gov/service/tribal-enrollment/tribal-enrollment-data-self-certification
- `src-bl-044` | Native Nations Institute | https://nni.arizona.edu/programs-projects/indigenous-data-sovereignty
- `src-bl-045` | Native Nations Institute | https://nni.arizona.edu/publications/native-nation-rebuilding-tribal-research-and-data-governance
- `src-bl-050` | Arizona Law Review | https://arizonalawreview.org/pdf/44-1/44-1-Tsosie.pdf
- `src-bl-051` | Frontiers in Research Metrics and Analytics | https://www.frontiersin.org/journals/research-metrics-and-analytics/articles/10.3389/frma.2021.792995/full
- `src-bl-052` | Data Science Journal | https://datascience.codata.org/articles/10.5334/dsj-2020-043
- `src-id-005` | Shoshone-Bannock Tribes | https://www.sbtribes.com/shoshone-bannock-privacy-policy/
- `src-or-006` | Confederated Tribes of the Warm Springs Reservation of Oregon | https://warmsprings-nsn.gov/book/tribal-code/
- `src-wac-006` | Snoqualmie Indian Tribe | https://www.snoqualmietribe.us/tribal-codes/
- `src-wac-008` | Swinomish Indian Tribal Community | https://www.swinomish-nsn.gov/tribal-archive/page/research-request-form
- `src-wai-005` | Kalispel Tribe of Indians and Washington State Department of Commerce | https://liheapch.acf.gov/docs/2024/tribal-contracts/Signed%202024_Kalispel_LIHEAP_Agreement.pdf
- `src-inst-001` | University of California, Berkeley Library | https://guides.lib.berkeley.edu/c.php?g=527365&p=8210973
- `src-inst-002` | Tribal Resilience Action Database | https://tribalresilienceactions.org/data-sovereignty/
- `src-inst-003` | National Institutes of Health Tribal Health Research Office | https://dpcpsi.nih.gov/sites/g/files/mnhszr346/files/THRO%20presentation%20TAC%20IDS%20Listening%20Session%20June%2026%202024_508.pdf
- `src-inst-004` | Bureau of Justice Assistance, U.S. Department of Justice | https://bja.ojp.gov/doc/tribal-data-sovereignty-presentation.pdf
- `src-inst-005` | Affiliated Tribes of Northwest Indians | https://github.com/atniclimate/TieredSovereignDataFramework/tree/main/literature
- `src-inst-006` | Affiliated Tribes of Northwest Indians | https://github.com/atniclimate/TieredSovereignDataFramework/tree/main/standard
- `src-inst-009` | United South & Eastern Tribes Sovereignty Protection Fund | https://www.usetinc.org/resources/resolutions/health/
- `src-inst-010` | U.S. Indigenous Data Sovereignty Network | https://usindigenousdatanetwork.org/wp-content/uploads/2024/10/Indigenous-Data-Governance-Brief-FINAL.pdf
- `src-inst-011` | Native Nations Institute | https://nni.arizona.edu/publications/policy-brief-data-governance-native-nation-rebuilding
- `src-inst-013` | Bureau of Indian Affairs | https://www.bia.gov/sites/default/files/dup/assets/public/raca/manual/pdf/78_iam_2_data_governance_final_5.9.24_signed5.13.24_w.footers_508.pdf
- `src-inst-016` | U.S. Environmental Protection Agency | https://www.epa.gov/exchangenetwork/my-tribe-interested-applying-en-grant-concerned-about-requirements-around-data
- `src-inst-017` | U.S. Geological Survey | https://www.usgs.gov/office-of-science-quality-and-integrity/tribal-related-guidance-usgs-authors
- `src-inst-018` | U.S. Geological Survey | https://www.usgs.gov/survey-manual/5006-relations-american-indian-and-alaska-native-tribes-alaska-native-corporations
- `src-inst-019` | Johns Hopkins Center for Indigenous Health | https://cih.jhu.edu/resource_tools_post/data-sharing-agreement/
- `src-d2bl-001` | Northwest Tribal Epidemiology Center | https://www.npaihb.org/wp-content/uploads/2024/11/NWTEC-Data-Governance-Handbook-v.1.1_weblinks-removed.pdf
- `src-d2id-001` | Kootenai Tribe of Idaho | https://www.kootenai.org/files/1-General.pdf
- `src-d2id-002` | Shoshone-Paiute Tribes | https://shopaitribes.org/sptenroll/constitution-and-bylaws.html
- `src-d2id-003` | Shoshone-Bannock Tribes | https://www.sbtribes.com/constitution-bylaws/

## Before finishing

`python tools/merge_validate.py validate` clean for your slices; lane report
`reviews/lane-reports/ds2-round3-2026-07-21.md` (fetched: doc_id/sha256/size
per row; probes; failures with retry class; terms/robots decisions; new
candidate registrations; flags for director). Do NOT touch merged JSONL
files, lanes.json, or anything outside your slices + corpus/ + your report.
