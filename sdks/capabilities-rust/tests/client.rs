// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Contract tests for the SynapseDX Tier-2 Rust client.

use serde_json::json;
use std::time::Duration;
use synapsedx::{Client, Credentials, DatasetListQuery, RecordQuery, RequestOptions};
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(server: &MockServer) -> Client {
    Client::builder(server.uri())
        .credentials(Credentials::api_key("dx-key").with_token("user-jwt"))
        .tenant("acme")
        .product("city")
        .retries(0)
        .build()
        .unwrap()
}

fn opts() -> RequestOptions {
    RequestOptions::new()
}

#[tokio::test]
async fn sends_auth_tenant_product_and_correlation_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/health"))
        .and(header("authorization", "Bearer user-jwt"))
        .and(header("x-api-key", "dx-key"))
        .and(header("x-synapseone-tenant", "acme"))
        .and(header("x-synapsedx-product", "city"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "ok",
            "service": "capabilities",
            "tier": 2,
            "version": "0.7.0",
            "dependencies": [],
            "time": "2026-11-13T00:00:00Z"
        })))
        .mount(&server)
        .await;

    let report = client(&server).health(&opts()).await.unwrap();
    assert_eq!(report.status, "ok");

    let requests = server.received_requests().await.unwrap();
    let correlation = requests[0]
        .headers
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .unwrap();
    assert!(!correlation.is_empty());
}

#[tokio::test]
async fn dataset_page_uses_pagination_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/datasets"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-total-count", "42")
                .insert_header("x-limit", "10")
                .insert_header("x-offset", "20")
                .insert_header("x-next-cursor", "cursor-2")
                .set_body_json(json!([{
                    "id": "d1",
                    "slug": "roads",
                    "name": "Roads",
                    "entityType": "Road",
                    "license": "CC-BY-4.0",
                    "public": true,
                    "status": "published",
                    "createdAt": "2026-11-13T00:00:00Z",
                    "updatedAt": "2026-11-13T00:00:00Z"
                }])),
        )
        .mount(&server)
        .await;

    let page = client(&server)
        .datasets()
        .list_page(DatasetListQuery::new().limit(10).offset(20), &opts())
        .await
        .unwrap();
    assert_eq!(page.total, 42);
    assert_eq!(page.limit, 10);
    assert_eq!(page.offset, 20);
    assert_eq!(page.next_cursor.as_deref(), Some("cursor-2"));
    assert_eq!(page.items[0].slug, "roads");
}

#[tokio::test]
async fn record_create_sets_idempotency_and_if_match() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/capabilities/datasets/d1/records"))
        .and(header("idempotency-key", "idem-1"))
        .and(header("if-match", "\"2\""))
        .and(body_partial_json(json!({
            "data": { "name": "New road" },
            "id": "r1",
            "publish": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": "r1",
            "data": { "name": "New road" },
            "version": 3,
            "published": true,
            "createdAt": "2026-11-13T00:00:00Z",
            "updatedAt": "2026-11-13T00:00:00Z"
        })))
        .mount(&server)
        .await;

    let request_opts = RequestOptions::new()
        .idempotency_key("idem-1")
        .if_version(2);
    let record = client(&server)
        .records()
        .create(
            "d1",
            json!({ "name": "New road" }),
            Some("r1"),
            Some(true),
            &request_opts,
        )
        .await
        .unwrap();
    assert_eq!(record.id, "r1");
    assert_eq!(record.version, 3);
}

#[tokio::test]
async fn record_query_posts_filter_and_limit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/capabilities/datasets/d1/records/query"))
        .and(body_partial_json(json!({
            "where": { "status": "new" },
            "limit": 5
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [],
            "total": 0,
            "limit": 5,
            "offset": 0,
            "nextCursor": null
        })))
        .mount(&server)
        .await;

    let page = client(&server)
        .records()
        .query(
            "d1",
            RecordQuery::new()
                .filter(json!({ "status": "new" }))
                .limit(5),
            &opts(),
        )
        .await
        .unwrap();
    assert_eq!(page.total, 0);
}

#[tokio::test]
async fn exposes_error_envelope_and_request_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/datasets/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": {
                "code": "not_found",
                "message": "dataset not found",
                "requestId": "req-123",
                "details": { "id": "missing" }
            }
        })))
        .mount(&server)
        .await;

    let error = client(&server)
        .datasets()
        .get("missing", &opts())
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(404));
    assert_eq!(error.code(), Some("not_found"));
    assert_eq!(error.request_id(), Some("req-123"));
    assert!(error.is_not_found());
}

#[tokio::test]
async fn retries_server_errors_when_idempotent() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/retry"))
        .respond_with(ResponseTemplate::new(503).set_body_string("down"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/retry"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .mount(&server)
        .await;

    let client = Client::builder(server.uri())
        .credentials(Credentials::none())
        .retries(1)
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let value = client.get("/v1/capabilities/retry", &opts()).await.unwrap();
    assert_eq!(value["ok"], true);
}

#[tokio::test]
async fn public_file_drops_credentials() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/capabilities/public/files/f1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "f1",
            "name": "public.pdf",
            "createdAt": "2026-11-13T00:00:00Z"
        })))
        .mount(&server)
        .await;

    client(&server)
        .files()
        .public_get("f1", &opts())
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap();
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(!requests[0].headers.contains_key("x-api-key"));
}
