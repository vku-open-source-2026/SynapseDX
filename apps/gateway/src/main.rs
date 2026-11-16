// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseDX public gateway in Rust.
//!
//! The gateway is a transparent HTTPS boundary in front of the capabilities
//! service: it forwards the caller credentials and conditional/idempotency
//! headers, streams request bodies unchanged, enforces an upstream timeout,
//! and answers CORS for both Tier-3 origins.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{HeaderValue, CONTENT_TYPE};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use bytes::Bytes;
use chrono::Utc;
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

pub const DEFAULT_CORS_ORIGINS: &[&str] = &[
    "https://synapsecity.sbs",
    "https://sos.synapsecity.sbs",
    "https://synapsedx.sbs",
    "https://cloud.synapsedx.sbs",
];

pub const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "idempotency-key",
    "if-match",
    "if-none-match",
    "last-event-id",
    "traceparent",
    "x-api-key",
    "x-correlation-id",
    "x-idempotency-key",
    "x-request-id",
    "x-synapseone-tenant",
    "x-synapsedx-product",
    "x-checksum-sha256",
    "x-file-name",
    // Server-to-server layout credentials must survive the public boundary.
    // Deliberately absent from browser CORS headers.
    "x-workspace-token",
    // App context selects the Common workspace; backend verifies membership.
    "x-workspace-app",
];

pub const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "cache-control",
    "content-disposition",
    "content-type",
    "etag",
    "link",
    "location",
    "retry-after",
    "www-authenticate",
    "x-correlation-id",
    "x-event-status",
    "x-lds-context",
    "x-lds-datasource",
    "x-lds-license",
    "x-lds-total",
    "x-limit",
    "x-next-cursor",
    "x-offset",
    "x-request-id",
    "x-total-count",
];

pub const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

#[derive(Clone)]
pub struct AppState {
    pub upstream: String,
    pub timeout: Duration,
    pub cors_origins: Vec<String>,
    pub client: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct CorrelationId(pub String);

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || (octets[0] == 100 && (64..=127).contains(&octets[1])) // CGNAT 100.64/10
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_private_ipv4(mapped);
    }
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
        || (segments[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
}

/// Mirror the capabilities-service `isPrivateHost()` policy: loopback,
/// RFC1918/CGNAT/link-local/metadata, IPv6 ULA/link-local, Docker service names
/// and internal DNS suffixes never belong in a production upstream URL.
fn is_private_host(raw: &str) -> bool {
    let host = raw
        .trim()
        .trim_matches(&['[', ']'][..])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    for suffix in [
        ".local",
        ".localdomain",
        ".internal",
        ".intranet",
        ".corp",
        ".lan",
        ".home.arpa",
        ".svc",
        ".consul",
        ".cluster.local",
        ".docker.internal",
    ] {
        if host == suffix.trim_start_matches('.') || host.ends_with(suffix) {
            return true;
        }
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_private_ipv4(v4),
            IpAddr::V6(v6) => is_private_ipv6(v6),
        };
    }
    // A single-label host resolves only inside the container/private network.
    !host.contains('.')
}

