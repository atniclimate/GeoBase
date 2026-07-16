//! The node's local `axum` server — tiles + data for the embedded MapLibre.
//!
//! ## Egress stance (Phase 1.0, load-bearing)
//!
//! - Binds **127.0.0.1 only**, hard-coded. There is deliberately no config
//!   to widen the bind: nothing this server does can leave the machine.
//!   (Federation is Phase 2.0 and T0-only by design.)
//! - The features endpoint serves **T0 and T1 packs only**. T2/T3 return
//!   `403` with a body naming the pack tier and the missing mechanism
//!   ("requires the Phase 1.2 permissions ceremony") — mechanism before
//!   access, even on localhost.
//! - Tile serving is the **pre-derived T0 pyramid** (built by
//!   `scripts/generate_terrain_tiles.py`, which itself refuses non-T0
//!   sources) served statically from `tiles_dir`.
//!
//! ## Routes
//!
//! - `GET /api/node` → `{ node_id, territory, home_crs, bbox, tsdf_origin,
//!   pack_count }`
//! - `GET /api/packs` → catalog as JSON (id, tier code, tagged,
//!   tsdf_version, tables)
//! - `GET /api/packs/{id}/layers` → vector layer metadata for feature
//!   tables only, in catalog order. Raster coverage tables are excluded
//!   from Phase 1.1 layer overlays. Bounds are read from `gpkg_contents`
//!   in the layer's native CRS; `color_seed` is the big-endian first four
//!   bytes of `SHA-256("{pack_id}/{table}")`.
//! - `GET /api/packs/{id}/tables/{table}/features` → RFC 7946
//!   FeatureCollection (geometry via `geozero` GPKG-WKB → GeoJSON;
//!   attributes as properties; `id` from the feature rowid). 404 unknown
//!   pack/table; 403 tier-refused; 400 non-feature table.
//! - `POST /api/export` → the first mutating endpoint (Phase 1.3b):
//!   painted polygons in, T2-stamped shapefile product out, through the
//!   CeremonyGate seam and the zero-source-disclosure verifier. Full
//!   contract in the `export` module docs. 503 without an exports dir.
//! - `GET /tiles/terrain/…` → static files from `tiles_dir`
//!   (`tower-http` ServeDir); 404 when `tiles_dir` is `None`.
//!
//! Responses carry `x-geobase-tier` (pack tier) where a pack is involved,
//! and `cache-control: no-store` (sovereignty posture: the viewer renders,
//! it does not hoard).

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use geobase_gpkg::cipher::{AtRestCipher, DevPlaintextCipher, FailClosedCipher};
use geobase_gpkg::consent::ExportIdentity;
use geobase_gpkg::consent_gate::RecordedConsentGate;
use geobase_gpkg::GeoPackage;
use geobase_tsdf::Tier;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

use crate::session::{SessionRegistry, SESSION_HEADER};
use crate::Node;

/// Header carrying the interim operator export token (Phase A, A1).
pub const EXPORT_TOKEN_HEADER: &str = "x-geobase-export-token";

/// Server configuration. `port: 0` binds an ephemeral port (tests).
///
/// `Debug` is hand-written to REDACT `export_token`: the token is a secret
/// (interim operator credential), and a derived `Debug` would print it into
/// any diagnostic log that formats the config (review advisory).
#[derive(Clone, Default)]
pub struct ServerConfig {
    pub port: u16,
    /// Pre-derived T0 tile pyramid directory (optional until wave 2 wiring).
    pub tiles_dir: Option<PathBuf>,
    /// Where exported products (and the export ledger) land. `None`
    /// refuses `POST /api/export` with 503 — exporting is opted into
    /// deliberately, never a default-on capability.
    pub exports_dir: Option<PathBuf>,
    /// At-rest encryption seam for T3 artifacts (the export ledger). `None`
    /// defaults to [`FailClosedCipher`]: a node with no configured cipher
    /// refuses to write the T3 ledger at all (fail-closed — no plaintext
    /// sovereign data). Local dev/demo nodes opt into `DevPlaintextCipher`.
    pub at_rest: Option<Arc<dyn AtRestCipher>>,
    /// **Interim operator export guard (Phase A, microtask A1 —
    /// `PLAN_1.0.md`).** When `exports_dir` is set, `POST /api/export`
    /// requires this operator-held token in the [`EXPORT_TOKEN_HEADER`]
    /// header *before* the ceremony seam runs; a missing or wrong token is
    /// refused 403 with an `export.refused` audit row. Exports enabled with
    /// **no** (or an empty/whitespace) token configured fail closed (503 — a
    /// misconfiguration, not an authorization outcome). Provisional by
    /// design: real requester authentication (per-app identity, Phase B item
    /// B5) replaces this guard; it exists to close the
    /// unauthenticated-localhost-export dev hole documented in `PLAN_1.0.md`
    /// § Current Position.
    pub export_token: Option<String>,
}

impl std::fmt::Debug for ServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerConfig")
            .field("port", &self.port)
            .field("tiles_dir", &self.tiles_dir)
            .field("exports_dir", &self.exports_dir)
            .field("at_rest", &self.at_rest)
            // Never print the secret — only whether one is set.
            .field(
                "export_token",
                &self.export_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// A running server: bound address plus graceful shutdown.
pub struct ServerHandle {
    pub addr: SocketAddr,
    shutdown: tokio::sync::oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    /// Signal shutdown and wait for the listener task to finish.
    pub async fn stop(self) {
        let _ = self.shutdown.send(());
        let _ = self.join.await;
    }
}

/// Errors from server startup.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("bind failed on 127.0.0.1:{port}: {source}")]
    Bind { port: u16, source: std::io::Error },
    /// Startup publication recovery failed (design §6 step 6) — the node
    /// must not serve with unresolved in-flight publications.
    #[error("publication recovery failed: {detail} — refusing to serve with unresolved in-flight publications (fail-closed)")]
    Recovery { detail: String },
}

#[derive(Clone)]
struct ServerState {
    node: Arc<Node>,
    /// The export-authorization seam — the SOVEREIGN gate since B3
    /// (`RecordedConsentGate`); composed in `router()`, nowhere else.
    gate: Arc<dyn geobase_gpkg::ceremony::CeremonyGate + Send + Sync>,
    /// The at-rest encryption seam for T3 writes (fail-closed by default).
    at_rest: Arc<dyn AtRestCipher>,
    /// `None` refuses `POST /api/export` — exporting is deliberate.
    exports_dir: Option<PathBuf>,
    /// Interim operator export token (A1); checked before the ceremony seam.
    export_token: Option<String>,
    /// Node-witnessed export sessions (B3, design §4): the ONLY producer
    /// of an export's source set.
    sessions: Arc<SessionRegistry>,
}

/// The enrollment reference of the interim A1 operator identity. Public
/// so local operator tooling (e.g. the consent-recording example) can
/// bind agreements to the same identity the route authenticates. B5
/// replaces this with the enrolled OS-keychain credential.
pub const INTERIM_OPERATOR_ENROLLMENT: &str = "a1-interim-export-token";

/// The authenticated requester identity for an export authorized through
/// the interim A1 operator token. B5 replaces this with the enrolled
/// OS-keychain credential; until then the enrollment reference names the
/// interim mechanism honestly.
pub fn interim_operator_identity() -> ExportIdentity {
    ExportIdentity::local_operator(INTERIM_OPERATOR_ENROLLMENT)
        .expect("static non-empty enrollment ref")
}

/// The gate composed when exports are DISABLED (`exports_dir: None`).
/// Unreachable through the route (it 503s first); if ever reached, it
/// fails as infrastructure, never as a silent authorization.
#[derive(Debug)]
struct ExportsNotConfiguredGate;

impl geobase_gpkg::ceremony::CeremonyGate for ExportsNotConfiguredGate {
    fn authorize_export(
        &self,
        _auth: &geobase_gpkg::ceremony::ExportAuthorization<'_>,
    ) -> Result<geobase_gpkg::ceremony::CeremonyRecord, geobase_gpkg::ceremony::CeremonyError> {
        Err(geobase_gpkg::ceremony::CeremonyError::Infrastructure {
            reason: "exports_dir is not configured for this node".into(),
        })
    }
}

/// Resolve the at-rest cipher for a LOCAL dev/demo binary from the
/// environment. Returns `None` — **fail-closed, the production default** —
/// unless `GEOBASE_DEV_UNENCRYPTED` is set, in which case the dev-plaintext
/// cipher is returned with a loud one-time warning. A shipped node MUST NEVER
/// silently default to plaintext T3, so this is the only sanctioned way a
/// binary opts into it, and it is always explicit and visible.
pub fn dev_unencrypted_cipher_if_opted_in() -> Option<Arc<dyn AtRestCipher>> {
    if std::env::var_os("GEOBASE_DEV_UNENCRYPTED").is_some() {
        eprintln!(
            "[geobase] WARNING: GEOBASE_DEV_UNENCRYPTED is set — the T3 export ledger \
             will be written UNENCRYPTED (dev only, permanently stamped UNENCRYPTED-DEV). \
             Never set this on a node holding real sovereign data."
        );
        Some(Arc::new(DevPlaintextCipher::new()))
    } else {
        None
    }
}

