// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 knowledge and hazards namespaces.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string};
use serde_json::{json, Value};

/// Knowledge API handle.
#[derive(Clone)]
pub struct Knowledge {
    client: Client,
}

impl Knowledge {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn index(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/knowledge/documents", input, opts)
            .await
    }

    pub async fn ingest_pdf(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/knowledge/ingest/pdf", input, opts)
            .await
    }

    pub async fn list(&self, limit: Option<i64>, opts: &RequestOptions) -> Result<Value> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", limit);
        self.client
            .get(
                format!(
                    "/v1/capabilities/knowledge/documents{}",
                    query_string(&params)
                ),
                opts,
            )
            .await
    }

    pub async fn query(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/knowledge/query", input, opts)
            .await
    }

    pub async fn status(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get("/v1/capabilities/knowledge/status", opts)
            .await
    }
}

/// Hazards API handle.
#[derive(Clone)]
pub struct Hazards {
    client: Client,
}

impl Hazards {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn today(
        &self,
        hours: Option<i64>,
        limit: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        opt_num(&mut params, "hours", hours);
        opt_num(&mut params, "limit", limit);
        self.client
            .get(
                format!("/v1/capabilities/hazards/today{}", query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn brief(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/hazards/brief", input, opts)
            .await
    }

    pub async fn status(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get("/v1/capabilities/hazards/status", opts)
            .await
    }

    pub async fn run_crawler(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/crawlers/kttv/run", json!({}), opts)
            .await
    }
}
