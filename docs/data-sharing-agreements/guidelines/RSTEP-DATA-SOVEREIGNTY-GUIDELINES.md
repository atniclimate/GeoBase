# RSTEP Data Sovereignty Guidelines

> **DRAFT — MACHINE-EXTRACTED, NOT NATION-CONFIRMED.** Every claim in this
> document was extracted by machine from publicly published instruments;
> nothing here has been confirmed by any Tribal Nation. Review-state upgrades
> to `human-reviewed` are deferred by owner decision (DECISIONS.md,
> 2026-07-21): the draft proceeds on machine-extracted claims. Before this
> document is used for anything other than internal drafting, the ratification
> path is mandatory: (1) review and approval by the RSTEP Tribal Advisory
> Board, (2) direct outreach to every Nation attributed in this draft, (3)
> Tribal IRB review where one exists, then (4) ratification recorded in
> `guidelines/RATIFICATION-LEDGER.md`. Until then, no Nation-attributed
> statement below may be presented as that Nation's confirmed requirement.

## 1. Purpose and status

RSTEP — the Reservation Siting Technical Evaluation Project — is ATNI's
offline-capable renewable-energy siting tool for Tribal Nations. It helps a
Nation evaluate where energy infrastructure could be sited on its own lands,
using layers the Nation controls, on hardware the Nation controls, without
requiring a network connection or an external account.

This document states how RSTEP, and any external partner or agency working
with RSTEP outputs, is expected to handle data about a Tribal Nation. It is
synthesized from a machine-built corpus of 64 published instruments carrying
359 cataloged claims (`catalog/catalog.jsonl`), restated in eight theme pages
under `wiki/`. Every normative statement attributed to an instrument cites its
stable claim ID; the catalog is the single source of truth, traceable to exact
source bytes.

What this document is not: not legal advice, not a substitute for any Nation's
own law or process, and not evidence of any Nation's agreement. Where a Nation
appears below, that reflects only what a machine pass found in a published
document — publication is availability, not consent, and non-discovery is
never absence (see the footer).

## 2. Principles

These principles are synthesized across the corpus. Each points to the theme
page that carries the claim-level citations.

1. **A Nation is sovereign over data about it.** The corpus consistently
   treats authority over Tribal data — wherever held — as resting with the
   Tribe (`inst-004:c001`, `inst-004:c003`, `inst-010:c001`,
   `nez-perce-2024-revised-research-permit-regulations-application:c021`). See
   `wiki/ownership-control.md`.
2. **Consent comes before collection AND before secondary use.** Permit and
   consent gates in Nation-linked instruments apply before work begins
   (`ctclusi-research-regulation:c001`, `siletz-research-ordinance:c002`,
   `colville-chapter-6-6-research-regulation:c001`), and secondary use
   requires fresh permission (`siletz-research-ordinance:c012`,
   `inst-003:c011`). Public posting is not downstream permission: the one
   corpus project that ingested already-public Tribal plans still conducted
   outreach and offers continuing opt-out (`inst-002:c002`, `inst-002:c004`).
   See `wiki/consent-fpic.md`.
3. **Access is role- and purpose-specific, beyond tiers.** Statutes and
   handbooks grant access only to named roles for named purposes under named
   triggers (DS3-D lane report, Theme patterns 1; `d2bl-001:c013`,
   `d2bl-001:c029`, `grand-ronde-foi-ordinance:c002`). A tier label alone
   cannot carry these entitlements. See
   `wiki/redisclosure-confidentiality.md`.
4. **Control is continuing, including withdrawal.** A Nation may withdraw
   consent, prevent harmful publication, and require return of all data and
   materials (`siletz-research-ordinance:c010`, `:c011`,
   `nez-perce-2024-revised-research-permit-regulations-application:c009`,
   `inst-002:c004`). See `wiki/benefit-sharing-data-return.md`.
5. **Engagement is with institutions, not persons.** Instruments route
   requests through councils, commissions, archives, and designated offices.
   RSTEP addresses institutional roles only and never keys any process to a
   named individual. See section 6.
6. **Written and formal beats verbal and informal.** Verbal authorization is
   not authorization
   (`nez-perce-2024-revised-research-permit-regulations-application:c016`,
   `colville-research-regulation-ordinance-process:c006`), and agreements must
   precede transfer (`d2bl-001:c009`).
