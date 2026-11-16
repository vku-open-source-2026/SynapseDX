// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP transport for the SynapseDX Tier-2 capabilities API.

use crate::error::{Error, Result};
use bytes::Bytes;
use http::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER,
};
use http::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

/// Public production endpoint.
pub const DEFAULT_BASE_URL: &str = "https://synapsedx.sbs";
/// Default timeout, matching the JS client.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
/// Default number of retries (in addition to the first attempt).
pub const DEFAULT_RETRIES: u32 = 1;

/// Credentials accepted by Tier 2.
#[derive(Clone, Default)]
pub struct Credentials {
    token: Option<String>,
    api_key: Option<String>,
}

impl Credentials {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn token(token: impl Into<String>) -> Self {
        Self {
            token: Some(token.into()),
            api_key: None,
        }
    }

    pub fn api_key(key: impl Into<String>) -> Self {
        Self {
            token: None,
            api_key: Some(key.into()),
        }
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Per-request overrides.
#[derive(Clone, Default)]
pub struct RequestOptions {
    pub token: Option<String>,
    pub api_key: Option<String>,
    pub tenant: Option<String>,
    pub product: Option<String>,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub if_version: Option<i64>,
    pub timeout: Option<Duration>,
    pub retries: Option<u32>,
    pub headers: HeaderMap,
    /// Drop credentials for public endpoints (public files, health).
    pub anonymous: bool,
}

impl std::fmt::Debug for RequestOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RequestOptions")
            .field("tenant", &self.tenant)
            .field("product", &self.product)
            .field("correlation_id", &self.correlation_id)
            .field("idempotency_key", &self.idempotency_key)
            .field("if_version", &self.if_version)
            .field("timeout", &self.timeout)
            .field("retries", &self.retries)
            .finish()
    }
}

impl RequestOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn tenant(mut self, tenant: impl Into<String>) -> Self {
        self.tenant = Some(tenant.into());
        self
    }

    pub fn product(mut self, product: impl Into<String>) -> Self {
        self.product = Some(product.into());
        self
    }

    pub fn correlation_id(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }

    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    pub fn if_version(mut self, version: i64) -> Self {
        self.if_version = Some(version);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn retries(mut self, retries: u32) -> Self {
        self.retries = Some(retries);
        self
    }

    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    /// Use no credentials (public endpoints).
    pub fn anonymous(mut self) -> Self {
        self.anonymous = true;
        self
    }
}

struct Inner {
    base_url: String,
    credentials: Credentials,
    tenant: Option<String>,
    product: Option<String>,
    correlation_id: Option<String>,
    http: reqwest::Client,
    timeout: Duration,
    retries: u32,
    extra_headers: HeaderMap,
    user_agent: String,
}

impl Clone for Inner {
    fn clone(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            credentials: self.credentials.clone(),
            tenant: self.tenant.clone(),
            product: self.product.clone(),
            correlation_id: self.correlation_id.clone(),
            http: self.http.clone(),
            timeout: self.timeout,
            retries: self.retries,
            extra_headers: self.extra_headers.clone(),
            user_agent: self.user_agent.clone(),
        }
    }
}

/// Tier-2 capabilities client.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("synapsedx::Client")
            .field("base_url", &self.inner.base_url)
            .field("tenant", &self.inner.tenant)
            .field("product", &self.inner.product)
            .finish()
    }
}

impl Client {
    pub fn new(base_url: impl Into<String>, credentials: Credentials) -> Result<Self> {
        ClientBuilder::new(base_url)
            .credentials(credentials)
            .build()
    }

    pub fn from_env() -> Result<Self> {
        let base =
            std::env::var("SYNAPSEDX_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let mut credentials = Credentials::default();
        if let Ok(token) = std::env::var("SYNAPSEDX_TOKEN") {
            if !token.trim().is_empty() {
                credentials.token = Some(token);
            }
        }
        if let Ok(key) = std::env::var("SYNAPSEDX_API_KEY") {
            if !key.trim().is_empty() {
                credentials.api_key = Some(key);
            }
        }
        Self::new(base, credentials)
    }

    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        ClientBuilder::new(base_url)
    }

    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// Send a JSON request and decode the response.
    pub async fn request(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        Ok(self.request_raw(method, path, body, opts).await?.data)
    }

    pub async fn get(&self, path: impl Into<String>, opts: &RequestOptions) -> Result<Value> {
        self.request(Method::GET, path, None, opts).await
    }

