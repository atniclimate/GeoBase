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
use geobase_gpkg::GeoPackage;
use geobase_tsdf::Tier;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

use crate::Node;

/// Server configuration. `port: 0` binds an ephemeral port (tests).
#[derive(Debug, Clone, Default)]
pub struct ServerConfig {
    pub port: u16,
    /// Pre-derived T0 tile pyramid directory (optional until wave 2 wiring).
    pub tiles_dir: Option<PathBuf>,
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
}

#[derive(Clone)]
struct ServerState {
    node: Arc<Node>,
}

/// Build the router for `node` (pure; unit-testable via tower `oneshot`).
pub fn router(node: Arc<Node>, config: &ServerConfig) -> axum::Router {
    let state = ServerState { node };
    let mut router = axum::Router::new()
        .route("/api/node", get(api_node))
        .route("/api/packs", get(api_packs))
        .route("/api/packs/{id}/layers", get(api_pack_layers))
        .route(
            "/api/packs/{id}/tables/{table}/features",
            get(api_pack_table_features),
        )
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
    let mut response = next.run(req).await;
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

async fn api_pack_layers(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
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

async fn api_pack_table_features(
    State(state): State<ServerState>,
    Path((id, table)): Path<(String, String)>,
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