7. **A modal never overrides legal status.** Guidance, templates, drafts, and
   unresolved instruments remain non-binding even where their text says
   "must." Every theme page preserves legal status per claim; so does this
   document.

## 3. What external partners and agencies must adhere to

Organized by the eight obligation classes of the wiki. Requirements are stated
as honest ranges — the range is the finding; stricter requirements are never
averaged away. All claims are machine-extracted restatements.

### 3.1 Consent and FPIC (`wiki/consent-fpic.md`)

- Research-permit gates: an unrequested, uncontracted study, survey, or
  research project requires a permit approved by the governing body or its
  designate before work begins — Confederated Tribes of Coos, Lower Umpqua and
  Siuslaw Indians (`ctclusi-research-regulation:c001`), Confederated Tribes of
  the Colville Reservation (`colville-chapter-6-6-research-regulation:c001`),
  Coeur d'Alene Tribe (`coeur-dalene-institutional-research-board:c001`), Nez
  Perce Tribe
  (`nez-perce-2024-revised-research-permit-regulations-application:c015`).
- Requirements range from a permit for projects on the Tribes' lands
  (`ctclusi-research-regulation:c001`) to the Confederated Tribes of Siletz
  Indians' broader reach: a Council-approved permit for any project on Tribal
  lands **or directly affecting the Tribe, Tribal lands, or Tribal members**,
  including Tribally sponsored research (`siletz-research-ordinance:c002`).
- Written agreement is a precondition: no Nez Perce research permit may issue
  without a written agreement; a verbal agreement is not authorized
  (`nez-perce-2024-revised-research-permit-regulations-application:c016`).
- Institutional consent can be required alongside individual consent: the
  Northwest Indian College IRB requires informed consent from participating
  Tribes, TCUs, and TBOs, not only individuals (`nwic-irb-policy-806:c007`).
- Intertribal and federal guidance points the same way with weaker force:
  agreements before transfer and Tribal approval before collection
  (`d2bl-001:c009`, `d2bl-001:c016`, `inst-003:c002` — draft), engagement with
  each Nation's own laws before research (`bl-032:c002` — non-binding),
  accountable consultation processes for federal agencies (`r3-005:c004`) and
  Washington state agencies (`r3-002:c001`).

### 3.2 Ownership and Tribal control (`wiki/ownership-control.md`)

- Requirements range from discretionary administrative record-keeping — the
  Confederated Tribes and Bands of the Yakama Nation's Water Code Director MAY
  collect and maintain statistical records (`yakama-water-code:c002`; modal
  corrected to may-permissive by authoritative correction `ev-director-0140`)
  — to the Siletz Tribe's option to retain sole ownership of ALL data,
  documents, specimens, and other items a researcher produces or gathers
  (`siletz-research-ordinance:c009`), unless the Research Contract makes an
  express exception.
- The Nez Perce application states retained sovereignty over information,
  data, and historical and cultural knowledge
  (`nez-perce-2024-revised-research-permit-regulations-application:c021` —
  descriptive, and approval does not imply endorsement of results).
- Record access can be membership-bounded: under the Confederated Tribes of
  the Grand Ronde Community of Oregon's Freedom of Information Ordinance, only
  Tribal members and Tribal newspaper staff in official capacity hold the
  ordinance's copy-access right (`grand-ronde-foi-ordinance:c002`).
- The NWIC IRB applies criteria under which each participating Tribe owns and
  controls data, materials, and analyses about itself and its members and
  determines access (`nwic-irb-policy-806:c010`).
- A Tribe that shares some data may still decide field-by-field what to
  withhold (`inst-016:c004`), and may request sensitive labeling of Indigenous
  Knowledge and culturally significant site information whoever collected it
  (`inst-018:c002`).

### 3.3 Review boards, permits, and oversight (`wiki/review-board.md`)

- Process obligations range from a request-based archive channel — the
  Swinomish Indian Tribal Community's Tribal Archive requests use of its
  research-request form (`wac-008:c001` — a request, not a legal prerequisite)
  — to the Nez Perce Tribe's 90-day advance application with NPTEC
  subcommittee presentation and itemized approval of purpose, funding,
  methodology, participants, products, and rights-protection steps
  (`nez-perce-2024-revised-research-permit-regulations-application:c001`,
  `:c019`).
