//! Run a grounded GeoBase node with its local server — the wave-1 smoke
//! harness and the core the wave-2 Tauri shell wraps.
//!
//! ```text
//! cargo run -p geobase-engine-desktop --example node -- \
//!     <place.toml> <vault-dir> [tiles-dir] [port]
//! ```
//!
//! Prints `NODE-READY <addr>` once serving; Ctrl-C to stop.

use std::path::PathBuf;
use std::sync::Arc;

use geobase_engine_desktop::server::{serve, ServerConfig};
use geobase_engine_desktop::Node;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(place), Some(vault)) = (args.next(), args.next()) else {
        eprintln!("usage: node <place.toml> <vault-dir> [tiles-dir] [port]");
        std::process::exit(2);
    };
    let tiles_dir = args.next().map(PathBuf::from);
    let port: u16 = args.next().map(|p| p.parse()).transpose()?.unwrap_or(0);

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
    let handle = serve(Arc::new(node), ServerConfig { port, tiles_dir }).await?;
    println!("NODE-READY http://{}", handle.addr);

    tokio::signal::ctrl_c().await?;
    handle.stop().await;
    println!("[node] stopped");
    Ok(())
}
