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

use geobase_engine_desktop::server::{
    dev_unencrypted_cipher_if_opted_in, generate_export_token, serve, ServerConfig,
};
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
    // Export capability is opted into deliberately (GEOBASE_EXPORTS), never
    // default-on.
    let exports_dir = env_path("GEOBASE_EXPORTS");
    // Interim operator guard (Phase A, A1): exports require a token. It is
    // injected into the webview (below), so it must stay inside the safe
    // injection alphabet — validate rather than silently filter, or the
    // server and the app would hold different tokens.
    let export_token = exports_dir.as_ref().map(|_| {
        let token = match std::env::var("GEOBASE_EXPORT_TOKEN") {
            Ok(token) if !token.trim().is_empty() => token,
            _ => match generate_export_token() {
                Ok(token) => {
                    eprintln!(
                        "[geobase-desktop] generated a boot export token (set \
                         GEOBASE_EXPORT_TOKEN to fix one across restarts)"
                    );
                    token
                }
                Err(err) => {
                    eprintln!("[geobase-desktop] no OS randomness for the export token: {err}");
                    std::process::exit(1);
                }
            },
        };
        if !token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            eprintln!(
                "[geobase-desktop] GEOBASE_EXPORT_TOKEN may only contain \
                 [A-Za-z0-9._-] (it is injected into the webview)"
            );
            std::process::exit(1);
        }
        token
    });
    // Fail-closed by default: a production desktop run refuses to write the
    // T3 export ledger in plaintext. Dev-plaintext is an EXPLICIT opt-in via
    // GEOBASE_DEV_UNENCRYPTED (stamped UNENCRYPTED-DEV, loudly warned) — never
    // the default for the shipped binary.
    let at_rest = dev_unencrypted_cipher_if_opted_in(); // fail-closed unless opted in
    let webview_token = export_token.clone();
    let handle = match runtime.block_on(serve(
        Arc::new(node),
        ServerConfig {
            port: 0,
            tiles_dir,
            exports_dir,
            at_rest,
            export_token,
        },
    )) {
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
            if let Some(token) = &webview_token {
                // Charset validated at boot — cannot escape the script.
                inject.push_str(&format!("window.__GEOBASE_EXPORT_TOKEN__ = '{token}';"));
            }
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