- Approval content is enumerated, not generic: CTCLUSI requires approval of
  purpose, profit status, funding, methodology, participants, dates, sources,
  final product, publication plan, and use of results
  (`ctclusi-research-regulation:c004`).
- Time for review is itself a ground of decision: CTCLUSI and Colville may
  refuse a permit when there is insufficient time for appropriate Tribal
  review, evaluation, supervision, or participation
  (`ctclusi-research-regulation:c006`,
  `colville-chapter-6-6-research-regulation:c005`).
- Ongoing oversight and reporting can be required during the project
  (`siletz-research-ordinance:c008`), and collections access can require
  clearance through the governing council and the Tribal Historic Preservation
  Officer — Spokane Tribe of Indians (`archives-and-collections:c001`).

### 3.4 Redisclosure and confidentiality (`wiki/redisclosure-confidentiality.md`)

- Nondisclosure duties bind the data holder's own staff: Tribal employees must
  not provide file or record information to unauthorized researchers
  (`ctclusi-research-regulation:c009`); Grand Ronde prohibits providing
  records to unauthorized persons and knowing unauthorized possession or
  distribution (`grand-ronde-foi-ordinance:c007`, `:c008`, exemption
  categories at `:c004`).
- Secondary use is separately gated: Siletz work product may not be used for
  another purpose without express written Tribal Council consent
  (`siletz-research-ordinance:c012`).
- Site-location secrecy is explicit where cataloged: Nez Perce guides and
  outfitters must not lead clients to, or disclose, archaeological or
  sensitive cultural-resource site information
  (`nez-perce-revised-code-title-3:c011`).
- PII stripping with narrow exceptions appears in enacted Tribal law: the Nez
  Perce hemp code requires removal and shielding of names, addresses,
  identifiers, GPS coordinates, and contact details except for required USDA
  and law-enforcement disclosures (`nez-perce-revised-code-title-6:c021`;
  Title 6 is `enacted-amended-check-version`, currentness under human review
  per correction `ev-director-0083`).
- Public-file boundaries are record-by-record: the Yakama Water Code opens
  applications and permits to inspection while keeping investigative, draft,
  internal, and privileged files nonpublic (`yakama-water-code:c010`).
- Intertribal practice adds release mechanics: Tribe-specific data released
  only with the DSA-designated authorizing official's permission and only to
  Tribe-authorized recipients (`d2bl-001:c013`, `:c029`, `:c002`); small-count
  suppression with anti-reconstruction secondary suppression (`d2bl-001:c017`,
  `:c030`); "under no circumstances" release outside the Tribe without written
  permission (`d2bl-001:c028` — stated as should).
- Federal handling shows both the strongest protections and the honest
  boundary: USGS marks Tribal-designated sensitive data, exempts it from its
  data-release requirements, binds contractors, and requires express written
  Tribal permission before federal or non-federal sharing (`inst-018:c003`,
  `:c004`, `:c006`, `:c008`, `:c009`) — but FOIA exemption cannot be promised
  in advance and that limit must be explained before collection
  (`inst-018:c007`, `inst-017:c003`).

### 3.5 Publication approval (`wiki/publication-approval.md`)

- Requirements range from review-and-comment rights — CTCLUSI and Colville
  require an opportunity to review and comment with official Tribal comments
  included in the final product, expressly not restated as an unqualified veto
  (`ctclusi-research-regulation:c003`,
  `colville-chapter-6-6-research-regulation:c002`) — to written permission and
  harm-based prevention: Siletz minor projects may not be published without
  written Tribal permission (`siletz-research-ordinance:c005`), and the Tribe
  may prevent publication that is unauthorized, insensitive,
  misrepresentative, stereotyping, or harmful
  (`siletz-research-ordinance:c010`).
- The Nez Perce written agreement must address prepublication review, final
  authorization, and publication parameters
  (`nez-perce-2024-revised-research-permit-regulations-application:c017`).
- The NWIC IRB approves, requires modification of, or disapproves all proposed
  presentations, reports, and publications (`nwic-irb-policy-806:c008`).
- Template and notice variants exist and stay distinct: sponsor review 30 days
  pre-publication and presentation notice in the Coeur d'Alene application
  (`coeur-dalene-research-permit-application:c006`, `:c008` — template-only),
  recommended discussion of Tribal preapproval processes (`bl-032:c006` —
  non-binding), and Tribe-specific-inference approval in draft federal
  material (`inst-003:c016` — draft).