/// Build the router for `node` (pure; unit-testable via tower `oneshot`).
pub fn router(node: Arc<Node>, config: &ServerConfig) -> axum::Router {
    // Fail-closed by default: absent an explicitly configured cipher,
    // the node refuses to write T3 at rest (no plaintext ledger).
    let at_rest: Arc<dyn AtRestCipher> = config
        .at_rest
        .clone()
        .unwrap_or_else(|| Arc::new(FailClosedCipher));
    // THE single gate composition point (docs/CEREMONY-GATE.md,
    // docs/CEREMONY-DESIGN.md §12): since B3 the composed gate is the
    // SOVEREIGN RecordedConsentGate — ProvisionalDevGate is no longer
    // reachable from any release-build composition. The consent store
    // lives beside the export ledger in exports_dir.
    let gate: Arc<dyn geobase_gpkg::ceremony::CeremonyGate + Send + Sync> =
        match &config.exports_dir {
            Some(dir) => Arc::new(RecordedConsentGate::new(
                dir.clone(),
                &node.tsdf_version,
                &node.tsdf_origin,
                at_rest.clone(),
            )),
            None => Arc::new(ExportsNotConfiguredGate),
        };
    let state = ServerState {
        node,
        gate,
        at_rest,
        exports_dir: config.exports_dir.clone(),
        export_token: config.export_token.clone(),
        sessions: Arc::new(SessionRegistry::default()),
    };
    let mut router = axum::Router::new()
        .route("/api/node", get(api_node))
        .route("/api/packs", get(api_packs))
        .route("/api/packs/{id}/layers", get(api_pack_layers))
        .route(
            "/api/packs/{id}/tables/{table}/features",
            get(api_pack_table_features),
        )
        .route("/api/sessions", axum::routing::post(api_sessions))
        .route("/api/export", axum::routing::post(api_export))
        .with_state(state);

    router = match &config.tiles_dir {
        Some(dir) => router.nest_service("/tiles/terrain", ServeDir::new(dir)),
        None => router
            .route("/tiles/terrain", get(no_terrain_tiles))
            .route("/tiles/terrain/{*path}", get(no_terrain_tiles)),
    };

    router.layer(middleware::from_fn(guard_localhost))
}

/// Loopback guard on every route — the browser-facing half of the egress
/// stance. The 127.0.0.1 bind keeps remote *sockets* out; this keeps
/// remote *web pages* out:
///
/// - **DNS-rebinding defense**: a `Host` header that is not a loopback
///   name is refused (a rebound attacker domain resolves here with its
///   own hostname and would otherwise be treated as same-origin by the
///   victim's browser, bypassing CORS entirely).
/// - **CORS allowlist, not `*`**: a present `Origin` is echoed into
///   `access-control-allow-origin` only when it is itself loopback
///   (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, or
///   `tauri://localhost` — the embedded shell). Any other origin gets a
///   flat 403: a random website must not read even T0 through the
///   user's browser — that would be egress off-node in all but name.
async fn guard_localhost(req: Request, next: Next) -> Response {
    if let Some(host) = req.headers().get(header::HOST) {
        let ok = host.to_str().is_ok_and(is_loopback_hostport);
        if !ok {
            return status_json(
                StatusCode::FORBIDDEN,
                json!({"reason": "host header is not a loopback name (node serves this machine only)"}),
                None,
            );
        }
    }
    let origin = req.headers().get(header::ORIGIN).cloned();
    if let Some(o) = &origin {
        let ok = o.to_str().is_ok_and(is_loopback_origin);
        if !ok {
            return status_json(
                StatusCode::FORBIDDEN,
                json!({"reason": "origin is not local to this machine (node serves this machine only)"}),
                None,
            );
        }
    }
    // CORS preflight: a browser JSON POST (RStep export) sends OPTIONS
    // first. Answer it HERE for loopback origins only — no route ever
    // sees an OPTIONS request, and foreign origins were already refused
    // above.
    let mut response = if req.method() == axum::http::Method::OPTIONS && origin.is_some() {
        let mut preflight = StatusCode::NO_CONTENT.into_response();
        preflight.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST"),
        );
        preflight.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            // The export token header (A1) must be preflight-approved or the
            // browser will never send it on the RStep export POST.
            HeaderValue::from_static("content-type, x-geobase-export-token, x-geobase-session"),
        );
        preflight
    } else {
        next.run(req).await
    };
    if let Some(o) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        response
            .headers_mut()
            .append(header::VARY, HeaderValue::from_static("origin"));
    }
    response
}

/// Whether a `host[:port]` names loopback. `.localhost` names are
/// loopback-only by RFC 6761.
fn is_loopback_hostport(hostport: &str) -> bool {
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        // Bracketed IPv6: everything after ']' must be empty or ':digits' —
        // trailing garbage ("[::1]evil.example") must not parse as loopback.
        match rest.split_once(']') {
            Some((h, tail))
                if tail.is_empty()
                    || (tail.strip_prefix(':').is_some_and(|p| {
                        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())
                    })) =>
            {
                h
            }
            _ => return false,
        }
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
            _ => hostport,
        }
    };
    // Hostnames are case-insensitive.
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "127.0.0.1" | "::1" | "localhost") || host.ends_with(".localhost")
}

/// Whether an `Origin` header value is local to this machine.
fn is_loopback_origin(origin: &str) -> bool {
    if origin == "tauri://localhost" {
        return true;
    }
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .is_some_and(is_loopback_hostport)
}

/// Bind 127.0.0.1 (never anything else) and serve until `stop()`.
pub async fn serve(node: Arc<Node>, config: ServerConfig) -> Result<ServerHandle, ServerError> {
    // Publication recovery BEFORE serving (design §6 step 6): every
    // prepared-but-unfinalized publication finalizes or aborts,
    // truthfully, before the node answers a single request. A node that
    // cannot resolve its own in-flight publications must not serve —
    // fail-closed.
    if let Some(exports_dir) = &config.exports_dir {
        let cipher: Arc<dyn AtRestCipher> = config
            .at_rest
            .clone()
            .unwrap_or_else(|| Arc::new(FailClosedCipher));
        let actions = crate::export::recover_publications(cipher.as_ref(), exports_dir).map_err(
            |source| ServerError::Recovery {
                detail: source.to_string(),
            },
        )?;
        for action in &actions {
            eprintln!("[geobase] publication recovery: {action:?}");
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|source| ServerError::Bind {
            port: config.port,
            source,
        })?;
    let addr = listener.local_addr().map_err(|source| ServerError::Bind {
        port: config.port,
        source,
    })?;
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let app = router(node, &config);
    let join = tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = receiver.await;
        });
        let _ = server.await;
    });

    Ok(ServerHandle {
        addr,
        shutdown,
        join,
    })
}

async fn api_node(State(state): State<ServerState>) -> impl IntoResponse {
    JsonNoStore(json!({
        "node_id": state.node.grounding.node_id,
        "territory": state.node.grounding.territory,
        "home_crs": state.node.grounding.home_crs,
        "bbox": state.node.grounding.bbox,
        "tsdf_origin": state.node.tsdf_origin,
        "pack_count": state.node.catalog.len(),
    }))
}

async fn api_packs(State(state): State<ServerState>) -> impl IntoResponse {
    let packs: Vec<Value> = state
        .node
        .catalog
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "tier": entry.tier.code(),
                "tagged": entry.tagged,
                "tsdf_version": entry.tsdf_version,
                "tables": entry.tables.iter().map(|table| {
                    json!({
                        "name": table.name,
                        "data_type": table.data_type,
                    })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    JsonNoStore(json!(packs))
}

async fn no_terrain_tiles() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        JsonNoStore(json!({
            "reason": "tiles_dir is not configured for this node"
        })),
    )
}

/// Issue a node-witnessed export session (B3, design §4). The id is the
/// only handle the SDK needs; every pack subsequently served with the
/// session header is accumulated by the node.
async fn api_sessions(State(state): State<ServerState>) -> Response {
    match state.sessions.issue() {
        Ok(id) => status_json(StatusCode::OK, json!({"session": id}), None),
        Err(err) => status_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"reason": format!("session id generation failed: {err}")}),
            None,
        ),
    }
}

/// Witness a successfully-served pack into the request's session, if the
/// session header accompanies it. An unknown session is a loud 400 — an
/// app that believes it is accumulating provenance must not silently
/// accumulate nothing. Returns an error response to surface, or `None` to
/// proceed with serving.
fn witness_serve(state: &ServerState, headers: &HeaderMap, pack_id: &str) -> Option<Response> {
    let session_id = headers.get(SESSION_HEADER)?.to_str().ok()?;
    match state.sessions.witness(session_id, pack_id) {
        Ok(()) => None,
        Err(err) => Some(status_json(
            StatusCode::BAD_REQUEST,
            json!({"reason": err.to_string()}),
            None,
        )),
    }
}

async fn api_pack_layers(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(entry) = state.node.catalog.iter().find(|entry| entry.id == id) else {
        return status_json(
            StatusCode::NOT_FOUND,
            json!({"reason": "unknown pack"}),
            None,
        );
    };

    let tier = entry.tier;
    if !matches!(tier, Tier::T0 | Tier::T1) {
        return status_json(
            StatusCode::FORBIDDEN,
            json!({
                "tier": tier.code(),
                "reason": "requires the Phase 1.2 permissions ceremony",
            }),
            Some(tier),
        );
    }
    // The node witnesses the serve (design §4) — a refused pack was never
    // served and is deliberately NOT witnessed.
    if let Some(refused) = witness_serve(&state, &headers, &entry.id) {
        return refused;
    }

    match layer_metadata(&entry.path, &entry.id, tier, &entry.tables) {
        Ok(layers) => status_json(
            StatusCode::OK,
            json!({
                "pack": entry.id,
                "tier": tier.code(),
                "layers": layers,
            }),
            Some(tier),
        ),
        Err(err) => status_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"reason": err}),
            Some(tier),
        ),
    }
}

