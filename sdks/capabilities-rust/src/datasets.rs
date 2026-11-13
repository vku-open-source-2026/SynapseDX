// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 datasets namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::types::{Dataset, DatasetInput, DatasetListQuery, DatasetPage, EntityPage};
use crate::util::{opt_num, query_string, segment};
use serde_json::{json, Value};

/// Datasets API handle.
#[derive(Clone)]
pub struct Datasets {
    client: Client,
}

impl Datasets {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn path(id: &str) -> String {
        format!("/v1/capabilities/datasets/{}", segment(id))
    }

    fn list_path(query: &DatasetListQuery) -> String {
        let mut params = Vec::new();
        if let Some(value) = query.public_only {
            params.push(("publicOnly", value.to_string()));
        }
        if let Some(value) = &query.status {
            params.push(("status", value.clone()));
        }
        opt_num(&mut params, "limit", query.limit);
        opt_num(&mut params, "offset", query.offset);
        if let Some(value) = &query.cursor {
            params.push(("cursor", value.clone()));
        }
        format!("/v1/capabilities/datasets{}", query_string(&params))
    }

    pub async fn list(
        &self,
        query: DatasetListQuery,
        opts: &RequestOptions,
    ) -> Result<Vec<Dataset>> {
        let value = self.client.get(Self::list_path(&query), opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn list_page(
        &self,
        query: DatasetListQuery,
        opts: &RequestOptions,
    ) -> Result<DatasetPage> {
        let response = self
            .client
            .request_raw(http::Method::GET, Self::list_path(&query), None, opts)
            .await?;
        let total = response.number_header("x-total-count");
        let limit = response.number_header("x-limit");
        let offset = response.number_header("x-offset");
        let next_cursor = response.header("x-next-cursor").map(str::to_string);
        let items: Vec<Dataset> = serde_json::from_value(response.data)?;
        Ok(DatasetPage {
            total: total.unwrap_or(items.len() as i64),
            limit: limit.unwrap_or(query.limit.unwrap_or(items.len() as i64)),
            offset: offset.unwrap_or(query.offset.unwrap_or(0)),
            next_cursor,
            items,
        })
    }

    pub async fn get(&self, id: &str, opts: &RequestOptions) -> Result<Dataset> {
        let value = self.client.get(Self::path(id), opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn create(&self, input: DatasetInput, opts: &RequestOptions) -> Result<Dataset> {
        let value = self
            .client
            .post(
                "/v1/capabilities/datasets",
                serde_json::to_value(input)?,
                opts,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn update(&self, id: &str, patch: Value, opts: &RequestOptions) -> Result<Dataset> {
        let value = self.client.patch(Self::path(id), patch, opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn delete(&self, id: &str, purge_records: bool, opts: &RequestOptions) -> Result<()> {
        let path = format!(
            "{}{}",
            Self::path(id),
            query_string(&[("purgeRecords", purge_records.to_string())])
        );
        self.client.delete(path, opts).await?;
        Ok(())
    }

    pub async fn publish(&self, id: &str, opts: &RequestOptions) -> Result<Dataset> {
        let value = self
            .client
            .post(format!("{}/publish", Self::path(id)), json!({}), opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn revoke(&self, id: &str, opts: &RequestOptions) -> Result<Dataset> {
        let value = self
            .client
            .post(format!("{}/revoke", Self::path(id)), json!({}), opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn entities(
        &self,
        id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Vec<Value>> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        let path = format!("{}/entities{}", Self::path(id), query_string(&params));
        let value = self.client.get(path, opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn entities_page(
        &self,
        id: &str,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<EntityPage> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        let path = format!("{}/entities{}", Self::path(id), query_string(&params));
        let response = self
            .client
            .request_raw(http::Method::GET, path, None, opts)
            .await?;
        let total = response.number_header("x-lds-total");
        let license = response.header("x-lds-license").map(str::to_string);
        let datasource_id = response.header("x-lds-datasource").map(str::to_string);
        let cache_control = response.header("cache-control").map(str::to_string);
        let contexts = response
            .header("x-lds-context")
            .map(|value| vec![value.to_string()])
            .unwrap_or_default();
        let items: Vec<Value> = serde_json::from_value(response.data)?;
        Ok(EntityPage {
            total: total.unwrap_or(items.len() as i64),
            license,
            license_url: None,
            datasource_id,
            contexts,
            cache_control,
            items,
        })
    }
}