### 3.6 Benefit sharing and data return (`wiki/benefit-sharing-data-return.md`)

- Benefit mechanisms range from conditional permit fees for profit-linked
  projects (`ctclusi-research-regulation:c007`,
  `colville-chapter-6-6-research-regulation:c006`) and consultant-cost
  contributions (`siletz-research-ordinance:c006`) to Nez Perce local-resource
  use, Tribal-member first preference, and a stated royalty percentage on
  for-profit publication
  (`nez-perce-2024-revised-research-permit-regulations-application:c011`,
  `:c018`).
- Return duties range from furnishing every interim and final report without
  charge (`ctclusi-research-regulation:c008`,
  `colville-chapter-6-6-research-regulation:c007`,
  `nez-perce-2024-revised-research-permit-regulations-application:c006`) to
  full return of all information, data, raw materials, and specimens when
  approval is withdrawn (`siletz-research-ordinance:c011`).
- Retention, return, and destruction follow the governing agreement, with
  direct Tribal follow-up on destruction preference where no guidance exists
  (`d2bl-001:c011`); continuing opt-out and removal (`inst-002:c004`);
  co-authorship and acknowledgement practice (`d2bl-001:c022`); state-side fee
  waivers for Tribal recipients (`wac-246-455-990:c005`).

### 3.7 Enforcement and jurisdiction (`wiki/enforcement-jurisdiction.md`)

- Undertaking covered research can itself constitute consent to Tribal
  jurisdiction: Siletz deems researchers to have consented to Tribal Council
  legislative and Tribal Court adjudicatory jurisdiction
  (`siletz-research-ordinance:c001`).
- Remedies range from permit cancellation for deviation from the approved
  design (`ctclusi-research-regulation:c005`) and withdrawal with public
  corrective statement after a 30-day cure window
  (`nez-perce-2024-revised-research-permit-regulations-application:c009`) to
  Tribal Court injunctions, data preservation and return orders, bond
  forfeiture, restitution, and civil penalties
  (`siletz-research-ordinance:c013`); escalating fines and loss of access
  rights (`grand-ronde-foi-ordinance:c009`); and civil or criminal exposure
  including exclusion and trespass for unauthorized research
  (`ctclusi-research-regulation:c010`,
  `nez-perce-2024-revised-research-permit-regulations-application:c007`).
- Boundary honesty: the catalog supports no inference of any waiver of Tribal
  sovereign immunity, and EO 13175 expressly creates no judicially enforceable
  right (`r3-005:c011`).

### 3.8 IP and Traditional Knowledge protection (`wiki/ip-tk-protection.md`)

- Sensitive-site data is excluded from products when a Tribe identifies the
  site, subject to stated mandate exceptions, with post-distribution
  mitigation duties (`inst-018:c005`); interagency sharing of Tribe-owned data
  including Indigenous Knowledge requires express written Tribal permission
  (`inst-018:c008`).
- Nation-linked protections span retained sovereignty over cultural knowledge
  (`nez-perce-2024-revised-research-permit-regulations-application:c021`),
  archaeological-site nondisclosure (`nez-perce-revised-code-title-3:c011`),
  and permit-gated effects on cultural resources (`preservation-program:c001`
  — guidance restating federal and state law).
- The Klamath Tribes' agreement record identifies cultural-resource
  confidentiality as a matter to be addressed through consultation
  (`klamath-special-use-permit:c004` — status `unknown-needs-review`); this
  document adopts that principle at the policy level and carries no content
  from the instrument's exhibits.
- Cultural-stewardship protocols should be identified before collection where
  relevant (`inst-003:c008` — draft material).

## 4. RSTEP-specific plan

### 4.1 What RSTEP collects

RSTEP works with siting layers, not people:

- **Capacity layers** — renewable-resource and buildable-capacity surfaces
  (wind, solar, geothermal potential; slope, aspect).
- **No-go layers** — areas excluded from siting by the Nation's own
  determination, by law, or by physical constraint.
- **Contention layers** — zones where siting interest conflicts with other
  values and the Nation's process must decide.
- **Infrastructure and hazard layers** — transmission, roads, substations,
  flood, wildfire, and related public reference data.

