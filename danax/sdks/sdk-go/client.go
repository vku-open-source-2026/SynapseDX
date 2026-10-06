// Copyright 2026 danax Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// danax Go SDK (minimal, fetch via net/http).
package danax

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	Token   string
	APIKey  string
	HTTP    *http.Client
}

func New(baseURL string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) do(method, path string, body any) ([]byte, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.BaseURL+path, r)
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.APIKey != "" {
		req.Header.Set("X-Api-Key", c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("danax %d %s: %s", resp.StatusCode, path, string(b))
	}
	return b, nil
}

// Login issues a dev token (see IAM /v1/auth/login).
func (c *Client) Login(email string) (map[string]any, error) {
	b, err := c.do("POST", "/v1/auth/login", map[string]any{"email": email, "orgSlug": "acme"})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out, nil
}

func (c *Client) ListOrgs() ([]any, error) {
	b, err := c.do("GET", "/v1/orgs", nil)
	if err != nil {
		return nil, err
	}
	var out []any
	_ = json.Unmarshal(b, &out)
	return out, nil
}
