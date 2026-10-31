// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseQueue: queues, publish (delay + dedupe), at-least-once consumption
// with visibility-timeout leases, ack/nack/heartbeat, retry, dead letters and
// replay.
//
// Delivery model: ConsumeMessages leases messages and returns a receipt per
// message. Ack when processing succeeds, Nack to requeue/dead-letter and
// Heartbeat to extend long-running leases. Expired leases are redelivered, so
// consumers must be idempotent.
//
// Every operation is scoped to the caller's tenant (org / account / user).
// Platform callers set Client.Tenant (x-synapseone-tenant).
package synapseone

import (
	"net/url"
	"strconv"
)

// QueueConfig is the create/update body for a queue.
type QueueConfig struct {
	MaxAttempts              int
	VisibilityTimeoutSeconds int
}

// QueuePublishOptions controls a single publish.
type QueuePublishOptions struct {
	DelaySeconds int
	MaxAttempts  int
	Headers      map[string]any
	ID           string
	DedupeKey    string
}

// QueueConsumeOptions controls a consume call.
type QueueConsumeOptions struct {
	MaxMessages              int
	VisibilityTimeoutSeconds int
	Consumer                 string
}

// QueueNackOptions controls a negative acknowledgement. Requeue=nil leaves the
// server default (true). Set Requeue to a pointer when you need false.
type QueueNackOptions struct {
	Requeue      *bool
	DelaySeconds int
	Error        string
}

func queuePath(queue string) string { return pathEscape(queue) }

// ListQueues lists the caller's queues.
func (c *Client) ListQueues() ([]map[string]any, error) {
	b, err := c.do("GET", "/v1/queue/queues", nil)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateQueue creates (or updates) a queue configuration.
func (c *Client) CreateQueue(queue string, cfg QueueConfig) (map[string]any, error) {
	body := map[string]any{}
	if cfg.MaxAttempts > 0 {
		body["maxAttempts"] = cfg.MaxAttempts
	}
	if cfg.VisibilityTimeoutSeconds > 0 {
		body["visibilityTimeoutSeconds"] = cfg.VisibilityTimeoutSeconds
	}
	return c.queueObject("PUT", "/v1/queue/queues/"+queuePath(queue), body)
}

// GetQueue fetches a queue plus its stats.
func (c *Client) GetQueue(queue string) (map[string]any, error) {
	return c.queueObject("GET", "/v1/queue/queues/"+queuePath(queue), nil)
}

// DeleteQueue deletes a queue and all of its messages.
func (c *Client) DeleteQueue(queue string) error {
	_, err := c.do("DELETE", "/v1/queue/queues/"+queuePath(queue), nil)
	return err
}

// PurgeQueue removes all messages (ready, delayed, in-flight and dead) and
// resets counters, keeping the queue and its configuration.
func (c *Client) PurgeQueue(queue string) (map[string]any, error) {
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/purge", nil)
}

// QueueStats reads ready/delayed/in-flight/dead counters.
func (c *Client) QueueStats(queue string) (map[string]any, error) {
	return c.queueObject("GET", "/v1/queue/queues/"+queuePath(queue)+"/stats", nil)
}

// PublishMessage publishes one payload (optionally delayed or deduplicated).
func (c *Client) PublishMessage(queue string, payload any, opts QueuePublishOptions) (map[string]any, error) {
	body := map[string]any{"payload": payload}
	if opts.DelaySeconds > 0 {
		body["delaySeconds"] = opts.DelaySeconds
	}
	if opts.MaxAttempts > 0 {
		body["maxAttempts"] = opts.MaxAttempts
	}
	if opts.Headers != nil {
		body["headers"] = opts.Headers
	}
	if opts.ID != "" {
		body["id"] = opts.ID
	}
	if opts.DedupeKey != "" {
		body["dedupeKey"] = opts.DedupeKey
	}
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/messages", body)
}

// PublishMessages publishes 1..100 messages; entries take the same fields as
// PublishMessage ({"payload":..., "delaySeconds":..., ...}).
func (c *Client) PublishMessages(queue string, messages []any) (map[string]any, error) {
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/messages:batch",
		map[string]any{"messages": messages})
}

