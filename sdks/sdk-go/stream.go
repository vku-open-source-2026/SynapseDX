// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// SynapseStream: topics, publish (single & batch), consumer groups,
// non-destructive reads, time-range queries and retention trimming.
package synapseone

import (
	"net/url"
	"strconv"
)

// StreamTopicConfig represents the configuration of a stream topic.
type StreamTopicConfig struct {
	Name        string `json:"name"`
	MaxLen      int    `json:"maxLen,omitempty"`
	MinID       string `json:"minId,omitempty"`
	RetentionMs int    `json:"retentionMs,omitempty"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// StreamPublishOptions controls an event publication.
type StreamPublishOptions struct {
	Key     string
	Headers map[string]any
	ID      string
}

// StreamReadOptions controls a raw stream read.
type StreamReadOptions struct {
	FromID  string
	Count   int
	BlockMs int
}

// StreamRangeOptions controls a historical time-range query.
type StreamRangeOptions struct {
	Start string
	End   string
	Count int
}

// StreamGroupReadOptions controls consumer group event leases.
type StreamGroupReadOptions struct {
	Consumer string
	Count    int
	BlockMs  int
	AutoAck  bool
}

func streamPath(topic string) string { return pathEscape(topic) }

// ListStreamTopics lists the caller's stream topics.
func (c *Client) ListStreamTopics() ([]StreamTopicConfig, error) {
	b, err := c.do("GET", "/v1/stream/topics", nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Topics []StreamTopicConfig `json:"topics"`
	}
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out.Topics, nil
}

// CreateStreamTopic creates or updates a stream topic with optional retention caps.
func (c *Client) CreateStreamTopic(topic string, maxLen int, minID string, retentionMs int) (*StreamTopicConfig, error) {
	body := map[string]any{}
	if maxLen > 0 {
		body["maxLen"] = maxLen
	}
	if minID != "" {
		body["minId"] = minID
	}
	if retentionMs > 0 {
		body["retentionMs"] = retentionMs
	}
	b, err := c.do("PUT", "/v1/stream/topics/"+streamPath(topic), body)
	if err != nil {
		return nil, err
	}
	var out struct {
		Topic StreamTopicConfig `json:"topic"`
	}
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return &out.Topic, nil
}

// GetStreamTopic fetches topic configuration.
func (c *Client) GetStreamTopic(topic string) (*StreamTopicConfig, error) {
	b, err := c.do("GET", "/v1/stream/topics/"+streamPath(topic), nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Topic StreamTopicConfig `json:"topic"`
	}
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return &out.Topic, nil
}

// DeleteStreamTopic deletes a topic and all its events.
func (c *Client) DeleteStreamTopic(topic string) error {
	_, err := c.do("DELETE", "/v1/stream/topics/"+streamPath(topic), nil)
	return err
}

// StreamTopicStats fetches topic statistics (length, first/last ID, groups).
func (c *Client) StreamTopicStats(topic string) (map[string]any, error) {
	b, err := c.do("GET", "/v1/stream/topics/"+streamPath(topic)+"/stats", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PublishStreamEvent publishes one event to a topic.
func (c *Client) PublishStreamEvent(topic string, payload any, opts StreamPublishOptions) (map[string]any, error) {
	body := map[string]any{"payload": payload}
	if opts.Key != "" {
		body["key"] = opts.Key
	}
	if len(opts.Headers) > 0 {
		body["headers"] = opts.Headers
	}
	if opts.ID != "" {
		body["id"] = opts.ID
	}
	b, err := c.do("POST", "/v1/stream/topics/"+streamPath(topic)+"/events", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PublishStreamBatch publishes up to 100 events in a batch.
func (c *Client) PublishStreamBatch(topic string, events []map[string]any) (map[string]any, error) {
	b, err := c.do("POST", "/v1/stream/topics/"+streamPath(topic)+"/events:batch", map[string]any{"events": events})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ReadStreamEvents performs a non-destructive raw stream read.
func (c *Client) ReadStreamEvents(topic string, opts StreamReadOptions) (map[string]any, error) {
	body := map[string]any{}
	if opts.FromID != "" {
		body["fromId"] = opts.FromID
	}
	if opts.Count > 0 {
		body["count"] = opts.Count
	}
	if opts.BlockMs > 0 {
		body["blockMs"] = opts.BlockMs
	}
	b, err := c.do("POST", "/v1/stream/topics/"+streamPath(topic)+"/read", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// QueryStreamRange performs a historical time-range query.
func (c *Client) QueryStreamRange(topic string, opts StreamRangeOptions) (map[string]any, error) {
	q := url.Values{}
	if opts.Start != "" {
		q.Set("start", opts.Start)
	}
	if opts.End != "" {
		q.Set("end", opts.End)
	}
	if opts.Count > 0 {
		q.Set("count", strconv.Itoa(opts.Count))
	}
	qs := q.Encode()
	path := "/v1/stream/topics/" + streamPath(topic) + "/range"
	if qs != "" {
		path += "?" + qs
	}
	b, err := c.do("GET", path, nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateStreamGroup creates a consumer group.
func (c *Client) CreateStreamGroup(topic, group, startID string) (map[string]any, error) {
	body := map[string]any{}
	if startID != "" {
		body["startId"] = startID
	}
	b, err := c.do("PUT", "/v1/stream/topics/"+streamPath(topic)+"/groups/"+pathEscape(group), body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DestroyStreamGroup destroys a consumer group.
func (c *Client) DestroyStreamGroup(topic, group string) error {
	_, err := c.do("DELETE", "/v1/stream/topics/"+streamPath(topic)+"/groups/"+pathEscape(group), nil)
	return err
}

// ReadStreamGroup reads events leased to a consumer group.
func (c *Client) ReadStreamGroup(topic, group string, opts StreamGroupReadOptions) (map[string]any, error) {
	consumer := opts.Consumer
	if consumer == "" {
		consumer = "default-worker"
	}
	body := map[string]any{"consumer": consumer}
	if opts.Count > 0 {
		body["count"] = opts.Count
	}
	if opts.BlockMs > 0 {
		body["blockMs"] = opts.BlockMs
	}
	if opts.AutoAck {
		body["autoAck"] = true
	}
	b, err := c.do("POST", "/v1/stream/topics/"+streamPath(topic)+"/groups/"+pathEscape(group)+"/read", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AckStreamEvents acknowledges processed event IDs for a consumer group.
func (c *Client) AckStreamEvents(topic, group string, ids []string) (map[string]any, error) {
	body := map[string]any{"ids": ids}
	b, err := c.do("POST", "/v1/stream/topics/"+streamPath(topic)+"/groups/"+pathEscape(group)+"/ack", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