/// `POST /api/export` request body (deny_unknown_fields: a mutating
/// endpoint never guesses what a stray field meant — and the pre-B3
/// `source_packs`/`requester` fields are REFUSED, not ignored: the old
/// body shape fails loudly instead of silently losing its claims).
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportBody {
    product: String,
    /// The node-witnessed export session (B3, design §4). The source set
    /// is the node's record for this session — the request can neither
    /// add nor subtract.
    session: String,
    #[serde(default)]
    purpose: Option<String>,
    features: Vec<ExportBodyFeature>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportBodyFeature {
    geometry: Value,
    score: f64,
}

/// The first mutating endpoint. Contract in `export.rs` module docs:
/// loopback-guarded like everything else, 503 without an exports dir,
/// 404 unknown source pack, 403 on ceremony refusal (the seam enforces
/// the T3 floor), 400 invalid, 409 exists; success is T2-stamped and
/// fully audited before the response returns.
async fn api_export(
    State(state): State<ServerState>,
    headers: HeaderMap,
    // Raw bytes, NOT `Json<Value>` (review H1): the JSON extractor would run
    // before this handler and reject a malformed body with 400 *before* the
    // token guard. Taking the body as bytes lets the guard authenticate
    // first; parsing happens only after a valid token.
    body: axum::body::Bytes,
) -> Response {
    use crate::export::{export_product, ExportError, ExportRequest, PaintedFeature, SourcePack};

    let Some(exports_dir) = state.exports_dir.clone() else {
        return status_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"reason": "exports_dir is not configured for this node"}),
            None,
        );
    };
    // Interim operator guard (A1): exports enabled without a NON-EMPTY
    // configured token is a misconfiguration — fail closed before reading
    // anything. An empty/whitespace token is treated as unconfigured so a
    // `Some("")` config can never authorize an empty header (the invariant
    // is enforced HERE, at the public server boundary, not only in binaries).
    let Some(expected_token) = state
        .export_token
        .clone()
        .filter(|token| !token.trim().is_empty())
    else {
        return status_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"reason": "exports are enabled but no non-empty export token is \
                              configured (interim operator guard, Phase A — set one at boot)"}),
            None,
        );
    };
    // Authenticate BEFORE parsing the body (A1 + review H1): a missing/wrong
    // token is refused before any request-controlled content is read, so an
    // unauthenticated caller cannot reach body parsing and cannot write
    // attacker-controlled identity into the audit trail. The refusal row is
    // therefore deliberately GENERIC — it records that an unauthenticated
    // attempt happened, never a claimed product/requester it cannot trust.
    let provided = headers
        .get(EXPORT_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if !provided.is_some_and(|candidate| token_matches(&expected_token, candidate)) {
        return match crate::export::record_unauthenticated_refusal(
            state.at_rest.as_ref(),
            &exports_dir,
        ) {
            // Refusal recorded (or the tier did not require a cipher): 403.
            Ok(()) => status_json(
                StatusCode::FORBIDDEN,
                json!({"reason": "export refused: missing or invalid export token \
                                  (interim operator guard — Phase A, replaced by \
                                  requester authentication in Phase B)"}),
                None,
            ),
            // Fail-closed: the node cannot even record the refusal safely
            // (no cipher for the T3 ledger). Say so honestly — do not claim
            // the 403+audit contract was met when it was not.
            Err(ExportError::Encryption(_)) => status_json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"reason": "export refused (invalid token) AND the node cannot \
                                  record the refusal: T3 ledger has no configured \
                                  at-rest cipher (fail-closed)"}),
                None,
            ),
            Err(err) => status_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"reason": format!("export refusal could not be audited: {err}")}),
                None,
            ),
        };
    }
    let parsed: ExportBody = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(err) => {
            return status_json(
                StatusCode::BAD_REQUEST,
                json!({"reason": format!("invalid export request: {err}")}),
                None,
            );
        }
    };

    let requester = interim_operator_identity();

    // B3 (design §4): the source set is the NODE'S session record — every
    // pack served into the named session, period. No valid session →
    // refuse, with a refusal row. The request cannot add or subtract.
    let witnessed_ids = match state.sessions.source_set(&parsed.session) {
        Ok(ids) => ids,
        Err(err) => {
            let reason = format!(
                "export refused: {err} (the source set is the node's own session \
                 record — an export without a witnessed session has no provenance)"
            );
            return match crate::export::record_declined_refusal(
                state.at_rest.as_ref(),
                &exports_dir,
                &parsed.product,
                &requester,
                &reason,
            ) {
                Ok(()) => status_json(StatusCode::FORBIDDEN, json!({"reason": reason}), None),
                Err(ExportError::Encryption(_)) => status_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"reason": "export refused (invalid session) AND the node cannot \
                                      record the refusal: T3 ledger has no configured \
                                      at-rest cipher (fail-closed)"}),
                    None,
                ),
                Err(err) => status_json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"reason": format!("export refusal could not be audited: {err}")}),
                    None,
                ),
            };
        }
    };
    // Re-resolve effective tiers against the catalog AT EXPORT TIME
    // (design §5.1 step 1): a witnessed pack that no longer resolves is
    // T3 — the floor refuses it downstream.
    let sources: Vec<SourcePack> = witnessed_ids
        .iter()
        .map(
            |pack_id| match state.node.catalog.iter().find(|entry| &entry.id == pack_id) {
                Some(entry) => SourcePack {
                    id: entry.id.clone(),
                    path: Some(entry.path.clone()),
                    tier: entry.tier,
                },
                None => SourcePack {
                    id: pack_id.clone(),
                    path: None,
                    tier: Tier::T3,
                },
            },
        )
        .collect();

    let mut features = Vec::with_capacity(parsed.features.len());
    for (index, feature) in parsed.features.iter().enumerate() {
        match painted_geometry_from_geojson(&feature.geometry) {
            Ok(geometry) => features.push(PaintedFeature {
                geometry,
                score: feature.score,
            }),
            Err(detail) => {
                return status_json(
                    StatusCode::BAD_REQUEST,
                    json!({"reason": format!("feature {index}: {detail}")}),
                    None,
                );
            }
        }
    }

    let request = ExportRequest {
        product: parsed.product,
        purpose: parsed.purpose,
        features,
    };
    let gate = state.gate.clone();
    let cipher = state.at_rest.clone();
    // File IO + SQLite are blocking; keep the runtime responsive.
    let outcome = tokio::task::spawn_blocking(move || {
        export_product(
            gate.as_ref(),
            cipher.as_ref(),
            &exports_dir,
            &request,
            &sources,
            &requester,
        )
    })
    .await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(join_err) => {
            return status_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"reason": format!("export task failed: {join_err}")}),
                None,
            );
        }
    };
    match outcome {
        Ok(done) => {
            let files: serde_json::Map<String, Value> = done
                .files
                .iter()
                .map(|(name, sha256)| {
                    // Frozen contract key for the sidecar is "tsdf_json"
                    // (Path::extension would say just "json").
                    let key = if name.ends_with(".tsdf.json") {
                        "tsdf_json".to_string()
                    } else {
                        std::path::Path::new(name)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("file")
                            .to_string()
                    };
                    (key, json!({"name": name, "sha256": sha256}))
                })
                .collect();
            status_json(
                StatusCode::OK,
                json!({
                    "product": done.product,
                    "tier": done.tier.code(),
                    "features": done.features_written,
                    "files": files,
                    "area_m2_total": done.area_m2_total,
                    "ceremony": {
                        "process": done.ceremony.process,
                        "basis": done.ceremony.basis,
                    },
                    "publication_id": done.publication_id,
                    "audit_ids": done.audit_ids,
                }),
                Some(done.tier),
            )
        }
        Err(err) => {
            let status = match &err {
                // Governance denial (design §5.3): 403 + refusal row.
                ExportError::Refused(_) => StatusCode::FORBIDDEN,
                ExportError::Invalid(_) => StatusCode::BAD_REQUEST,
                ExportError::Exists(_) => StatusCode::CONFLICT,
                // Infrastructure failure (design §5.3): 503, never
                // attributed to the sovereign ceremony. Fail-closed
                // encryption is the same class: the node is not
                // provisioned to store the T3 ledger safely.
                ExportError::Infrastructure(_) | ExportError::Encryption(_) => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            status_json(status, json!({"reason": err.to_string()}), None)
        }
    }
}

