// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// Synapse Faststore: Redis-backed cache/KV with strings, hashes, lists, sets,
// sorted sets, TTLs, counters, scans, batches and distributed locks.
//
// Every operation is scoped to the caller's tenant (org / account / user).
// Platform callers set Client.Tenant (x-synapseone-tenant).
package synapseone

import (
	"net/url"
	"strconv"
)

// FaststoreSetOptions controls Set (TTL > 0; NX/XX conditions).
type FaststoreSetOptions struct {
	TTLSeconds  int
	IfNotExists bool
	IfExists    bool
}

// FaststoreListPushOptions controls list pushes.
type FaststoreListPushOptions struct {
	Side       string // left|right (default right)
	TTLSeconds int
}

// FaststoreZSetMember is one sorted-set entry.
type FaststoreZSetMember struct {
	Member any     `json:"member"`
	Score  float64 `json:"score"`
}

// FaststoreLockOptions controls lock acquisition.
type FaststoreLockOptions struct {
	TTLSeconds int
	WaitMS     int
	Token      string
}

func faststoreKey(key string) string { return pathEscape(key) }

// FaststoreStats reads per-tenant backend and key counts.
func (c *Client) FaststoreStats() (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/stats", nil)
}

// FaststoreKeys scans keys; pass the returned cursor back to continue.
func (c *Client) FaststoreKeys(prefix string, limit int, cursor string) (map[string]any, error) {
	q := url.Values{}
	if prefix != "" {
		q.Set("prefix", prefix)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	p := "/v1/faststore/keys"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	return c.faststoreObject("GET", p, nil)
}

// FaststoreGet reads one key with its type and remaining TTL.
func (c *Client) FaststoreGet(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/keys/"+faststoreKey(key), nil)
}

// FaststoreSet writes a string/JSON value.
func (c *Client) FaststoreSet(key string, value any, opts FaststoreSetOptions) (map[string]any, error) {
	body := map[string]any{"value": value}
	if opts.TTLSeconds > 0 {
		body["ttlSeconds"] = opts.TTLSeconds
	}
	if opts.IfNotExists {
		body["ifNotExists"] = true
	}
	if opts.IfExists {
		body["ifExists"] = true
	}
	return c.faststoreObject("PUT", "/v1/faststore/keys/"+faststoreKey(key), body)
}

// FaststoreDelete removes a key.
func (c *Client) FaststoreDelete(key string) error {
	_, err := c.do("DELETE", "/v1/faststore/keys/"+faststoreKey(key), nil)
	return err
}

// FaststoreTTL reads a key's remaining TTL in seconds.
func (c *Client) FaststoreTTL(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/keys/"+faststoreKey(key)+"/ttl", nil)
}

// FaststoreExpire updates a key's TTL.
func (c *Client) FaststoreExpire(key string, ttlSeconds int) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/keys/"+faststoreKey(key)+"/expire",
		map[string]any{"ttlSeconds": ttlSeconds})
}

// FaststoreIncr atomically increments a counter (by=0 -> 1).
func (c *Client) FaststoreIncr(key string, by, ttlSeconds int) (map[string]any, error) {
	if by == 0 {
		by = 1
	}
	body := map[string]any{"by": by}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/keys/"+faststoreKey(key)+"/incr", body)
}

// FaststoreBatch runs 1..100 set/delete/expire/incr/hset/hdel/lpush/lpop/
// sadd/srem/zadd/zrem operations.
func (c *Client) FaststoreBatch(operations []any) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/batch", map[string]any{"operations": operations})
}

// ---------- hashes ----------

func (c *Client) FaststoreHashGet(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/hashes/"+faststoreKey(key), nil)
}

func (c *Client) FaststoreHashSet(key string, values map[string]any, ttlSeconds int) (map[string]any, error) {
	body := map[string]any{"values": values}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("PUT", "/v1/faststore/hashes/"+faststoreKey(key), body)
}

func (c *Client) FaststoreHashDelete(key string) error {
	_, err := c.do("DELETE", "/v1/faststore/hashes/"+faststoreKey(key), nil)
	return err
}

func (c *Client) FaststoreHashLength(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/hashes/"+faststoreKey(key)+"/length", nil)
}

func (c *Client) FaststoreHashGetField(key, field string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/hashes/"+faststoreKey(key)+"/"+faststoreKey(field), nil)
}

func (c *Client) FaststoreHashSetField(key, field string, value any, ttlSeconds int) (map[string]any, error) {
	body := map[string]any{"value": value}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("PUT", "/v1/faststore/hashes/"+faststoreKey(key)+"/"+faststoreKey(field), body)
}

func (c *Client) FaststoreHashDeleteField(key, field string) error {
	_, err := c.do("DELETE", "/v1/faststore/hashes/"+faststoreKey(key)+"/"+faststoreKey(field), nil)
	return err
}

func (c *Client) FaststoreHashIncr(key, field string, by, ttlSeconds int) (map[string]any, error) {
	if by == 0 {
		by = 1
	}
	body := map[string]any{"field": field, "by": by}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/hashes/"+faststoreKey(key)+"/incr", body)
}

// ---------- lists ----------

func (c *Client) FaststoreListRange(key string, start, stop int) (map[string]any, error) {
	p := "/v1/faststore/lists/" + faststoreKey(key) +
		"?start=" + strconv.Itoa(start) + "&stop=" + strconv.Itoa(stop)
	return c.faststoreObject("GET", p, nil)
}