fn validate_upstream(raw: &str, is_prod: bool, allow_local: bool) -> Result<String, String> {
    let parsed = Url::parse(raw).map_err(|e| format!("CAPABILITIES_SERVICE_URL is not an absolute URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("CAPABILITIES_SERVICE_URL must be an HTTP(S) URL".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("CAPABILITIES_SERVICE_URL must not contain credentials".into());
    }
    if parsed.fragment().is_some() {
        return Err("CAPABILITIES_SERVICE_URL must not contain a fragment".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("CAPABILITIES_SERVICE_URL must include a host".into());
    }
    if is_private_host(host) && !allow_local {
        return Err(
            "CAPABILITIES_SERVICE_URL may not point to a private/loopback/internal host (set ALLOW_LOCAL_DEPENDENCIES=true only for a trusted container network or tests)"
                .into(),
        );
    }
    if parsed.scheme() != "https" && !allow_local {
        return Err("CAPABILITIES_SERVICE_URL must use HTTPS outside tests".into());
    }
    // `is_prod` is retained in the signature for callers/tests that pass the
    // deployment mode; the host policy is strict in every mode.
    let _ = is_prod;
    Ok(raw.trim_end_matches('/').to_string())
}

fn parse_cors_origins() -> Vec<String> {
    let mut origins = Vec::new();
    for key in &["CORS_ORIGINS", "CORS_ORIGIN"] {
        if let Ok(val) = std::env::var(key) {
            for part in val.split(',') {
                let trimmed = part.trim().trim_end_matches('/');
                if !trimmed.is_empty() && !origins.iter().any(|o: &String| o == trimmed) {
                    origins.push(trimmed.to_string());
                }
            }
        }
    }
    if origins.is_empty() {
        DEFAULT_CORS_ORIGINS.iter().map(|s| s.to_string()).collect()
    } else {
        origins
    }
}

pub fn create_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(ready_handler))
        .route("/v1/capabilities", any(proxy_handler))
        .route("/v1/capabilities/{*path}", any(proxy_handler))
        .fallback(fallback_handler)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors_and_headers_middleware,
        ))
        .with_state(state)
}

async fn cors_and_headers_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let incoming_corr = req
        .headers()
        .get("x-correlation-id")
        .or_else(|| req.headers().get("x-request-id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string());

    let corr_id = match incoming_corr {
        Some(ref val) if !val.is_empty() && val.len() <= 200 && val.bytes().all(|b| (0x20..=0x7E).contains(&b)) => {
            val.clone()
        }
        _ => Uuid::new_v4().to_string(),
    };

    req.extensions_mut().insert(CorrelationId(corr_id.clone()));

    // Check CORS
    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_end_matches('/').to_string());

    let is_allowed_origin = origin
        .as_ref()
        .map(|o| state.cors_origins.iter().any(|allowed| allowed == o))
        .unwrap_or(false);

    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        let headers = res.headers_mut();
        headers.insert("vary", HeaderValue::from_static("Origin"));
        if is_allowed_origin {
            if let Some(ref o) = origin {
                if let Ok(val) = HeaderValue::from_str(o) {
                    headers.insert("access-control-allow-origin", val);
                    headers.insert("access-control-allow-credentials", HeaderValue::from_static("true"));
                }
            }
        }
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
        );
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static(
                "accept,authorization,content-type,idempotency-key,if-match,if-none-match,\
                 last-event-id,x-api-key,x-correlation-id,x-request-id,x-idempotency-key,\
                 x-synapseone-tenant,x-synapsedx-product,x-checksum-sha256,x-workspace-app,x-file-name",
            ),
        );
        headers.insert(
            "access-control-expose-headers",
            HeaderValue::from_static(
                "etag,link,retry-after,www-authenticate,x-correlation-id,x-request-id,\
                 x-total-count,x-limit,x-offset,x-next-cursor,x-event-status,\
                 x-lds-license,x-lds-datasource,x-lds-total,x-lds-context,\
                 x-spatial-field,x-spatial-collection,\
                 x-checksum-sha256,content-disposition,cache-control",
            ),
        );
        headers.insert("access-control-max-age", HeaderValue::from_static("600"));
        return res;
    }

    let mut res = next.run(req).await;
    let headers = res.headers_mut();

    headers.insert("vary", HeaderValue::from_static("Origin"));
    if is_allowed_origin {
        if let Some(ref o) = origin {
            if let Ok(val) = HeaderValue::from_str(o) {
                headers.insert("access-control-allow-origin", val);
                headers.insert("access-control-allow-credentials", HeaderValue::from_static("true"));
            }
        }
    }
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static(
            "accept,authorization,content-type,idempotency-key,if-match,if-none-match,\
             last-event-id,x-api-key,x-correlation-id,x-request-id,x-idempotency-key,\
             x-synapseone-tenant,x-synapsedx-product,x-checksum-sha256,x-workspace-app",
        ),
    );
    headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static(
            "etag,link,retry-after,www-authenticate,x-correlation-id,x-request-id,\
             x-total-count,x-limit,x-offset,x-next-cursor,x-event-status,\
             x-lds-license,x-lds-datasource,x-lds-total,x-lds-context,\
             x-spatial-field,x-spatial-collection,\
             x-checksum-sha256,content-disposition,cache-control",
        ),
    );
    headers.insert("access-control-max-age", HeaderValue::from_static("600"));

    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));

    if let Ok(val) = HeaderValue::from_str(&corr_id) {
        headers.insert("x-correlation-id", val.clone());
        headers.insert("x-request-id", val);
    }

    res
}

