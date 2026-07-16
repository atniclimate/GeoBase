//! Local operator consent recording — B3 (`docs/CEREMONY-DESIGN.md` §3.3).
//!
//! Recording consent is a **LocalOperator act performed on the node**,
//! never a network route — this example is the operator's path (and the
//! harness's) into the consent store. It records ONE agreement,
//! evidence-complete, active immediately.
//!
//! ```text
//! cargo run -p geobase-engine-desktop --example record-consent -- \
//!     <exports-dir> <agreement-id> \
//!     --source <pack-id>...            # source scope (>= 1)
//!     --authority "<name>"             # the real authority of record
//!     --document-ref <ref>             # evidence: agreement reference
//!     --document-sha256 <64 hex>       # evidence: agreement hash
//!     [--expires <RFC3339 UTC>]        # optional enforced expiry
//! ```
//!
//! The agreement binds the interim A1 operator identity as requester
//! (B5 replaces this with the enrolled OS-keychain credential). The store
//! is a T3 artifact: creation goes through the same fail-closed cipher
//! posture as the node (set `GEOBASE_DEV_UNENCRYPTED=1` for a dev store,
//! permanently poison-stamped).

use std::process::exit;

use geobase_engine_desktop::server;
use geobase_gpkg::consent::{Conditions, ConsentBasis, Sha256Digest, UtcInstant};
use geobase_gpkg::consent_store::{AgreementKind, AgreementRecord, ConsentStore};

fn fail(why: &str) -> ! {
    eprintln!("CONSENT-FAIL: {why}");
    exit(1);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(exports_dir), Some(agreement_id)) = (args.next(), args.next()) else {
        eprintln!(
            "usage: record-consent <exports-dir> <agreement-id> --source <pack>... \
             --authority <name> --document-ref <ref> --document-sha256 <hex> \
             [--expires <rfc3339>]"
        );
        exit(2);
    };

    let mut sources: Vec<String> = Vec::new();
    let mut authority: Option<String> = None;
    let mut document_ref: Option<String> = None;
    let mut document_sha256: Option<String> = None;
    let mut expires: Option<String> = None;
    while let Some(flag) = args.next() {
        let mut value_for = |flag: &str| match args.next() {
            Some(value) => value,
            None => fail(&format!("{flag} requires a value")),
        };
        match flag.as_str() {
            "--source" => sources.push(value_for("--source")),
            "--authority" => authority = Some(value_for("--authority")),
            "--document-ref" => document_ref = Some(value_for("--document-ref")),
            "--document-sha256" => document_sha256 = Some(value_for("--document-sha256")),
            "--expires" => expires = Some(value_for("--expires")),
            other => fail(&format!("unknown flag {other}")),
        }
    }
    let Some(authority) = authority else {
        fail("--authority is required (the agreement names the real authority, never the requester echo)");
    };
    let (Some(document_ref), Some(document_sha256)) = (document_ref, document_sha256) else {
        fail("--document-ref and --document-sha256 are required (evidence-thin agreements are unconstructible)");
    };

    let cipher = server::dev_unencrypted_cipher_if_opted_in()
        .unwrap_or_else(|| std::sync::Arc::new(geobase_gpkg::cipher::FailClosedCipher));

    let now = match UtcInstant::now() {
        Ok(now) => now,
        Err(err) => fail(&format!("node clock: {err}")),
    };
    let digest = match Sha256Digest::from_hex(&document_sha256) {
        Ok(digest) => digest,
        Err(err) => fail(&err.to_string()),
    };
    let evidence = match ConsentBasis::signed_agreement(&document_ref, digest, now, now) {
        Ok(evidence) => evidence,
        Err(err) => fail(&err.to_string()),
    };
    let expires_at = match expires.as_deref().map(UtcInstant::parse_rfc3339).transpose() {
        Ok(expires_at) => expires_at,
        Err(err) => fail(&err.to_string()),
    };

    let (tsdf_version, tsdf_origin) = {
        use geobase_tsdf::TsdfSource;
        let source = geobase_tsdf::VendoredSource::embedded();
        match source.load() {
            Ok(spec) => (spec.version, source.origin()),
            Err(err) => fail(&format!("tsdf source: {err}")),
        }
    };

    let store = match ConsentStore::open_or_create(
        std::path::Path::new(&exports_dir),
        &tsdf_version,
        &tsdf_origin,
        cipher.as_ref(),
    ) {
        Ok(store) => store,
        Err(err) => fail(&err.to_string()),
    };
    let record = AgreementRecord {
        agreement_id: agreement_id.clone(),
        kind: AgreementKind::TribalSigned,
        source_scope: sources,
        product_class: "painted-opportunity-shapefile".into(),
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
    match store.record_agreement(&record, None, false) {
        Ok(sequence) => {
            println!("CONSENT-OK ('{agreement_id}' recorded at store sequence {sequence})");
        }
        Err(err) => fail(&err.to_string()),
    }
}