// ConsumeMessages leases ready messages. Each message carries a receipt used by
// Ack/Nack/Heartbeat.
func (c *Client) ConsumeMessages(queue string, opts QueueConsumeOptions) (map[string]any, error) {
	body := map[string]any{}
	if opts.MaxMessages > 0 {
		body["maxMessages"] = opts.MaxMessages
	}
	if opts.VisibilityTimeoutSeconds > 0 {
		body["visibilityTimeoutSeconds"] = opts.VisibilityTimeoutSeconds
	}
	if opts.Consumer != "" {
		body["consumer"] = opts.Consumer
	}
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/consume", body)
}

// AckMessage acknowledges a successful delivery.
func (c *Client) AckMessage(queue, receipt string) (map[string]any, error) {
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/ack",
		map[string]any{"receipt": receipt})
}

// AckMessages acknowledges up to 100 receipts in one call.
func (c *Client) AckMessages(queue string, receipts []string) (map[string]any, error) {
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/ack",
		map[string]any{"receipts": receipts})
}

// NackMessage requeues (default) or dead-letters a delivery; the server applies
// maxAttempts and the requested retry delay.
func (c *Client) NackMessage(queue, receipt string, opts QueueNackOptions) (map[string]any, error) {
	body := map[string]any{"receipt": receipt}
	if opts.Requeue != nil {
		body["requeue"] = *opts.Requeue
	}
	if opts.DelaySeconds > 0 {
		body["delaySeconds"] = opts.DelaySeconds
	}
	if opts.Error != "" {
		body["error"] = opts.Error
	}
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/nack", body)
}

// HeartbeatMessage extends a delivery lease (visibility timeout).
func (c *Client) HeartbeatMessage(queue, receipt string, visibilityTimeoutSeconds int) (map[string]any, error) {
	body := map[string]any{"receipt": receipt}
	if visibilityTimeoutSeconds > 0 {
		body["visibilityTimeoutSeconds"] = visibilityTimeoutSeconds
	}
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/heartbeat", body)
}

// PeekMessages inspects messages without leasing them. ready=true hides delayed
// and in-flight messages.
func (c *Client) PeekMessages(queue string, limit int, ready bool) (map[string]any, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if ready {
		q.Set("ready", "true")
	}
	p := "/v1/queue/queues/" + queuePath(queue) + "/messages"
	if qs := q.Encode(); qs != "" {
		p += "?" + qs
	}
	return c.queueObject("GET", p, nil)
}

// DeadMessages lists dead-lettered messages.
func (c *Client) DeadMessages(queue string, limit int) (map[string]any, error) {
	p := "/v1/queue/queues/" + queuePath(queue) + "/dead"
	if limit > 0 {
		p += "?limit=" + strconv.Itoa(limit)
	}
	return c.queueObject("GET", p, nil)
}

// ReplayDeadMessage moves a dead letter back to the ready set.
func (c *Client) ReplayDeadMessage(queue, id string, delaySeconds int, resetAttempts bool) (map[string]any, error) {
	body := map[string]any{}
	if delaySeconds > 0 {
		body["delaySeconds"] = delaySeconds
	}
	if resetAttempts {
		body["resetAttempts"] = true
	}
	return c.queueObject("POST", "/v1/queue/queues/"+queuePath(queue)+"/dead/"+pathEscape(id)+"/replay", body)
}

// DeleteDeadMessage permanently removes a dead letter.
func (c *Client) DeleteDeadMessage(queue, id string) error {
	_, err := c.do("DELETE", "/v1/queue/queues/"+queuePath(queue)+"/dead/"+pathEscape(id), nil)
	return err
}

func (c *Client) queueObject(method, path string, body any) (map[string]any, error) {
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
