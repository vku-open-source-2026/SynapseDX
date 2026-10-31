// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
// Synapse Inference Engine: OpenRouter-backed LLM proxy, self-hosted lightweight
// embeddings (sentence-transformers/all-MiniLM-L6-v2), and self-hosted
// Decision-2.0-Eos-0.8B structured routing.
package synapseone

// ChatMessage represents a single message in a chat completion request.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	Name    string `json:"name,omitempty"`
}

// ChatCompletionOptions controls optional settings for chat completions.
type ChatCompletionOptions struct {
	Model       string  `json:"model,omitempty"`
	Temperature float64 `json:"temperature,omitempty"`
	MaxTokens   int     `json:"max_tokens,omitempty"`
	Stream      bool    `json:"stream,omitempty"`
	TopP        float64 `json:"top_p,omitempty"`
}

// DecisionQuestion represents a single structured question for Decision-2.0-Eos-0.8B.
type DecisionQuestion struct {
	Type         string            `json:"type"` // "choice", "noul", "score"
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria,omitempty"`
}

// InferenceHealth returns the health and loaded status of inference subsystems.
func (c *Client) InferenceHealth() (map[string]any, error) {
	b, err := c.do("GET", "/v1/inference/health", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// InferenceChat runs chat completions through the OpenRouter-backed LLM proxy.
func (c *Client) InferenceChat(messages []ChatMessage, opts ...ChatCompletionOptions) (map[string]any, error) {
	body := map[string]any{
		"messages": messages,
	}
	if len(opts) > 0 {
		o := opts[0]
		if o.Model != "" {
			body["model"] = o.Model
		}
		if o.Temperature > 0 {
			body["temperature"] = o.Temperature
		}
		if o.MaxTokens > 0 {
			body["max_tokens"] = o.MaxTokens
		}
		if o.Stream {
			body["stream"] = true
		}
		if o.TopP > 0 {
			body["top_p"] = o.TopP
		}
	}
	b, err := c.do("POST", "/v1/inference/chat/completions", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// InferenceEmbeddings generates text embeddings using the self-hosted lightweight model.
// Input can be a string or []string.
func (c *Client) InferenceEmbeddings(input any, model ...string) (map[string]any, error) {
	body := map[string]any{
		"input": input,
	}
	if len(model) > 0 && model[0] != "" {
		body["model"] = model[0]
	}
	b, err := c.do("POST", "/v1/inference/embeddings", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// InferenceDecision evaluates structured questions on a state via Decision-2.0-Eos-0.8B (system_one).
func (c *Client) InferenceDecision(state string, questions map[string]DecisionQuestion) (map[string]any, error) {
	body := map[string]any{
		"state":     state,
		"questions": questions,
	}
	b, err := c.do("POST", "/v1/inference/decision", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// InferenceRoute classifies and semantically routes an input text between candidate choices.
func (c *Client) InferenceRoute(input string, choices map[string]string, instruction ...string) (map[string]any, error) {
	body := map[string]any{
		"input":   input,
		"choices": choices,
	}
	if len(instruction) > 0 && instruction[0] != "" {
		body["instruction"] = instruction[0]
	}
	b, err := c.do("POST", "/v1/inference/decision/route", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}
