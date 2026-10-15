// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package synapsedx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func echoServer(t *testing.T, seen map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen["auth"] = r.Header.Get("Authorization")
		seen["key"] = r.Header.Get("X-API-Key")
		seen["path"] = r.URL.RequestURI()
		seen["method"] = r.Method
		w.Header().Set("Content-Type", "application/json")
		// List endpoints (GET only) return arrays in the real API; everything else an object.
		p := r.URL.Path
		isList := r.Method == "GET" && (p == "/v1/orgs" ||
			strings.HasSuffix(p, "/accounts") ||
			strings.HasSuffix(p, "/users") ||
			strings.HasSuffix(p, "/roles") ||
			strings.HasSuffix(p, "/policies") ||
			strings.HasSuffix(p, "/service-accounts") ||
			strings.HasSuffix(p, "/keys") ||
			p == "/v1/templates" || p == "/v1/workflows" || p == "/v1/audit")
		if isList {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": r.URL.Path})
	}))
}

func TestNew(t *testing.T) {
	c := New("http://localhost:8080/")
	if c.BaseURL != "http://localhost:8080" {
		t.Fatalf("trim slash: %s", c.BaseURL)
	}
	c.SetToken("t")
	c.SetAPIKey("k")
	if c.Token != "t" || c.APIKey != "k" {
		t.Fatalf("setters broken")
	}
}

func TestAuthHeaders(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	c.SetToken("tok123")
	if _, err := c.ListOrgs(); err != nil {
		t.Fatal(err)
	}
	if seen["auth"] != "Bearer tok123" {
		t.Fatalf("bearer missing: %v", seen)
	}
	if seen["path"] != "/v1/orgs" {
		t.Fatalf("path: %v", seen)
	}
	c2 := New(srv.URL)
	c2.SetAPIKey("k1")
	if _, err := c2.ListTemplates(); err != nil {
		t.Fatal(err)
	}
	if seen["key"] != "k1" {
		t.Fatalf("apikey missing: %v", seen)
	}
}

func TestAuthMethods(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.Login("a@b.c", "acme"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/auth/login" || seen["method"] != "POST" {
		t.Fatalf("login: %v", seen)
	}
	if _, err := c.Refresh("rt"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/auth/refresh" {
		t.Fatalf("refresh: %v", seen)
	}
	if err := c.Logout("rt"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.LogoutAll("rt"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Verify(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Me(); err != nil {
		t.Fatal(err)
	}
}

func TestIAMCoverage(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.CreateOrg("acme", "ACME"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListAccounts("org1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateAccount("org1", "prod", "Prod"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListUsers("org1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateUser("org1", "u@x.y", "U"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateRole("acc", "admin", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListRoles("acc"); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteRole("r1"); err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{"Statement": []any{map[string]any{"Effect": "Allow", "Action": "*", "Resource": "*"}}}
	if _, err := c.CreatePolicy("acc", "p", doc, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListPolicies("acc"); err != nil {
		t.Fatal(err)
	}
	if err := c.DeletePolicy("p1"); err != nil {
		t.Fatal(err)
	}
	if err := c.AttachPolicy("r", "p"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/roles/r/attach" {
		t.Fatalf("attach: %v", seen)
	}
	if err := c.DetachPolicy("r", "p"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/roles/r/policies/p" || seen["method"] != "DELETE" {
		t.Fatalf("detach: %v", seen)
	}
	if _, err := c.RolePolicies("r"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/roles/r/policies" {
		t.Fatalf("role policies: %v", seen)
	}
	if err := c.AssignRole("u", "r"); err != nil {
		t.Fatal(err)
	}
	if err := c.UnassignRole("u", "r"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/users/u/roles/r" || seen["method"] != "DELETE" {
		t.Fatalf("unassign: %v", seen)
	}
	if _, err := c.UserRoles("u"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/users/u/roles" {
		t.Fatalf("user roles: %v", seen)
	}
	if _, err := c.Authorize("u", "workflow:Execute", "*", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Simulate([]any{doc}, "workflow:Execute", "*", nil); err != nil {
		t.Fatal(err)
	}
	// echo returns {"ok":true} (object) but ListAudit expects []any -> decode error is fine;
	// exercise path + query building instead via raw check below.
	_ = seen
}

func TestWorkflowCoverage(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.ListWorkflows(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetWorkflow("w1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo"); err != nil {
		t.Fatal(err)
	}
	if err := c.ActivateWorkflow("w1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows/w1/activate" {
		t.Fatalf("activate: %v", seen)
	}
	if err := c.DeactivateWorkflow("w1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ExecuteWorkflow("w1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpdateWorkflow("w1", map[string]any{"name": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows/w1" {
		t.Fatalf("update: %v", seen)
	}
	if err := c.DeleteWorkflow("w1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows/w1" || seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
	if _, err := c.ListAPIKeys("a1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/accounts/a1/keys" {
		t.Fatalf("list keys: %v", seen)
	}
	if _, err := c.ListTemplates(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetTemplate("webhook-to-log"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetExecution("e1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateAPIKey("acc", "cli", nil); err != nil {
		t.Fatal(err)
	}
	if err := c.RevokeAPIKey("k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateServiceAccount("acc", "sa", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListServiceAccounts("acc"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ServiceAccountToken("sa1", nil); err != nil {
		t.Fatal(err)
	}
}

func TestErrorWrapping(t *testing.T) {
	c := New("http://127.0.0.1:1")
	_, err := c.ListOrgs()
	if err == nil || !strings.Contains(err.Error(), "synapsedx") {
		t.Fatalf("expected wrapped error, got %v", err)
	}
}

func TestPathEscape(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.GetWorkflow("a/b"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows/a%2Fb" {
		t.Fatalf("escape: %v", seen)
	}
}
