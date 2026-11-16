// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 geo namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::util::{opt_num, query_string, segment};
use serde_json::Value;

/// Geo API handle.
#[derive(Clone)]
pub struct Geo {
    client: Client,
}

impl Geo {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn autocomplete(
        &self,
        q: &str,
        limit: Option<i64>,
        focus: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Vec<Value>> {
        let mut params = vec![("q", q.to_string())];
        opt_num(&mut params, "limit", limit);
        if let Some(focus) = focus {
            params.push(("focus", focus.to_string()));
        }
        let value = self
            .client
            .get(
                format!("/v1/capabilities/geo/autocomplete{}", query_string(&params)),
                opts,
            )
            .await?;
        Ok(value
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn geocode(&self, address: &str, opts: &RequestOptions) -> Result<Vec<Value>> {
        let value = self
            .client
            .get(
                format!(
                    "/v1/capabilities/geo/geocode{}",
                    query_string(&[("address", address.to_string())])
                ),
                opts,
            )
            .await?;
        Ok(value
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn reverse(&self, lat: f64, lon: f64, opts: &RequestOptions) -> Result<Vec<Value>> {
        let value = self
            .client
            .get(
                format!(
                    "/v1/capabilities/geo/reverse{}",
                    query_string(&[("lat", lat.to_string()), ("lon", lon.to_string()),])
                ),
                opts,
            )
            .await?;
        Ok(value
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn place(&self, id: &str, opts: &RequestOptions) -> Result<Option<Value>> {
        let value = self
            .client
            .get(
                format!(
                    "/v1/capabilities/geo/place{}",
                    query_string(&[("id", id.to_string())])
                ),
                opts,
            )
            .await?;
        Ok(value
            .get("result")
            .cloned()
            .filter(|value| !value.is_null()))
    }

    /// Convenience: percent-encode a value for a caller-built path.
    pub fn encode(value: &str) -> String {
        segment(value)
    }
}
