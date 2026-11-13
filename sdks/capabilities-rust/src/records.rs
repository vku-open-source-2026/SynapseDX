// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 records namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::types::{RecordItem, RecordListQuery, RecordPage, RecordQuery};
use crate::util::{opt_num, query_string, segment};
use serde_json::{json, Value};

/// Records API handle.
#[derive(Clone)]
pub struct Records {
    client: Client,
}

impl Records {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn base(dataset_id: &str) -> String {
        format!("/v1/capabilities/datasets/{}/records", segment(dataset_id))
    }

    fn item(dataset_id: &str, id: &str) -> String {
        format!("{}/{}", Self::base(dataset_id), segment(id))
    }

    pub async fn list(
        &self,
        dataset_id: &str,
        query: RecordListQuery,
        opts: &RequestOptions,
    ) -> Result<RecordPage> {
        let mut params = Vec::new();
        opt_num(&mut params, "limit", query.limit);
        opt_num(&mut params, "offset", query.offset);
        if let Some(value) = &query.cursor {
            params.push(("cursor", value.clone()));
        }
        if let Some(value) = query.published_only {
            params.push(("publishedOnly", value.to_string()));
        }
        if let Some(value) = &query.order_by {
            params.push(("orderBy", value.clone()));
        }
        let path = format!("{}{}", Self::base(dataset_id), query_string(&params));
        let value = self.client.get(path, opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn query(
        &self,
        dataset_id: &str,
        query: RecordQuery,
        opts: &RequestOptions,
    ) -> Result<RecordPage> {
        let path = format!("{}/query", Self::base(dataset_id));
        let value = self
            .client
            .post(path, serde_json::to_value(query)?, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn get(
        &self,
        dataset_id: &str,
        id: &str,
        opts: &RequestOptions,
    ) -> Result<RecordItem> {
        let value = self.client.get(Self::item(dataset_id, id), opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn create(
        &self,
        dataset_id: &str,
        data: Value,
        id: Option<&str>,
        publish: Option<bool>,
        opts: &RequestOptions,
    ) -> Result<RecordItem> {
        let mut body = json!({ "data": data });
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        if let Some(publish) = publish {
            body["publish"] = json!(publish);
        }
        let value = self.client.post(Self::base(dataset_id), body, opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn update(
        &self,
        dataset_id: &str,
        id: &str,
        data: Value,
        publish: Option<bool>,
        opts: &RequestOptions,
    ) -> Result<RecordItem> {
        let mut body = json!({ "data": data });
        if let Some(publish) = publish {
            body["publish"] = json!(publish);
        }
        let value = self
            .client
            .patch(Self::item(dataset_id, id), body, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn delete(&self, dataset_id: &str, id: &str, opts: &RequestOptions) -> Result<()> {
        self.client.delete(Self::item(dataset_id, id), opts).await?;
        Ok(())
    }

    pub async fn bulk_create(
        &self,
        dataset_id: &str,
        entries: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                format!("{}/bulk", Self::base(dataset_id)),
                json!({ "records": entries }),
                opts,
            )
            .await
    }

    /// Iterate all records using offset pagination.
    pub async fn iterate(
        &self,
        dataset_id: &str,
        mut query: RecordQuery,
        opts: &RequestOptions,
    ) -> Result<Vec<RecordItem>> {
        let page_size = query.limit.unwrap_or(100);
        let mut offset = 0;
        let mut items = Vec::new();
        loop {
            query.limit = Some(page_size);
            query.offset = Some(offset);
            let page = self.query(dataset_id, query.clone(), opts).await?;
            let count = page.items.len() as i64;
            items.extend(page.items);
            if count == 0 || offset + count >= page.total {
                return Ok(items);
            }
            offset += count;
        }
    }
}
