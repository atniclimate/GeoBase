//! Offline **assertion-only** verifier for the T3 export ledger — the trusted
//! inspection path for harnesses (Phase A, A4; hardened per review B1).
//!
//! The ledger (`exports_dir/node-audit.gpkg`) is T3. This tool therefore
//! NEVER serializes ledger row *contents* to stdout/stderr (that would be a
//! T3 egress path into CI logs, review finding B1). It reads the ledger
//! through the product crate, checks it against expectations passed on the
//! command line, and emits ONLY an aggregate pass/fail plus counts —
//! `AUDIT-OK (<n> rows for '<product>')` or `AUDIT-FAIL: <why>` where `<why>`
//! never contains a row's `details`, `actor`, or other sovereign content.
//!
//! It reads the ledger through the product crate deliberately: it is the
//! right *place* for Phase B's at-rest decryption to live (a shipped node
//! opens its own T3 ledger), so when `GeoPackage` gains an encrypted-open
//! path this tool moves with it. It does NOT claim to decrypt anything today
//! — an encrypted ledger will require a cipher/key here, which is Phase B
//! work (see `docs/DECISIONS.md` 2026-07-16 DG-2 spike).
//!
//! ```text
//! cargo run -p geobase-engine-desktop --example verify-export-audit -- \
//!     <exports-dir> <product> \
//!     [--expect-action NAME]...        # exact, ordered, exhaustive for the product
//!     [--expect-actor ACTOR]           # every product row's actor must equal this
//!     [--expect-basis-contains S]      # export.ceremony rows must contain S in basis
//!     [--expect-basis S]               # export.ceremony rows' basis must EXACTLY equal S
//!     [--expect-process S]             # export.ceremony rows' process must EXACTLY equal S
//!     [--forbid-substring S]...        # NO row's serialized form may contain S
//! ```
//!
//! Exit 0 + `AUDIT-OK`; any mismatch → `AUDIT-FAIL: <why>` on stderr, exit 1.

use std::process::exit;

fn fail(why: &str) -> ! {
    // `why` is composed only from expectations and positions — never from row
    // contents — so this cannot leak T3 data.
    eprintln!("AUDIT-FAIL: {why}");
    exit(1);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(exports_dir), Some(product)) = (args.next(), args.next()) else {
        eprintln!(
            "usage: verify-export-audit <exports-dir> <product> \
             [--expect-action NAME]... [--expect-actor ACTOR] \
             [--expect-basis-contains S] [--forbid-substring S]..."
        );
        exit(2);
    };

    let mut expect_actions: Vec<String> = Vec::new();
    let mut expect_actor: Option<String> = None;
    let mut expect_basis_contains: Option<String> = None;
    let mut expect_basis: Option<String> = None;
    let mut expect_process: Option<String> = None;
    let mut forbid_substrings: Vec<String> = Vec::new();
    while let Some(flag) = args.next() {
        let mut value_for = |flag: &str| match args.next() {
            Some(value) => value,
            None => fail(&format!("{flag} requires a value")),
        };
        match flag.as_str() {
            "--expect-action" => expect_actions.push(value_for("--expect-action")),
            "--expect-actor" => expect_actor = Some(value_for("--expect-actor")),
            "--expect-basis-contains" => {
                expect_basis_contains = Some(value_for("--expect-basis-contains"));
            }
            // EXACT basis / process on the export.ceremony row (review B3
            // F9): the B8 bar asserts EXPECT_PROCESS and EXPECT_BASIS
            // independently, not a substring, and against the PERSISTED
            // row, not only the HTTP response.
            "--expect-basis" => expect_basis = Some(value_for("--expect-basis")),
            "--expect-process" => expect_process = Some(value_for("--expect-process")),
            "--forbid-substring" => forbid_substrings.push(value_for("--forbid-substring")),
            other => fail(&format!("unknown flag {other}")),
        }
    }

    let ledger_path = std::path::Path::new(&exports_dir).join("node-audit.gpkg");
    if !ledger_path.is_file() {
        fail(&format!("ledger not found: {}", ledger_path.display()));
    }
    let ledger = match geobase_gpkg::GeoPackage::open(&ledger_path) {
        Ok(ledger) => ledger,
        Err(err) => fail(&format!("ledger open failed: {err}")),
    };

    // The ledger itself must be T3-tagged — an untagged or downgraded ledger
    // is a finding regardless of what the rows say.
    match ledger.geopackage_tier() {
        Ok(Some(geobase_tsdf::Tier::T3)) => {}
        Ok(other) => fail(&format!("ledger tier is {other:?}, expected Some(T3)")),
        Err(err) => fail(&format!("ledger tier read failed: {err}")),
    }

    let trail = match ledger.audit_trail() {
        Ok(trail) => trail,
        Err(err) => fail(&format!("audit trail read failed: {err}")),
    };

    // Forbidden-substring check runs over the FULL serialized trail, but the
    // serialization is computed locally and never emitted — only a
    // position-indexed verdict is. (Used to prove a secret, e.g. the export
    // token, never landed in the trail.)
    let full_trail_json = match serde_json::to_string(&trail) {
        Ok(json) => json,
        Err(err) => fail(&format!("trail serialization failed: {err}")),
    };
    for (position, forbidden) in forbid_substrings.iter().enumerate() {
        if full_trail_json.contains(forbidden.as_str()) {
            fail(&format!(
                "forbidden substring #{position} appears in the audit trail"
            ));
        }
    }

    let product_rows: Vec<_> = trail
        .iter()
        .filter(|row| row.dataset_id == product)
        .collect();

    if !expect_actions.is_empty() {
        let got: Vec<&str> = product_rows.iter().map(|row| row.action.as_str()).collect();
        let want: Vec<&str> = expect_actions.iter().map(String::as_str).collect();
        if got != want {
            // Report shapes (counts/positions), not contents.
            fail(&format!(
                "product '{product}' has {} rows; action sequence did not match the \
                 expected {} actions (ordered, exhaustive)",
                got.len(),
                want.len()
            ));
        }
    }
    if let Some(actor) = &expect_actor {
        for (index, row) in product_rows.iter().enumerate() {
            if &row.actor != actor {
                fail(&format!(
                    "product row #{index} actor did not match the expected actor"
                ));
            }
        }
    }
    // Ceremony-row field checks (substring and/or exact).
    if expect_basis_contains.is_some() || expect_basis.is_some() || expect_process.is_some() {
        let ceremonies: Vec<_> = product_rows
            .iter()
            .filter(|row| row.action == "export.ceremony")
            .collect();
        if ceremonies.is_empty() {
            fail("no export.ceremony row to check basis/process against");
        }
        for (index, row) in ceremonies.iter().enumerate() {
            let basis = row.details["basis"].as_str().unwrap_or("");
            let process = row.details["process"].as_str().unwrap_or("");
            if let Some(needle) = &expect_basis_contains {
                if !basis.contains(needle.as_str()) {
                    fail(&format!(
                        "ceremony row #{index} basis did not contain the expected substring"
                    ));
                }
            }
            if let Some(exact) = &expect_basis {
                if basis != exact {
                    fail(&format!(
                        "ceremony row #{index} basis did not exactly match EXPECT_BASIS"
                    ));
                }
            }
            if let Some(exact) = &expect_process {
                if process != exact {
                    fail(&format!(
                        "ceremony row #{index} process did not exactly match EXPECT_PROCESS"
                    ));
                }
            }
        }
    }

    // Aggregate-only success line — a count, never row contents.
    println!("AUDIT-OK ({} rows for '{product}')", product_rows.len());
}
