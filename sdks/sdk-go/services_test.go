// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package synapseone

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// serviceServer mimics the gateway routes used by the new SDK modules.
func serviceServer(t *testing.T, seen map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen["auth"] = r.Header.Get("Authorization")
		seen["key"] = r.Header.Get("X-API-Key")
		seen["tenant"] = r.Header.Get("x-synapseone-tenant")
		seen["path"] = r.URL.RequestURI()
		seen["method"] = r.Method
		seen["body"] = ""
		if b, err := io.ReadAll(r.Body); err == nil {
			seen["body"] = string(b)
		}
		p := r.URL.Path
		var payload any = map[string]any{"ok": true}
		switch {
		case r.Method == "GET" && p == "/v1/base/collections":
			payload = []any{}
		case r.Method == "GET" && p == "/v1/base/collections/parks/documents":
			payload = []any{map[string]any{
				"id": "d1", "data": map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}},
				"version": 1, "createdAt": "t", "updatedAt": "t",
			}}
		case r.Method == "GET" && p == "/v1/base/collections/parks/documents/d1":
			payload = map[string]any{
				"id": "d1", "object": map[string]any{"name": "Central", "capacity": 10},
				"data":    map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}},
				"version": 3, "createdAt": "t", "updatedAt": "t", "collection": "parks",
			}
		case strings.HasSuffix(p, "/query"):
			payload = map[string]any{
				"items": []any{map[string]any{
					"id": "p1", "version": 1,
					"object": map[string]any{"name": "Central", "capacity": 10},
					"data":   map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}},
				}},
				"total": 1, "limit": 100, "offset": 0, "nextCursor": "abc",
			}
		case strings.HasSuffix(p, "/changes"):
			payload = map[string]any{"changes": []any{}, "nextSince": "2026-01-01T00:00:00.000Z", "hasMore": false}
		case strings.HasSuffix(p, "/vector-search"):
			payload = map[string]any{
				"items": []any{map[string]any{
					"id": "p1", "similarity": 0.99, "distance": 0.01, "version": 1,
					"object": map[string]any{"name": "Central", "capacity": 10},
					"data":   map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}},
				}},
				"total": 1, "limit": 10, "metric": "cosine",
			}
		case r.Method != "GET" && strings.HasPrefix(p, "/v1/base/collections/parks/documents") && !strings.HasSuffix(p, ":batch"):
			payload = map[string]any{
				"id": "p1", "data": map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}},
				"version": 1, "createdAt": "t", "updatedAt": "t",
			}
		case r.Method == "GET" && p == "/v1/faststore/keys":
			payload = map[string]any{"keys": []any{}, "cursor": nil, "truncated": false}
		case r.Method == "GET" && strings.HasPrefix(p, "/v1/faststore/keys/") && !strings.HasSuffix(p, "/ttl"):
			payload = map[string]any{"key": "user:1", "type": "string", "value": "v", "ttlSeconds": 60}
		case strings.HasSuffix(p, "/ttl"):
			payload = map[string]any{"key": "user:1", "ttlSeconds": 42}
		case r.Method == "GET" && p == "/v1/queue/queues":
			payload = []any{}
		case strings.HasSuffix(p, "/consume"):
			payload = map[string]any{
				"queue": "emails", "count": 1, "visibilityTimeoutSeconds": 30,
				"messages": []any{map[string]any{
					"id": "m1", "payload": map[string]any{"to": "a@b.c"},
					"attempts": 1, "maxAttempts": 5, "publishedAt": "t",
					"receipt": "r1", "leaseExpiresAt": "t2",
				}},
			}
		case strings.HasSuffix(p, "/ack"):
			payload = map[string]any{"ok": true, "queue": "emails", "receipt": "r1", "id": "m1"}
		case strings.HasSuffix(p, "/nack"):
			payload = map[string]any{"ok": true, "queue": "emails", "id": "m1", "state": "ready", "attempts": 2}
		case strings.HasSuffix(p, "/heartbeat"):
			payload = map[string]any{"ok": true, "queue": "emails", "receipt": "r1", "leaseExpiresAt": "t3", "visibilityTimeoutSeconds": 30}
		case r.Method == "GET" && (strings.HasSuffix(p, "/messages") || strings.HasSuffix(p, "/dead")):
			payload = map[string]any{"queue": "emails", "count": 0, "messages": []any{}}
		case strings.HasSuffix(p, "/replay"):
			payload = map[string]any{"ok": true, "queue": "emails", "message": map[string]any{"id": "m1", "attempts": 0}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
}

