// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 event feed namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string};
use serde_json::{json, Value};

/// Events API handle.
#[derive(Clone)]
pub struct Events {
    client: Client,
}

impl Events {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn list(
        &self,
        since: Option<&str>,
        event_type: Option<&str>,
        dataset_id: Option<&str>,
        limit: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(value) = since {
            params.push(("since", value.to_string()));
        }
        if let Some(value) = event_type {
            params.push(("type", value.to_string()));
        }
        if let Some(value) = dataset_id {
            params.push(("datasetId", value.to_string()));
        }
        opt_num(&mut params, "limit", limit);
        self.client
            .get(
                format!("/v1/capabilities/events{}", query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn flush_outbox(
        &self,
        dataset_id: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(value) = dataset_id {
            params.push(("datasetId", value.to_string()));
        }
        self.client
            .post(
                format!(
                    "/v1/capabilities/events/outbox/flush{}",
                    query_string(&params)
                ),
                json!({}),
                opts,
            )
            .await
    }
}