func (c *Client) FaststoreListDelete(key string) error {
	_, err := c.do("DELETE", "/v1/faststore/lists/"+faststoreKey(key), nil)
	return err
}

func (c *Client) FaststoreListPush(key string, values []any, opts FaststoreListPushOptions) (map[string]any, error) {
	side := opts.Side
	if side == "" {
		side = "right"
	}
	body := map[string]any{"values": values, "side": side}
	if opts.TTLSeconds > 0 {
		body["ttlSeconds"] = opts.TTLSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/lists/"+faststoreKey(key)+"/push", body)
}

func (c *Client) FaststoreListPop(key, side string, count int) (map[string]any, error) {
	if side == "" {
		side = "left"
	}
	if count <= 0 {
		count = 1
	}
	return c.faststoreObject("POST", "/v1/faststore/lists/"+faststoreKey(key)+"/pop",
		map[string]any{"side": side, "count": count})
}

func (c *Client) FaststoreListTrim(key string, start, stop int) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/lists/"+faststoreKey(key)+"/trim",
		map[string]any{"start": start, "stop": stop})
}

func (c *Client) FaststoreListLength(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/lists/"+faststoreKey(key)+"/length", nil)
}

// ---------- sets ----------

func (c *Client) FaststoreSetMembers(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/sets/"+faststoreKey(key), nil)
}

func (c *Client) FaststoreSetDelete(key string) error {
	_, err := c.do("DELETE", "/v1/faststore/sets/"+faststoreKey(key), nil)
	return err
}

func (c *Client) FaststoreSetAdd(key string, members []any, ttlSeconds int) (map[string]any, error) {
	body := map[string]any{"members": members}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/sets/"+faststoreKey(key)+"/add", body)
}

func (c *Client) FaststoreSetRemove(key string, members []any) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/sets/"+faststoreKey(key)+"/remove",
		map[string]any{"members": members})
}

func (c *Client) FaststoreSetContains(key string, member any) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/sets/"+faststoreKey(key)+"/contains",
		map[string]any{"member": member})
}

func (c *Client) FaststoreSetCard(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/sets/"+faststoreKey(key)+"/card", nil)
}

// ---------- sorted sets ----------

func (c *Client) FaststoreZSetRange(key string, start, stop int, rev, withScores bool) (map[string]any, error) {
	q := url.Values{}
	q.Set("start", strconv.Itoa(start))
	q.Set("stop", strconv.Itoa(stop))
	if rev {
		q.Set("rev", "true")
	}
	if withScores {
		q.Set("withScores", "true")
	}
	return c.faststoreObject("GET", "/v1/faststore/zsets/"+faststoreKey(key)+"?"+q.Encode(), nil)
}

func (c *Client) FaststoreZSetDelete(key string) error {
	_, err := c.do("DELETE", "/v1/faststore/zsets/"+faststoreKey(key), nil)
	return err
}

func (c *Client) FaststoreZSetAdd(key string, members []FaststoreZSetMember, ttlSeconds int) (map[string]any, error) {
	body := map[string]any{"members": members}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/zsets/"+faststoreKey(key)+"/add", body)
}

func (c *Client) FaststoreZSetIncr(key string, member any, by float64, ttlSeconds int) (map[string]any, error) {
	if by == 0 {
		by = 1
	}
	body := map[string]any{"member": member, "by": by}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/zsets/"+faststoreKey(key)+"/incr", body)
}

func (c *Client) FaststoreZSetRemove(key string, members []any) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/zsets/"+faststoreKey(key)+"/remove",
		map[string]any{"members": members})
}

func (c *Client) FaststoreZSetScore(key string, member any) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/zsets/"+faststoreKey(key)+"/score",
		map[string]any{"member": member})
}

func (c *Client) FaststoreZSetRank(key string, member any, rev bool) (map[string]any, error) {
	body := map[string]any{"member": member}
	if rev {
		body["rev"] = true
	}
	return c.faststoreObject("POST", "/v1/faststore/zsets/"+faststoreKey(key)+"/rank", body)
}

func (c *Client) FaststoreZSetCard(key string) (map[string]any, error) {
	return c.faststoreObject("GET", "/v1/faststore/zsets/"+faststoreKey(key)+"/card", nil)
}

// ---------- distributed locks ----------

// FaststoreLockAcquire tries to acquire a named lock. Token may be supplied to
// make release idempotent; otherwise the server returns one.
func (c *Client) FaststoreLockAcquire(name string, opts FaststoreLockOptions) (map[string]any, error) {
	body := map[string]any{"waitMs": opts.WaitMS}
	if opts.TTLSeconds > 0 {
		body["ttlSeconds"] = opts.TTLSeconds
	}
	if opts.Token != "" {
		body["token"] = opts.Token
	}
	return c.faststoreObject("POST", "/v1/faststore/locks/"+pathEscape(name)+"/acquire", body)
}

func (c *Client) FaststoreLockRelease(name, token string) (map[string]any, error) {
	return c.faststoreObject("POST", "/v1/faststore/locks/"+pathEscape(name)+"/release",
		map[string]any{"token": token})
}

func (c *Client) FaststoreLockExtend(name, token string, ttlSeconds int) (map[string]any, error) {
	body := map[string]any{"token": token}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	return c.faststoreObject("POST", "/v1/faststore/locks/"+pathEscape(name)+"/extend", body)
}

func (c *Client) faststoreObject(method, path string, body any) (map[string]any, error) {
	b, err := c.do(method, path, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
