// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 AI namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use serde_json::{json, Value};

/// AI API handle.
#[derive(Clone)]
pub struct Ai {
    client: Client,
}

impl Ai {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn status(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get("/v1/capabilities/ai/status", opts).await
    }

    pub async fn chat(
        &self,
        messages: Value,
        model: Option<&str>,
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "messages": messages });
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        if let Some(temperature) = temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        self.client
            .post("/v1/capabilities/ai/chat", body, opts)
            .await
    }

    pub async fn embeddings(
        &self,
        input: Value,
        model: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "input": input });
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        self.client
            .post("/v1/capabilities/ai/embeddings", body, opts)
            .await
    }

    pub async fn decision(
        &self,
        state: Value,
        questions: Value,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/ai/decision",
                json!({ "state": state, "questions": questions }),
                opts,
            )
            .await
    }

    pub async fn route(
        &self,
        input: Value,
        choices: Value,
        instruction: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "input": input, "choices": choices });
        if let Some(instruction) = instruction {
            body["instruction"] = json!(instruction);
        }
        self.client
            .post("/v1/capabilities/ai/route", body, opts)
            .await
    }
}
