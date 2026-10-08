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

// AssignRole assigns a role to a user.
func (c *Client) AssignRole(userID, roleID string) error {
	_, err := c.do("POST", "/v1/users/"+pathEscape(userID)+"/assign", map[string]any{"roleId": roleID})
	return err
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
func (c *Client) ServiceAccountToken(saID string, scopes []string) (map[string]any, error) {
	if len(scopes) == 0 {
		scopes = []string{"*"}
	}
	b, err := c.do("POST", "/v1/service-accounts/"+pathEscape(saID)+"/token", map[string]any{"scopes": scopes})
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

// CreateWorkflowRaw creates a workflow from a raw n8n definition.
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

func (c *Client) ActivateWorkflow(id string) error {
	_, err := c.do("POST", "/v1/workflows/"+pathEscape(id)+"/activate", map[string]any{})
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
func (c *Client) ListExecutions(query string) (any, error) {
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
	var out any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetExecution(id string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/executions/"+pathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