async fn health_handler(State(state): State<AppState>, req: Request) -> Response {
    let corr_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let target_url = format!("{}/health", state.upstream);
    let upstream_req = state
        .client
        .get(&target_url)
        .header("x-correlation-id", &corr_id)
        .timeout(state.timeout)
        .send()
        .await;

    match upstream_req {
        Ok(res) => {
            let status = res.status();
            let is_ok = status.is_success();
            let text = res.text().await.unwrap_or_default();
            let upstream_body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|_| json!({ "raw": text.chars().take(200).collect::<String>() }));

            let reported_status = if is_ok {
                upstream_body
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ok")
            } else {
                "degraded"
            };

            let body = json!({
                "status": reported_status,
                "service": "synapsedx-gateway",
                "dependencies": [{
                    "name": "capabilities",
                    "status": if is_ok { "ok" } else { "down" },
                    "critical": true
                }],
                "upstream": upstream_body,
                "time": Utc::now().to_rfc3339()
            });

            let status_code = if is_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
            (status_code, [("content-type", "application/json")], body.to_string()).into_response()
        }
        Err(err) => {
            let error_kind = if err.is_timeout() { "timeout" } else { "unreachable" };
            let body = json!({
                "status": "down",
                "service": "synapsedx-gateway",
                "dependencies": [{
                    "name": "capabilities",
                    "status": "down",
                    "critical": true,
                    "error": error_kind
                }],
                "time": Utc::now().to_rfc3339()
            });
            (StatusCode::SERVICE_UNAVAILABLE, [("content-type", "application/json")], body.to_string()).into_response()
        }
    }
}

async fn ready_handler(State(state): State<AppState>, req: Request) -> Response {
    let corr_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let target_url = format!("{}/ready", state.upstream);
    let upstream_req = state
        .client
        .get(&target_url)
        .header("x-correlation-id", &corr_id)
        .timeout(state.timeout)
        .send()
        .await;

    match upstream_req {
        Ok(res) => {
            let is_ok = res.status().is_success();
            let text = res.text().await.unwrap_or_default();
            let upstream_body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|_| json!({ "raw": text.chars().take(200).collect::<String>() }));

            let body = json!({
                "status": if is_ok { "ready" } else { "degraded" },
                "service": "synapsedx-gateway",
                "dependencies": [{
                    "name": "capabilities",
                    "status": if is_ok { "ok" } else { "down" },
                    "critical": true
                }],
                "upstream": upstream_body,
                "time": Utc::now().to_rfc3339()
            });

            let status_code = if is_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
            (status_code, [("content-type", "application/json")], body.to_string()).into_response()
        }
        Err(err) => {
            let error_kind = if err.is_timeout() { "timeout" } else { "unreachable" };
            let body = json!({
                "status": "degraded",
                "service": "synapsedx-gateway",
                "dependencies": [{
                    "name": "capabilities",
                    "status": "down",
                    "critical": true,
                    "error": error_kind
                }],
                "time": Utc::now().to_rfc3339()
            });
            (StatusCode::SERVICE_UNAVAILABLE, [("content-type", "application/json")], body.to_string()).into_response()
        }
    }
}