func jsonBody(t *testing.T, seen map[string]string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &out); err != nil {
		t.Fatalf("body %q: %v", seen["body"], err)
	}
	return out
}

func TestBaseCollections(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.CreateBaseCollection(map[string]any{
		"name": "parks", "description": "city parks",
		"mapping": map[string]any{"name": "profile.name"},
	}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections" || seen["method"] != "POST" {
		t.Fatalf("create: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["name"] != "parks" || body["description"] != "city parks" {
		t.Fatalf("create body: %v", body)
	}

	if _, err := c.ListBaseCollections("org1", "acc1"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections?accountId=acc1&orgId=org1" {
		t.Fatalf("list: %v", seen)
	}
	if _, err := c.GetBaseCollection("parks"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks" {
		t.Fatalf("get: %v", seen)
	}
	if _, err := c.UpdateBaseCollection("parks", map[string]any{"description": nil}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PATCH" || seen["path"] != "/v1/base/collections/parks" {
		t.Fatalf("patch: %v", seen)
	}
	if _, err := c.GetBaseCollectionStats("parks"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/stats" {
		t.Fatalf("stats: %v", seen)
	}
	if err := c.DeleteBaseCollection("parks"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
}

func TestBaseDocuments(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.CreateBaseDocument("parks", BaseDocumentInput{
		Object: map[string]any{"name": "Central"}, ID: "p1",
	}); err != nil {
		t.Fatal(err)
	}
	body := jsonBody(t, seen)
	if obj, ok := body["object"].(map[string]any); !ok || obj["name"] != "Central" {
		t.Fatalf("create object: %v", body)
	}
	if body["id"] != "p1" {
		t.Fatalf("create id: %v", body)
	}
	if _, err := c.CreateBaseDocument("parks", BaseDocumentInput{Data: map[string]any{"a": 1}}); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["data"] == nil {
		t.Fatalf("create data: %v", body)
	}
	if _, err := c.CreateBaseDocument("parks", BaseDocumentInput{}); err == nil {
		t.Fatal("expected exclusivity error for empty write")
	}
	if _, err := c.CreateBaseDocument("parks", BaseDocumentInput{
		Data: map[string]any{"a": 1}, Object: map[string]any{"a": 1},
	}); err == nil {
		t.Fatal("expected exclusivity error for data+object")
	}

	if _, err := c.GetBaseDocument("parks", "p1", "object"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents/p1?as=object" {
		t.Fatalf("get object: %v", seen)
	}
	if _, err := c.SetBaseDocument("parks", "p1", BaseDocumentInput{
		Data: map[string]any{"a": 1}, IfVersion: 2, Merge: true,
	}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PUT" {
		t.Fatalf("set method: %v", seen)
	}
	body = jsonBody(t, seen)
	if body["ifVersion"] != float64(2) || body["merge"] != true {
		t.Fatalf("set body: %v", body)
	}
	if _, err := c.UpdateBaseDocument("parks", "p1", BaseDocumentInput{
		Data: map[string]any{"b": 2}, Unset: []string{"profile.old"}, IfVersion: 3,
	}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PATCH" {
		t.Fatalf("update method: %v", seen)
	}
	body = jsonBody(t, seen)
	if body["ifVersion"] != float64(3) {
		t.Fatalf("update body: %v", body)
	}
	if _, err := c.UpdateBaseDocument("parks", "p1", BaseDocumentInput{}); err == nil {
		t.Fatal("expected empty patch error")
	}
	if err := c.DeleteBaseDocument("parks", "p1", 2); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents/p1?ifVersion=2" || seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
}

func TestBaseQueryIncrementBatchChanges(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	order := []BaseOrderBy{{Field: "name", Direction: "desc"}}
	out, err := c.QueryBaseDocuments("parks", BaseQuery{
		Where: map[string]any{"status": "active"}, OrderBy: order,
		Limit: 10, Offset: 5, Select: []string{"name"}, As: "object",
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/query" {
		t.Fatalf("query path: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["as"] != "object" || body["limit"] != float64(10) || body["offset"] != float64(5) {
		t.Fatalf("query body: %v", body)
	}
	if out.Total != 1 || out.NextCursor != "abc" || len(out.Items) != 1 {
		t.Fatalf("query out: %+v", out)
	}

	if _, err := c.IncrementBaseDocument("parks", "p1", "counter", 3, 2); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents/p1/increment" {
		t.Fatalf("increment path: %v", seen)
	}
	body = jsonBody(t, seen)
	if body["field"] != "counter" || body["by"] != float64(3) || body["ifVersion"] != float64(2) {
		t.Fatalf("increment body: %v", body)
	}

	ops := []any{map[string]any{"op": "create", "object": map[string]any{"name": "x"}}}
	if _, err := c.BatchBaseDocuments("parks", ops); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents:batch" {
		t.Fatalf("batch path: %v", seen)
	}

	changes, err := c.BaseChanges("parks", "2026-01-01T00:00:00Z", 50, "object")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(seen["path"], "since=2026-01-01T00%3A00%3A00Z") ||
		!strings.Contains(seen["path"], "limit=50") || !strings.Contains(seen["path"], "as=object") {
		t.Fatalf("changes query: %v", seen)
	}
	if changes["nextSince"] != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("changes out: %v", changes)
	}

	if _, err := c.ListBaseDocuments("parks", 10, 20); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents?limit=10&offset=20" {
		t.Fatalf("list docs: %v", seen)
	}
}

