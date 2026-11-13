// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Errors returned by the SynapseDX capabilities client.

use serde_json::Value;

/// Result alias used by this crate.
pub type Result<T> = std::result::Result<T, Error>;

/// A SynapseDX capabilities API error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The service returned a non-success status with a structured envelope.
    #[error("synapsedx {status} {path}: {message} (request {request_id})")]
    Api {
        /// HTTP status.
        status: u16,
        /// Request path.
        path: String,
        /// Human-readable message from the envelope.
        message: String,
        /// Machine-readable code from the envelope.
        code: Option<String>,
        /// Correlation id (from the envelope or `x-correlation-id`).
        request_id: String,
        /// Optional structured details.
        details: Option<Value>,
        /// Parsed response body.
        body: Option<Value>,
        /// Base URL.
        base_url: String,
    },

    /// Network/DNS/TLS/timeout failure.
    #[error("synapsedx network {path}: {source}")]
    Network {
        /// Request path.
        path: String,
        /// Base URL.
        base_url: String,
        /// Underlying transport error.
        #[source]
        source: reqwest::Error,
    },

    /// The client was configured incorrectly.
    #[error("invalid synapsedx configuration: {0}")]
    Config(String),

    /// JSON serialization/deserialization failure.
    #[error("synapsedx JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Invalid header value.
    #[error("synapsedx header error: {0}")]
    Header(#[from] http::header::InvalidHeaderValue),
}

impl Error {
    /// HTTP status, when one was returned.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Machine-readable error code.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// Correlation id for support/debugging.
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Error::Api { request_id, .. } => Some(request_id),
            _ => None,
        }
    }

    /// Parsed response body.
    pub fn body(&self) -> Option<&Value> {
        match self {
            Error::Api { body, .. } => body.as_ref(),
            _ => None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
    }

    pub fn is_conflict(&self) -> bool {
        self.status() == Some(409)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(401)
    }
}
