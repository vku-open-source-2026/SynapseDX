// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseBase: collections, documents, queries, batch writes, atomic counters,
// the change feed and typed object<->data mapping.
package synapsedx

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// ---------- mapping ----------

// BaseMappingField maps one logical name onto a dot path inside stored data.
type BaseMappingField struct {
	Path     string `json:"path"`
	Type     string `json:"type,omitempty"`     // string|number|boolean|date|array|object|any
	Required bool   `json:"required,omitempty"` // required on full writes, not patches
}

// BaseMapping is the canonical server mapping. An empty mapping copies data 1:1.
type BaseMapping struct {
	Fields     map[string]BaseMappingField `json:"fields"`
	Additional bool                        `json:"additional,omitempty"`
}

// NewBaseMapping builds a mapping from logical name -> dot path.
func NewBaseMapping(paths map[string]string) BaseMapping {
	fields := make(map[string]BaseMappingField, len(paths))
	for name, path := range paths {
		fields[name] = BaseMappingField{Path: path}
	}
	return BaseMapping{Fields: fields}
}

func getBasePath(data map[string]any, path string) (any, bool) {
	var cur any = data
	for _, key := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = m[key]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

func setBasePath(target map[string]any, path string, value any) {
	segments := strings.Split(path, ".")
	cur := target
	for _, key := range segments[:len(segments)-1] {
		next, ok := cur[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[key] = next
		}
		cur = next
	}
	cur[segments[len(segments)-1]] = value
}

// DataToObject projects stored data onto logical field names. An empty mapping
// copies every key.
func DataToObject(data map[string]any, mapping BaseMapping) map[string]any {
	if data == nil {
		data = map[string]any{}
	}
	if len(mapping.Fields) == 0 {
		out := make(map[string]any, len(data))
		for k, v := range data {
			out[k] = v
		}
		return out
	}
	out := make(map[string]any, len(mapping.Fields))
	for name, field := range mapping.Fields {
		if value, ok := getBasePath(data, field.Path); ok {
			out[name] = value
		}
	}
	return out
}

// ObjectToData projects a logical object onto stored data. Unknown keys are
// kept as-is (the server enforces mapping.additional policies).
func ObjectToData(obj map[string]any, mapping BaseMapping) map[string]any {
	out := map[string]any{}
	for name, value := range obj {
		path := name
		if field, ok := mapping.Fields[name]; ok && field.Path != "" {
			path = field.Path
		}
		setBasePath(out, path, value)
	}
	return out
}

// BaseFilter is one node of the query filter tree. Use Field/Op/Value for
// comparisons, And/Or/Not for composition, or leave all empty and use a raw
// shorthand map through BaseQuery.Where.
type BaseFilter struct {
	Field string       `json:"field,omitempty"`
	Op    string       `json:"op,omitempty"` // eq|ne|gt|gte|lt|lte|in|nin|contains|startsWith|endsWith|exists
	Value any          `json:"value,omitempty"`
	And   []BaseFilter `json:"and,omitempty"`
	Or    []BaseFilter `json:"or,omitempty"`
	Not   *BaseFilter  `json:"not,omitempty"`
}

type BaseOrderBy struct {
	Field     string `json:"field"`
	Direction string `json:"direction,omitempty"` // asc|desc
}

// BaseQuery is the POST body of a collection query. Where accepts a BaseFilter,
// []BaseFilter, or a raw shorthand map; OrderBy accepts BaseOrderBy,
// []BaseOrderBy, a field name, or []string.
type BaseQuery struct {
	Where   any      `json:"where,omitempty"`
	OrderBy any      `json:"orderBy,omitempty"`
	Limit   int      `json:"limit,omitempty"`
	Offset  int      `json:"offset,omitempty"`
	Cursor  string   `json:"cursor,omitempty"`
	Select  []string `json:"select,omitempty"`
	As      string   `json:"as,omitempty"` // data|object
}

// BaseDocumentInput is a write payload: provide exactly one of Data or Object.
// Unset removes dot paths on PATCH. IfVersion > 0 enables optimistic locking.
type BaseDocumentInput struct {
	Data      map[string]any
	Object    any
	ID        string
	IfVersion int
	Merge     bool
	Unset     []string
}

func (in BaseDocumentInput) body(requireValue, includeID bool) (map[string]any, error) {
	hasData := in.Data != nil
	hasObject := in.Object != nil
	switch {
	case hasData && hasObject:
		return nil, fmt.Errorf("synapsedx base: provide exactly one of data or object")
	case requireValue && !hasData && !hasObject:
		return nil, fmt.Errorf("synapsedx base: provide exactly one of data or object")
	case !requireValue && !hasData && !hasObject && len(in.Unset) == 0:
		return nil, fmt.Errorf("synapsedx base: provide data/object and/or unset")
	}
	body := map[string]any{}
	if hasData {
		body["data"] = in.Data
	}
	if hasObject {
		body["object"] = in.Object
	}
	if includeID && in.ID != "" {
		body["id"] = in.ID
	}
	if in.IfVersion > 0 {
		body["ifVersion"] = in.IfVersion
	}
	if in.Merge {
		body["merge"] = true
	}
	if len(in.Unset) > 0 {
		body["unset"] = in.Unset
	}
	return body, nil
}

// BaseQueryResult is a page of documents (data view unless As=object).
type BaseQueryResult[T any] struct {
	Items      []T    `json:"items"`
	Total      int    `json:"total"`
	Limit      int    `json:"limit"`
	Offset     int    `json:"offset"`
	NextCursor string `json:"nextCursor"`
}

type baseQueryEnvelope struct {
	Items      []map[string]any `json:"items"`
	Total      int              `json:"total"`
	Limit      int              `json:"limit"`
	Offset     int              `json:"offset"`
	NextCursor *string          `json:"nextCursor"`
}

// ---------- collections ----------

// ListBaseCollections lists visible collections, optionally filtered by
// orgID/accountID (pass "" to omit a filter).
func (c *Client) ListBaseCollections(orgID, accountID string) ([]map[string]any, error) {
	q := url.Values{}
	if orgID != "" {
		q.Set("orgId", orgID)
	}
	if accountID != "" {
		q.Set("accountId", accountID)
	}
	p := "/v1/base/collections"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateBaseCollection creates a collection. body supports name, description,
// mapping ({fields:{logical:{path,type?,required?}},additional?}), orgId and
// accountId. A map keeps the request forward-compatible.
func (c *Client) CreateBaseCollection(body map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/base/collections", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetBaseCollection fetches a collection plus its stats.
func (c *Client) GetBaseCollection(name string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/base/collections/"+pathEscape(name), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateBaseCollection patches name/description/mapping.
func (c *Client) UpdateBaseCollection(name string, patch map[string]any) (map[string]any, error) {
	b, err := c.do("PATCH", "/v1/base/collections/"+pathEscape(name), patch)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteBaseCollection deletes a collection and all of its documents.
func (c *Client) DeleteBaseCollection(name string) error {
	_, err := c.do("DELETE", "/v1/base/collections/"+pathEscape(name), nil)
	return err
}

// GetBaseCollectionStats reads document counts for a collection.
func (c *Client) GetBaseCollectionStats(name string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/base/collections/"+pathEscape(name)+"/stats", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- documents ----------

// CreateBaseDocument creates a document. Set BaseDocumentInput.ID to choose an
// id, otherwise the server generates a UUID.
func (c *Client) CreateBaseDocument(collection string, in BaseDocumentInput) (map[string]any, error) {
	body, err := in.body(true, true)
	if err != nil {
		return nil, err
	}
	b, err := c.do("POST", "/v1/base/collections/"+pathEscape(collection)+"/documents", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetBaseDocument fetches one document. as is "data", "object", or "" (server
// default: data).
func (c *Client) GetBaseDocument(collection, id, as string) (map[string]any, error) {
	p := "/v1/base/collections/" + pathEscape(collection) + "/documents/" + pathEscape(id)
	if as != "" {
		p += "?as=" + url.QueryEscape(as)
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

// SetBaseDocument replaces a document (merge=true patches instead).
func (c *Client) SetBaseDocument(collection, id string, in BaseDocumentInput) (map[string]any, error) {
	body, err := in.body(true, false)
	if err != nil {
		return nil, err
	}
	b, err := c.do("PUT", "/v1/base/collections/"+pathEscape(collection)+"/documents/"+pathEscape(id), body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateBaseDocument patches a document; Unset removes dot paths.
func (c *Client) UpdateBaseDocument(collection, id string, in BaseDocumentInput) (map[string]any, error) {
	body, err := in.body(false, false)
	if err != nil {
		return nil, err
	}
	b, err := c.do("PATCH", "/v1/base/collections/"+pathEscape(collection)+"/documents/"+pathEscape(id), body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteBaseDocument deletes a document. ifVersion > 0 enforces optimistic locking.
func (c *Client) DeleteBaseDocument(collection, id string, ifVersion int) error {
	p := "/v1/base/collections/" + pathEscape(collection) + "/documents/" + pathEscape(id)
	if ifVersion > 0 {
		p += "?ifVersion=" + strconv.Itoa(ifVersion)
	}
	_, err := c.do("DELETE", p, nil)
	return err
}

// ListBaseDocuments lists documents in raw data view (limit 1..1000).
func (c *Client) ListBaseDocuments(collection string, limit, offset int) ([]map[string]any, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if offset > 0 {
		q.Set("offset", strconv.Itoa(offset))
	}
	p := "/v1/base/collections/" + pathEscape(collection) + "/documents"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	b, err := c.do("GET", p, nil)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// QueryBaseDocuments runs a filter/order/cursor query. As defaults to "data".
func (c *Client) QueryBaseDocuments(collection string, q BaseQuery) (BaseQueryResult[map[string]any], error) {
	if q.As == "" {
		q.As = "data"
	}
	b, err := c.do("POST", "/v1/base/collections/"+pathEscape(collection)+"/query", q)
	if err != nil {
		return BaseQueryResult[map[string]any]{}, err
	}
	var env baseQueryEnvelope
	if err := unmarshal(b, &env); err != nil {
		return BaseQueryResult[map[string]any]{}, err
	}
	out := BaseQueryResult[map[string]any]{
		Items:  env.Items,
		Total:  env.Total,
		Limit:  env.Limit,
		Offset: env.Offset,
	}
	if env.NextCursor != nil {
		out.NextCursor = *env.NextCursor
	}
	return out, nil
}

// IncrementBaseDocument atomically increments a numeric field (by=0 -> 1).
// ifVersion > 0 enforces optimistic locking.
func (c *Client) IncrementBaseDocument(collection, id, field string, by, ifVersion int) (map[string]any, error) {
	if by == 0 {
		by = 1
	}
	body := map[string]any{"field": field, "by": by}
	if ifVersion > 0 {
		body["ifVersion"] = ifVersion
	}
	b, err := c.do("POST", "/v1/base/collections/"+pathEscape(collection)+"/documents/"+pathEscape(id)+"/increment", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// BatchBaseDocuments runs 1..100 create/set/update/delete/increment operations.
func (c *Client) BatchBaseDocuments(collection string, operations []any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/base/collections/"+pathEscape(collection)+"/documents:batch",
		map[string]any{"operations": operations})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// BaseChanges polls the upsert-only change feed since an ISO-8601 timestamp.
// Pass the returned nextSince back on the next call.
func (c *Client) BaseChanges(collection, since string, limit int, as string) (map[string]any, error) {
	q := url.Values{}
	q.Set("since", since)
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if as != "" {
		q.Set("as", as)
	}
	b, err := c.do("GET", "/v1/base/collections/"+pathEscape(collection)+"/changes?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- typed collection ----------

// BaseCollection binds a collection to a Go model. Model fields are converted
// through encoding/json, so use json tags for logical names:
//
//	type Park struct {
//	    Name     string `json:"name"`
//	    Capacity int    `json:"capacity"`
//	}
//	parks := synapsedx.NewBaseCollection[Park](c, "parks",
//	    synapsedx.NewBaseMapping(map[string]string{"name": "profile.name"}))
type BaseCollection[T any] struct {
	Client  *Client
	Name    string
	Mapping BaseMapping
}

// NewBaseCollection creates a typed collection wrapper.
func NewBaseCollection[T any](client *Client, name string, mapping BaseMapping) *BaseCollection[T] {
	return &BaseCollection[T]{Client: client, Name: name, Mapping: mapping}
}

// ToObject converts a model instance into a logical object (JSON tags win).
func (c *BaseCollection[T]) ToObject(value T) (map[string]any, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("synapsedx base: encode object: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("synapsedx base: encode object: %w", err)
	}
	return out, nil
}

// FromObject converts a logical object into a model instance.
func (c *BaseCollection[T]) FromObject(obj map[string]any) (T, error) {
	var out T
	if obj == nil {
		return out, nil
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return out, fmt.Errorf("synapsedx base: decode object: %w", err)
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return out, fmt.Errorf("synapsedx base: decode object: %w", err)
	}
	return out, nil
}

// FromData converts stored data through the mapping, then into a model.
func (c *BaseCollection[T]) FromData(data map[string]any) (T, error) {
	return c.FromObject(DataToObject(data, c.Mapping))
}

func (c *BaseCollection[T]) docResult(doc map[string]any) (T, error) {
	if obj, ok := doc["object"].(map[string]any); ok {
		return c.FromObject(obj)
	}
	data, _ := doc["data"].(map[string]any)
	return c.FromData(data)
}

func (c *BaseCollection[T]) objectInput(value T) (BaseDocumentInput, error) {
	obj, err := c.ToObject(value)
	if err != nil {
		return BaseDocumentInput{}, err
	}
	return BaseDocumentInput{Object: obj}, nil
}

// Create writes a model as a logical object. id may be "" (server-generated).
func (c *BaseCollection[T]) Create(value T, id string) (T, error) {
	var zero T
	in, err := c.objectInput(value)
	if err != nil {
		return zero, err
	}
	in.ID = id
	doc, err := c.Client.CreateBaseDocument(c.Name, in)
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// CreateWithData writes raw data (mapping still applies when reading back).
func (c *BaseCollection[T]) CreateWithData(data map[string]any, id string) (T, error) {
	var zero T
	doc, err := c.Client.CreateBaseDocument(c.Name, BaseDocumentInput{Data: data, ID: id})
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// Get reads a document as a logical object and converts it to the model.
func (c *BaseCollection[T]) Get(id string) (T, error) {
	var zero T
	doc, err := c.Client.GetBaseDocument(c.Name, id, "object")
	if err != nil {
		return zero, err
	}
	obj, _ := doc["object"].(map[string]any)
	return c.FromObject(obj)
}

// GetRaw fetches the API document in the requested view ("data" or "object").
func (c *BaseCollection[T]) GetRaw(id, as string) (map[string]any, error) {
	return c.Client.GetBaseDocument(c.Name, id, as)
}

// Set replaces a document with the model object.
func (c *BaseCollection[T]) Set(id string, value T, ifVersion int, merge bool) (T, error) {
	var zero T
	in, err := c.objectInput(value)
	if err != nil {
		return zero, err
	}
	in.IfVersion, in.Merge = ifVersion, merge
	doc, err := c.Client.SetBaseDocument(c.Name, id, in)
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// SetWithData replaces a document with raw data.
func (c *BaseCollection[T]) SetWithData(id string, data map[string]any, ifVersion int, merge bool) (T, error) {
	var zero T
	doc, err := c.Client.SetBaseDocument(c.Name, id, BaseDocumentInput{
		Data: data, IfVersion: ifVersion, Merge: merge,
	})
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// Update patches a document with the model object.
func (c *BaseCollection[T]) Update(id string, value T, unset []string, ifVersion int) (T, error) {
	var zero T
	in, err := c.objectInput(value)
	if err != nil {
		return zero, err
	}
	in.Unset, in.IfVersion = unset, ifVersion
	doc, err := c.Client.UpdateBaseDocument(c.Name, id, in)
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// UpdateWithData patches a document with raw data and/or unset paths.
func (c *BaseCollection[T]) UpdateWithData(id string, data map[string]any, unset []string, ifVersion int) (T, error) {
	var zero T
	doc, err := c.Client.UpdateBaseDocument(c.Name, id, BaseDocumentInput{
		Data: data, Unset: unset, IfVersion: ifVersion,
	})
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// Delete removes a document (ifVersion > 0 enforces optimistic locking).
func (c *BaseCollection[T]) Delete(id string, ifVersion int) error {
	return c.Client.DeleteBaseDocument(c.Name, id, ifVersion)
}

// Increment atomically increments a field and returns the updated model.
func (c *BaseCollection[T]) Increment(id, field string, by, ifVersion int) (T, error) {
	var zero T
	doc, err := c.Client.IncrementBaseDocument(c.Name, id, field, by, ifVersion)
	if err != nil {
		return zero, err
	}
	return c.docResult(doc)
}

// List returns a page of documents converted from the data view.
func (c *BaseCollection[T]) List(limit, offset int) ([]T, error) {
	docs, err := c.Client.ListBaseDocuments(c.Name, limit, offset)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(docs))
	for _, doc := range docs {
		data, _ := doc["data"].(map[string]any)
		value, err := c.FromData(data)
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

// Query runs a query against the object view and converts every item.
func (c *BaseCollection[T]) Query(q BaseQuery) (BaseQueryResult[T], error) {
	q.As = "object"
	raw, err := c.Client.QueryBaseDocuments(c.Name, q)
	if err != nil {
		return BaseQueryResult[T]{}, err
	}
	out := BaseQueryResult[T]{
		Items:      make([]T, 0, len(raw.Items)),
		Total:      raw.Total,
		Limit:      raw.Limit,
		Offset:     raw.Offset,
		NextCursor: raw.NextCursor,
	}
	for _, item := range raw.Items {
		obj, _ := item["object"].(map[string]any)
		value, err := c.FromObject(obj)
		if err != nil {
			return BaseQueryResult[T]{}, err
		}
		out.Items = append(out.Items, value)
	}
	return out, nil
}

// Changes polls the change feed in object view; each entry keeps its metadata
// and gains a "document" field with the typed model.
func (c *BaseCollection[T]) Changes(since string, limit int) (map[string]any, error) {
	raw, err := c.Client.BaseChanges(c.Name, since, limit, "object")
	if err != nil {
		return nil, err
	}
	changes, _ := raw["changes"].([]any)
	converted := make([]any, 0, len(changes))
	for _, entry := range changes {
		ch, _ := entry.(map[string]any)
		obj, _ := ch["object"].(map[string]any)
		value, err := c.FromObject(obj)
		if err != nil {
			return nil, err
		}
		out := make(map[string]any, len(ch)+1)
		for k, v := range ch {
			out[k] = v
		}
		out["document"] = value
		converted = append(converted, out)
	}
	raw["changes"] = converted
	return raw, nil
}

// Batch runs batch operations (raw shape, like BatchBaseDocuments).
func (c *BaseCollection[T]) Batch(operations []any) (map[string]any, error) {
	return c.Client.BatchBaseDocuments(c.Name, operations)
}

// Stats reads this collection's document stats.
func (c *BaseCollection[T]) Stats() (map[string]any, error) {
	return c.Client.GetBaseCollectionStats(c.Name)
}
