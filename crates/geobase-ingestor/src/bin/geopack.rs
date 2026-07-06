//! `geopack` — CLI for the GeoBase ingestor (Phase 0.3 MVP).
//!
//! ```text
//! geopack ingest --tif <dem.tif> --shp <layer.shp> --out <pack.gpkg>
//!                [--tier T0|T1|T2|T3] [--dataset-id <id>] [--actor <name>]
//!                [--declare-crs <epsg> --declare-crs-reason "<why>"]
//!                [--basis "<classification basis>"] [--force]
//! geopack package --manifest <pkg.toml> --out <pack.gpkg>
//!                  [--actor <name>] [--force]
//! ```
//!
//! Unclassified ingests default to **T3** — the TSDF posture, not a CLI
//! convenience. Argument parsing is deliberately dependency-free.

use std::path::PathBuf;
use std::process::ExitCode;

use geobase_ingestor::{
    ingest,
    package::{package, PackageRequest},
    IngestRequest,
};
use geobase_tsdf::Tier;

fn usage() -> &'static str {
    "usage: geopack ingest --tif <dem.tif> --shp <layer.shp> --out <pack.gpkg>\n\
     \x20                  [--tier T0|T1|T2|T3] [--dataset-id <id>] [--actor <name>]\n\
     \x20                  [--declare-crs <epsg> --declare-crs-reason \"<why>\"]\n\
     \x20                  [--basis \"<classification basis>\"] [--force]\n\
     \x20  geopack package --manifest <pkg.toml> --out <pack.gpkg>\n\
     \x20                  [--actor <name>] [--force]"
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("ingest") => ingest_command(&args[1..]),
        Some("package") => package_command(&args[1..]),
        _ => {
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
    }
}

fn ingest_command(args: &[String]) -> ExitCode {
    let mut tif: Option<PathBuf> = None;
    let mut shp: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut tier: Option<Tier> = None;
    let mut dataset_id: Option<String> = None;
    let mut actor: Option<String> = None;
    let mut declare_crs: Option<u32> = None;
    let mut declare_crs_reason: Option<String> = None;
    let mut basis: Option<String> = None;
    let mut force = false;

    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        let result: Result<(), String> = match flag.as_str() {
            "--tif" => value("--tif").map(|v| tif = Some(v.into())),
            "--shp" => value("--shp").map(|v| shp = Some(v.into())),
            "--out" => value("--out").map(|v| out = Some(v.into())),
            "--tier" => value("--tier").and_then(|v| {
                Tier::from_code(&v)
                    .map(|t| tier = Some(t))
                    .ok_or_else(|| format!("unknown tier '{v}' (T0|T1|T2|T3)"))
            }),
            "--dataset-id" => value("--dataset-id").map(|v| dataset_id = Some(v)),
            "--actor" => value("--actor").map(|v| actor = Some(v)),
            "--declare-crs" => value("--declare-crs").and_then(|v| {
                v.trim_start_matches("EPSG:")
                    .parse::<u32>()
                    .map(|e| declare_crs = Some(e))
                    .map_err(|_| format!("--declare-crs expects an EPSG code, got '{v}'"))
            }),
            "--declare-crs-reason" => {
                value("--declare-crs-reason").map(|v| declare_crs_reason = Some(v))
            }
            "--basis" => value("--basis").map(|v| basis = Some(v)),
            "--force" => {
                force = true;
                Ok(())
            }
            other => Err(format!("unknown flag '{other}'")),
        };
        if let Err(msg) = result {
            eprintln!("geopack: {msg}\n{}", usage());
            return ExitCode::from(2);
        }
    }

    let (Some(geotiff), Some(shapefile), Some(out)) = (tif, shp, out) else {
        eprintln!("geopack: --tif, --shp, and --out are required\n{}", usage());
        return ExitCode::from(2);
    };
    let dataset_id = dataset_id.unwrap_or_else(|| {
        out.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "geopack".into())
    });

    let req = IngestRequest {
        geotiff,
        shapefile,
        out,
        dataset_id,
        tier,
        declared_epsg: declare_crs,
        declared_crs_reason: declare_crs_reason,
        actor: actor.unwrap_or_else(|| "geopack-cli".into()),
        classification_basis: basis,
        overwrite: force,
    };

    match ingest(&req) {
        Ok(result) => {
            println!(
                "[geopack] {}: tier {} (TSDF {}), raster '{}' ({} tiles), vector '{}' ({} features)",
                result.geopack.display(),
                result.tier.code(),
                result.tsdf_version,
                result.raster_table,
                result.tiles_written,
                result.vector_table,
                result.features_written,
            );
            println!("[geopack] verified: tags + audit present and correct");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("geopack: ingest failed: {err}");
            ExitCode::FAILURE
        }
    }
}

fn package_command(args: &[String]) -> ExitCode {
    let mut manifest: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut actor: Option<String> = None;
    let mut force = false;

    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = |name: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        let result: Result<(), String> = match flag.as_str() {
            "--manifest" => value("--manifest").map(|v| manifest = Some(v.into())),
            "--out" => value("--out").map(|v| out = Some(v.into())),
            "--actor" => value("--actor").map(|v| actor = Some(v)),
            "--force" => {
                force = true;
                Ok(())
            }
            other => Err(format!("unknown flag '{other}'")),
        };
        if let Err(msg) = result {
            eprintln!("geopack: {msg}\n{}", usage());
            return ExitCode::from(2);
        }
    }

    let (Some(manifest), Some(out)) = (manifest, out) else {
        eprintln!("geopack: --manifest and --out are required\n{}", usage());
        return ExitCode::from(2);
    };

    let req = PackageRequest {
        manifest,
        out,
        actor: actor.unwrap_or_else(|| "geopack-cli".into()),
        overwrite: force,
    };

    match package(&req) {
        Ok(result) => {
            println!(
                "[geopack] package '{}' ({})",
                result.package_id, result.package_name
            );
            println!(
                "[geopack] tier {} (TSDF {})",
                result.tier.code(),
                result.tsdf_version
            );
            for table in result.raster_tables {
                println!(
                    "[geopack] raster '{}' ({} tiles)",
                    table.table, table.tiles_written
                );
            }
            for table in result.vector_tables {
                println!(
                    "[geopack] vector '{}' ({} features)",
                    table.table, table.features_written
                );
            }
            println!("[geopack] verified: tags + audit present and correct");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("geopack: package failed: {err}");
            ExitCode::FAILURE
        }
    }
}