    pub async fn post(
        &self,
        path: impl Into<String>,
        body: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.request(Method::POST, path, Some(body), opts).await
    }

    pub async fn put(
        &self,
        path: impl Into<String>,
        body: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.request(Method::PUT, path, body, opts).await
    }

    pub async fn patch(
        &self,
        path: impl Into<String>,
        body: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.request(Method::PATCH, path, Some(body), opts).await
    }

    pub async fn delete(&self, path: impl Into<String>, opts: &RequestOptions) -> Result<Value> {
        self.request(Method::DELETE, path, None, opts).await
    }

    /// Request that preserves response headers (pagination).
    pub async fn request_raw(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<RawResponse> {
        let path = normalize_path(path.into());
        let attempts = opts.retries.unwrap_or(self.inner.retries) + 1;
        let idempotent =
            matches!(method, Method::GET | Method::HEAD) || opts.idempotency_key.is_some();
        let mut last_error: Option<Error> = None;

        for attempt in 0..attempts {
            match self.once(&method, &path, body.as_ref(), opts, false).await {
                Ok(raw) => return Ok(raw),
                Err(error) => {
                    let retryable = matches!(&error, Error::Network { .. })
                        || matches!(error.status(), Some(status) if status >= 500 || status == 429);
                    if !idempotent || !retryable || attempt + 1 >= attempts {
                        return Err(error);
                    }
                    let delay = match &error {
                        Error::Api { status: 429, .. } => Duration::from_millis(200),
                        _ => Duration::from_millis(100 * (attempt as u64 + 1)),
                    };
                    last_error = Some(error);
                    tokio::time::sleep(delay).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            Error::Config("request retries exhausted without an error".to_string())
        }))
    }

    /// Binary download.
    pub async fn request_bytes(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Bytes>,
        content_type: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<BinaryResponse> {
        let path = normalize_path(path.into());
        let attempts = opts.retries.unwrap_or(self.inner.retries) + 1;
        let idempotent =
            matches!(method, Method::GET | Method::HEAD) || opts.idempotency_key.is_some();
        let mut last_error: Option<Error> = None;

        for attempt in 0..attempts {
            match self
                .once_bytes(&method, &path, body.clone(), content_type, opts)
                .await
            {
                Ok(response) => return Ok(response),
                Err(error) => {
                    let retryable = matches!(&error, Error::Network { .. })
                        || matches!(error.status(), Some(status) if status >= 500 || status == 429);
                    if !idempotent || !retryable || attempt + 1 >= attempts {
                        return Err(error);
                    }
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(100 * (attempt as u64 + 1))).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            Error::Config("request retries exhausted without an error".to_string())
        }))
    }

    /// Send a raw binary body and decode a JSON response (uploads).
    pub async fn request_with_bytes(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Bytes,
        content_type: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let path = normalize_path(path.into());
        let attempts = opts.retries.unwrap_or(self.inner.retries) + 1;
        let idempotent =
            matches!(method, Method::GET | Method::HEAD) || opts.idempotency_key.is_some();
        let mut last_error: Option<Error> = None;

        for attempt in 0..attempts {
            match self
                .once_json_bytes(&method, &path, body.clone(), content_type, opts)
                .await
            {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let retryable = matches!(&error, Error::Network { .. })
                        || matches!(error.status(), Some(status) if status >= 500 || status == 429);
                    if !idempotent || !retryable || attempt + 1 >= attempts {
                        return Err(error);
                    }
                    last_error = Some(error);
                    tokio::time::sleep(Duration::from_millis(100 * (attempt as u64 + 1))).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            Error::Config("request retries exhausted without an error".to_string())
        }))
    }

