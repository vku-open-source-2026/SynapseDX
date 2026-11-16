// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 files namespace.

use crate::client::{BinaryResponse, Client, RequestOptions};
use crate::error::Result;
use crate::types::{FileObject, FilePage};
use crate::util::{opt_num, query_string, segment};
use bytes::Bytes;
use http::Method;
use serde_json::{json, Value};

/// Files API handle.
#[derive(Clone)]
pub struct Files {
    client: Client,
}

impl Files {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn path(id: &str) -> String {
        format!("/v1/capabilities/files/{}", segment(id))
    }

    pub async fn create(&self, metadata: Value, opts: &RequestOptions) -> Result<FileObject> {
        let value = self
            .client
            .post("/v1/capabilities/files", metadata, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn upload_bytes(
        &self,
        id: &str,
        content: impl Into<Bytes>,
        content_type: &str,
        checksum_sha256: Option<&str>,
        opts: &RequestOptions,
    ) -> Result<FileObject> {
        let path = format!("{}/content", Self::path(id));
        let value = self
            .client
            .request_with_bytes(Method::PUT, path, content.into(), Some(content_type), opts)
            .await?;
        // Checksums are accepted as a header in the JS client; keep the
        // parameter for parity and let callers verify server metadata.
        let _ = checksum_sha256;
        Ok(serde_json::from_value(value)?)
    }

    /// Create the metadata record and upload bytes in one call.
    pub async fn upload(
        &self,
        metadata: Value,
        content: impl Into<Bytes>,
        content_type: &str,
        opts: &RequestOptions,
    ) -> Result<FileObject> {
        let ticket = self.create(metadata, opts).await?;
        self.upload_bytes(&ticket.id, content, content_type, None, opts)
            .await
    }

    pub async fn download(&self, id: &str, opts: &RequestOptions) -> Result<BinaryResponse> {
        self.client
            .request_bytes(
                Method::GET,
                format!("{}/content", Self::path(id)),
                None,
                None,
                opts,
            )
            .await
    }

    pub async fn get(&self, id: &str, opts: &RequestOptions) -> Result<FileObject> {
        let value = self.client.get(Self::path(id), opts).await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn public_get(&self, id: &str, opts: &RequestOptions) -> Result<FileObject> {
        let opts = opts.clone().anonymous();
        let value = self
            .client
            .get(
                format!("/v1/capabilities/public/files/{}", segment(id)),
                &opts,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn public_download(&self, id: &str, opts: &RequestOptions) -> Result<BinaryResponse> {
        let opts = opts.clone().anonymous();
        self.client
            .request_bytes(
                Method::GET,
                format!("/v1/capabilities/public/files/{}/content", segment(id)),
                None,
                None,
                &opts,
            )
            .await
    }

    pub async fn list(
        &self,
        prefix: Option<&str>,
        limit: Option<i64>,
        offset: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<FilePage> {
        let mut params = Vec::new();
        if let Some(value) = prefix {
            params.push(("prefix", value.to_string()));
        }
        opt_num(&mut params, "limit", limit);
        opt_num(&mut params, "offset", offset);
        let value = self
            .client
            .get(
                format!("/v1/capabilities/files{}", query_string(&params)),
                opts,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn quota(&self, opts: &RequestOptions) -> Result<Value> {
        self.client.get("/v1/capabilities/files/quota", opts).await
    }

    pub async fn presign(
        &self,
        id: &str,
        method: &str,
        expires_in: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<Value> {
        let mut body = json!({ "method": method });
        if let Some(expires_in) = expires_in {
            body["expiresIn"] = json!(expires_in);
        }
        self.client
            .post(format!("{}/presign", Self::path(id)), body, opts)
            .await
    }

    pub async fn complete(
        &self,
        id: &str,
        size: Option<i64>,
        opts: &RequestOptions,
    ) -> Result<FileObject> {
        let body = match size {
            Some(size) => json!({ "size": size }),
            None => json!({}),
        };
        let value = self
            .client
            .post(format!("{}/complete", Self::path(id)), body, opts)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn delete(&self, id: &str, opts: &RequestOptions) -> Result<()> {
        self.client.delete(Self::path(id), opts).await?;
        Ok(())
    }
}
