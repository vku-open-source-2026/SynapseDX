// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 scheduled jobs namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string, segment};
use serde_json::{json, Value};

/// Jobs API handle.
#[derive(Clone)]
pub struct Jobs {
    client: Client,
}

impl Jobs {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn path(id: &str) -> String {
        format!("/v1/capabilities/jobs/{}", segment(id))
    }

    pub async fn list(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        self.client
            .get(
                format!("/v1/capabilities/jobs{}", query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn get(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client.get(Self::path(id), opts).await
    }

    pub async fn create(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client.post("/v1/capabilities/jobs", input, opts).await
    }

    pub async fn update(&self, id: &str, patch: Value, opts: &RequestOptions) -> Result<Value> {
        self.client.patch(Self::path(id), patch, opts).await
    }

    pub async fn delete(&self, id: &str, opts: &RequestOptions) -> Result<()> {
        self.client.delete(Self::path(id), opts).await?;
        Ok(())
    }

    pub async fn runs(
        &self,
        id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        self.client
            .get(
                format!("{}/runs{}", Self::path(id), query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn run(
        &self,
        id: &str,
        payload: Option<Value>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let body = match payload {
            Some(payload) => json!({ "payload": payload }),
            None => json!({}),
        };
        self.client
            .post(format!("{}/run", Self::path(id)), body, opts)
            .await
    }

    pub async fn kinds(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get("/v1/capabilities/jobs/kinds", opts).await
    }

    pub async fn lease(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/jobs/lease", input, opts)
            .await
    }

    pub async fn heartbeat(
        &self,
        id: &str,
        run_id: &str,
        lease_token: &str,
        lease_seconds: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "leaseToken": lease_token });
        if let Some(lease_seconds) = lease_seconds {
            body["leaseSeconds"] = json!(lease_seconds);
        }
        self.client
            .post(
                format!("{}/runs/{}/heartbeat", Self::path(id), segment(run_id)),
                body,
                opts,
            )
            .await
    }

    pub async fn complete(
        &self,
        id: &str,
        run_id: &str,
        input: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                format!("{}/runs/{}/complete", Self::path(id), segment(run_id)),
                input,
                opts,
            )
            .await
    }
}