    async fn once_json_bytes(
        &self,
        method: &Method,
        path: &str,
        body: Bytes,
        content_type: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let response = self
            .build_request_bytes(method, path, Some(body), content_type, opts)
            .send()
            .await
            .map_err(|source| Error::Network {
                path: path.to_string(),
                base_url: self.inner.base_url.clone(),
                source,
            })?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.bytes().await.map_err(|source| Error::Network {
            path: path.to_string(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;
        if !status.is_success() {
            return Err(self.error_from_response(status.as_u16(), path, &headers, &bytes));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_slice::<Value>(&bytes)?)
    }

    async fn once(
        &self,
        method: &Method,
        path: &str,
        body: Option<&Value>,
        opts: &RequestOptions,
        binary: bool,
    ) -> Result<RawResponse> {
        let response = self
            .build_request(method, path, body, opts, binary)
            .send()
            .await
            .map_err(|source| Error::Network {
                path: path.to_string(),
                base_url: self.inner.base_url.clone(),
                source,
            })?;

        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.bytes().await.map_err(|source| Error::Network {
            path: path.to_string(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;

        if !status.is_success() {
            return Err(self.error_from_response(status.as_u16(), path, &headers, &bytes));
        }

        let data = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice::<Value>(&bytes)?
        };

        Ok(RawResponse {
            status: status.as_u16(),
            headers,
            data,
        })
    }

    async fn once_bytes(
        &self,
        method: &Method,
        path: &str,
        body: Option<Bytes>,
        content_type: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<BinaryResponse> {
        let response = self
            .build_request_bytes(method, path, body, content_type, opts)
            .send()
            .await
            .map_err(|source| Error::Network {
                path: path.to_string(),
                base_url: self.inner.base_url.clone(),
                source,
            })?;

        let status = response.status();
        let headers = response.headers().clone();
        let data = response.bytes().await.map_err(|source| Error::Network {
            path: path.to_string(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;

        if !status.is_success() {
            return Err(self.error_from_response(status.as_u16(), path, &headers, &data));
        }

        Ok(BinaryResponse {
            status: status.as_u16(),
            headers,
            data,
        })
    }

    fn build_request(
        &self,
        method: &Method,
        path: &str,
        body: Option<&Value>,
        opts: &RequestOptions,
        binary: bool,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.inner.base_url, path);
        let mut builder = self
            .inner
            .http
            .request(method.clone(), url)
            .timeout(opts.timeout.unwrap_or(self.inner.timeout));
        let headers = self.headers(opts, binary);
        builder = builder.headers(headers);
        if let Some(body) = body {
            builder = builder.json(body);
        }
        builder
    }

    fn build_request_bytes(
        &self,
        method: &Method,
        path: &str,
        body: Option<Bytes>,
        content_type: Option<&str>,
        opts: &RequestOptions,
    ) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.inner.base_url, path);
        let mut builder = self
            .inner
            .http
            .request(method.clone(), url)
            .timeout(opts.timeout.unwrap_or(self.inner.timeout));
        let mut headers = self.headers(opts, true);
        if let Some(content_type) = content_type {
            if let Ok(value) = HeaderValue::from_str(content_type) {
                headers.insert(CONTENT_TYPE, value);
            }
        }
        builder = builder.headers(headers);
        if let Some(body) = body {
            builder = builder.body(body);
        }
        builder
    }

    fn headers(&self, opts: &RequestOptions, binary: bool) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static(if binary {
                "application/octet-stream"
            } else {
                "application/json"
            }),
        );

        let token = if opts.anonymous {
            None
        } else {
            opts.token
                .as_ref()
                .or(self.inner.credentials.token.as_ref())
        };
        let api_key = if opts.anonymous {
            None
        } else {
            opts.api_key
                .as_ref()
                .or(self.inner.credentials.api_key.as_ref())
        };
        if let Some(token) = token {
            if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                headers.insert(AUTHORIZATION, value);
            }
        }
        if let Some(api_key) = api_key {
            if let Ok(value) = HeaderValue::from_str(api_key) {
                headers.insert(HeaderName::from_static("x-api-key"), value);
            }
        }
        if let Some(tenant) = opts.tenant.as_ref().or(self.inner.tenant.as_ref()) {
            if let Ok(value) = HeaderValue::from_str(tenant) {
                headers.insert(HeaderName::from_static("x-synapseone-tenant"), value);
            }
        }
        if let Some(product) = opts.product.as_ref().or(self.inner.product.as_ref()) {
            if let Ok(value) = HeaderValue::from_str(product) {
                headers.insert(HeaderName::from_static("x-synapsedx-product"), value);
            }
        }
        let correlation_id = opts
            .correlation_id
            .as_ref()
            .or(self.inner.correlation_id.as_ref())
            .cloned()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if let Ok(value) = HeaderValue::from_str(&correlation_id) {
            headers.insert(HeaderName::from_static("x-correlation-id"), value);
        }
        if let Some(key) = &opts.idempotency_key {
            if let Ok(value) = HeaderValue::from_str(key) {
                headers.insert(HeaderName::from_static("idempotency-key"), value);
            }
        }
        if let Some(version) = opts.if_version {
            if let Ok(value) = HeaderValue::from_str(&format!("\"{version}\"")) {
                headers.insert(HeaderName::from_static("if-match"), value);
            }
        }
        for (name, value) in &self.inner.extra_headers {
            headers.insert(name, value.clone());
        }
        for (name, value) in &opts.headers {
            headers.insert(name, value.clone());
        }
        headers
    }

    fn error_from_response(
        &self,
        status: u16,
        path: &str,
        headers: &HeaderMap,
        bytes: &[u8],
    ) -> Error {
        let body = serde_json::from_slice::<Value>(bytes).ok();
        let envelope = body
            .as_ref()
            .and_then(|value| value.get("error"))
            .cloned()
            .unwrap_or(Value::Null);
        let message = envelope
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let text = String::from_utf8_lossy(bytes);
                let text = text.trim();
                if text.is_empty() {
                    format!("synapsedx {status} {path}")
                } else {
                    text.chars().take(300).collect()
                }
            });
        let code = envelope
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_id = envelope
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                headers
                    .get("x-correlation-id")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        Error::Api {
            status,
            path: path.to_string(),
            message,
            code,
            request_id,
            details: envelope.get("details").cloned(),
            body,
            base_url: self.inner.base_url.clone(),
        }
    }

    /// Generic typed request helper.
    pub async fn request_typed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<T> {
        let value = self.request(method, path, body, opts).await?;
        Ok(serde_json::from_value(value)?)
    }
}

fn normalize_path(path: String) -> String {
    if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    }
}