RSTEP does not collect personal, enrollment, health, or household data.
**Cultural and subsistence site locations are never collected, stored, or
displayed by RSTEP — not as points, polygons, or derived buffers whose
geometry could be inverted.** This categorical product rule is adopted from
the corpus's archaeological-nondisclosure and sensitive-site precedents
(`nez-perce-revised-code-title-3:c011`, `inst-018:c002`, `inst-018:c005`) and
the consultation-based confidentiality principle in the Klamath record
(`klamath-special-use-permit:c004`, policy level only). If a Nation runs its
own cultural constraints against RSTEP outputs, that happens inside the
Nation's own systems; RSTEP receives at most the resulting no-go mask, never
the underlying sites, and a no-go polygon carries no reason code that would
reveal why an area is excluded.

### 4.2 Tier assignments under TSDF

RSTEP data rides on GeoBase and inherits TSDF tiers (TSDF v0.95; basis in
`guidelines/GEOBASE-ADHERENCE-MAP.md`). Default postures, always overridable
by the Nation:

- Public reference layers (federal/state hazard and infrastructure data):
  public handling as sourced; republication from RSTEP still follows the
  Nation's say.
- Capacity analyses over a Nation's lands: restricted by default; sharing
  requires the Nation's decision through a recorded consent ceremony (T2
  negotiated-sharing semantics).
- No-go and contention layers: sovereign-controlled, most restrictive default;
  no egress without an explicit, recorded, revocable grant. Contention zones
  are deliberation records of the Nation.

The adherence map's uniform finding applies: a tier is necessary but not
sufficient — 35 of 64 cataloged records are only partially mapped by tiers;
the remainder of each obligation lives in agreements, process, and product
behavior (sections 4.3 and 5).

### 4.3 Consent flows

- Collection: RSTEP ingests a Nation's layers only at the Nation's initiative
  — no ambient harvesting, and publicly posted Tribal data is not ingested on
  the strength of being public (`inst-002:c002` direction; charter §2).
- Secondary use: any use beyond the approved purpose — aggregation across
  Nations, regional roll-ups, publication of derived maps — requires a new,
  specific grant (`siletz-research-ordinance:c012`, `inst-003:c011`
  direction).
- Written and recorded: consent is a recorded, attributable event tied to the
  exact dataset version; verbal authorization is not authorization
  (`nez-perce-2024-revised-research-permit-regulations-application:c016`).
- Withdrawal: every grant is revocable; revocation triggers cessation of use
  and, where the Nation requires, return or destruction of copies
  (`siletz-research-ordinance:c011`, `d2bl-001:c011` direction).

### 4.4 Siting-data sensitivities

Site locations are the defining sensitivity of a siting tool. Beyond the
categorical cultural/subsistence exclusion in 4.1: proposed project locations
reveal a Nation's economic intentions and negotiating position; contention
zones reveal internal deliberation; no-go boundaries can leak protected-place
geometry by inversion. RSTEP therefore treats all Nation-specific siting
geometry as restricted by default, releases nothing at parcel or site
precision without an explicit grant, and applies aggregation or generalization
to any permitted regional product (small-cell suppression logic adapted from
`d2bl-001:c017`, `:c030`).

## 5. TSDF adherence summary (design inputs)

From `guidelines/GEOBASE-ADHERENCE-MAP.md` (outcome counts: in-tension 1,
not-represented 6, partially-mapped 35, needs-human-review 4, not-applicable
18):

- **In-tension (1):** BIA 78 IAM 2's statutory open-data-by-default rule
  (`inst-013:c012`) runs opposite to TSDF's restricted-by-default posture.
  Design input: the federal exchange boundary must be contractual and explicit
  — a federal partner's open-data default must never silently apply to
  Nation-controlled layers, and anything given to a federal agency is scoped
  knowing the recipient's default is release.
