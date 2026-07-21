# DS-2 round-3 clearance screen — 2026-07-21

Automated sensitivity screen per COLLECTION-CHARTER.md §4 ("minimal automated
screen"), run before clearance over the 32 documents fetched by lane
ds2-round3 (`corpus/MANIFEST.jsonl` records whose `fetch_event` id starts with
`ev-ds2-round3-`). Screening only — no policy-content analysis or
summarization performed. Flags screened: personal-data, signatures-contacts,
site-locations, restricted-tk, publication-ambiguity; plus file integrity.
All 32 files located at their manifest `local_path` and sha256-verified
against the manifest before screening (32/32 match).

Screener: automated agent (Claude subagent), ds2-round3 lane population.

| doc_id | nation_authored | verdict | basis (one line) |
|---|---|---|---|
| r3-001 | true | CLEAN | Complete CTUIR codes/statutes index page (relocated official codes page); Office of Legal Counsel departmental phone and HQ phone/fax only; no individuals' contact details. |
| r3-002 | false | CLEAN | Complete WA Legislature statute page (RCW 43.376 full chapter); only agency 800-numbers; "draft"/"signed" hits are site-nav boilerplate and statute text. |
| r3-003 | false | CLEAN | Complete WA Legislature statute page (RCW 70.02 full chapter); "confidential" hits (43) are health-records statute terminology, not document markings. |
| bl-001 | true | CLEAN | Published CTUIR Constitution and Bylaws through Amendment 18 (8-pp. text PDF); "signature" hits are constitutional provisions (officers affix signature, petition signatures); ends at Art. IX Ratification with no executed certification block. |
| bl-003 | true | CLEAN | Published Warm Springs Constitution and By-Laws with amendment history (27-pp. text PDF); "restricted" hits are restricted-land provisions; no executed signatures, personal data, or markings. |
| bl-022 | false | CLEAN | Complete Oregon OLIS measure-overview page (SB 841); only legislature org emails (help.leg@, languageaccess@) and agency numbers. |
| bl-023 | false | CLEAN | Complete Oregon OLIS measure-overview page (SB 835); same org-contact footprint as bl-022; no personal data or markings. |
| bl-028 | false | CLEAN | Complete uscode.house.gov XHTML (25 U.S.C. ch. 33, ISDEAA prelim edition); no contacts, personal data, or markings. |
| bl-029 | false | CLEAN | Complete uscode.house.gov XHTML (25 U.S.C. ch. 18, IHCIA prelim edition); "404" hits are Statutes-at-Large page cites (90 Stat. 1404) and statviewer URLs, not error content. |
| or-006 | true | CLEAN | Complete Warm Springs tribal-code index page (chapter listing as of the site's stated upload state); no contacts beyond site nav, no personal data or markings. |
| wai-005 | true | FLAGGED(signatures-contacts) | Fully executed 2024 Kalispel LIHEAP agreement (DocuSign envelope, signature page with signatories for the Tribe and WA Commerce) hosted on the federal LIHEAP clearinghouse; cover block lists named-contact individual work emails and direct lines (RSutch@kalispeltribe.com, (509) 445-1147; brian.sarensen@commerce.wa.gov, (360) 725-2862); no beneficiary/client personal data present. |
| inst-019 | false | CLEAN | Complete JHU Center for Indigenous Health resource page describing its downloadable DSA template; page body carries no contacts, personal data, or markings ("draft(ed) by CIRCLE team members" is attribution text). |
| d2bl-001 | true | FLAGGED(signatures-contacts) | Complete published NWTEC Data Governance Handbook v1.1 (55 pp.), but body lists a named WA DOH staff member's individual work email (Linda.Lohdefinck@doh.wa.gov) alongside org inboxes; "confidential"/"restricted"/"internal use" hits are the handbook's dataset-handling rules for external data systems, not markings on this document; appendix signature line is a blank template field. |
| d2id-002 | true | CLEAN | Complete Sho-Pai enrollment-site landing page for the Constitution and Bylaws (heading/TOC text plus Amendment I PDF link); thin by design, no contacts, personal data, or markings. |
| bl-030 | false | CLEAN | Complete archives.gov 1998 EO disposition-table page containing the EO 13175-related entries; "signed" hits (38) are EO disposition metadata; only agency 866-number. |
| bl-032 | false | CLEAN | Complete NIH Guide notice page (NOT-OD-22-214); "draft" hits are policy terminology; no individual contacts beyond program inbox references, no markings. |
| bl-038 | false | FLAGGED(signatures-contacts) | Complete BIA Tribal Data Priorities consultation page, but the Contact Us block lists a named staff member's individual work email (Veronica Lane, Veronica.Lane@bia.gov). |
| id-005 | true | CLEAN | Complete Shoshone-Bannock privacy-policy page; only Tribes' main phone numbers and PO box (organizational); no personal data or markings. |
| wac-006 | true | CLEAN | Complete Snoqualmie tribal-codes listing page; "sacred" hit is the Aerospace Protection code's stated purpose (no site locations disclosed); no contacts or personal data. |
| wac-008 | true | FLAGGED(signatures-contacts) | Complete Swinomish Tribal Archive research-request page, but body names the Archive and Records Manager with her direct line (Krista Hamburg, (360) 466.7382); "404" hit is a street address (11404 Moorage Way), not error content. |
| inst-001 | false | CLEAN | Complete UC Berkeley libguide page (Indigenous Data Sovereignty); no librarian personal-contact block on the saved page; only site nav and CC-license footer. |
| inst-002 | false | CLEAN | Complete tribalresilienceactions.org Data Sovereignty page; "sacred" hit is topical narrative; no contacts, personal data, or markings. |
| inst-003 | false | FLAGGED(signatures-contacts) | Complete NIH THRO listening-session presentation PDF (22 pp., 508 version), but contact slides list named staff individual work emails (Karina.walters@nih.gov, medranom3@od.nih.gov); "sacred"/story content is presented cultural narrative by the presenting official, no restricted-TK disclosure. |
| inst-004 | false | FLAGGED(signatures-contacts) | Complete BJA tribal-data-sovereignty presentation PDF (23 pp.), but closing slide lists presenters' individual emails, one on a personal-domain mailbox (heather@erblawfirm.com; lou.schmitz.aihc@outlook.com). |
| inst-009 | false | CLEAN | Complete USET health-resolutions listing page incl. 2026:004; "signature" hit is resolution directive text; only USET office phone numbers (organizational). |
| inst-010 | false | CLEAN | Complete US Indigenous Data Network Indigenous Data Governance Brief PDF (5 pp.); no contacts, personal data, site locations, or markings. |
| inst-011 | false | FLAGGED(signatures-contacts) | Complete NNI policy-brief publication page, but Contacts block lists a named individual's work email (Andrew Martinez, andrewmartinez@arizona.edu). |
| inst-013 | false | FLAGGED(signatures-contacts) | Complete published 78 IAM 2 Data Governance directive (8 pp., 508 "signed" release), but p. 8 carries the executed approval block with the BIA Director's signature image (Darryl LaCounte, 05/13/24) — official capacity; "confidential"/"restricted" hits are policy terminology. |
| inst-016 | false | CLEAN | Complete EPA Exchange Network FAQ page; no contacts, personal data, or markings. |
| inst-017 | false | CLEAN | Complete USGS tribal-related guidance page for USGS authors; "restricted" hit is guidance terminology; only agency 888-number. |
| inst-018 | false | CLEAN | Complete USGS Survey Manual 500.6 page; "sacred" hits are the policy's category definitions (no locations or TK content disclosed); only agency 888-number. |
| d2id-003 | true | CLEAN | Complete Shoshone-Bannock Constitution and Bylaws page (full HTML transcription incl. amendments); the 1936 Certificate of Adoption is a typed historical transcription naming officials without contact details — no executed signature images; "restricted" hits are restricted-land provisions. |

## Integrity

No integrity failures. All 32 sha256 digests match the manifest. All 20
HTML/XHTML files are complete (closing `</html>` present, expected substantive
content confirmed, no saved error pages — all "404"/"not found" string hits
traced to Statutes-at-Large page citations and statviewer URLs in bl-029 and a
street address in wac-008). All 12 PDFs opened and rendered fully via pypdf
with extractable text and page counts matching their titles. Specifics:

- d2id-002 is a deliberately thin landing page (constitution heading/TOC text
  plus a link to the Amendment I PDF) — intentional page structure on the
  Sho-Pai enrollment site, not truncation or an error save.
- inst-019 is the JHU resource-library page describing the DSA template; the
  template document itself is a separate download not in this fetch — the
  page as saved is complete.
- wai-005's signatory names render as garbled glyph text over the DocuSign
  signature images (extraction artifact of the signature rendering, not file
  corruption); the three-page agreement is complete and legible.

## nation_authored honesty

- d2bl-001 (NWTEC Data Governance Handbook) is marked `nation_authored: true`,
  but the issuing entity per the register and the document is the Northwest
  Tribal Epidemiology Center (NPAIHB) — an intertribal organization, not a
  single Nation. Under the charter §4 taxonomy (intertribal documents sit in
  the auto-clear-eligible bucket) this is a mislabel, though in the
  conservative direction (it routes the document to human clearance rather
  than around it). Reported for the clearing human; no file changed.
- wai-005 is marked `nation_authored: true` for a bilateral instrument
  co-executed by the Kalispel Tribe and WA Commerce, hosted on the federal
  LIHEAP clearinghouse (`official_source: false` in the register). The label
  is defensible (the Nation is a co-author/signatory) and conservative; noted
  as borderline, not a mislabel.
- All other 30 records' flags match the issuing entity implied by the
  register row and the document itself (Nation official-site documents true;
  state, federal, congressional, academic, NGO, and intertribal documents
  false).

## Notes for the clearing human

- All eight flags this round are signatures-contacts only. No personal-data,
  site-locations, restricted-tk, or publication-ambiguity findings.
- Seven of the eight concern named officials/staff with individual work
  emails or direct lines on deliberately published pages/documents —
  bright-line rule as in rounds 1 and 2, not
  personal-data-beyond-official-capacity. inst-004 additionally includes a
  personal-domain mailbox (outlook.com) for a named presenter.
- wai-005 and inst-013 are the two executed instruments (DocuSign-executed
  agreement; signed federal directive). wai-005 combines executed signatures
  with named-contact details and is the only Nation-attributed flagged
  document this round besides d2bl-001 and wac-008.
- No document carries DRAFT/internal-use markings of its own; d2bl-001's
  confidentiality/internal-use language defines handling rules for external
  data systems it describes, and discloses none of that data.

Summary: 32 screened — 24 CLEAN, 8 FLAGGED (all signatures-contacts);
0 integrity failures; 1 nation_authored mislabel (d2bl-001, conservative
direction) and 1 borderline label noted (wai-005).
