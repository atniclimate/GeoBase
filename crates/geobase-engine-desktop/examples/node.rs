//! Run a grounded GeoBase node with its local server — the wave-1 smoke
//! harness and the core the wave-2 Tauri shell wraps.
//!
//! ```text
//! cargo run -p geobase-engine-desktop --example node -- \
//!     <place.toml> <vault-dir> [tiles-dir] [port] [exports-dir]
//! ```
//!
//! Prints `NODE-READY <addr>` once serving; Ctrl-C to stop.

use std::path::PathBuf;
use std::sync::Arc;

use geobase_engine_desktop::server::{dev_unencrypted_cipher_if_opted_in, serve, ServerConfig};
use geobase_engine_desktop::Node;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(place), Some(vault)) = (args.next(), args.next()) else {
        eprintln!("usage: node <place.toml> <vault-dir> [tiles-dir] [port] [exports-dir]");
        std::process::exit(2);
    };
    let tiles_dir = args.next().map(PathBuf::from);
    let port: u16 = args.next().map(|p| p.parse()).transpose()?.unwrap_or(0);
    let exports_dir = args.next().map(PathBuf::from);
    // Interim operator guard (Phase A, A1): exports REQUIRE an operator
    // token via GEOBASE_EXPORT_TOKEN. Deliberately no auto-generate here: a
    // generated token would have to be printed, and tokens never go to
    // stdout (logs capture stdout). Harnesses set the env var themselves.
    let export_token = match &exports_dir {
        Some(_) => match std::env::var("GEOBASE_EXPORT_TOKEN") {
            Ok(token) if !token.trim().is_empty() => Some(token),
            _ => {
                eprintln!(
                    "exports enabled but GEOBASE_EXPORT_TOKEN is not set — \
                     set it (interim operator guard, Phase A A1)"
                );
                std::process::exit(2);
            }
        },
        None => None,
    };

    let node = Node::boot(
        PathBuf::from(place).as_path(),
        PathBuf::from(vault).as_path(),
    )?;
    println!(
        "[node] grounded: {} ({}) — {} pack(s), TSDF {} via {}",
        node.grounding.node_id,
        node.grounding.territory,
        node.catalog.len(),
        node.tsdf_version,
        node.tsdf_origin,
    );
    let handle = serve(
        Arc::new(node),
        ServerConfig {
            port,
            tiles_dir,
            exports_dir,
            // Fail-closed by default; dev-plaintext only via an explicit
            // GEOBASE_DEV_UNENCRYPTED opt-in (loudly warned). Even this
            // local harness never silently defaults to plaintext T3.
            at_rest: dev_unencrypted_cipher_if_opted_in(),
            export_token,
        },
    )
    .await?;
    println!("NODE-READY http://{}", handle.addr);

    tokio::signal::ctrl_c().await?;
    handle.stop().await;
    println!("[node] stopped");
    Ok(())
}