async fn proxy_handler(State(state): State<AppState>, req: Request) -> Response {
    let corr_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let method = req.method().clone();
    let uri = req.uri().clone();
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or(uri.path());
    let target_url = format!("{}{}", state.upstream, path_and_query);
    // Server-Sent Events are long-lived by design. A total request timeout
    // would terminate every stream at UPSTREAM_TIMEOUT_MS, so the SSE route is
    // exempt and relies on the client/upstream heartbeat to detect failure.
    let is_event_stream = uri.path() == "/v1/capabilities/events/stream";

    let mut upstream_req = state.client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &target_url,
    );

    // Filter and set request headers
    for &h_name in FORWARDED_REQUEST_HEADERS {
        if let Some(h_val) = req.headers().get(h_name) {
            upstream_req = upstream_req.header(h_name, h_val);
        }
    }
    upstream_req = upstream_req
        .header("x-correlation-id", &corr_id)
        .header("x-request-id", &corr_id);
    if !is_event_stream {
        upstream_req = upstream_req.timeout(state.timeout);
    }

    // Stream / pass body if not GET / HEAD
    if method != Method::GET && method != Method::HEAD {
        let body_bytes = match axum::body::to_bytes(req.into_body(), 26_214_400).await {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    [("content-type", "application/json")],
                    json!({
                        "error": {
                            "code": "payload_too_large",
                            "message": format!("request body exceeds limit: {e}"),
                            "requestId": corr_id
                        }
                    })
                    .to_string(),
                )
                    .into_response();
            }
        };
        if !body_bytes.is_empty() {
            upstream_req = upstream_req.body(body_bytes);
        }
    }

    match upstream_req.send().await {
        Ok(res) => {
            let upstream_status = res.status();
            let mut response_builder = Response::builder().status(
                StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            );

            let res_headers = response_builder.headers_mut().unwrap();
            for (name, value) in res.headers() {
                let name_lower = name.as_str().to_ascii_lowercase();
                if HOP_BY_HOP.contains(&name_lower.as_str()) {
                    if method == Method::HEAD && name_lower == "content-length" {
                        res_headers.insert(name.clone(), value.clone());
                    }
                    continue;
                }
                if FORWARDED_RESPONSE_HEADERS.contains(&name_lower.as_str()) || name_lower.starts_with("x-") {
                    res_headers.insert(name.clone(), value.clone());
                }
            }

            if method == Method::HEAD {
                return response_builder.body(Body::empty()).unwrap();
            }

            // Never buffer an event stream: forward chunks as they arrive so
            // heartbeat and event latency survive the public gateway.
            let is_sse_response = res
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
                .unwrap_or(false);
            if is_sse_response {
                return response_builder
                    .body(Body::from_stream(res.bytes_stream()))
                    .unwrap();
            }

            let body_bytes = res.bytes().await.unwrap_or_else(|_| Bytes::new());
            response_builder.body(Body::from(body_bytes)).unwrap()
        }
        Err(err) => {
            if err.is_timeout() {
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    [("content-type", "application/json")],
                    json!({
                        "error": {
                            "code": "upstream_timeout",
                            "message": "the capabilities service did not respond in time",
                            "requestId": corr_id
                        }
                    })
                    .to_string(),
                )
                    .into_response()
            } else {
                (
                    StatusCode::BAD_GATEWAY,
                    [("content-type", "application/json")],
                    json!({
                        "error": {
                            "code": "upstream_unavailable",
                            "message": "the capabilities service is unavailable",
                            "requestId": corr_id
                        }
                    })
                    .to_string(),
                )
                    .into_response()
            }
        }
    }
}

async fn fallback_handler(req: Request) -> Response {
    let corr_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    (
        StatusCode::NOT_FOUND,
        [("content-type", "application/json")],
        json!({
            "error": {
                "code": "route_not_found",
                "message": "Route not found",
                "requestId": corr_id
            }
        })
        .to_string(),
    )
        .into_response()
}