/// Parse a GeoJSON Polygon/MultiPolygon object into painted geometry.
/// Structural parsing only — ring validity (closure, >= 3 distinct
/// vertices, finiteness) is the export pipeline's job, where failures
/// name the feature.
fn painted_geometry_from_geojson(value: &Value) -> Result<crate::export::PaintedGeometry, String> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("geometry missing 'type'")?;
    let coordinates = value
        .get("coordinates")
        .ok_or("geometry missing 'coordinates'")?;
    let ring = |raw: &Value| -> Result<geo_types::LineString<f64>, String> {
        let positions = raw.as_array().ok_or("ring is not an array")?;
        let mut coords = Vec::with_capacity(positions.len());
        for position in positions {
            let pair = position.as_array().ok_or("position is not an array")?;
            let (Some(x), Some(y)) = (
                pair.first().and_then(Value::as_f64),
                pair.get(1).and_then(Value::as_f64),
            ) else {
                return Err("position is not [lon, lat] numbers".into());
            };
            coords.push(geo_types::Coord { x, y });
        }
        Ok(geo_types::LineString::from(coords))
    };
    let polygon = |raw: &Value| -> Result<geo_types::Polygon<f64>, String> {
        let rings = raw
            .as_array()
            .ok_or("polygon coordinates are not an array")?;
        let mut iter = rings.iter();
        let exterior = ring(iter.next().ok_or("polygon has no exterior ring")?)?;
        let interiors = iter.map(ring).collect::<Result<Vec<_>, _>>()?;
        Ok(geo_types::Polygon::new(exterior, interiors))
    };
    match kind {
        "Polygon" => Ok(crate::export::PaintedGeometry::Polygon(polygon(
            coordinates,
        )?)),
        "MultiPolygon" => {
            let polys = coordinates
                .as_array()
                .ok_or("multipolygon coordinates are not an array")?
                .iter()
                .map(polygon)
                .collect::<Result<Vec<_>, String>>()?;
            Ok(crate::export::PaintedGeometry::MultiPolygon(
                geo_types::MultiPolygon(polys),
            ))
        }
        other => Err(format!(
            "geometry type '{other}' is not Polygon or MultiPolygon"
        )),
    }
}

async fn api_pack_table_features(
    State(state): State<ServerState>,
    Path((id, table)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(entry) = state.node.catalog.iter().find(|entry| entry.id == id) else {
        return status_json(
            StatusCode::NOT_FOUND,
            json!({"reason": "unknown pack"}),
            None,
        );
    };

    let tier = entry.tier;
    let Some(table_info) = entry.tables.iter().find(|info| info.name == table) else {
        return status_json(
            StatusCode::NOT_FOUND,
            json!({"reason": "unknown table"}),
            Some(tier),
        );
    };
    if table_info.data_type != "features" {
        return status_json(
            StatusCode::BAD_REQUEST,
            json!({"reason": "table is not a feature table"}),
            Some(tier),
        );
    }
    if !matches!(tier, Tier::T0 | Tier::T1) {
        return status_json(
            StatusCode::FORBIDDEN,
            json!({
                "tier": tier.code(),
                "reason": "requires the Phase 1.2 permissions ceremony",
            }),
            Some(tier),
        );
    }
    if !valid_identifier(&table) {
        return status_json(
            StatusCode::BAD_REQUEST,
            json!({"reason": "invalid table identifier"}),
            Some(tier),
        );
    }
    // Witness the serve into the session, if one accompanies the request
    // (design §4) — feature data is exactly what a product derives from.
    if let Some(refused) = witness_serve(&state, &headers, &entry.id) {
        return refused;
    }

    match feature_collection(entry.path.clone(), &table) {
        Ok(collection) => status_json(StatusCode::OK, collection, Some(tier)),
        Err(err) => status_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"reason": err}),
            Some(tier),
        ),
    }
}

fn layer_metadata(
    path: &FsPath,
    pack_id: &str,
    pack_tier: Tier,
    tables: &[crate::vault::TableInfo],
) -> Result<Vec<Value>, String> {
    let gpkg = GeoPackage::open(path).map_err(|err| err.to_string())?;
    let tags = gpkg.read_tsdf_tags().map_err(|err| err.to_string())?;
    let mut layers = Vec::new();
    for table in tables.iter().filter(|table| table.data_type == "features") {
        let table_tier = tags
            .iter()
            .filter(|tag| tag.scope == "table" && tag.table.as_deref() == Some(table.name.as_str()))
            .map(|tag| tag.tier)
            .max()
            .unwrap_or(pack_tier);
        let info = gpkg_layer_info(&gpkg, &table.name)?;
        layers.push(json!({
            "table": table.name,
            "geometry_type": info.geometry_type,
            "bounds": info.bounds,
            "srs": info.srs,
            "tier": table_tier.code(),
            "color_seed": layer_color_seed(pack_id, &table.name),
        }));
    }
    Ok(layers)
}

struct GpkgLayerInfo {
    geometry_type: String,
    bounds: Value,
    srs: Value,
}

