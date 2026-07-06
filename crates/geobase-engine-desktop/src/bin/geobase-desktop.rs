//! `geobase-desktop` — the Phase 1.0 Desktop Engine shell.
//!
//! Boots a grounded [`Node`], starts the localhost-only server, and opens
//! a Tauri window onto the embedded Light Engine (one rendering stack),
//! pointed at this node via an injected `__GEOBASE_NODE__` — the observed
//! Phase 1.0 gate: *desktop app opens a grounded node and serves the T0
//! baseline to its embedded MapLibre*.
//!
//! Paths (env-overridable, dev-friendly defaults):
//! - `GEOBASE_PLACE`  — grounding; default `place.toml`, falling back to
//!   `place.example.toml` with a loud warning (dev only — a real node is
//!   grounded deliberately).
//! - `GEOBASE_VAULT`  — GeoPack vault dir; default `data/vault`.
//! - `GEOBASE_TILES`  — pre-derived T0 pyramid; default
//!   `engine-light/public/tiles/terrain` when present.
//! - `GEOBASE_LAYERS` — optional boot view state (Phase 1.1): comma-joined
//!   layer keys surfaced to the app as the `?layers=` URL param before it
//!   boots (URL-as-state, desktop form — the panel's grammar validation
//!   still applies; unknown keys are loudly dropped by the app).
//!
//! Build: `pnpm --filter @geobase/engine-light run build:desktop`, then
//! `cargo run -p geobase-engine-desktop --features shell --bin geobase-desktop`.

#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use geobase_engine_desktop::server::{serve, ServerConfig};
use geobase_engine_desktop::Node;

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

fn main() {
    let place = env_path("GEOBASE_PLACE").unwrap_or_else(|| PathBuf::from("place.toml"));
    let place = if place.is_file() {
        place
    } else {
        eprintln!(
            "[geobase-desktop] {} not found — falling back to place.example.toml \
             (dev only; a real node is grounded deliberately)",
            place.display()
        );
        PathBuf::from("place.example.toml")
    };
    let vault = env_path("GEOBASE_VAULT").unwrap_or_else(|| PathBuf::from("data/vault"));
    let tiles_dir = env_path("GEOBASE_TILES").or_else(|| {
        let dev_default = PathBuf::from("engine-light/public/tiles/terrain");
        dev_default.is_dir().then_some(dev_default)
    });

    let node = match Node::boot(&place, &vault) {
        Ok(node) => node,
        Err(err) => {
            eprintln!("[geobase-desktop] node failed to boot: {err}");
            std::process::exit(1);
        }
    };
    let territory = node.grounding.territory.clone();
    println!(
        "[geobase-desktop] grounded: {} ({territory}) — {} pack(s), TSDF {} via {}",
        node.grounding.node_id,
        node.catalog.len(),
        node.tsdf_version,
        node.tsdf_origin,
    );

    // The server lives on its own runtime; both stay alive for the whole
    // app lifetime (dropping the handle would trigger graceful shutdown).
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let handle = match runtime.block_on(serve(Arc::new(node), ServerConfig { port: 0, tiles_dir }))
    {
        Ok(handle) => handle,
        Err(err) => {
            eprintln!("[geobase-desktop] server failed to start: {err}");
            std::process::exit(1);
        }
    };
    let addr = handle.addr;
    println!("[geobase-desktop] node server on http://{addr}");

    // Boot view state: injected only through the layer-key alphabet so the
    // init script cannot be escaped by env content.
    let layers: String = std::env::var("GEOBASE_LAYERS")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ',' | '-' | '_'))
        .collect();

    tauri::Builder::default()
        .setup(move |app| {
            let mut inject = format!("window.__GEOBASE_NODE__ = 'http://{addr}';");
            if !layers.is_empty() {
                inject.push_str(&format!(
                    "if (!new URLSearchParams(location.search).has('layers')) {{\
                       const u = new URL(location.href);\
                       u.searchParams.set('layers', '{layers}');\
                       history.replaceState(null, '', u);\
                     }}"
                ));
            }
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title(format!("GeoBase — {territory}"))
            .inner_size(1280.0, 800.0)
            .initialization_script(&inject)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri shell failed to run");

    // Unreachable in practice (run() exits the process), but keep the
    // server handle formally alive to this point.
    drop(handle);
    drop(runtime);
}
