//! Local operator consent tooling — B3 (`docs/CEREMONY-DESIGN.md` §3.3;
//! completed per review B3 F7).
//!
//! Consent lifecycle acts are **LocalOperator acts performed on the node**,
//! never network routes — this is the operator's (and the harness's) path
//! into the consent store. Subcommands:
//!
//! ```text
//! record-consent record   <exports-dir> <agreement-id> \
//!     --kind signed|witnessed \
//!     --source <pack-id>...            # source scope (>= 1)
//!     --authority "<name>"             # the real authority of record
//!     --product-class <class>          # default: painted-opportunity-shapefile
//!     [--expires <RFC3339 UTC>]        # optional enforced expiry
//!     [--supersedes <agreement-id>]... # predecessors this record supersedes
//!     # signed:    --document-ref <ref> --document-sha256 <64hex>
//!     #            --acknowledged-at <RFC3339 UTC>   (REQUIRED — the real
//!     #            instant the agreement was acknowledged, not "now")
//!     # witnessed: --witness "<name>"... --attestation "<who verified, how>"
//!
//! record-consent revoke    <exports-dir> <agreement-id>
//! record-consent supersede <exports-dir> <new-agreement-id> --supersedes <id>... [record flags]
//! record-consent correct   <exports-dir> <new-agreement-id> --supersedes <id>... [record flags]
//! ```
//!
//! `supersede`/`correct` are `record` with predecessors (correct sets the
//! corrected_by lineage marker). The store is a T3 artifact: creation goes
//! through the same fail-closed cipher posture as the node (set
//! `GEOBASE_DEV_UNENCRYPTED=1` for a dev store, permanently poison-stamped).

use std::process::exit;
use std::sync::Arc;

use geobase_engine_desktop::server;
use geobase_gpkg::cipher::{AtRestCipher, FailClosedCipher};
use geobase_gpkg::consent::{Conditions, ConsentBasis, Sha256Digest, UtcInstant, Witness};
use geobase_gpkg::consent_store::{AgreementKind, AgreementRecord, ConsentStore};

fn fail(why: &str) -> ! {
    eprintln!("CONSENT-FAIL: {why}");
    exit(1);
}

const DEFAULT_PRODUCT_CLASS: &str = "painted-opportunity-shapefile";

fn cipher() -> Arc<dyn AtRestCipher> {
    server::dev_unencrypted_cipher_if_opted_in().unwrap_or_else(|| Arc::new(FailClosedCipher))
}

fn tsdf_info() -> (String, String) {
    use geobase_tsdf::TsdfSource;
    let source = geobase_tsdf::VendoredSource::embedded();
    match source.load() {
        Ok(spec) => (spec.version, source.origin()),
        Err(err) => fail(&format!("tsdf source: {err}")),
    }
}