type park struct {
	Name     string `json:"name"`
	Capacity int    `json:"capacity"`
}

func TestBaseMappingHelpers(t *testing.T) {
	data := map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}}
	mapping := NewBaseMapping(map[string]string{
		"name": "profile.name", "capacity": "profile.capacity",
	})
	obj := DataToObject(data, mapping)
	if obj["name"] != "Central" || obj["capacity"] != 10 {
		t.Fatalf("data to object: %v", obj)
	}
	back := ObjectToData(map[string]any{"name": "Central"}, mapping)
	profile, ok := back["profile"].(map[string]any)
	if !ok || profile["name"] != "Central" {
		t.Fatalf("object to data: %v", back)
	}
	if got := DataToObject(map[string]any{"any": 1}, BaseMapping{}); got["any"] != 1 {
		t.Fatalf("empty mapping: %v", got)
	}
}

func TestBaseTypedCollection(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	parks := NewBaseCollection[park](c, "parks", NewBaseMapping(map[string]string{
		"name": "profile.name", "capacity": "profile.capacity",
	}))

	obj, err := parks.ToObject(park{Name: "Central", Capacity: 10})
	if err != nil || obj["name"] != "Central" || obj["capacity"] != float64(10) {
		t.Fatalf("to object: %v %v", obj, err)
	}
	fromObj, err := parks.FromObject(map[string]any{"name": "Central", "capacity": 10})
	if err != nil || fromObj != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("from object: %+v %v", fromObj, err)
	}
	fromData, err := parks.FromData(map[string]any{"profile": map[string]any{"name": "Central", "capacity": 10}})
	if err != nil || fromData != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("from data: %+v %v", fromData, err)
	}

	created, err := parks.Create(park{Name: "Central", Capacity: 10}, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if created != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("create out: %+v", created)
	}
	body := jsonBody(t, seen)
	if body["id"] != "p1" {
		t.Fatalf("create body: %v", body)
	}
	createdObj, _ := body["object"].(map[string]any)
	if createdObj["name"] != "Central" {
		t.Fatalf("create object: %v", body)
	}

	fetched, err := parks.Get("d1")
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/base/collections/parks/documents/d1?as=object" {
		t.Fatalf("get path: %v", seen)
	}
	if fetched != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("get out: %+v", fetched)
	}

	listed, err := parks.List(5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0] != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("list out: %+v", listed)
	}

	queried, err := parks.Query(BaseQuery{Where: map[string]any{"name": "Central"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(queried.Items) != 1 || queried.Items[0] != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("query out: %+v", queried)
	}

	updated, err := parks.Update("d1", park{Name: "Central", Capacity: 11}, []string{"profile.old"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if updated != (park{Name: "Central", Capacity: 10}) {
		t.Fatalf("update out: %+v", updated)
	}
	body = jsonBody(t, seen)
	if body["unset"] == nil {
		t.Fatalf("update body: %v", body)
	}

	incremented, err := parks.Increment("p1", "capacity", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if incremented.Capacity != 10 {
		t.Fatalf("increment out: %+v", incremented)
	}

	vsRes, err := c.VectorSearchBaseDocuments("parks", BaseVectorSearchOptions{
		Vector: []float64{0.1, 0.2, 0.3},
		Limit:  5,
		Metric: "cosine",
		Where:  map[string]any{"name": "Central"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(vsRes.Items) != 1 || vsRes.Items[0].Similarity < 0.9 {
		t.Fatalf("vector search out: %+v", vsRes)
	}

	colVs, err := parks.VectorSearch(BaseVectorSearchOptions{
		Vector: []float64{0.1, 0.2, 0.3},
		Limit:  5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(colVs.Items) != 1 || colVs.Items[0].Object.Name != "Central" {
		t.Fatalf("col vector search out: %+v", colVs)
	}
}

func TestFaststoreKVTenant(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)
	c.SetTenant("acme")

	if _, err := c.FaststoreSet("user:1", map[string]any{"a": 1}, FaststoreSetOptions{
		TTLSeconds: 60, IfNotExists: true,
	}); err != nil {
		t.Fatal(err)
	}
	if seen["tenant"] != "acme" {
		t.Fatalf("tenant header: %v", seen)
	}
	if seen["path"] != "/v1/faststore/keys/user:1" || seen["method"] != "PUT" {
		t.Fatalf("set path: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["ttlSeconds"] != float64(60) || body["ifNotExists"] != true {
		t.Fatalf("set body: %v", body)
	}

	got, err := c.FaststoreGet("user:1")
	if err != nil || got["value"] != "v" {
		t.Fatalf("get: %v %v", got, err)
	}
	if _, err := c.FaststoreExpire("user:1", 30); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/keys/user:1/expire" {
		t.Fatalf("expire: %v", seen)
	}
	if _, err := c.FaststoreIncr("counter", 2, 0); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["by"] != float64(2) {
		t.Fatalf("incr body: %v", body)
	}
	ttl, err := c.FaststoreTTL("user:1")
	if err != nil || ttl["ttlSeconds"] != float64(42) {
		t.Fatalf("ttl: %v %v", ttl, err)
	}
	if _, err := c.FaststoreKeys("user:", 5, "10"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/keys?cursor=10&limit=5&prefix=user%3A" {
		t.Fatalf("keys: %v", seen)
	}
	ops := []any{map[string]any{"op": "set", "key": "a", "value": 1}}
	if _, err := c.FaststoreBatch(ops); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/batch" {
		t.Fatalf("batch: %v", seen)
	}
	if err := c.FaststoreDelete("user:1"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" {
		t.Fatalf("delete: %v", seen)
	}
	c.SetTenant("")
}

func TestFaststoreCollectionsAndLocks(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.FaststoreHashSet("h1", map[string]any{"a": 1}, 10); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/hashes/h1" {
		t.Fatalf("hash set: %v", seen)
	}
	if body := jsonBody(t, seen); body["ttlSeconds"] != float64(10) {
		t.Fatalf("hash set body: %v", body)
	}
	if _, err := c.FaststoreHashGetField("h1", "a"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/hashes/h1/a" {
		t.Fatalf("hash get field: %v", seen)
	}
	if _, err := c.FaststoreHashIncr("h1", "a", 2, 0); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["field"] != "a" || body["by"] != float64(2) {
		t.Fatalf("hash incr body: %v", body)
	}
	if _, err := c.FaststoreListPush("l1", []any{"x", "y"}, FaststoreListPushOptions{Side: "left"}); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["side"] != "left" {
		t.Fatalf("list push body: %v", body)
	}
	if _, err := c.FaststoreListPop("l1", "right", 2); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["count"] != float64(2) {
		t.Fatalf("list pop body: %v", body)
	}
	if _, err := c.FaststoreListRange("l1", 0, -1); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/lists/l1?start=0&stop=-1" {
		t.Fatalf("list range: %v", seen)
	}
	if _, err := c.FaststoreSetAdd("s1", []any{"a"}, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := c.FaststoreSetContains("s1", "a"); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["member"] != "a" {
		t.Fatalf("set contains body: %v", body)
	}
	if _, err := c.FaststoreZSetAdd("z1", []FaststoreZSetMember{{Member: "a", Score: 2}}, 0); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["members"] == nil {
		t.Fatalf("zset add body: %v", body)
	}
	if _, err := c.FaststoreZSetRange("z1", 0, -1, true, true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/zsets/z1?rev=true&start=0&stop=-1&withScores=true" {
		t.Fatalf("zset range: %v", seen)
	}
	if _, err := c.FaststoreZSetIncr("z1", "a", 1.5, 0); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["by"] != 1.5 {
		t.Fatalf("zset incr body: %v", body)
	}
	if _, err := c.FaststoreLockAcquire("job", FaststoreLockOptions{
		TTLSeconds: 60, WaitMS: 500, Token: "tok",
	}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/faststore/locks/job/acquire" {
		t.Fatalf("lock acquire: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["waitMs"] != float64(500) || body["ttlSeconds"] != float64(60) || body["token"] != "tok" {
		t.Fatalf("lock body: %v", body)
	}
	if _, err := c.FaststoreLockExtend("job", "tok", 60); err != nil {
		t.Fatal(err)
	}
	if _, err := c.FaststoreLockRelease("job", "tok"); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["token"] != "tok" {
		t.Fatalf("lock release body: %v", body)
	}
}

func TestQueueConfigAndPublish(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.CreateQueue("emails", QueueConfig{MaxAttempts: 7, VisibilityTimeoutSeconds: 45}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails" || seen["method"] != "PUT" {
		t.Fatalf("create queue: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["maxAttempts"] != float64(7) || body["visibilityTimeoutSeconds"] != float64(45) {
		t.Fatalf("create queue body: %v", body)
	}
	if _, err := c.ListQueues(); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues" {
		t.Fatalf("list queues: %v", seen)
	}

	if _, err := c.PublishMessage("emails", map[string]any{"to": "a@b.c"}, QueuePublishOptions{
		DelaySeconds: 30, MaxAttempts: 3, Headers: map[string]any{"trace": "t1"},
		ID: "m1", DedupeKey: "welcome:a@b.c",
	}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/messages" {
		t.Fatalf("publish: %v", seen)
	}
	body = jsonBody(t, seen)
	if body["delaySeconds"] != float64(30) || body["dedupeKey"] != "welcome:a@b.c" {
		t.Fatalf("publish body: %v", body)
	}
	msgs := []any{map[string]any{"payload": 1}, map[string]any{"payload": 2, "dedupeKey": "k"}}
	if _, err := c.PublishMessages("emails", msgs); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/messages:batch" {
		t.Fatalf("publish batch: %v", seen)
	}
	if _, err := c.QueueStats("emails"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/stats" {
		t.Fatalf("stats: %v", seen)
	}
	if _, err := c.PurgeQueue("emails"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/purge" {
		t.Fatalf("purge: %v", seen)
	}
	if err := c.DeleteQueue("emails"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" {
		t.Fatalf("delete queue: %v", seen)
	}
}

func TestQueueConsumeAckNackHeartbeat(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	out, err := c.ConsumeMessages("emails", QueueConsumeOptions{
		MaxMessages: 5, VisibilityTimeoutSeconds: 20, Consumer: "w1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/consume" {
		t.Fatalf("consume: %v", seen)
	}
	body := jsonBody(t, seen)
	if body["maxMessages"] != float64(5) || body["consumer"] != "w1" {
		t.Fatalf("consume body: %v", body)
	}
	msgs, _ := out["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("consume out: %v", out)
	}
	msg, _ := msgs[0].(map[string]any)
	receipt, _ := msg["receipt"].(string)
	if receipt != "r1" {
		t.Fatalf("receipt: %v", msg)
	}

	if _, err := c.AckMessage("emails", receipt); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["receipt"] != "r1" {
		t.Fatalf("ack body: %v", body)
	}
	if _, err := c.AckMessages("emails", []string{"r1", "r2"}); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["receipts"] == nil {
		t.Fatalf("ack many body: %v", body)
	}
	requeue := false
	if _, err := c.NackMessage("emails", "r1", QueueNackOptions{
		Requeue: &requeue, DelaySeconds: 5, Error: "boom",
	}); err != nil {
		t.Fatal(err)
	}
	body = jsonBody(t, seen)
	if body["requeue"] != false || body["delaySeconds"] != float64(5) || body["error"] != "boom" {
		t.Fatalf("nack body: %v", body)
	}
	if _, err := c.HeartbeatMessage("emails", "r1", 60); err != nil {
		t.Fatal(err)
	}
	if body := jsonBody(t, seen); body["visibilityTimeoutSeconds"] != float64(60) {
		t.Fatalf("heartbeat body: %v", body)
	}
}

func TestQueueInspectionAndDeadLetters(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.PeekMessages("emails", 10, true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/messages?limit=10&ready=true" {
		t.Fatalf("peek: %v", seen)
	}
	if _, err := c.DeadMessages("emails", 5); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/dead?limit=5" {
		t.Fatalf("dead: %v", seen)
	}
	if _, err := c.ReplayDeadMessage("emails", "m1", 0, true); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/queue/queues/emails/dead/m1/replay" {
		t.Fatalf("replay: %v", seen)
	}
	if body := jsonBody(t, seen); body["resetAttempts"] != true {
		t.Fatalf("replay body: %v", body)
	}
	if err := c.DeleteDeadMessage("emails", "m1"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" || seen["path"] != "/v1/queue/queues/emails/dead/m1" {
		t.Fatalf("delete dead: %v", seen)
	}
}

func TestStreamTopicAndEvents(t *testing.T) {
	seen := map[string]string{}
	srv := serviceServer(t, seen)
	defer srv.Close()
	c := New(srv.URL)

	if _, err := c.CreateStreamTopic("telemetry", 5000, "", 0); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PUT" || seen["path"] != "/v1/stream/topics/telemetry" {
		t.Fatalf("create topic: %v", seen)
	}
	if body := jsonBody(t, seen); body["maxLen"] != float64(5000) {
		t.Fatalf("topic body: %v", body)
	}

	if _, err := c.ListStreamTopics(); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics" {
		t.Fatalf("list topics: %v", seen)
	}

	if _, err := c.GetStreamTopic("telemetry"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry" {
		t.Fatalf("get topic: %v", seen)
	}

	if _, err := c.StreamTopicStats("telemetry"); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/stats" {
		t.Fatalf("topic stats: %v", seen)
	}

	if _, err := c.PublishStreamEvent("telemetry", map[string]any{"temp": 24.5}, StreamPublishOptions{Key: "s1"}); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/stream/topics/telemetry/events" {
		t.Fatalf("publish event: %v", seen)
	}

	if _, err := c.PublishStreamBatch("telemetry", []map[string]any{{"payload": map[string]any{"a": 1}}}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/events:batch" {
		t.Fatalf("publish batch: %v", seen)
	}

	if _, err := c.ReadStreamEvents("telemetry", StreamReadOptions{FromID: "0-0", Count: 10}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/read" {
		t.Fatalf("read stream: %v", seen)
	}

	if _, err := c.QueryStreamRange("telemetry", StreamRangeOptions{Start: "0-0", End: "+", Count: 5}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/range?count=5&end=%2B&start=0-0" {
		t.Fatalf("stream range: %v", seen)
	}

	if _, err := c.CreateStreamGroup("telemetry", "workers", "$"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "PUT" || seen["path"] != "/v1/stream/topics/telemetry/groups/workers" {
		t.Fatalf("create group: %v", seen)
	}

	if _, err := c.ReadStreamGroup("telemetry", "workers", StreamGroupReadOptions{Consumer: "w1", Count: 5}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/groups/workers/read" {
		t.Fatalf("read group: %v", seen)
	}

	if _, err := c.AckStreamEvents("telemetry", "workers", []string{"id-1", "id-2"}); err != nil {
		t.Fatal(err)
	}
	if seen["path"] != "/v1/stream/topics/telemetry/groups/workers/ack" {
		t.Fatalf("ack stream: %v", seen)
	}

	if err := c.DestroyStreamGroup("telemetry", "workers"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" || seen["path"] != "/v1/stream/topics/telemetry/groups/workers" {
		t.Fatalf("destroy group: %v", seen)
	}

	if err := c.DeleteStreamTopic("telemetry"); err != nil {
		t.Fatal(err)
	}
	if seen["method"] != "DELETE" || seen["path"] != "/v1/stream/topics/telemetry" {
		t.Fatalf("delete topic: %v", seen)
	}
}
