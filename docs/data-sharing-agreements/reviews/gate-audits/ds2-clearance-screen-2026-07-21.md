# DS-2 clearance screen — 2026-07-21

Automated sensitivity screen per COLLECTION-CHARTER.md §4 ("minimal automated
screen"), run before clearance over the 21 staged documents in
`corpus/MANIFEST.jsonl`. Screening only — no policy-content analysis or
summarization performed. Flags screened: personal-data, signatures-contacts,
site-locations, restricted-tk, publication-ambiguity; plus file integrity.

Screener: automated agent (Claude subagent), DS-2 lanes merged population.

| doc_id | nation_authored | verdict | basis (one line) |
|---|---|---|---|
| rcw-43-376 | false | CLEAN | Complete WA Legislature statute page (RCW 43.376); only agency 800-numbers; "draft" hits are site-nav boilerplate. |
| rcw-70-02 | false | CLEAN | Complete WA Legislature statute page (RCW 70.02); "confidential" hits are statute terminology, not document markings. |
| wac-246-455-990 | false | CLEAN | Complete WA Legislature rule page (WAC 246-455-990); no personal data, contacts, or markings. |
| wac-182-125-0100 | false | CLEAN | Complete WA Legislature rule page (WAC 182-125-0100); no personal data, contacts, or markings. |
| local-contexts-home | false | CLEAN | Complete Local Contexts public homepage; only org support@ email; no restrictions or personal data. |
| coeur-dalene-institutional-research-board | true | CLEAN | Complete public IRB program page; department address/phones only (official capacity); no individuals' personal data. |
| coeur-dalene-research-permit-application | true | CLEAN | Blank published application template (CDARESOLUTION-036 approved 10/25/18); signature/initial lines are empty form fields; no filled personal data. |
| nez-perce-2024-revised-research-permit-regulations-application | true | CLEAN | Blank adopted regulations + application packet (NPTEC 10-22-2024); signature lines are empty form fields; maps referenced are published treaty/reservation boundary maps, not site registers. |
| nez-perce-tribal-code | true | CLEAN | Complete public tribal-code index page; only org email (NPTEC@) and office phones. |
| burns-paiute-tribal-code | true | CLEAN | Complete public tribal-code listing page; only org contact info; "404" hits are SVG path data, not error content. |
| ctclusi-research-regulation | true | CLEAN | Codified public tribal code chapter (Ch. 1-10) with legislative-history appendix; no signatures, personal data, or markings. |
| grand-ronde-foi-ordinance | true | FLAGGED(signatures-contacts) | Final adopted public ordinance, but last page carries a wet-ink certification signature of the Tribal Council Secretary (official capacity; p. 9 of PDF); otherwise clean — records-request form is blank template. |
| siletz-research-ordinance | true | CLEAN | Codified public research ordinance (STC 9.100, amended 2/20/25); no signatures, personal data, or restricted markings. |
| coquille-indigenous-determinants-health-ordinance | true | CLEAN | Codified public tribal code chapter (Ch. 146); narrative history but no identifiable-individual personal data; no markings. |
| klamath-special-use-permit | true | FLAGGED(signatures-contacts, site-locations) | Scanned executed USFS permit hosted on the Tribe's own site: wet-ink signatures (permit p. 2: tribal signatory + two USFS district rangers; camping-code certification page: Chairman + Secretary); Exhibit D lists rangers' direct phone lines; Exhibit A maps show specific Tribal camp boundaries for traditional/cultural/subsistence use with PLS section grid. Human review of handling before analysis. |
| quileute-law-and-order-codes | true | CLEAN | Complete public codes/court-forms index page; court/program phone numbers only; no docket contents or personal data on page. |
| nwic-irb-policy-806 | false | CLEAN | Complete published IRB policy PDF; preparer named in official capacity; signature cells in header table are unexecuted. |
| archives-records-colville | true | FLAGGED(signatures-contacts) | Complete public Archives & Records page, but body contact block lists two named staff members' individual work emails (karen.condon@, brock.belgarde.arc@colvilletribes.com); "404" hits are asset-hash strings, not error content. |
| kalispel-commerce-mou-announcement | false | CLEAN | Complete state agency press-release page; officials named in public roles only; no contact details or markings. |
| archives-and-collections | true | FLAGGED(signatures-contacts) | Complete public Spokane DNR Archives page, but body names the Archives and Collections Manager with her individual work email (rachel.vang@spokanetribe.com). |
| preservation-program | true | CLEAN | Complete public Preservation Program page; program phone/fax/PO box only (departmental, not individual). |

## Integrity

No integrity problems found. All 13 HTML files are complete (closing `</html>`
present, expected substantive content confirmed, no saved error pages — all
"404"/"not found" string hits traced to SVG path data, asset-hash filenames, or
nav boilerplate). All 8 PDFs opened and rendered fully, including the 20-page
scanned Klamath permit packet (legible throughout).

## Notes for the clearing human

- The three signatures-contacts flags on web pages (archives-records-colville,
  archives-and-collections) and the ordinance certification signature
  (grand-ronde-foi-ordinance) are named officials/staff in official capacity on
  deliberately published pages — flagged per the screen's bright-line rule, not
  because personal-data-beyond-official-capacity was found.
- klamath-special-use-permit is the only document combining executed signatures,
  direct individual phone lines, and maps of cultural-use site locations; it is
  also an expired (2008) instrument — relevant to `legal_status` at catalog
  time, not to this screen.
- No document carries DRAFT/internal-use markings; none self-marks content as
  restricted or TK-sensitive (siletz-research-ordinance and the Klamath MOA
  *define* protections for such content but disclose none).

## Round 2 screen

Automated sensitivity screen per COLLECTION-CHARTER.md §4 over the nine staged
documents in `corpus/MANIFEST.ds2-round2.jsonl`. Screening only — no policy
analysis or summarization performed. Same flag set as above. The 43MB Quileute
PDF was reviewed page-by-page (all 41 pages: full front matter/TOC, every
article's text including Article IX Clerk and Records in full); the Nez Perce
and Yakama codes were read in full; the Colville set was read in full.

| doc_id | nation_authored | verdict | basis (one line) |
|---|---|---|---|
| colville-research-permit-application | true | FLAGGED(signatures-contacts) | Blank published ARC permit application; intake block on p. 1 lists a named staff member's direct line and individual work email (brock.belgarde.arc@colvilletribes.com, 509-634-2148) — official capacity; all applicant/signature fields are empty template fields. |
| colville-research-regulation-ordinance-process | true | CLEAN | Complete one-page public process summary of the research regulation ordinance; departmental info only; no signatures, personal data, or markings. |
| colville-chapter-6-6-research-regulation | true | CLEAN | Complete codified public Chapter 6-6 research regulation text; no signatures, personal data, site locations, or restricted markings ("confidential" hits are the regulation's own protections for future research data, not document markings). |
| colville-resolution-1981-721 | true | FLAGGED(signatures-contacts) | Complete adopted resolution 1981-721 as published, but carries the executed certification block with the Chairman's wet-ink signature (final page); officials in official capacity only. |
| colville-resolution-1990-317 | true | FLAGGED(signatures-contacts) | Complete adopted resolution 1990-317 as published, with executed certification signature block (Chairman, final page); officials in official capacity only. |
| quileute-law-and-order-code-articles-i-xii | true | CLEAN | Scanned adopted Law and Order Ordinance 74-A7 as amended, Articles I–XII complete (TOC pp. i–xvi + code pp. 1–24, ends at §12.09 as expected for this part); date-received stamp and compiled amendment insert (Resolution 90-A-41) are codification artifacts, not leak indicators; no signatures, personal data, or site locations. |
| nez-perce-revised-code-title-3 | true | CLEAN | Complete Nez Perce Revised Code Title 3 (43 pp., read in full); named fishing areas (e.g., Rapid River) are public statutory area designations, not sensitive site locations; no signatures or personal data. |
| nez-perce-revised-code-title-6 | true | CLEAN | Nez Perce Revised Code Title 6 compilation incl. Hemp/Gaming ordinances (front, middle, and end sampled; USDA appendices verified); all forms (incl. an election candidacy form with an SSN field) are blank templates; no filled personal data, signatures, or markings. |
| yakama-water-code | true | CLEAN | Complete Revised YN Law and Order Codes Title LX Water Code (2016 Ed. V.3.2022, 55 pp., read in full, ends at §60.29.17); "Culturally Sensitive Area" consultation duty is defined but no site locations disclosed; no signatures, personal data, or markings. |

### Round 2 integrity

All nine PDFs opened and rendered fully; no truncation or wrong-content saves.
Specifics:

- quileute-law-and-order-code-articles-i-xii: 41-page image-only scan (no text
  layer — explains the 43MB size). TOC page iv (PDF p. 4) is scanned rotated
  180 degrees but fully legible; several TOC pages are noisy photocopies with
  handwritten pagination corrections; one amendment resolution page
  (90-A-41, unsigned promulgation text) is interleaved mid-Article X as part
  of the compiled codification. Content ends exactly where the title says
  (Article XII); the TOC covering Articles XIII–XX belongs to companion files
  not in this fetch — not truncation.
- yakama-water-code p. 27 carries a typographical chapter-heading error in the
  source document ("CHAPTER 60.11 60.13 – WELL CONSTRUCTION...") — source
  artifact, not a save defect.
- colville-research-permit-application: manifest `final_url` is null with a
  Squarespace-redirect note; bytes verified as the intact blank ARC
  application PDF.

### Round 2 notes for the clearing human

- All three round-2 flags are signatures-contacts only, and all concern
  officials/staff in official capacity on deliberately published instruments
  (bright-line rule, as in round 1). No personal-data, site-locations,
  restricted-tk, or publication-ambiguity findings in this round.
- The two Colville resolutions (1981-721, 1990-317) and the permit
  application are the Nation's own published copies; the executed signature
  blocks are standard certification of adopted resolutions.
- No document in this round carries DRAFT/internal-use markings; the
  Quileute received-date stamp and marginal codification annotations are
  normal for a published compiled ordinance scan.
