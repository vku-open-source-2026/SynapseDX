// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 warehouse namespace (OLAP datasets, SQL, ETL, reports, dashboards).

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::segment;
use serde_json::{json, Value};

const PREFIX: &str = "/v1/capabilities/warehouse";

/// Warehouse API handle.
#[derive(Clone)]
pub struct Warehouse {
    client: Client,
}

impl Warehouse {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn status(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/status"), opts).await
    }

    pub async fn datasets(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/datasets"), opts).await
    }

    pub async fn dataset(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/datasets/{}", segment(id)), opts)
            .await
    }

    pub async fn create_dataset(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/datasets"), input, opts)
            .await
    }

    pub async fn ingest(&self, id: &str, rows: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/datasets/{}/rows", segment(id)),
                json!({ "rows": rows }),
                opts,
            )
            .await
    }

    pub async fn query(
        &self,
        sql: &str,
        limit: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "sql": sql });
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        self.client
            .post(format!("{PREFIX}/query"), body, opts)
            .await
    }

    pub async fn templates(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/templates"), opts).await
    }

    pub async fn workflow_templates(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/workflow-templates"), opts)
            .await
    }

    pub async fn instantiate_workflow_template(
        &self,
        name: &str,
        input: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/workflow-templates/{}/instantiate", segment(name)),
                input,
                opts,
            )
            .await
    }

    pub async fn jobs(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/jobs"), opts).await
    }

    pub async fn run_batch(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/etl/batch"), input, opts)
            .await
    }

    pub async fn ensure_stream(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/etl/stream"), input, opts)
            .await
    }

    pub async fn run_job(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/jobs/{}/run", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn pause_job(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/jobs/{}/pause", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn reports(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/reports"), opts).await
    }

    pub async fn create_report(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/reports"), input, opts)
            .await
    }

    pub async fn run_report(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/reports/{}/run", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn publish_report(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/reports/{}/publish", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn public_report(&self, share_id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!("{PREFIX}/public/reports/{}", segment(share_id)),
                opts,
            )
            .await
    }

    pub async fn dashboards(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/dashboards"), opts).await
    }

    pub async fn create_dashboard(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/dashboards"), input, opts)
            .await
    }

    pub async fn run_dashboard(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/dashboards/{}/run", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn publish_dashboard(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/dashboards/{}/publish", segment(id)),
                json!({}),
                opts,
            )
            .await
    }

    pub async fn public_dashboard(&self, share_id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!("{PREFIX}/public/dashboards/{}", segment(share_id)),
                opts,
            )
            .await
    }

    pub async fn use_cases(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get(format!("{PREFIX}/use-cases"), opts).await
    }

    pub async fn seed_use_case(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/use-cases/{}/seed", segment(id)),
                json!({}),
                opts,
            )
            .await
    }
}