/// A decoded JSON response that preserves status and headers.
#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub data: Value,
}

impl RawResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub fn number_header(&self, name: &str) -> Option<i64> {
        self.header(name).and_then(|value| value.parse().ok())
    }
}

/// A binary response.
#[derive(Debug, Clone)]
pub struct BinaryResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub data: Bytes,
}

impl BinaryResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// Builder for [`Client`].
pub struct ClientBuilder {
    base_url: String,
    credentials: Credentials,
    tenant: Option<String>,
    product: Option<String>,
    correlation_id: Option<String>,
    timeout: Duration,
    retries: u32,
    headers: HeaderMap,
    user_agent: String,
    connect_timeout: Duration,
}

impl ClientBuilder {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            credentials: Credentials::default(),
            tenant: None,
            product: None,
            correlation_id: None,
            timeout: DEFAULT_TIMEOUT,
            retries: DEFAULT_RETRIES,
            headers: HeaderMap::new(),
            user_agent: format!("synapsedx-rust/{}", env!("CARGO_PKG_VERSION")),
            connect_timeout: Duration::from_secs(10),
        }
    }

    pub fn credentials(mut self, credentials: Credentials) -> Self {
        self.credentials = credentials;
        self
    }

    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.credentials.token = Some(token.into());
        self
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.credentials.api_key = Some(key.into());
        self
    }

    pub fn tenant(mut self, tenant: impl Into<String>) -> Self {
        self.tenant = Some(tenant.into());
        self
    }

    pub fn product(mut self, product: impl Into<String>) -> Self {
        self.product = Some(product.into());
        self
    }

    pub fn correlation_id(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    pub fn retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    pub fn user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    pub fn build(self) -> Result<Client> {
        let base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err(Error::Config("base_url is empty".to_string()));
        }
        let parsed = Url::parse(&base_url)
            .map_err(|error| Error::Config(format!("base_url is not a URL: {error}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::Config(format!(
                "base_url must be http(s), got {}",
                parsed.scheme()
            )));
        }

        let http = reqwest::Client::builder()
            .connect_timeout(self.connect_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(self.user_agent.clone())
            .build()
            .map_err(|source| Error::Network {
                path: String::new(),
                base_url: base_url.clone(),
                source,
            })?;

        Ok(Client {
            inner: Arc::new(Inner {
                base_url,
                credentials: self.credentials,
                tenant: self.tenant,
                product: self.product,
                correlation_id: self.correlation_id,
                http,
                timeout: self.timeout,
                retries: self.retries,
                extra_headers: self.headers,
                user_agent: self.user_agent,
            }),
        })
    }
}

/// Convenience: parse a `Retry-After` value (not currently used by the JS
/// client, but exposed for callers that want to honour it).
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .map(|seconds| Duration::from_secs_f64(seconds.clamp(0.0, 30.0)))
}

#[allow(dead_code)]
fn _retry_after(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after)
}