fn gpkg_layer_info(gpkg: &GeoPackage, table: &str) -> Result<GpkgLayerInfo, String> {
    let (geometry_type, min_x, min_y, max_x, max_y, srs_id) = gpkg
        .conn()
        .query_row(
            "SELECT g.geometry_type_name, c.min_x, c.min_y, c.max_x, c.max_y, c.srs_id \
             FROM gpkg_contents c \
             JOIN gpkg_geometry_columns g ON g.table_name = c.table_name \
             WHERE c.table_name = ?1",
            [table],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    let bounds = match (min_x, min_y, max_x, max_y) {
        (Some(min_x), Some(min_y), Some(max_x), Some(max_y)) => {
            json!([min_x, min_y, max_x, max_y])
        }
        _ => Value::Null,
    };
    let srs = match srs_id {
        Some(srs_id) if srs_id > 0 => json!(format!("EPSG:{srs_id}")),
        _ => Value::Null,
    };

    Ok(GpkgLayerInfo {
        geometry_type,
        bounds,
        srs,
    })
}

fn layer_color_seed(pack_id: &str, table: &str) -> u32 {
    let digest = Sha256::digest(format!("{pack_id}/{table}"));
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

fn feature_collection(path: PathBuf, table: &str) -> Result<Value, String> {
    let gpkg = GeoPackage::open(&path).map_err(|err| err.to_string())?;
    let columns = feature_columns(&gpkg, table)?;
    let sql = feature_select_sql(table, &columns);
    let mut stmt = gpkg.conn().prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    let mut features = Vec::new();
    for row in rows {
        let (id, geom_blob, raw_properties) = row.map_err(|err| err.to_string())?;
        let geometry = gpkg_geometry_to_geojson(&geom_blob)?;
        let properties = serde_json::from_str::<Value>(&raw_properties)
            .map_err(|err| err.to_string())?
            .as_object()
            .cloned()
            .unwrap_or_default();
        features.push(json!({
            "type": "Feature",
            "id": id,
            "geometry": geometry,
            "properties": properties,
        }));
    }

    Ok(json!({
        "type": "FeatureCollection",
        "features": features,
    }))
}

fn feature_columns(gpkg: &GeoPackage, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = gpkg
        .conn()
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(|err| err.to_string())?;

    let mut columns = Vec::new();
    for row in rows {
        let (name, sql_type) = row.map_err(|err| err.to_string())?;
        if name == "id" || name == "geom" {
            continue;
        }
        if !valid_identifier(&name) {
            return Err(format!("invalid column identifier '{name}'"));
        }
        match sql_type.as_str() {
            "INTEGER" | "REAL" | "TEXT" => columns.push(name),
            other => return Err(format!("unsupported feature column SQL type '{other}'")),
        }
    }
    Ok(columns)
}

fn feature_select_sql(table: &str, columns: &[String]) -> String {
    let mut json_args = String::new();
    for column in columns {
        if !json_args.is_empty() {
            json_args.push_str(", ");
        }
        json_args.push_str(&format!("'{column}', \"{column}\""));
    }
    if json_args.is_empty() {
        json_args.push_str("'_empty', NULL");
    }
    format!("SELECT id, geom, json_object({json_args}) FROM \"{table}\" ORDER BY id")
}

fn gpkg_geometry_to_geojson(blob: &[u8]) -> Result<Value, String> {
    let mut geojson = Vec::new();
    let mut writer = geozero::geojson::GeoJsonWriter::new(&mut geojson);
    geozero::wkb::process_gpkg_geom(&mut std::io::Cursor::new(blob), &mut writer)
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&geojson).map_err(|err| err.to_string())
}

fn valid_identifier(identifier: &str) -> bool {
    let mut chars = identifier.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Constant-time token comparison. Length mismatch returns early — the
/// token's length is not a secret; its bytes are.
fn token_matches(expected: &str, provided: &str) -> bool {
    let (e, p) = (expected.as_bytes(), provided.as_bytes());
    e.len() == p.len() && e.iter().zip(p).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Generate a fresh operator export token: 32 hex chars from the OS CSPRNG.
/// Binaries that enable exports without `GEOBASE_EXPORT_TOKEN` call this at
/// boot and print the value once — operator-held, never persisted.
pub fn generate_export_token() -> Result<String, getrandom::Error> {
    use std::fmt::Write as _;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)?;
    let mut token = String::with_capacity(32);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

fn status_json(status: StatusCode, body: Value, tier: Option<Tier>) -> Response {
    let mut response = JsonNoStore(body).into_response();
    *response.status_mut() = status;
    if let Some(tier) = tier {
        response
            .headers_mut()
            .insert("x-geobase-tier", HeaderValue::from_static(tier.code()));
    }
    response
}

struct JsonNoStore(Value);

impl IntoResponse for JsonNoStore {
    fn into_response(self) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        (headers, axum::Json(self.0)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use geobase_gpkg::vector::{create_feature_table, FeatureTableSpec};
    use geobase_gpkg::TsdfTag;
    use serde_json::Map;
    use std::fs;
    use std::io::{Read, Write};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    use crate::place::{Grounding, TsdfOrigin};
    use crate::vault::{CatalogEntry, TableInfo};

    fn test_node(catalog: Vec<CatalogEntry>) -> Arc<Node> {
        Arc::new(Node {
            grounding: Grounding {
                node_id: "test-node".into(),
                territory: "Test Territory".into(),
                home_crs: "EPSG:4326".into(),
                bbox: Some([-123.0, 48.0, -122.0, 49.0]),
                tsdf: TsdfOrigin::Vendored,
            },
            tsdf_origin: "vendored:embedded".into(),
            tsdf_version: "0.9.4".into(),
            catalog,
        })
    }

    fn temp_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-server-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn create_pack(name: &str, tier: Option<Tier>) -> CatalogEntry {
        let path = temp_path(name);
        let gpkg = GeoPackage::create(&path).unwrap();
        if let Some(tier) = tier {
            gpkg.write_tsdf_tag(&TsdfTag {
                table: None,
                tier,
                tsdf_version: "0.9.4".into(),
                tsdf_source_origin: "vendored:embedded".into(),
                classified_by: "test".into(),
                extras: Map::new(),
            })
            .unwrap();
        }
        CatalogEntry {
            id: path.file_stem().unwrap().to_string_lossy().into_owned(),
            path,
            tier: tier.unwrap_or(Tier::T3),
            tagged: tier.is_some(),
            tsdf_version: tier.map(|_| "0.9.4".into()),
            tables: Vec::new(),
        }
    }

    async fn json_response(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ===================================================================
    // ADVERSARIAL EGRESS GATE (A1–A6). Prove T3 cannot be extracted through
    // the loopback API or the catalog. Attacker model: loopback network +
    // filesystem read of vault/exports. OUT OF SCOPE (operational controls,
    // not software): OS memory dumps, admin/physical access, screenshots —
    // G1's three-part scoping, docs/handoffs/geobase-completion-plan.md §2.
    // A7 (at-rest ledger) + A8 (near-trace, ignored) live in export.rs.
    // ===================================================================

    const T3_SENTINEL: &str = "T3_SENTINEL_DO_NOT_LEAK";

    /// A T3 pack carrying a sentinel feature — the needle every attack must
    /// fail to extract from any reachable surface.
    fn t3_sentinel_pack(name: &str) -> CatalogEntry {
        let path = temp_path(name);
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "sites".into(),
                identifier: "Sensitive sites".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POINT".into(),
                columns: vec![geobase_gpkg::vector::ColumnDef {
                    name: "label".into(),
                    sql_type: "TEXT",
                }],
                bounds: (-123.456, 48.789, -123.456, 48.789),
            },
        )
        .unwrap();
        let geom = gpkg_point_blob(-123.456, 48.789);
        gpkg.conn()
            .execute(
                "INSERT INTO sites (geom, label) VALUES (?1, ?2)",
                (&geom, T3_SENTINEL),
            )
            .unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            table: None,
            tier: Tier::T3,
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:embedded".into(),
            classified_by: "test".into(),
            extras: Map::new(),
        })
        .unwrap();
        drop(gpkg);
        CatalogEntry {
            id: path.file_stem().unwrap().to_string_lossy().into_owned(),
            path,
            tier: Tier::T3,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![TableInfo {
                name: "sites".into(),
                data_type: "features".into(),
            }],
        }
    }

    /// [EGRESS-GATE A1] Layer metadata for a T3 pack is refused (403) and no
    /// layer data leaks in the body.
    #[tokio::test]
    async fn egress_gate_a1_t3_layers_refused() {
        let entry = t3_sentinel_pack("a1-t3.gpkg");
        let id = entry.id.clone();
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get(format!("/api/packs/{id}/layers"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = json_response(response).await;
        assert_eq!(body["tier"], "T3");
        assert!(body.get("layers").is_none(), "no layer metadata may leak");
    }

    /// [EGRESS-GATE A2] Feature data for a T3 pack is refused (403) and the
    /// sentinel never appears in the response bytes.
    #[tokio::test]
    async fn egress_gate_a2_t3_features_refused() {
        let entry = t3_sentinel_pack("a2-t3.gpkg");
        let id = entry.id.clone();
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get(format!("/api/packs/{id}/tables/sites/features"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let raw = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(T3_SENTINEL));
    }

    /// [EGRESS-GATE A3] `/api/packs` exposes catalog metadata only — a T3 pack
    /// is listed (id/tier/tables) but NO feature data / sentinel leaks.
    #[tokio::test]
    async fn egress_gate_a3_packs_catalog_leaks_no_feature_data() {
        let entry = t3_sentinel_pack("a3-t3.gpkg");
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(Request::get("/api/packs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let raw = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.contains("\"T3\""),
            "the pack is catalogued as T3 metadata"
        );
        assert!(!text.contains(T3_SENTINEL), "but no feature data may leak");
    }

    /// [EGRESS-GATE A4, B3 rework] The T3-omission bypass is closed
    /// STRUCTURALLY: the request can no longer declare source packs at
    /// all. (a) The pre-B3 body shape (`source_packs`/`requester`) is
    /// refused 400 by `deny_unknown_fields` — the bypass field is gone,
    /// not deprecated. (b) A session that witnessed nothing has an empty
    /// node-derived source set, which resolves to T3 and hits the floor:
    /// 403 with a refusal row, no product bytes. (c) A T3 pack can never
    /// be served (A1/A2), so it can never enter a session's source set —
    /// there is no request shape that reaches the ceremony with an
    /// unwitnessed T3 source omitted.
    #[tokio::test]
    async fn egress_gate_a4_export_source_set_is_node_witnessed_only() {
        let entry = t3_sentinel_pack("a4-t3.gpkg");
        let id = entry.id.clone();
        let exports = temp_path("a4-exports");
        let app = router(
            test_node(vec![entry]),
            &ServerConfig {
                exports_dir: Some(exports.clone()),
                at_rest: Some(Arc::new(geobase_gpkg::cipher::DevPlaintextCipher::new())),
                export_token: Some("a4-token".into()),
                ..ServerConfig::default()
            },
        );
        // (a) The pre-B3 body shape is refused loudly — a caller cannot
        // even CLAIM a source set anymore.
        let old_shape = json!({
            "product": "steal",
            "source_packs": [id],
            "requester": "attacker",
            "features": [{
                "geometry": {"type":"Polygon","coordinates":[[[0.0,0.0],[0.001,0.0],[0.001,0.001],[0.0,0.0]]]},
                "score": 1.0
            }]
        });
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/export")
                    .header("content-type", "application/json")
                    .header(EXPORT_TOKEN_HEADER, "a4-token")
                    .body(Body::from(old_shape.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "declared source packs must be refused as an unknown field"
        );

        // (b) A session that served nothing: empty node-witnessed source
        // set → T3 floor → 403.
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/sessions")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let session = json_response(response).await["session"]
            .as_str()
            .unwrap()
            .to_string();
        let body = json!({
            "product": "steal",
            "session": session,
            "features": [{
                "geometry": {"type":"Polygon","coordinates":[[[0.0,0.0],[0.001,0.0],[0.001,0.001],[0.0,0.0]]]},
                "score": 1.0
            }]
        });
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/export")
                    .header("content-type", "application/json")
                    .header(EXPORT_TOKEN_HEADER, "a4-token")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let reason = json_response(response).await["reason"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(reason.contains("never leaves the node"), "{reason}");

        // (c) An unknown session is refused outright, with a refusal row.
        let body = json!({
            "product": "steal2",
            "session": "forged-session-id",
            "features": [{
                "geometry": {"type":"Polygon","coordinates":[[[0.0,0.0],[0.001,0.0],[0.001,0.001],[0.0,0.0]]]},
                "score": 1.0
            }]
        });
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header("content-type", "application/json")
                    .header(EXPORT_TOKEN_HEADER, "a4-token")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // ...and NO product artifact of any kind was written.
        assert!(!exports.join("steal").exists());
        assert!(!exports.join("steal2").exists());
        // The refusals were audited.
        let ledger = GeoPackage::open(&exports.join("node-audit.gpkg")).unwrap();
        let refused: Vec<_> = ledger
            .audit_trail()
            .unwrap()
            .into_iter()
            .filter(|row| row.action == "export.refused")
            .collect();
        assert_eq!(refused.len(), 2, "floor refusal + unknown-session refusal");
    }

    /// §11 (B3): a corrupt/unreadable consent store is an INFRASTRUCTURE
    /// failure — HTTP 503, distinct from a governance 403, never
    /// attributed to the sovereign ceremony.
    #[tokio::test]
    async fn corrupt_consent_store_returns_503_not_403() {
        let entry = create_pack("infra-t0.gpkg", Some(Tier::T0));
        let id = entry.id.clone();
        let exports = temp_path("infra-exports");
        std::fs::create_dir_all(&exports).unwrap();
        // A garbage file bearing the reserved consent-store name.
        std::fs::write(
            exports.join(geobase_gpkg::consent_store::RESERVED_CONSENT_STORE_NAME),
            b"not a database",
        )
        .unwrap();
        let app = router(
            test_node(vec![entry]),
            &ServerConfig {
                exports_dir: Some(exports.clone()),
                at_rest: Some(Arc::new(geobase_gpkg::cipher::DevPlaintextCipher::new())),
                export_token: Some("infra-token".into()),
                ..ServerConfig::default()
            },
        );
        // Witness the T0 pack into a session so the request reaches the
        // gate's store access (past the floor).
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/sessions")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let session = json_response(response).await["session"]
            .as_str()
            .unwrap()
            .to_string();
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/packs/{id}/layers"))
                    .header(header::HOST, "127.0.0.1")
                    .header(crate::session::SESSION_HEADER, session.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json!({
            "product": "infra-blocked",
            "session": session,
            "features": [{
                "geometry": {"type":"Polygon","coordinates":[[[0.0,0.0],[0.001,0.0],[0.001,0.001],[0.0,0.0]]]},
                "score": 1.0
            }]
        });
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header("content-type", "application/json")
                    .header(EXPORT_TOKEN_HEADER, "infra-token")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a corrupt consent store is infrastructure, never a governance denial"
        );
        let reason = json_response(response).await["reason"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            reason.contains("never attributed to the sovereign ceremony"),
            "{reason}"
        );
        assert!(!exports.join("infra-blocked").exists(), "no product bytes");
    }

    /// [EGRESS-GATE A5] The T3 export ledger AND the T3 consent store are
    /// never catalogued — enforced by name, not merely by living in a
    /// separate directory. Even placed INSIDE the vault (a
    /// misconfiguration), both reserved names are skipped by the scanner.
    #[test]
    fn egress_gate_a5_reserved_artifacts_never_catalogued_even_inside_vault() {
        let vault = temp_path("a5-vault");
        std::fs::create_dir_all(&vault).unwrap();
        drop(GeoPackage::create(&vault.join("public.gpkg")).unwrap());
        // Adversarial misconfiguration: both reserved T3 artifacts sitting
        // in the vault.
        let ledger = GeoPackage::create(&vault.join(crate::vault::RESERVED_LEDGER_NAME)).unwrap();
        ledger
            .write_tsdf_tag(&TsdfTag {
                table: None,
                tier: Tier::T3,
                tsdf_version: "0.9.4".into(),
                tsdf_source_origin: "vendored:embedded".into(),
                classified_by: "test".into(),
                extras: Map::new(),
            })
            .unwrap();
        drop(ledger);
        drop(
            geobase_gpkg::consent_store::ConsentStore::open_or_create(
                &vault,
                "0.9.4",
                "vendored:embedded",
                &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            )
            .unwrap(),
        );
        let catalog = crate::vault::scan(&vault).unwrap();
        assert_eq!(catalog.len(), 1, "only the public pack is catalogued");
        assert_eq!(catalog[0].id, "public");
        assert!(
            catalog
                .iter()
                .all(|e| e.id != "node-audit" && e.id != "node-consent"),
            "the reserved T3 artifacts must never be catalogued, even inside the vault"
        );
    }

    /// [EGRESS-GATE A6] "When in doubt, T3": an untagged pack catalogs as T3
    /// and its layers are refused — a downgrade needs a tag it does not have.
    #[tokio::test]
    async fn egress_gate_a6_untagged_pack_is_t3_and_refused() {
        let entry = create_pack("a6-untagged.gpkg", None);
        let id = entry.id.clone();
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get(format!("/api/packs/{id}/layers"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(json_response(response).await["tier"], "T3");
    }

    #[tokio::test]
    async fn api_node_returns_grounding_fields_and_pack_count() {
        let catalog = vec![create_pack("node-count.gpkg", Some(Tier::T0))];
        let app = router(test_node(catalog), &ServerConfig::default());
        let response = app
            .oneshot(Request::get("/api/node").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["node_id"], "test-node");
        assert_eq!(body["territory"], "Test Territory");
        assert_eq!(body["home_crs"], "EPSG:4326");
        assert_eq!(body["bbox"], json!([-123.0, 48.0, -122.0, 49.0]));
        assert_eq!(body["tsdf_origin"], "vendored:embedded");
        assert_eq!(body["pack_count"], 1);
    }

    #[tokio::test]
    async fn api_packs_lists_t0_and_untagged_t3_codes() {
        let mut t0 = create_pack("public.gpkg", Some(Tier::T0));
        t0.tables.push(TableInfo {
            name: "places".into(),
            data_type: "features".into(),
        });
        let t3 = create_pack("untagged.gpkg", None);
        let app = router(test_node(vec![t0, t3]), &ServerConfig::default());
        let response = app
            .oneshot(Request::get("/api/packs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body[0]["tier"], "T0");
        assert_eq!(body[0]["tagged"], true);
        assert_eq!(body[0]["tables"][0]["name"], "places");
        assert_eq!(body[1]["tier"], "T3");
        assert_eq!(body[1]["tagged"], false);
    }

    #[tokio::test]
    async fn features_endpoint_serves_t0_feature_collection() {
        let path = temp_path("features.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "places".into(),
                identifier: "Places".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POINT".into(),
                columns: vec![
                    geobase_gpkg::vector::ColumnDef {
                        name: "name".into(),
                        sql_type: "TEXT",
                    },
                    geobase_gpkg::vector::ColumnDef {
                        name: "count".into(),
                        sql_type: "INTEGER",
                    },
                    geobase_gpkg::vector::ColumnDef {
                        name: "score".into(),
                        sql_type: "REAL",
                    },
                ],
                bounds: (-123.5, 48.5, -123.5, 48.5),
            },
        )
        .unwrap();
        let geom = gpkg_point_blob(-123.5, 48.5);
        gpkg.conn()
            .execute(
                "INSERT INTO places (geom, name, count, score) VALUES (?1, ?2, ?3, ?4)",
                (&geom, "alpha", 7_i64, 2.5_f64),
            )
            .unwrap();
        drop(gpkg);

        let entry = CatalogEntry {
            id: "features".into(),
            path,
            tier: Tier::T0,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![TableInfo {
                name: "places".into(),
                data_type: "features".into(),
            }],
        };
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/features/tables/places/features")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-geobase-tier"], "T0");
        let body = json_response(response).await;
        assert_eq!(body["type"], "FeatureCollection");
        assert_eq!(body["features"][0]["id"], 1);
        assert_eq!(body["features"][0]["geometry"]["type"], "Point");
        assert_eq!(body["features"][0]["properties"]["name"], "alpha");
        assert_eq!(body["features"][0]["properties"]["count"], 7);
        assert_eq!(body["features"][0]["properties"]["score"], 2.5);
    }

    #[tokio::test]
    async fn layers_endpoint_lists_t0_feature_layers_and_skips_rasters() {
        let path = temp_path("features.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "places".into(),
                identifier: "Places".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POINT".into(),
                columns: Vec::new(),
                bounds: (-123.5, 48.5, -123.5, 48.5),
            },
        )
        .unwrap();
        drop(gpkg);

        let entry = CatalogEntry {
            id: "features".into(),
            path,
            tier: Tier::T0,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![
                TableInfo {
                    name: "places".into(),
                    data_type: "features".into(),
                },
                TableInfo {
                    name: "terrain".into(),
                    data_type: "2d-gridded-coverage".into(),
                },
            ],
        };
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/features/layers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["pack"], "features");
        assert_eq!(body["tier"], "T0");
        assert_eq!(body["layers"].as_array().unwrap().len(), 1);
        let layer = &body["layers"][0];
        assert_eq!(layer["table"], "places");
        assert_eq!(layer["geometry_type"], "POINT");
        assert_eq!(layer["bounds"], json!([-123.5, 48.5, -123.5, 48.5]));
        assert_eq!(layer["srs"], "EPSG:4326");
        assert_eq!(layer["tier"], "T0");
        let digest = Sha256::digest("features/places");
        let expected_seed = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
        assert_eq!(expected_seed, 56_627_218);
        assert_eq!(layer_color_seed("features", "places"), expected_seed);
        assert_eq!(
            layer_color_seed("landcover-2026", "landcover"),
            3_385_947_637
        );
        assert_eq!(layer["color_seed"], expected_seed);
    }

    #[tokio::test]
    async fn layers_endpoint_honors_table_scope_tsdf_tag_tier() {
        let path = temp_path("tiered-layers.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "places".into(),
                identifier: "Places".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POINT".into(),
                columns: Vec::new(),
                bounds: (-123.5, 48.5, -123.5, 48.5),
            },
        )
        .unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            table: None,
            tier: Tier::T1,
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:embedded".into(),
            classified_by: "test".into(),
            extras: Map::new(),
        })
        .unwrap();
        let mut extras = Map::new();
        extras.insert(
            "classification_basis".into(),
            Value::String("test table override".into()),
        );
        extras.insert(
            "source".into(),
            json!({"file": "synthetic", "sha256": "abc123"}),
        );
        gpkg.write_tsdf_tag(&TsdfTag {
            table: Some("places".into()),
            tier: Tier::T0,
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:embedded".into(),
            classified_by: "test".into(),
            extras,
        })
        .unwrap();
        drop(gpkg);

        let entry = CatalogEntry {
            id: "tiered-layers".into(),
            path,
            tier: Tier::T1,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![TableInfo {
                name: "places".into(),
                data_type: "features".into(),
            }],
        };
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/tiered-layers/layers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_response(response).await;
        assert_eq!(body["tier"], "T1");
        assert_eq!(body["layers"][0]["tier"], "T0");
    }

    #[tokio::test]
    async fn layers_endpoint_returns_404_for_unknown_pack() {
        let app = router(test_node(Vec::new()), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/missing/layers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.headers().get("x-geobase-tier").is_none());
        let body = json_response(response).await;
        assert_eq!(body["reason"], "unknown pack");
    }

    #[tokio::test]
    async fn layers_endpoint_refuses_t2_before_metadata_leaks() {
        let mut entry = create_pack("restricted-layers.gpkg", Some(Tier::T2));
        entry.id = "restricted-layers".into();
        entry.tier = Tier::T2;
        entry.tables = vec![TableInfo {
            name: "places".into(),
            data_type: "features".into(),
        }];
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/restricted-layers/layers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()["x-geobase-tier"], "T2");
        let body = json_response(response).await;
        assert_eq!(body["tier"], "T2");
        assert_eq!(
            body["reason"],
            "requires the Phase 1.2 permissions ceremony"
        );
    }

    #[tokio::test]
    async fn layers_endpoint_sets_tier_and_no_store_headers_on_200() {
        let path = temp_path("headers-layers.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "places".into(),
                identifier: "Places".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POINT".into(),
                columns: Vec::new(),
                bounds: (-123.5, 48.5, -123.5, 48.5),
            },
        )
        .unwrap();
        drop(gpkg);

        let entry = CatalogEntry {
            id: "headers-layers".into(),
            path,
            tier: Tier::T0,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![TableInfo {
                name: "places".into(),
                data_type: "features".into(),
            }],
        };
        let app = router(test_node(vec![entry]), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::get("/api/packs/headers-layers/layers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-geobase-tier"], "T0");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn features_endpoint_rejects_unknown_nonfeature_and_restricted_tier() {
        let mut entry = create_pack("restricted.gpkg", Some(Tier::T2));
        entry.id = "restricted".into();
        entry.tier = Tier::T2;
        entry.tables = vec![
            TableInfo {
                name: "places".into(),
                data_type: "features".into(),
            },
            TableInfo {
                name: "raster".into(),
                data_type: "2d-gridded-coverage".into(),
            },
        ];
        let app = router(test_node(vec![entry]), &ServerConfig::default());

        let response = app
            .clone()
            .oneshot(
                Request::get("/api/packs/missing/tables/places/features")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app
            .clone()
            .oneshot(
                Request::get("/api/packs/restricted/tables/missing/features")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["x-geobase-tier"], "T2");

        let response = app
            .clone()
            .oneshot(
                Request::get("/api/packs/restricted/tables/raster/features")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = app
            .oneshot(
                Request::get("/api/packs/restricted/tables/places/features")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()["x-geobase-tier"], "T2");
        let body = json_response(response).await;
        assert_eq!(body["tier"], "T2");
        assert_eq!(
            body["reason"],
            "requires the Phase 1.2 permissions ceremony"
        );
    }

    // multi_thread is load-bearing: the raw-socket exchange below is
    // blocking std IO, and on the default current-thread test runtime it
    // would starve the server task forever (the exact hang this test
    // originally shipped with).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn serve_binds_loopback_responds_and_stops() {
        let handle = serve(test_node(Vec::new()), ServerConfig::default())
            .await
            .unwrap();
        assert!(handle.addr.ip().is_loopback());

        let addr = handle.addr;
        let response = tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            write!(
                stream,
                "GET /api/node HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("\"node_id\":\"test-node\""));

        handle.stop().await;
    }

    #[test]
    fn loopback_hostport_parsing_edges() {
        for good in [
            "127.0.0.1:8765",
            "LOCALHOST",
            "[::1]:80",
            "tauri.localhost",
            "[::1]",
        ] {
            assert!(is_loopback_hostport(good), "{good} should be loopback");
        }
        for bad in [
            "[::1]evil.example",
            "[::1]:evil",
            "evil.com@127.0.0.1:80",
            "evil.notlocalhost",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
        ] {
            assert!(!is_loopback_hostport(bad), "{bad} must be rejected");
        }
    }

    #[tokio::test]
    async fn export_route_refuses_without_exports_dir() {
        let app = router(test_node(Vec::new()), &ServerConfig::default());
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_response(response).await;
        assert_eq!(
            body["reason"],
            "exports_dir is not configured for this node"
        );
    }

    /// Build a router with exports enabled behind the A1 token guard plus a
    /// T1 source pack, returning (app, exports_dir, source pack id).
    fn export_guard_fixture(prefix: &str, token: Option<&str>) -> (axum::Router, PathBuf, String) {
        let entry = create_pack(&format!("{prefix}-src.gpkg"), Some(Tier::T1));
        let id = entry.id.clone();
        let exports = temp_path(&format!("{prefix}-exports"));
        let app = router(
            test_node(vec![entry]),
            &ServerConfig {
                exports_dir: Some(exports.clone()),
                at_rest: Some(Arc::new(geobase_gpkg::cipher::DevPlaintextCipher::new())),
                export_token: token.map(String::from),
                ..ServerConfig::default()
            },
        );
        (app, exports, id)
    }

    fn export_body_for(id: &str) -> Value {
        json!({
            "product": "guard-check",
            "source_packs": [id],
            "requester": "guard-test",
            "features": [{
                "geometry": {"type":"Polygon","coordinates":[[[0.0,0.0],[0.001,0.0],[0.001,0.001],[0.0,0.001],[0.0,0.0]]]},
                "score": 0.5
            }]
        })
    }

    /// [A1] Exports enabled with no token configured fail CLOSED (503,
    /// misconfiguration) — never open, never a guessable 403 loop.
    #[tokio::test]
    async fn export_enabled_without_configured_token_fail_closes() {
        let (app, exports, id) = export_guard_fixture("a1-noconf", None);
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_response(response).await;
        assert!(
            body["reason"]
                .as_str()
                .unwrap()
                .contains("no non-empty export token is configured"),
            "reason names the misconfiguration: {body}"
        );
        assert!(
            !exports.join("node-audit.gpkg").exists(),
            "a misconfigured node audits nothing (nothing was refused, \
             nothing was attempted — the route never opened)"
        );
    }

    /// [A1] A missing token is refused 403 BEFORE the ceremony seam, with a
    /// GENERIC `export.refused` audit row (no attacker-controlled identity),
    /// and no product artifact of any kind on disk.
    #[tokio::test]
    async fn export_without_token_refused_with_generic_audit_row() {
        let (app, exports, id) = export_guard_fixture("a1-missing", Some("secret-token"));
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = json_response(response).await;
        assert!(
            body["reason"].as_str().unwrap().contains("export token"),
            "refusal names the guard: {body}"
        );
        let ledger = GeoPackage::open(&exports.join("node-audit.gpkg")).unwrap();
        let trail = ledger.audit_trail().unwrap();
        assert_eq!(trail.len(), 1, "exactly the refusal row");
        assert_eq!(trail[0].action, "export.refused");
        // The row must NOT echo the request's claimed product/requester
        // (review H1): those are attacker-controlled and were never trusted.
        assert_eq!(trail[0].dataset_id, "(unauthenticated export attempt)");
        assert_ne!(
            trail[0].actor, "guard-test",
            "claimed requester must not be trusted"
        );
        assert!(
            trail[0].details["reason"]
                .as_str()
                .unwrap()
                .contains("ceremony seam was never consulted"),
            "the row records that no ceremony ran: {}",
            trail[0].details
        );
        for ext in ["shp", "shx", "dbf", "prj", "tsdf.json"] {
            assert!(
                !exports.join(format!("guard-check.{ext}")).exists(),
                "a token-refused export must write no guard-check.{ext}"
            );
        }
    }

    /// [A1] A wrong token is refused identically to a missing one.
    #[tokio::test]
    async fn export_with_wrong_token_refused() {
        let (app, _exports, id) = export_guard_fixture("a1-wrong", Some("secret-token"));
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(EXPORT_TOKEN_HEADER, "wrong-token!")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    /// [A1 / review B3] An empty configured token is treated as UNCONFIGURED
    /// at the server boundary — an empty header can never authorize. Fails
    /// closed (503), even though the request supplies a matching empty token.
    #[tokio::test]
    async fn empty_configured_token_fail_closes_and_empty_header_never_authorizes() {
        let (app, exports, id) = export_guard_fixture("a1-empty", Some("   "));
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    // An attacker supplying the "matching" empty token.
                    .header(EXPORT_TOKEN_HEADER, "")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_response(response).await;
        assert!(
            body["reason"]
                .as_str()
                .unwrap()
                .contains("no non-empty export token"),
            "an empty configured token is a misconfiguration, not an authorizer: {body}"
        );
        // Nothing was exported and no refusal row was written (the route
        // never reached the guard — it fail-closed on misconfiguration).
        assert!(!exports.join(format!("{id}.shp")).exists());
    }

    /// [A1 / review H1] Malformed JSON WITHOUT a token is refused by the guard
    /// (403), never reaching the body parser — authentication precedes parsing.
    #[tokio::test]
    async fn malformed_body_without_token_is_refused_by_the_guard() {
        let (app, _exports, _id) = export_guard_fixture("a1-malformed", Some("secret-token"));
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{ this is not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 403 (guard), not 400 (parser): the token is checked first.
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn token_matches_is_exact() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", ""));
    }

    /// [review advisory] An exactly-empty (not just whitespace) configured
    /// token fail-closes at the boundary too.
    #[tokio::test]
    async fn exactly_empty_configured_token_fail_closes() {
        let (app, _exports, id) = export_guard_fixture("a1-emptystr", Some(""));
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(EXPORT_TOKEN_HEADER, "")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// [review advisory] A wrong token on a FAIL-CLOSED node (no cipher) is
    /// refused with an honest 503 (the node cannot record the refusal
    /// safely), never a false 403 implying the refusal was audited.
    #[tokio::test]
    async fn wrong_token_on_fail_closed_node_returns_503_not_false_403() {
        // No `at_rest` cipher configured → FailClosedCipher refuses the T3
        // ledger write, so the refusal cannot be recorded.
        let entry = create_pack("a1-failclosed-src.gpkg", Some(Tier::T1));
        let id = entry.id.clone();
        let exports = temp_path("a1-failclosed-exports");
        let app = router(
            test_node(vec![entry]),
            &ServerConfig {
                exports_dir: Some(exports.clone()),
                export_token: Some("secret-token".into()),
                // at_rest: None -> FailClosedCipher by default.
                ..ServerConfig::default()
            },
        );
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(EXPORT_TOKEN_HEADER, "wrong")
                    .body(Body::from(export_body_for(&id).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_response(response).await;
        assert!(
            body["reason"].as_str().unwrap().contains("fail-closed"),
            "the 503 names the fail-closed cause honestly: {body}"
        );
        // No ledger was created — the node could not even record the refusal.
        assert!(!exports.join("node-audit.gpkg").exists());
    }

    #[tokio::test]
    async fn export_route_exports_t2_product_end_to_end() {
        // A T1 source pack with one polygon feature table.
        let path = temp_path("export-src.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "capacity".into(),
                identifier: "Capacity".into(),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POLYGON".into(),
                columns: Vec::new(),
                bounds: (0.0, 0.0, 1.0, 1.0),
            },
        )
        .unwrap();
        drop(gpkg);
        let entry = CatalogEntry {
            id: "capacity-2026".into(),
            path,
            tier: Tier::T1,
            tagged: true,
            tsdf_version: Some("0.9.4".into()),
            tables: vec![TableInfo {
                name: "capacity".into(),
                data_type: "features".into(),
            }],
        };
        let exports_dir = temp_path("exports-route");
        // B3: the sovereign gate is composed, so the export requires a
        // RECORDED agreement covering the witnessed source set, bound to
        // the authenticated (interim A1) operator identity. Seed the
        // consent store the way the local operator would.
        {
            use geobase_gpkg::consent::{Conditions, ConsentBasis, Sha256Digest, UtcInstant};
            use geobase_gpkg::consent_store::{AgreementKind, AgreementRecord, ConsentStore};
            let store = ConsentStore::open_or_create(
                &exports_dir,
                "0.9.4",
                "vendored:embedded",
                &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            )
            .unwrap();
            let now = UtcInstant::now().unwrap();
            let evidence = ConsentBasis::signed_agreement(
                "agreements/route-test.pdf",
                Sha256Digest::from_hex(&"ab".repeat(32)).unwrap(),
                now,
                now,
            )
            .unwrap();
            store
                .record_agreement(
                    &AgreementRecord {
                        agreement_id: "route-agreement-1".into(),
                        kind: AgreementKind::TribalSigned,
                        source_scope: vec!["capacity-2026".into()],
                        product_class: "painted-opportunity-shapefile".into(),
                        evidence,
                        authority_of_record: "Example Signatory, Example Nation".into(),
                        requester_binding: super::interim_operator_identity(),
                        conditions: Conditions::default(),
                        recorded_by: super::interim_operator_identity(),
                    },
                    None,
                    false,
                )
                .unwrap();
        }
        let app = router(
            test_node(vec![entry]),
            &ServerConfig {
                exports_dir: Some(exports_dir.clone()),
                // Dev test node: opt into the dev cipher so the ledger writes
                // (stamped UNENCRYPTED-DEV). The fail-closed default is
                // exercised separately by the egress gate (A7).
                at_rest: Some(Arc::new(geobase_gpkg::cipher::DevPlaintextCipher::new())),
                export_token: Some("route-token".into()),
                ..ServerConfig::default()
            },
        );
        // 1. Obtain a node-witnessed session.
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/sessions")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let session = json_response(response).await["session"]
            .as_str()
            .unwrap()
            .to_string();
        // 2. Serve the source pack INTO the session — the node witnesses it.
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/packs/capacity-2026/tables/capacity/features")
                    .header(header::HOST, "127.0.0.1")
                    .header(crate::session::SESSION_HEADER, session.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // 3. Export against the session.
        let body = json!({
            "product": "route-site",
            "session": session.clone(),
            "features": [{
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.001], [0.0, 0.0]]],
                },
                "score": 0.8,
            }],
        });
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(EXPORT_TOKEN_HEADER, "route-token")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-geobase-tier"], "T2");
        let payload = json_response(response).await;
        assert_eq!(payload["tier"], "T2");
        assert_eq!(payload["features"], 1);
        assert!(payload["files"]["shp"]["sha256"].is_string());
        assert_eq!(
            payload["files"]["tsdf_json"]["name"],
            "route-site.tsdf.json"
        );
        // The SOVEREIGN record, never the provisional wording (B3).
        assert_eq!(
            payload["ceremony"]["process"],
            geobase_gpkg::ceremony::SOVEREIGN_PROCESS
        );
        assert_eq!(
            payload["ceremony"]["basis"],
            geobase_gpkg::ceremony::SOVEREIGN_BASIS
        );
        assert!(payload["publication_id"].is_string());
        // The bundle publishes as a directory (B3 publication protocol).
        assert!(exports_dir
            .join("route-site")
            .join("route-site.shp")
            .is_file());
        assert!(exports_dir.join("node-audit.gpkg").is_file());

        // Same product name again -> 409, no overwrite through the API.
        let response = app
            .oneshot(
                Request::post("/api/export")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(EXPORT_TOKEN_HEADER, "route-token")
                    .body(Body::from(
                        json!({
                            "product": "route-site",
                            // Sessions are reusable: the same witnessed
                            // session backs the duplicate attempt.
                            "session": session,
                            "features": [{
                                "geometry": {
                                    "type": "Polygon",
                                    "coordinates": [[[0.01, 0.0], [0.011, 0.0], [0.011, 0.001], [0.01, 0.001], [0.01, 0.0]]],
                                },
                                "score": 0.5,
                            }],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn preflight_options_answers_loopback_origins_only() {
        let app = router(test_node(Vec::new()), &ServerConfig::default());
        let request = axum::http::Request::builder()
            .method(axum::http::Method::OPTIONS)
            .uri("/api/export")
            .header(header::HOST, "127.0.0.1:8765")
            .header(header::ORIGIN, "http://localhost:4173")
            .body(Body::empty())
            .unwrap();
        let response = tower::ServiceExt::oneshot(app.clone(), request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:4173"
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "GET, POST"
        );
        // The A1 export token header must be preflight-approved or the
        // browser never sends it and every RStep export dies as a 403.
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "content-type, x-geobase-export-token, x-geobase-session"
        );

        let foreign = axum::http::Request::builder()
            .method(axum::http::Method::OPTIONS)
            .uri("/api/export")
            .header(header::HOST, "127.0.0.1:8765")
            .header(header::ORIGIN, "https://evil.example")
            .body(Body::empty())
            .unwrap();
        let response = tower::ServiceExt::oneshot(app, foreign).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn guard_refuses_non_loopback_host_and_origin() {
        let app = router(test_node(Vec::new()), &ServerConfig::default());
        let rebind = axum::http::Request::builder()
            .uri("/api/node")
            .header(header::HOST, "evil.example:8765")
            .body(Body::empty())
            .unwrap();
        let response = tower::ServiceExt::oneshot(app.clone(), rebind)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let foreign = axum::http::Request::builder()
            .uri("/api/node")
            .header(header::HOST, "127.0.0.1:8765")
            .header(header::ORIGIN, "https://evil.example")
            .body(Body::empty())
            .unwrap();
        let response = tower::ServiceExt::oneshot(app, foreign).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn guard_echoes_loopback_origins_only() {
        for origin in [
            "http://localhost:4174",
            "http://127.0.0.1:5173",
            "http://tauri.localhost",
            "tauri://localhost",
        ] {
            let app = router(test_node(Vec::new()), &ServerConfig::default());
            let request = axum::http::Request::builder()
                .uri("/api/node")
                .header(header::HOST, "localhost:8765")
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap();
            let response = tower::ServiceExt::oneshot(app, request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "origin {origin}");
            assert_eq!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .and_then(|v| v.to_str().ok()),
                Some(origin),
                "ACAO must echo {origin}"
            );
        }
    }

    fn gpkg_point_blob(x: f64, y: f64) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(b"GP");
        blob.push(0);
        blob.push(1);
        blob.extend_from_slice(&4326_i32.to_le_bytes());
        blob.push(1);
        blob.extend_from_slice(&1_u32.to_le_bytes());
        blob.extend_from_slice(&x.to_le_bytes());
        blob.extend_from_slice(&y.to_le_bytes());
        blob
    }
}
