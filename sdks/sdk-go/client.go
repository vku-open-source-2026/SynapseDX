// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseDX Go SDK — gateway + IAM + workflow client (net/http only, no deps).
package synapsedx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client talks to the SynapseDX gateway (e.g. http://localhost:8080).
type Client struct {
	BaseURL string
	Token   string // Bearer JWT (user or service-account token)
	APIKey  string // X-API-Key
	HTTP    *http.Client
}

// New creates a client with a 15s timeout. Use NewWithClient for custom transport.
func New(baseURL string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// NewWithClient allows custom timeout / transport (tests, mTLS, tracing...).
func NewWithClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: httpClient}
}

// SetToken sets the Bearer JWT for subsequent calls.
func (c *Client) SetToken(t string) { c.Token = t }

// SetAPIKey sets the X-API-Key for subsequent calls.
func (c *Client) SetAPIKey(k string) { c.APIKey = k }

func (c *Client) do(method, path string, body any) ([]byte, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("synapsedx encode %s: %w", path, err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, r)
	if err != nil {
		return nil, fmt.Errorf("synapsedx request %s: %w", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("synapsedx network %s: %w", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("synapsedx %d %s: %s", resp.StatusCode, path, truncate(string(b), 500))
	}
	return b, nil
}

func unmarshal(b []byte, out any) error {
	if len(b) == 0 {
		return nil
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("synapsedx decode: %w", err)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func pathEscape(s string) string { return url.PathEscape(s) }

// ---------- auth ----------

// Login issues tokens via dev login (IAM_ALLOW_DEV_LOGIN=true) or test seed.
func (c *Client) Login(email, orgSlug string) (map[string]any, error) {
	if orgSlug == "" {
		orgSlug = "acme"
	}
	b, err := c.do("POST", "/v1/auth/login", map[string]any{"email": email, "orgSlug": orgSlug})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Refresh rotates a refresh token (atomic server-side; old token is revoked).
func (c *Client) Refresh(refreshToken string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/auth/refresh", map[string]any{"refreshToken": refreshToken})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Logout revokes a single refresh token.
func (c *Client) Logout(refreshToken string) error {
	_, err := c.do("POST", "/v1/auth/logout", map[string]any{"refreshToken": refreshToken})
	return err
}

// LogoutAll revokes every session of the token owner (takes any still-valid refresh token).
func (c *Client) LogoutAll(refreshToken string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/auth/logout-all", map[string]any{"refreshToken": refreshToken})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Verify checks the current Bearer / X-API-Key without fetching the user.
func (c *Client) Verify() (map[string]any, error) {
	b, err := c.do("GET", "/v1/auth/verify", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Me returns the user record behind the current Bearer token.
func (c *Client) Me() (map[string]any, error) {
	b, err := c.do("GET", "/v1/auth/me", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// OIDCConfig returns the IdP discovery info (issuer, client, demo-callback flag).
func (c *Client) OIDCConfig() (map[string]any, error) {
	b, err := c.do("GET", "/v1/auth/oidc/config", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// OIDCStart begins the SSO round-trip (returns authorizeUrl + signed state).
func (c *Client) OIDCStart(org string) (map[string]any, error) {
	if org == "" {
		org = "acme"
	}
	b, err := c.do("GET", "/v1/auth/oidc/start?org="+url.QueryEscape(org), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// OIDCCallback exchanges an IdP authorization code (+ signed state) for tokens.
func (c *Client) OIDCCallback(code, state string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/auth/oidc/callback", map[string]any{"code": code, "state": state})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- orgs / accounts / users ----------

func (c *Client) ListOrgs() ([]any, error) {
	b, err := c.do("GET", "/v1/orgs", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateOrg creates an organization by slug.
func (c *Client) CreateOrg(slug, displayName string) (map[string]any, error) {
	if displayName == "" {
		displayName = slug
	}
	b, err := c.do("POST", "/v1/orgs", map[string]any{"slug": slug, "displayName": displayName})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListAccounts lists accounts in an org.
func (c *Client) ListAccounts(orgID string) ([]any, error) {
	b, err := c.do("GET", "/v1/orgs/"+pathEscape(orgID)+"/accounts", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateAccount creates an account under an org.
func (c *Client) CreateAccount(orgID, slug, displayName string) (map[string]any, error) {
	if displayName == "" {
		displayName = slug
	}
	b, err := c.do("POST", "/v1/orgs/"+pathEscape(orgID)+"/accounts", map[string]any{"slug": slug, "displayName": displayName})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListUsers lists users in an org.
func (c *Client) ListUsers(orgID string) ([]any, error) {
	b, err := c.do("GET", "/v1/orgs/"+pathEscape(orgID)+"/users", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateUser upserts a user in an org.
func (c *Client) CreateUser(orgID, email, displayName string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/orgs/"+pathEscape(orgID)+"/users", map[string]any{"email": email, "displayName": displayName})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UserPolicies lists the effective policy documents of a user (debug helper).
func (c *Client) UserPolicies(userID string) ([]any, error) {
	b, err := c.do("GET", "/v1/users/"+pathEscape(userID)+"/policies", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- roles / policies / authorize ----------

func (c *Client) CreateRole(accountID, slug, description string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/accounts/"+pathEscape(accountID)+"/roles", map[string]any{"slug": slug, "description": description})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ListRoles(accountID string) ([]any, error) {
	b, err := c.do("GET", "/v1/accounts/"+pathEscape(accountID)+"/roles", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) DeleteRole(roleID string) error {
	_, err := c.do("DELETE", "/v1/roles/"+pathEscape(roleID), nil)
	return err
}

func (c *Client) CreatePolicy(accountID, slug string, document any, description string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/accounts/"+pathEscape(accountID)+"/policies", map[string]any{"slug": slug, "document": document, "description": description})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ListPolicies(accountID string) ([]any, error) {
	b, err := c.do("GET", "/v1/accounts/"+pathEscape(accountID)+"/policies", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) DeletePolicy(policyID string) error {
	_, err := c.do("DELETE", "/v1/policies/"+pathEscape(policyID), nil)
	return err
}

// AttachPolicy attaches a policy to a role.
func (c *Client) AttachPolicy(roleID, policyID string) error {
	_, err := c.do("POST", "/v1/roles/"+pathEscape(roleID)+"/attach", map[string]any{"policyId": policyID})
	return err
}

// DetachPolicy removes a policy from a role.
func (c *Client) DetachPolicy(roleID, policyID string) error {
	_, err := c.do("DELETE", "/v1/roles/"+pathEscape(roleID)+"/policies/"+pathEscape(policyID), nil)
	return err
}

// RolePolicies lists the policies attached to a role.
func (c *Client) RolePolicies(roleID string) ([]any, error) {
	b, err := c.do("GET", "/v1/roles/"+pathEscape(roleID)+"/policies", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AssignRole assigns a role to a user.
func (c *Client) AssignRole(userID, roleID string) error {
	_, err := c.do("POST", "/v1/users/"+pathEscape(userID)+"/assign", map[string]any{"roleId": roleID})
	return err
}

// UnassignRole removes a role from a user.
func (c *Client) UnassignRole(userID, roleID string) error {
	_, err := c.do("DELETE", "/v1/users/"+pathEscape(userID)+"/roles/"+pathEscape(roleID), nil)
	return err
}

// UserRoles lists the roles assigned to a user.
func (c *Client) UserRoles(userID string) ([]any, error) {
	b, err := c.do("GET", "/v1/users/"+pathEscape(userID)+"/roles", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Authorize checks userId/action/resource with optional context.
func (c *Client) Authorize(userID, action, resource string, context map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/authorize", map[string]any{"userId": userID, "action": action, "resource": resource, "context": context})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Simulate dry-runs policy documents without a user (like AWS IAM Policy Simulator).
func (c *Client) Simulate(documents []any, action, resource string, context map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/authorize/dry-run", map[string]any{"documents": documents, "action": action, "resource": resource, "context": context})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListAudit reads the audit log (limit clamped server-side to 1..200).
func (c *Client) ListAudit(limit int, actor string) ([]any, error) {
	if limit <= 0 {
		limit = 50
	}
	q := fmt.Sprintf("?limit=%d", limit)
	if actor != "" {
		q += "&actor=" + url.QueryEscape(actor)
	}
	b, err := c.do("GET", "/v1/audit"+q, nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- API keys ----------

func (c *Client) CreateAPIKey(accountID, name string, scopes []string) (map[string]any, error) {
	if name == "" {
		name = "default"
	}
	if len(scopes) == 0 {
		scopes = []string{"*"}
	}
	b, err := c.do("POST", "/v1/accounts/"+pathEscape(accountID)+"/keys", map[string]any{"name": name, "scopes": scopes})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) RevokeAPIKey(keyID string) error {
	_, err := c.do("DELETE", "/v1/keys/"+pathEscape(keyID), nil)
	return err
}

// ListAPIKeys returns key metadata for an account (id/prefix only — never secrets).
func (c *Client) ListAPIKeys(accountID string) ([]any, error) {
	b, err := c.do("GET", "/v1/accounts/"+pathEscape(accountID)+"/keys", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// VerifyAPIKey checks a raw key via the internal verify endpoint.
func (c *Client) VerifyAPIKey(apiKey string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/keys/verify", map[string]any{"apiKey": apiKey})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- service accounts ----------

func (c *Client) CreateServiceAccount(accountID, slug, description string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/accounts/"+pathEscape(accountID)+"/service-accounts", map[string]any{"slug": slug, "description": description})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ListServiceAccounts(accountID string) ([]any, error) {
	b, err := c.do("GET", "/v1/accounts/"+pathEscape(accountID)+"/service-accounts", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ServiceAccountToken mints a short-lived JWT for a service account.
// A nil scopes slice delegates the caller's own scopes (never widens to '*');
// pass an explicit list to narrow the minted token.
func (c *Client) ServiceAccountToken(saID string, scopes []string) (map[string]any, error) {
	body := map[string]any{}
	if scopes != nil {
		body["scopes"] = scopes
	}
	b, err := c.do("POST", "/v1/service-accounts/"+pathEscape(saID)+"/token", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Call is a generic escape hatch (forward-compat with endpoints added after
// this SDK). Method is e.g. "GET"/"POST"/"PUT"/"DELETE"; path must start
// with "/". Decodes the JSON response into `any` (use a typed assertion or
// UnwrapExecutions on the result as needed).
func (c *Client) Call(method, path string, body any) (any, error) {
	m := strings.ToUpper(strings.TrimSpace(method))
	if m == "" {
		m = "GET"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if m == "GET" || m == "HEAD" {
		body = nil
	}
	b, err := c.do(m, path, body)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, nil
	}
	var out any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- credentials (account-scoped secrets; PROPOSED contract — backend in progress) ----------
//
// Backend contract (dev1, pending): secrets are encrypted at rest and NEVER
// returned — create/rotate accept a secret once; list/get return metadata
// only: {id, name, type, accountId, expiresAt, version}.
// credType is one of bearer|basic|apiKey|oauth2 (passed through, not validated
// client-side, so future types keep working).

// CreateCredential stores an account credential (secret is write-only, never returned).
func (c *Client) CreateCredential(accountID, name, credType, secret, expiresAt string) (map[string]any, error) {
	body := map[string]any{"name": name, "type": credType, "secret": secret}
	if expiresAt != "" {
		body["expiresAt"] = expiresAt
	}
	b, err := c.do("POST", "/v1/accounts/"+pathEscape(accountID)+"/credentials", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListCredentials lists credential metadata for an account (never secret values).
func (c *Client) ListCredentials(accountID string) ([]any, error) {
	b, err := c.do("GET", "/v1/accounts/"+pathEscape(accountID)+"/credentials", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetCredential fetches one credential's metadata (never the secret).
func (c *Client) GetCredential(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/credentials/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteCredential deletes a credential.
func (c *Client) DeleteCredential(id string) error {
	_, err := c.do("DELETE", "/v1/credentials/"+pathEscape(id), nil)
	return err
}

// RotateCredential rotates a credential's secret (bumps version; old secret stops working).
func (c *Client) RotateCredential(id, secret string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/credentials/"+pathEscape(id)+"/rotate", map[string]any{"secret": secret})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- LDS (datasources / licenses / attributes / records / entities) ----------
//
// Contract: GET /v1/lds/licenses returns the built-in SPDX + proprietary
// catalog; datasources own a name/entityType/license plus a set of typed
// attributes; records are ingested into NGSI-LD entities exported as JSON-LD.
// Every endpoint accepts a Bearer JWT or an X-API-Key.

// ListLDSLicenses lists the built-in license catalog ({id, name, url, openData}).
func (c *Client) ListLDSLicenses() ([]any, error) {
	b, err := c.do("GET", "/v1/lds/licenses", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListLDSDatasources lists datasources, optionally filtered by orgID/accountID
// (pass "" to omit a filter).
func (c *Client) ListLDSDatasources(orgID, accountID string) ([]any, error) {
	q := url.Values{}
	if orgID != "" {
		q.Set("orgId", orgID)
	}
	if accountID != "" {
		q.Set("accountId", accountID)
	}
	p := "/v1/lds/datasources"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateLDSDatasource creates a datasource from the contract body: name,
// entityType and license are required; slug/licenseUrl/contexts/
// defaultVisibility/description/orgId/accountId are optional.
func (c *Client) CreateLDSDatasource(body map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/lds/datasources", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetLDSDatasource fetches one datasource plus its attributes and stats.
func (c *Client) GetLDSDatasource(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/lds/datasources/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateLDSDatasource patches a datasource (partial body; same fields as create).
func (c *Client) UpdateLDSDatasource(id string, patch map[string]any) (map[string]any, error) {
	b, err := c.do("PATCH", "/v1/lds/datasources/"+pathEscape(id), patch)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteLDSDatasource removes a datasource ({ok: true} on success).
func (c *Client) DeleteLDSDatasource(id string) error {
	_, err := c.do("DELETE", "/v1/lds/datasources/"+pathEscape(id), nil)
	return err
}

// ListLDSAttributes lists a datasource's attribute definitions.
func (c *Client) ListLDSAttributes(datasourceID string) ([]any, error) {
	b, err := c.do("GET", "/v1/lds/datasources/"+pathEscape(datasourceID)+"/attributes", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetLDSAttributes replaces a datasource's attribute definitions
// ([{name, ngsiLdType?, visibility?, description?, sourceField?}]). The server
// rejects reserved names with 400 reserved_attribute.
func (c *Client) SetLDSAttributes(datasourceID string, attributes []any) ([]any, error) {
	b, err := c.do("PUT", "/v1/lds/datasources/"+pathEscape(datasourceID)+"/attributes",
		map[string]any{"attributes": attributes})
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// IngestLDSRecords ingests records into a datasource. records accepts a single
// record object, a []any of records (wrapped as {"records": ...}), or a
// pre-wrapped map already carrying a "records" or "record" key.
func (c *Client) IngestLDSRecords(datasourceID string, records any) (map[string]any, error) {
	var body any
	switch v := records.(type) {
	case []any:
		body = map[string]any{"records": v}
	case map[string]any:
		if _, ok := v["records"]; ok {
			body = v
		} else if _, ok := v["record"]; ok {
			body = v
		} else {
			body = map[string]any{"record": v}
		}
	default:
		body = map[string]any{"record": records}
	}
	b, err := c.do("POST", "/v1/lds/datasources/"+pathEscape(datasourceID)+"/records", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListLDSEntities lists NGSI-LD entities of a datasource. params is allowlisted
// to limit (1..500, server default 100), offset and visibility=public|restricted.
func (c *Client) ListLDSEntities(datasourceID string, params map[string]string) ([]any, error) {
	allowed := []string{"limit", "offset", "visibility"}
	q := url.Values{}
	for _, k := range allowed {
		if v, ok := params[k]; ok && v != "" {
			q.Set(k, v)
		}
	}
	p := "/v1/lds/datasources/" + pathEscape(datasourceID) + "/entities"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetLDSEntity fetches one entity by its NGSI-LD id (404 not_found when absent).
func (c *Client) GetLDSEntity(datasourceID, entityID string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/lds/datasources/"+pathEscape(datasourceID)+"/entities/"+pathEscape(entityID), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetLDSStats reads a datasource's record/attribute counts and last ingest time.
func (c *Client) GetLDSStats(datasourceID string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/lds/datasources/"+pathEscape(datasourceID)+"/stats", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- workflows / templates / executions ----------

func (c *Client) ListWorkflows() (any, error) {
	b, err := c.do("GET", "/v1/workflows", nil)
	if err != nil {
		return nil, err
	}
	var out any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetWorkflow(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/workflows/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateWorkflowFromTemplate instantiates a built-in template on the engine.
func (c *Client) CreateWorkflowFromTemplate(template, name string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/workflows", map[string]any{"template": template, "name": name})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateWorkflowRaw creates a workflow from a raw workflow definition.
func (c *Client) CreateWorkflowRaw(name string, definition any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/workflows", map[string]any{"name": name, "definition": definition})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateWorkflow updates a workflow's name and/or definition.
func (c *Client) UpdateWorkflow(id string, patch map[string]any) (map[string]any, error) {
	b, err := c.do("PUT", "/v1/workflows/"+pathEscape(id), patch)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ActivateWorkflow(id string) error {
	_, err := c.do("POST", "/v1/workflows/"+pathEscape(id)+"/activate", map[string]any{})
	return err
}

// DeleteWorkflow removes a workflow from the engine.
func (c *Client) DeleteWorkflow(id string) error {
	_, err := c.do("DELETE", "/v1/workflows/"+pathEscape(id), nil)
	return err
}

func (c *Client) DeactivateWorkflow(id string) error {
	_, err := c.do("POST", "/v1/workflows/"+pathEscape(id)+"/deactivate", map[string]any{})
	return err
}

// ExecuteWorkflow triggers a manual execution (proxied to the engine).
func (c *Client) ExecuteWorkflow(id string, payload any) (map[string]any, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	b, err := c.do("POST", "/v1/workflows/"+pathEscape(id)+"/execute", payload)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ListTemplates() ([]any, error) {
	b, err := c.do("GET", "/v1/templates", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetTemplate fetches a single built-in template definition by name.
func (c *Client) GetTemplate(name string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/templates/"+pathEscape(name), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListExecutions proxies the engine execution list (supports ?limit etc.).
// query may be a raw string ("limit=20&status=success") or "" for defaults.
// The engine returns {data: []}; UnwrapExecutions normalizes to []any so
// callers accept both the envelope and a bare array.
func (c *Client) ListExecutions(query string) ([]any, error) {
	p := "/v1/executions"
	if query != "" {
		if !strings.HasPrefix(query, "?") {
			query = "?" + query
		}
		p += query
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	return UnwrapExecutions(b)
}

// ListExecutionsWithParams builds the allowlisted query
// (limit/offset/workflowId/status/triggeredBy/includeData) and returns the unwrapped list.
func (c *Client) ListExecutionsWithParams(params map[string]string) ([]any, error) {
	allowed := []string{"limit", "offset", "workflowId", "status", "triggeredBy", "includeData"}
	q := url.Values{}
	for _, k := range allowed {
		if v, ok := params[k]; ok && v != "" {
			q.Set(k, v)
		}
	}
	qs := q.Encode()
	p := "/v1/executions"
	if qs != "" {
		p += "?" + qs
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	return UnwrapExecutions(b)
}

// UnwrapExecutions normalizes GET /v1/executions payloads: the engine returns
// {data: [...]}, older mocks return a bare array. Accepts both.
func UnwrapExecutions(b []byte) ([]any, error) {
	if len(b) == 0 {
		return []any{}, nil
	}
	var arr []any
	if err := json.Unmarshal(b, &arr); err == nil {
		return arr, nil
	}
	var env struct {
		Data []any `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("synapsedx decode: %w", err)
	}
	if env.Data == nil {
		return []any{}, nil
	}
	return env.Data, nil
}

// TestRun tries a definition without saving (POST /v1/workflows/test-run).
// Pass workflowID to attach the run to a saved workflow's history.
func (c *Client) TestRun(definition any, input any, workflowID ...string) (map[string]any, error) {
	if input == nil {
		input = map[string]any{}
	}
	body := map[string]any{"definition": definition, "input": input}
	if len(workflowID) > 0 && workflowID[0] != "" {
		body["workflowId"] = workflowID[0]
	}
	b, err := c.do("POST", "/v1/workflows/test-run", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetExecution(id string) (map[string]any, error) {
	return c.GetExecutionWithData(id, false)
}

// GetExecutionWithData fetches one execution; includeData=true adds per-node I/O.
func (c *Client) GetExecutionWithData(id string, includeData bool) (map[string]any, error) {
	p := "/v1/executions/" + pathEscape(id)
	if includeData {
		p += "?includeData=true"
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TriggerWebhook fires a public inbound webhook: ANY /webhook/:path (no auth).
// It triggers the ACTIVE workflow whose webhook node declares that path.
//
// NOTE: the gateway does not proxy /webhook/* — pass the workflow-service
// origin (e.g. http://localhost:4002), not the gateway URL. No auth headers
// are sent even if the client has a token configured.
func TriggerWebhook(webhookBaseURL, path string, payload any) (map[string]any, error) {
	return TriggerWebhookWithMethod(webhookBaseURL, path, payload, "")
}

// TriggerWebhookWithMethod is TriggerWebhook with an explicit HTTP method
// (default GET for nil payload, POST otherwise).
func TriggerWebhookWithMethod(webhookBaseURL, path string, payload any, method string) (map[string]any, error) {
	base := strings.TrimRight(webhookBaseURL, "/")
	clean := strings.Trim(strings.SplitN(strings.Trim(path, "/"), "?", 2)[0], "/")
	if clean == "" {
		return nil, fmt.Errorf("synapsedx webhook: path required")
	}
	if method == "" {
		method = "POST"
		if payload == nil {
			method = "GET"
		}
	}
	method = strings.ToUpper(method)
	url := base + "/webhook/" + clean
	var r io.Reader
	if payload != nil && method != "GET" && method != "HEAD" {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("synapsedx encode /webhook/%s: %w", clean, err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		return nil, fmt.Errorf("synapsedx request /webhook/%s: %w", clean, err)
	}
	if r != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	httpClient := &http.Client{Timeout: 15 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("synapsedx network /webhook/%s: %w", clean, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("synapsedx %d /webhook/%s: %s", resp.StatusCode, clean, truncate(string(b), 500))
	}
	if len(b) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("synapsedx decode: %w", err)
	}
	return out, nil
}
