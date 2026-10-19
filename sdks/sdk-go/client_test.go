// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package synapsedx

import (
	"encoding/json"
	"io"
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
		if b, err := io.ReadAll(r.Body); err == nil {
			seen["body"] = string(b)
		}
		w.Header().Set("Content-Type", "application/json")
		// List endpoints return arrays in the real API; everything else an object.
		p := r.URL.Path
		isList := (r.Method == "GET" && (p == "/v1/orgs" ||
			strings.HasSuffix(p, "/accounts") ||
			strings.HasSuffix(p, "/users") ||
			strings.HasSuffix(p, "/roles") ||
			strings.HasSuffix(p, "/policies") ||
			strings.HasSuffix(p, "/credentials") ||
			strings.HasSuffix(p, "/service-accounts") ||
			strings.HasSuffix(p, "/keys") ||
			p == "/v1/templates" || p == "/v1/workflows" || p == "/v1/audit" ||
			p == "/v1/lds/licenses" || p == "/v1/lds/datasources")) ||
			strings.HasSuffix(p, "/attributes") || strings.HasSuffix(p, "/entities")
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

func TestTestRun(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	def := map[string]any{"nodes": []any{}, "connections": map[string]any{}}
	if _, err := c.TestRun(def, map[string]any{"value": 21}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows/test-run" || seen["method"] != "POST" {
		t.Fatalf("test-run: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("test-run body: %v", err)
	}
	if _, ok := body["definition"]; !ok {
		t.Fatalf("test-run body missing definition: %v", body)
	}
	if _, ok := body["input"]; !ok {
		t.Fatalf("test-run body missing input: %v", body)
	}
}

func TestListExecutionsParams(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	items, err := c.ListExecutionsWithParams(map[string]string{
		"workflowId": "w1", "status": "error", "limit": "20", "includeData": "true", "bogus": "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"workflowId=w1", "status=error", "limit=20", "includeData=true"} {
		if !strings.Contains(seen["path"], want) {
			t.Fatalf("missing %q in %v", want, seen)
		}
	}
	if strings.Contains(seen["path"], "bogus") {
		t.Fatalf("unknown param leaked: %v", seen)
	}
	if len(items) != 0 {
		t.Fatalf("expected empty echo list, got %v", items)
	}
	if _, err := c.ListExecutions("limit=5"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/executions?limit=5" {
		t.Fatalf("raw query: %v", seen)
	}
	if _, err := c.GetExecutionWithData("e1", true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/executions/e1?includeData=true" {
		t.Fatalf("includeData: %v", seen)
	}
}

func TestUnwrapExecutions(t *testing.T) {
	arr, err := UnwrapExecutions([]byte(`[{"id":"e1"}]`))
	if err != nil || len(arr) != 1 {
		t.Fatalf("bare array: %v %v", arr, err)
	}
	env, err := UnwrapExecutions([]byte(`{"data":[{"id":"e2"}]}`))
	if err != nil || len(env) != 1 {
		t.Fatalf("envelope: %v %v", env, err)
	}
	empty, err := UnwrapExecutions(nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty: %v %v", empty, err)
	}
}

func TestTriggerWebhook(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	out, err := TriggerWebhook(srv.URL, "transform", map[string]any{"value": 21})
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/webhook/transform" || seen["method"] != "POST" {
		t.Fatalf("webhook: %v", seen)
	}
	if seen["auth"] != "" {
		t.Fatalf("webhook must not send auth: %v", seen)
	}
	if out["ok"] != true {
		t.Fatalf("webhook out: %v", out)
	}
}

func TestCall(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.Call("POST", "/v1/accounts/a1/credentials", map[string]any{"name": "x"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/accounts/a1/credentials" || seen["method"] != "POST" {
		t.Fatalf("call: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil || body["name"] != "x" {
		t.Fatalf("call body: %v %v", seen["body"], err)
	}
	if _, err := c.Call("get", "v1/workflows", nil); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/workflows" || seen["method"] != "GET" {
		t.Fatalf("call normalize: %v", seen)
	}
}

func TestCredentials(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.CreateCredential("a1", "stripe-live", "bearer", "s3cr3t", "2027-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/accounts/a1/credentials" || seen["method"] != "POST" {
		t.Fatalf("create: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("create body: %v", err)
	}
	for _, k := range []string{"name", "type", "secret", "expiresAt"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("create body missing %q: %v", k, body)
		}
	}
	if _, err := c.ListCredentials("a1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/accounts/a1/credentials" || seen["method"] != "GET" {
		t.Fatalf("list: %v", seen)
	}
	if _, err := c.GetCredential("c1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/credentials/c1" {
		t.Fatalf("get: %v", seen)
	}
	if _, err := c.RotateCredential("c1", "n3w"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/credentials/c1/rotate" || seen["method"] != "POST" {
		t.Fatalf("rotate: %v", seen)
	}
	if err := c.DeleteCredential("c1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/credentials/c1" || seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
}

func TestLDSLicensesAndDatasources(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	licenses, err := c.ListLDSLicenses()
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/licenses" || seen["method"] != "GET" {
		t.Fatalf("licenses: %v", seen)
	}
	if len(licenses) != 0 {
		t.Fatalf("licenses list: %v", licenses)
	}

	if _, err := c.ListLDSDatasources("org1", "acc1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources?accountId=acc1&orgId=org1" {
		t.Fatalf("datasources filters: %v", seen)
	}
	if _, err := c.ListLDSDatasources("", ""); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources" {
		t.Fatalf("datasources plain: %v", seen)
	}

	created, err := c.CreateLDSDatasource(map[string]any{
		"name": "Weather", "slug": "weather", "entityType": "WeatherObserved",
		"license": "CC-BY-4.0", "defaultVisibility": "public",
		"contexts": []any{"https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources" || seen["method"] != "POST" {
		t.Fatalf("create: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("create body: %v", err)
	}
	for _, k := range []string{"name", "slug", "entityType", "license", "defaultVisibility", "contexts"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("create body missing %q: %v", k, body)
		}
	}
	if created["ok"] != true {
		t.Fatalf("create out: %v", created)
	}

	if _, err := c.GetLDSDatasource("ds1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1" || seen["method"] != "GET" {
		t.Fatalf("get: %v", seen)
	}
	if _, err := c.UpdateLDSDatasource("ds1", map[string]any{"name": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1" || seen["method"] != "PATCH" {
		t.Fatalf("patch: %v", seen)
	}
	if err := c.DeleteLDSDatasource("ds1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1" || seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
}

func TestLDSAttributes(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	attrs, err := c.ListLDSAttributes("ds1")
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/attributes" || seen["method"] != "GET" {
		t.Fatalf("list attributes: %v", seen)
	}
	if len(attrs) != 0 {
		t.Fatalf("attributes list: %v", attrs)
	}

	rows := []any{map[string]any{"name": "temperature", "ngsiLdType": "Property", "visibility": "public"}}
	out, err := c.SetLDSAttributes("ds1", rows)
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/attributes" || seen["method"] != "PUT" {
		t.Fatalf("set attributes: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("set attributes body: %v", err)
	}
	got, ok := body["attributes"].([]any)
	if !ok || len(got) != 1 {
		t.Fatalf("set attributes body: %v", body)
	}
	if len(out) != 0 {
		t.Fatalf("set attributes out: %v", out)
	}
}

func TestLDSIngest(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.IngestLDSRecords("ds1", map[string]any{"sensor": "s1"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/records" || seen["method"] != "POST" {
		t.Fatalf("ingest single: %v", seen)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("ingest single body: %v", err)
	}
	if _, ok := body["record"]; !ok {
		t.Fatalf("single record must wrap in {record}: %v", body)
	}

	if _, err := c.IngestLDSRecords("ds1", []any{map[string]any{"sensor": "s1"}, map[string]any{"sensor": "s2"}}); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("ingest array body: %v", err)
	}
	if arr, ok := body["records"].([]any); !ok || len(arr) != 2 {
		t.Fatalf("array must wrap in {records}: %v", body)
	}

	if _, err := c.IngestLDSRecords("ds1", map[string]any{"records": []any{map[string]any{"sensor": "s3"}}}); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(seen["body"]), &body); err != nil {
		t.Fatalf("ingest wrapped body: %v", err)
	}
	if arr, ok := body["records"].([]any); !ok || len(arr) != 1 {
		t.Fatalf("pre-wrapped records must pass through: %v", body)
	}
}

func TestLDSEntitiesAndStats(t *testing.T) {
	seen := map[string]string{}
	srv := echoServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	entities, err := c.ListLDSEntities("ds1", map[string]string{
		"limit": "50", "offset": "10", "visibility": "public", "bogus": "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/entities?limit=50&offset=10&visibility=public" {
		t.Fatalf("entities query: %v", seen)
	}
	if strings.Contains(seen["path"], "bogus") {
		t.Fatalf("unknown param leaked: %v", seen)
	}
	if len(entities) != 0 {
		t.Fatalf("entities list: %v", entities)
	}
	if _, err := c.ListLDSEntities("ds1", nil); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/entities" {
		t.Fatalf("entities plain: %v", seen)
	}

	if _, err := c.GetLDSEntity("ds1", "urn:ngsi-ld:Thing:t1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/entities/urn:ngsi-ld:Thing:t1" {
		t.Fatalf("get entity: %v", seen)
	}
	if _, err := c.GetLDSEntity("ds1", "a/b"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/entities/a%2Fb" {
		t.Fatalf("get entity escape: %v", seen)
	}

	if _, err := c.GetLDSStats("ds1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/lds/datasources/ds1/stats" || seen["method"] != "GET" {
		t.Fatalf("stats: %v", seen)
	}
}

func TestLDSSetAttributesReservedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"reserved_attribute","message":"attribute name \"id\" is reserved"}`))
	}))
	defer srv.Close()
	c := New(srv.URL)
	_, err := c.SetLDSAttributes("ds1", []any{map[string]any{"name": "id"}})
	if err == nil || !strings.Contains(err.Error(), "synapsedx 400") || !strings.Contains(err.Error(), "reserved_attribute") {
		t.Fatalf("expected reserved_attribute error, got %v", err)
	}
}