- **Not-represented obligations (6 records)** become product and process
  requirements, since no tier can encode them:
  - Role- and purpose-specific entitlements (Grand Ronde FOI model; Coeur
    d'Alene permit process): RSTEP access control must support per-role,
    per-purpose grants, not just tier gates.
  - Publication review: RSTEP outputs destined for publication carry a review
    obligation routed to the Nation before release (3.5 range).
  - Benefit terms (fees, royalties, local preference) and fee
    schedules/waivers (WAC 246-455-990): carried in the partnership agreement,
    not in software.
  - FOIA boundary: agreements with federal or state partners must document,
    before any transfer, that FOIA exemption cannot be promised
    (`inst-017:c003`, `inst-018:c007`).
  - Government-to-government process (RCW 43.376, EO 13175): a separate
    control plane. RSTEP engagement never substitutes for, or claims to
    satisfy, any agency's consultation duty (`r3-002:c001`, `r3-005:c004`);
    likewise a data grant to RSTEP is not consultation.

## 6. Engagement protocol for the outreach stage

Built on the custodian model from the corpus and research report: instruments
live with institutional custodians, and so does authority to speak to them.
All engagement is institution-to-institution.

1. **Address the office, never a person.** Contact goes to the institutional
   custodian for the instrument class: Tribal Council secretary or records
   office for codes and ordinances; legal counsel for agreements and
   jurisdiction; health board, research office, or Tribal IRB for research
   governance; THPO or archives for cultural-resource and collections matters
   (custodian pattern per `archives-and-collections:c001`, `wac-008:c001`,
   `archives-records-colville:c001`).
2. **Homework first.** Outreach opens with what this project found in the
   Nation's published instruments, presented as unconfirmed machine extraction
   for correction — never as a statement of the Nation's law. For
   searched-not-found Nations, outreach is gated on the per-Nation structured
   deep sweep (PLAN.md pre-DS-5 task).
3. **Follow the Nation's own process.** Where an instrument defines a research
   or data channel (permit application, request form, council presentation),
   RSTEP uses that channel and its timelines, including the Nation's right to
   decline for insufficient review time (`ctclusi-research-regulation:c006`,
   `colville-chapter-6-6-research-regulation:c005`).
4. **Bring the correction path.** Every outreach packet identifies the claim
   IDs attributed to that Nation, offers correction or deletion, and records
   the outcome in `guidelines/RATIFICATION-LEDGER.md` against exact claim IDs
   and content versions.
5. **No named individuals in any project artifact.** Contact records name
   offices and titles, not persons; personal contact details are never stored
   in this corpus or its outputs.

## 7. Open items

- **Searched-not-found Nations (13):** Cowlitz Indian Tribe, Hoh Indian Tribe,
  Jamestown S'Klallam Tribe, Lummi Nation, Makah Tribe, Nooksack Indian Tribe,
  Samish Indian Nation, Sauk-Suiattle Indian Tribe, Shoalwater Bay Indian
  Tribe, Squaxin Island Tribe, Stillaguamish Tribe of Indians, Cow Creek Band
  of Umpqua Tribe of Indians, and the Kootenai Tribe of Idaho — recorded with
  logged search evidence; a statement about this review's reach, never about
  those Nations' requirements. The structured per-Nation deep sweep (PLAN.md
  pre-DS-5 task) has not yet run; outreach to each of these Nations is blocked
  until its sweep is complete and event-logged.
- **Machine-extracted status:** all 359 claims remain `machine-extracted`;
  review upgrades to `human-reviewed` are deferred by owner decision
  (DECISIONS.md 2026-07-21) and remain a gate before any non-draft use of
  Nation-attributed claims.
- **Corrections applied:** `ev-director-0140` (Yakama Water Code c002 is
  may-permissive) and `ev-director-0083` (Nez Perce Revised Code Title 6 is
  enacted-amended-check-version, currentness under human review). Records
  flagged `needs-human-review` in the catalog are not cited here.
- **Klamath instrument status:** the Klamath special-use permit record remains
  `unknown-needs-review`; it is used here only for the policy-level
  consultation-confidentiality principle.

---

> **DRAFT — non-discovery ≠ absence.** Every claim above is machine-extracted
> from published documents; no claim is confirmed by any Tribal Nation.
> "Searched-not-found" means this review did not locate a qualifying published
> instrument — never that a Nation has no requirement. Instruments may be held
> by custodians or unpublished by sovereign choice. Public availability
> establishes availability, not consent. Non-draft use is gated on the
> ratification path: RSTEP Tribal Advisory Board review → direct outreach to
> every Nation attributed here → Tribal IRB review where present →
> ratification recorded in `guidelines/RATIFICATION-LEDGER.md`.