fn open_store(exports_dir: &str) -> ConsentStore {
    let (tsdf_version, tsdf_origin) = tsdf_info();
    match ConsentStore::open_or_create(
        std::path::Path::new(exports_dir),
        &tsdf_version,
        &tsdf_origin,
        cipher().as_ref(),
    ) {
        Ok(store) => store,
        Err(err) => fail(&err.to_string()),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let subcommand = args.next().unwrap_or_default();
    match subcommand.as_str() {
        "record" => cmd_record(args.collect(), false, false),
        // The verb names a lifecycle act: supersede/correct MUST name at
        // least one predecessor (review B3 N2) — a supersession of nothing
        // silently recording a new root would misdescribe the operator's
        // own act.
        "supersede" => cmd_record(args.collect(), false, true),
        "correct" => cmd_record(args.collect(), true, true),
        "revoke" => cmd_revoke(args.collect()),
        other => {
            eprintln!(
                "usage: record-consent <record|supersede|correct|revoke> <exports-dir> ... \
                 (got subcommand '{other}')"
            );
            exit(2);
        }
    }
}

fn cmd_revoke(args: Vec<String>) {
    let mut args = args.into_iter();
    let (Some(exports_dir), Some(agreement_id)) = (args.next(), args.next()) else {
        fail("revoke: usage: record-consent revoke <exports-dir> <agreement-id>");
    };
    let store = open_store(&exports_dir);
    match store.revoke(&agreement_id, &server::interim_operator_identity()) {
        Ok(seq) => println!("CONSENT-OK ('{agreement_id}' revoked at store sequence {seq})"),
        Err(err) => fail(&err.to_string()),
    }
}

fn cmd_record(args: Vec<String>, correction: bool, require_predecessors: bool) {
    let mut args = args.into_iter();
    let (Some(exports_dir), Some(agreement_id)) = (args.next(), args.next()) else {
        fail("record: usage: record-consent <record|supersede|correct> <exports-dir> <agreement-id> ...");
    };

    let mut kind = "signed".to_string();
    let mut sources: Vec<String> = Vec::new();
    let mut authority: Option<String> = None;
    let mut product_class = DEFAULT_PRODUCT_CLASS.to_string();
    let mut expires: Option<String> = None;
    let mut supersedes: Vec<String> = Vec::new();
    let mut document_ref: Option<String> = None;
    let mut document_sha256: Option<String> = None;
    let mut acknowledged_at: Option<String> = None;
    let mut witnesses: Vec<String> = Vec::new();
    let mut attestation: Option<String> = None;
    while let Some(flag) = args.next() {
        let mut value_for = |flag: &str| {
            args.next()
                .unwrap_or_else(|| fail(&format!("{flag} requires a value")))
        };
        match flag.as_str() {
            "--kind" => kind = value_for("--kind"),
            "--source" => sources.push(value_for("--source")),
            "--authority" => authority = Some(value_for("--authority")),
            "--product-class" => product_class = value_for("--product-class"),
            "--expires" => expires = Some(value_for("--expires")),
            "--supersedes" => supersedes.push(value_for("--supersedes")),
            "--document-ref" => document_ref = Some(value_for("--document-ref")),
            "--document-sha256" => document_sha256 = Some(value_for("--document-sha256")),
            "--acknowledged-at" => acknowledged_at = Some(value_for("--acknowledged-at")),
            "--witness" => witnesses.push(value_for("--witness")),
            "--attestation" => attestation = Some(value_for("--attestation")),
            other => fail(&format!("unknown flag {other}")),
        }
    }
    let Some(authority) = authority else {
        fail("--authority is required (the agreement names the real authority, never the requester echo)");
    };
    if require_predecessors && supersedes.is_empty() {
        fail(
            "supersede/correct require at least one --supersedes <agreement-id> — \
             the verb names a lifecycle act against an existing record; to record \
             a new root agreement use 'record'",
        );
    }

    let now = match UtcInstant::now() {
        Ok(now) => now,
        Err(err) => fail(&format!("node clock: {err}")),
    };
    let (agreement_kind, evidence) = match kind.as_str() {
        "signed" => {
            let (Some(document_ref), Some(document_sha256), Some(acknowledged)) =
                (document_ref, document_sha256, acknowledged_at)
            else {
                fail("signed: --document-ref, --document-sha256, and --acknowledged-at are all required \
                      (the acknowledgment instant is normative evidence — never defaulted to now)");
            };
            let digest =
                Sha256Digest::from_hex(&document_sha256).unwrap_or_else(|e| fail(&e.to_string()));
            let acknowledged_at =
                UtcInstant::parse_rfc3339(&acknowledged).unwrap_or_else(|e| fail(&e.to_string()));
            let evidence =
                ConsentBasis::signed_agreement(&document_ref, digest, acknowledged_at, now)
                    .unwrap_or_else(|e| fail(&e.to_string()));
            (AgreementKind::TribalSigned, evidence)
        }
        "witnessed" => {
            if witnesses.is_empty() {
                fail("witnessed: at least one --witness is required");
            }
            let Some(attestation) = attestation else {
                fail("witnessed: --attestation is required (who verified the witnesses, and how)");
            };
            let typed = witnesses
                .iter()
                .map(|w| Witness::new(w))
                .collect::<Result<Vec<_>, _>>()
                .unwrap_or_else(|e| fail(&e.to_string()));
            let evidence = ConsentBasis::witnessed_verbal(typed, &attestation)
                .unwrap_or_else(|e| fail(&e.to_string()));
            (AgreementKind::IndividualWitnessed, evidence)
        }
        other => fail(&format!(
            "--kind must be 'signed' or 'witnessed' (got '{other}')"
        )),
    };
    let expires_at = match expires
        .as_deref()
        .map(UtcInstant::parse_rfc3339)
        .transpose()
    {
        Ok(expires_at) => expires_at,
        Err(err) => fail(&err.to_string()),
    };

    let store = open_store(&exports_dir);
    let record = AgreementRecord {
        agreement_id: agreement_id.clone(),
        kind: agreement_kind,
        source_scope: sources,
        product_class,
        evidence,
        authority_of_record: authority,
        requester_binding: server::interim_operator_identity(),
        conditions: Conditions {
            expires_at,
            purpose_limit: None,
            geography_limit: None,
        },
        recorded_by: server::interim_operator_identity(),
    };
    let predecessors: Vec<&str> = supersedes.iter().map(String::as_str).collect();
    match store.record_agreement(&record, &predecessors, correction) {
        Ok(sequence) => {
            println!("CONSENT-OK ('{agreement_id}' recorded at store sequence {sequence})");
        }
        Err(err) => fail(&err.to_string()),
    }
}
