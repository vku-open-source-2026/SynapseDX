// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 notifications namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string, segment};
use serde_json::{json, Value};

/// Notifications API handle.
#[derive(Clone)]
pub struct Notifications {
    client: Client,
}

impl Notifications {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn path(id: &str) -> String {
        format!("/v1/capabilities/notifications/{}", segment(id))
    }

    pub async fn send(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/notifications/send", input, opts)
            .await
    }

    pub async fn get(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client.get(Self::path(id), opts).await
    }

    pub async fn list(
        &self,
        status: Option<&str>,
        limit: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(value) = status {
            params.push(("status", value.to_string()));
        }
        opt_num(&mut params, "limit", limit);
        self.client
            .get(
                format!("/v1/capabilities/notifications{}", query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn cancel(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(format!("{}/cancel", Self::path(id)), json!({}), opts)
            .await
    }

    pub async fn create_template(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/notifications/templates", input, opts)
            .await
    }

    pub async fn list_templates(
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
                format!(
                    "/v1/capabilities/notifications/templates{}",
                    query_string(&params)
                ),
                opts,
            )
            .await
    }

    pub async fn get_template(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!("/v1/capabilities/notifications/templates/{}", segment(id)),
                opts,
            )
            .await
    }

    pub async fn update_template(
        &self,
        id: &str,
        patch: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .patch(
                format!("/v1/capabilities/notifications/templates/{}", segment(id)),
                patch,
                opts,
            )
            .await
    }

    pub async fn delete_template(&self, id: &str, opts: &RequestOptions) -> Result<()> {
        self.client
            .delete(
                format!("/v1/capabilities/notifications/templates/{}", segment(id)),
                opts,
            )
            .await?;
        Ok(())
    }

    pub async fn get_preference(&self, recipient: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get(
                format!(
                    "/v1/capabilities/notifications/preferences/{}",
                    segment(recipient)
                ),
                opts,
            )
            .await
    }

    pub async fn set_preference(
        &self,
        recipient: &str,
        channels: Option<Vec<String>>,
        unsubscribed: Option<bool>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(channels) = channels {
            body.insert("channels".to_string(), json!(channels));
        }
        if let Some(unsubscribed) = unsubscribed {
            body.insert("unsubscribed".to_string(), json!(unsubscribed));
        }
        self.client
            .put(
                format!(
                    "/v1/capabilities/notifications/preferences/{}",
                    segment(recipient)
                ),
                Some(Value::Object(body)),
                opts,
            )
            .await
    }

    pub async fn unsubscribe(&self, recipient: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/notifications/unsubscribe",
                json!({ "recipient": recipient }),
                opts,
            )
            .await
    }
}
