// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 auth namespace.

use crate::client::{Client, RequestOptions};
use crate::error::Result;
use crate::types::AuthSession;
use crate::util::{query_string, segment};
use serde_json::{json, Value};

/// Auth API handle.
#[derive(Clone)]
pub struct Auth {
    client: Client,
}

impl Auth {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn login(
        &self,
        email: &str,
        password: Option<&str>,
        org_slug: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<AuthSession> {
        let mut body = json!({ "email": email });
        if let Some(password) = password {
            body["password"] = json!(password);
        }
        if let Some(org_slug) = org_slug {
            body["orgSlug"] = json!(org_slug);
        }
        let value = self
            .client
            .post("/v1/capabilities/auth/login", body, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn register(
        &self,
        email: &str,
        password: &str,
        display_name: Option<&str>,
        org_slug: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<AuthSession> {
        let mut body = json!({ "email": email, "password": password });
        if let Some(display_name) = display_name {
            body["displayName"] = json!(display_name);
        }
        if let Some(org_slug) = org_slug {
            body["orgSlug"] = json!(org_slug);
        }
        let value = self
            .client
            .post("/v1/capabilities/auth/register", body, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn refresh(&self, refresh_token: &str, opts: &RequestOptions) -> Result<AuthSession> {
        let value = self
            .client
            .post(
                "/v1/capabilities/auth/refresh",
                json!({ "refreshToken": refresh_token }),
                opts,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn logout(&self, refresh_token: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/logout",
                json!({ "refreshToken": refresh_token }),
                opts,
            )
            .await
    }

    pub async fn logout_all(&self, refresh_token: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/logout-all",
                json!({ "refreshToken": refresh_token }),
                opts,
            )
            .await
    }

    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/password/change",
                json!({ "currentPassword": current_password, "newPassword": new_password }),
                opts,
            )
            .await
    }

    pub async fn request_password_reset(
        &self,
        email: &str,
        org_slug: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "email": email });
        if let Some(org_slug) = org_slug {
            body["orgSlug"] = json!(org_slug);
        }
        self.client
            .post("/v1/capabilities/auth/password/forgot", body, opts)
            .await
    }

    pub async fn reset_password(
        &self,
        token: &str,
        new_password: &str,
        opts: &RequestOptions,
    ) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/password/reset",
                json!({ "token": token, "newPassword": new_password }),
                opts,
            )
            .await
    }

    pub async fn verify_email(&self, token: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/email/verify",
                json!({ "token": token }),
                opts,
            )
            .await
    }

    pub async fn request_email_verification(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post(
                "/v1/capabilities/auth/email/verify/request",
                json!({}),
                opts,
            )
            .await
    }

    pub async fn sessions(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get("/v1/capabilities/auth/sessions", opts)
            .await
    }

    pub async fn revoke_session(&self, id: &str, opts: &RequestOptions) -> Result<Value> {
        self.client
            .delete(
                format!("/v1/capabilities/auth/sessions/{}", segment(id)),
                opts,
            )
            .await
    }

    pub async fn me(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get("/v1/capabilities/auth/me", opts).await
    }

    pub async fn oidc_config(&self, opts: &RequestOptions) -> Result<Value> {
        self.client
            .get("/v1/capabilities/auth/oidc/config", opts)
            .await
    }

    pub async fn oidc_start(&self, org: Option<&str>, opts: &RequestOptions) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(org) = org {
            params.push(("org", org.to_string()));
        }
        self.client
            .get(
                format!("/v1/capabilities/auth/oidc/start{}", query_string(&params)),
                opts,
            )
            .await
    }

    pub async fn oidc_callback(
        &self,
        code: &str,
        state: &str,
        opts: &RequestOptions,
    ) -> Result<AuthSession> {
        let value = self
            .client
            .post(
                "/v1/capabilities/auth/oidc/callback",
                json!({ "code": code, "state": state }),
                opts,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn exchange(&self, input: Value, opts: &RequestOptions) -> Result<Value> {
        self.client
            .post("/v1/capabilities/auth/exchange", input, opts)
            .await
    }
}
