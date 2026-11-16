// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 audit and usage namespaces.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string};
use serde_json::Value;

/// Audit API handle.
#[derive(Clone)]
pub struct Audit {
    client: Client,
}

impl Audit {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn list(
        &self,
        action: Option<&str>,
        dataset_id: Option<&str>,
        record_id: Option<&str>,
        actor: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(value) = action {
            params.push(("action", value.to_string()));
        }
        if let Some(value) = dataset_id {
            params.push(("datasetId", value.to_string()));
        }
        if let Some(value) = record_id {
            params.push(("recordId", value.to_string()));
        }
        if let Some(value) = actor {
            params.push(("actor", value.to_string()));
        }
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        self.client
            .get(
                format!("/v1/capabilities/audit{}", query_string(&params)),
                opts,
            )
            .await
    }
}

/// Usage API handle.
#[derive(Clone)]
pub struct Usage {
    client: Client,
}

impl Usage {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn summary(&self, filter: &[(&str, String)], opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!("/v1/capabilities/usage{}", query_string(filter)),
                opts,
            )
            .await
    }

    pub async fn events(&self, filter: &[(&str, String)], opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!("/v1/capabilities/usage/events{}", query_string(filter)),
                opts,
            )
            .await
    }
}
