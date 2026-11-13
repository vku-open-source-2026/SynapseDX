// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Async Rust client for the SynapseDX Tier-2 capabilities API.
//!
//! ```no_run
//! use synapsedx::{Client, Credentials, RecordQuery, RequestOptions};
//! use serde_json::json;
//!
//! # async fn example() -> synapsedx::Result<()> {
//! let client = Client::new(
//!     "https://synapsedx.sbs",
//!     Credentials::api_key("synapsedx_..."),
//! )?;
//! let page = client
//!     .records()
//!     .query("dataset-id", RecordQuery::new().filter(json!({ "status": "new" })), &RequestOptions::new())
//!     .await?;
//! println!("{} records", page.items.len());
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]
// Thin wrappers intentionally mirror the HTTP API's argument lists and keep the
// full platform error body on the error type for callers to inspect.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

pub mod ai;
pub mod audit;
pub mod auth;
pub mod client;
pub mod datasets;
pub mod error;
pub mod events;
pub mod files;
pub mod geo;
pub mod jobs;
pub mod knowledge;
pub mod notifications;
pub mod records;
pub mod types;
pub mod util;
pub mod warehouse;

pub use ai::Ai;
pub use audit::{Audit, Usage};
pub use auth::Auth;
pub use client::{
    parse_retry_after, BinaryResponse, Client, ClientBuilder, Credentials, RawResponse,
    RequestOptions, DEFAULT_BASE_URL, DEFAULT_RETRIES, DEFAULT_TIMEOUT,
};
pub use datasets::Datasets;
pub use error::{Error, Result};
pub use events::Events;
pub use files::Files;
pub use geo::Geo;
pub use jobs::Jobs;
pub use knowledge::{Hazards, Knowledge};
pub use notifications::Notifications;
pub use records::Records;
pub use types::{
    AuthSession, Dataset, DatasetInput, DatasetListQuery, DatasetPage, EntityPage, FileObject,
    FilePage, HealthDependency, HealthReport, RecordItem, RecordListQuery, RecordPage, RecordQuery,
};
pub use warehouse::Warehouse;

use http::Method;
use serde_json::Value;

/// Shorthand used by health probes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CapabilitiesAdvertisement {
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Client {
    pub fn datasets(&self) -> Datasets {
        Datasets::new(self.clone())
    }

    pub fn records(&self) -> Records {
        Records::new(self.clone())
    }

    pub fn events(&self) -> Events {
        Events::new(self.clone())
    }

    pub fn auth(&self) -> Auth {
        Auth::new(self.clone())
    }

    pub fn ai(&self) -> Ai {
        Ai::new(self.clone())
    }

    pub fn jobs(&self) -> Jobs {
        Jobs::new(self.clone())
    }

    pub fn audit(&self) -> Audit {
        Audit::new(self.clone())
    }

    pub fn usage(&self) -> Usage {
        Usage::new(self.clone())
    }

    pub fn files(&self) -> Files {
        Files::new(self.clone())
    }

    pub fn notifications(&self) -> Notifications {
        Notifications::new(self.clone())
    }

    pub fn warehouse(&self) -> Warehouse {
        Warehouse::new(self.clone())
    }

    pub fn knowledge(&self) -> Knowledge {
        Knowledge::new(self.clone())
    }

    pub fn hazards(&self) -> Hazards {
        Hazards::new(self.clone())
    }

    pub fn geo(&self) -> Geo {
        Geo::new(self.clone())
    }

    /// GET `/v1/capabilities/health`.
    pub async fn health(&self, opts: &RequestOptions) -> Result<HealthReport> {
        let value = self.get("/v1/capabilities/health", opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// GET `/v1/capabilities/ready`.
    pub async fn ready(&self, opts: &RequestOptions) -> Result<HealthReport> {
        let value = self.get("/v1/capabilities/ready", opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// GET `/v1/capabilities` (capability advertisement).
    pub async fn capabilities(&self, opts: &RequestOptions) -> Result<Value> {
        self.get("/v1/capabilities", opts).await
    }

    /// Raw request escape hatch for endpoints added after this release.
    pub async fn raw_request(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.request(method, path, body, opts).await
    }
}
