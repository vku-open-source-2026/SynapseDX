// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared Tier-2 response types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Dataset metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    pub license: String,
    #[serde(rename = "licenseUrl", skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub public: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(rename = "schemaVersion", skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    #[serde(rename = "retentionDays", skip_serializing_if = "Option::is_none")]
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "ldsDatasourceId", skip_serializing_if = "Option::is_none")]
    pub lds_datasource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

/// Dataset create/update payload.
#[derive(Debug, Clone, Serialize, Default)]
pub struct DatasetInput {
    pub slug: String,
    pub name: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    pub license: String,
    #[serde(rename = "licenseUrl", skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(rename = "schemaVersion", skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    #[serde(rename = "retentionDays", skip_serializing_if = "Option::is_none")]
    pub retention_days: Option<u32>,
}

/// Paginated dataset list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetPage {
    pub items: Vec<Dataset>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

/// A stored record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordItem {
    pub id: String,
    pub data: Value,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub published: Option<bool>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

/// Paginated record list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordPage {
    pub items: Vec<RecordItem>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

/// Record query body.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Value>,
    #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
    pub order_by: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

impl RecordQuery {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn filter(mut self, filter: Value) -> Self {
        self.r#where = Some(filter);
        self
    }

    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn offset(mut self, offset: i64) -> Self {
        self.offset = Some(offset);
        self
    }

    pub fn cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }
}

/// Dataset list filters.
#[derive(Debug, Clone, Default)]
pub struct DatasetListQuery {
    pub public_only: Option<bool>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub cursor: Option<String>,
}

impl DatasetListQuery {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn public_only(mut self, value: bool) -> Self {
        self.public_only = Some(value);
        self
    }

    pub fn status(mut self, value: impl Into<String>) -> Self {
        self.status = Some(value.into());
        self
    }

    pub fn limit(mut self, value: i64) -> Self {
        self.limit = Some(value);
        self
    }

    pub fn offset(mut self, value: i64) -> Self {
        self.offset = Some(value);
        self
    }

    pub fn cursor(mut self, value: impl Into<String>) -> Self {
        self.cursor = Some(value.into());
        self
    }
}

/// Record list filters.
#[derive(Debug, Clone, Default)]
pub struct RecordListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub cursor: Option<String>,
    pub published_only: Option<bool>,
    pub order_by: Option<String>,
}

impl RecordListQuery {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn limit(mut self, value: i64) -> Self {
        self.limit = Some(value);
        self
    }

    pub fn offset(mut self, value: i64) -> Self {
        self.offset = Some(value);
        self
    }

    pub fn cursor(mut self, value: impl Into<String>) -> Self {
        self.cursor = Some(value.into());
        self
    }

    pub fn published_only(mut self, value: bool) -> Self {
        self.published_only = Some(value);
        self
    }

    pub fn order_by(mut self, value: impl Into<String>) -> Self {
        self.order_by = Some(value.into());
        self
    }
}

/// A page of NGSI-LD entities plus LDS headers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityPage {
    pub items: Vec<Value>,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(rename = "licenseUrl", skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(rename = "datasourceId", skip_serializing_if = "Option::is_none")]
    pub datasource_id: Option<String>,
    pub contexts: Vec<String>,
    #[serde(rename = "cacheControl", skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<String>,
}

/// Health dependency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthDependency {
    pub name: String,
    pub status: String,
    #[serde(rename = "latency_ms", default)]
    pub latency_ms: f64,
    #[serde(default)]
    pub critical: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Health report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    pub status: String,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub tier: i64,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub dependencies: Vec<HealthDependency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<Value>,
    #[serde(default)]
    pub time: String,
}

/// Authentication session returned by login/refresh/OIDC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "expiresIn", skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<Value>,
    #[serde(
        rename = "emailVerificationToken",
        skip_serializing_if = "Option::is_none"
    )]
    pub email_verification_token: Option<String>,
}

/// File metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileObject {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(rename = "checksumSha256", skip_serializing_if = "Option::is_none")]
    pub checksum_sha256: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// A page of files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePage {
    pub items: Vec<FileObject>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}