async fn check_health_cli(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/health");
    match client.get(&url).send().await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);

    if std::env::args().any(|arg| arg == "--healthcheck") {
        let ok = check_health_cli(port).await;
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,synapsedx_gateway=info")),
        )
        .init();

    let node_env = std::env::var("NODE_ENV").unwrap_or_default();
    let is_prod = node_env == "production";
    let allow_local = std::env::var("ALLOW_LOCAL_DEPENDENCIES")
        .map(|v| v == "true")
        .unwrap_or(false);

    let raw_upstream = std::env::var("CAPABILITIES_SERVICE_URL")
        .unwrap_or_else(|_| "http://capabilities:8082".to_string());
    let upstream = validate_upstream(&raw_upstream, is_prod, allow_local)?;

    let timeout_ms = std::env::var("UPSTREAM_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000);
    let timeout = Duration::from_millis(timeout_ms);

    let cors_origins = parse_cors_origins();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let state = AppState {
        upstream: upstream.clone(),
        timeout,
        cors_origins,
        client,
    };

    let app = create_app(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("[synapsedx-gateway] listening on :{} (upstream: {})", port, upstream);
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    #[tokio::test]
    async fn native_upload_forwards_filename_app_and_binary_body() {
        let bytes = vec![173u8; 3 * 1024 * 1024];
        let upstream = Router::new().fallback(any(|request: Request| async move {
            assert_eq!(request.headers()["x-file-name"], "T%C3%A0i%20li%E1%BB%87u.csv");
            assert_eq!(request.headers()["x-workspace-app"], "city");
            assert_eq!(request.headers()["content-type"], "text/csv");
            let received = axum::body::to_bytes(request.into_body(), 4 * 1024 * 1024).await.unwrap();
            assert_eq!(received.len(), 3 * 1024 * 1024);
            assert!(received.iter().all(|b| *b == 173));
            StatusCode::CREATED
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let gateway = create_app(AppState { upstream: format!("http://{address}"), timeout: Duration::from_secs(5), cors_origins: vec!["https://synapsedx.sbs".into()], client: reqwest::Client::new() });
        let result = gateway.clone().oneshot(HttpRequest::builder().method("POST")
            .uri("/v1/capabilities/workspaces/installed/page/widgets/form/upload?action=upload")
            .header("x-file-name", "T%C3%A0i%20li%E1%BB%87u.csv").header("x-workspace-app", "city")
            .header("content-type", "text/csv").body(Body::from(bytes)).unwrap()).await.unwrap();
        assert_eq!(result.status(), StatusCode::CREATED);
        let preflight = gateway.oneshot(HttpRequest::builder().method("OPTIONS").uri("/v1/capabilities/files")
            .header("origin", "https://synapsedx.sbs").header("access-control-request-headers", "x-file-name")
            .body(Body::empty()).unwrap()).await.unwrap();
        assert!(preflight.headers()["access-control-allow-headers"].to_str().unwrap().contains("x-file-name"));
        task.abort();
    }

    #[tokio::test]
    async fn forwards_common_workspace_app_context_and_allows_browser_preflight() {
        let upstream = Router::new().fallback(any(|request: Request| async move {
            request.headers().get("x-workspace-app").and_then(|value|value.to_str().ok()).unwrap_or("missing").to_string()
        }));
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address=listener.local_addr().unwrap();
        let task=tokio::spawn(async move {axum::serve(listener,upstream).await.unwrap()});
        let gateway=create_app(AppState {upstream:format!("http://{address}"),timeout:Duration::from_secs(2),cors_origins:vec!["https://synapsedx.sbs".into()],client:reqwest::Client::new()});
        for app in ["city","sos"] {
            let result=gateway.clone().oneshot(HttpRequest::builder().uri("/v1/capabilities/projects").header("x-workspace-app",app).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(result.status(),StatusCode::OK);
            let body=axum::body::to_bytes(result.into_body(),1024).await.unwrap();
            assert_eq!(body.as_ref(),app.as_bytes());
        }
        let result=gateway.oneshot(HttpRequest::builder().method("OPTIONS").uri("/v1/capabilities/projects").header("origin","https://synapsedx.sbs").header("access-control-request-method","GET").header("access-control-request-headers","x-workspace-app").body(Body::empty()).unwrap()).await.unwrap();
        assert!(result.status().is_success());
        assert!(result.headers().get("access-control-allow-headers").unwrap().to_str().unwrap().contains("x-workspace-app"));
        task.abort();
    }

    #[tokio::test]
    async fn forwards_workspace_token_through_public_gateway() {
        let upstream = Router::new().fallback(any(|request: Request| async move {
            if request.headers().get("x-workspace-token").and_then(|v| v.to_str().ok())
                == Some("test-layout-credential")
            {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::UNAUTHORIZED
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let gateway = create_app(AppState {
            upstream: format!("http://{address}"),
            timeout: Duration::from_secs(2),
            cors_origins: vec!["https://synapsedx.sbs".into()],
            client: reqwest::Client::new(),
        });
        let result = gateway.oneshot(HttpRequest::builder()
            .uri("/v1/capabilities/workspaces/runtime/city")
            .header("x-workspace-token", "test-layout-credential")
            .body(Body::empty()).unwrap()).await.unwrap();
        task.abort();
        assert_eq!(result.status(), StatusCode::NO_CONTENT);
        assert!(!result.headers().get("access-control-allow-headers").unwrap()
            .to_str().unwrap().contains("x-workspace-token"));
    }

    #[tokio::test]
    async fn forwards_sse_frames_without_buffering_the_content_type() {
        let upstream = Router::new().fallback(any(|request: Request| async move {
            assert_eq!(request.headers()["last-event-id"], "42-0");
            (
                StatusCode::OK,
                [("content-type", "text/event-stream; charset=utf-8")],
                "id: 43-0\nevent: capability\ndata: {\"ok\":true}\n\n",
            )
                .into_response()
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let gateway = create_app(AppState {
            upstream: format!("http://{address}"),
            timeout: Duration::from_secs(2),
            cors_origins: vec!["https://synapsedx.sbs".into()],
            client: reqwest::Client::new(),
        });
        let result = gateway
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/v1/capabilities/events/stream?type=record.created")
                    .header("last-event-id", "42-0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        assert!(result.headers()[CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
        let body = axum::body::to_bytes(result.into_body(), 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("event: capability"));
        let preflight = gateway
            .oneshot(
                HttpRequest::builder()
                    .method("OPTIONS")
                    .uri("/v1/capabilities/events/stream")
                    .header("origin", "https://synapsedx.sbs")
                    .header("access-control-request-headers", "last-event-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(preflight.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("last-event-id"));
        task.abort();
    }

    #[test]
    fn upstream_validation_rejects_private_metadata_and_plain_http_targets() {
        for target in [
            "http://capabilities:8082",
            "http://127.0.0.1:8082",
            "https://127.0.0.1:8082",
            "https://[::1]:8082",
            "http://169.254.169.254/latest/meta-data",
            "https://10.0.0.5:8082",
            "https://192.168.1.10",
            "https://172.16.0.5",
            "https://metadata.google.internal",
            "https://postgres:5432",
            "https://user:pass@example.com",
        ] {
            assert!(
                validate_upstream(target, true, false).is_err(),
                "{target} must be rejected as a production upstream"
            );
        }
        assert!(validate_upstream("http://example.com", true, false).is_err());
        assert_eq!(
            validate_upstream("https://capabilities.synapsedx.sbs/", true, false).unwrap(),
            "https://capabilities.synapsedx.sbs"
        );
        // Tests and a trusted container network must opt in explicitly.
        assert!(validate_upstream("http://capabilities:8082", true, true).is_ok());
        assert!(validate_upstream("http://127.0.0.1:8082", false, true).is_ok());
    }
}
