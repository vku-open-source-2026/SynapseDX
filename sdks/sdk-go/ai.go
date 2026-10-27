// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");

package synapsedx

// AiHistoryItem represents one turn in the assistant conversation.
type AiHistoryItem struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// AiAgentResult is returned by the AI guidance assistant (POST /v1/ai/agent).
type AiAgentResult struct {
	OK          bool              `json:"ok"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Auth        string            `json:"auth"`
	PathValues  map[string]string `json:"pathValues"`
	Body        any               `json:"body,omitempty"`
	Explanation string            `json:"explanation"`
	Reason      string            `json:"reason"`
	Guidance    string            `json:"guidance,omitempty"`
}

// AIAgent queries the natural language API guidance assistant (POST /v1/ai/agent).
func (c *Client) AIAgent(question string, history ...AiHistoryItem) (*AiAgentResult, error) {
	body := map[string]any{"question": question}
	if len(history) > 0 {
		body["history"] = history
	}
	b, err := c.do("POST", "/v1/ai/agent", body)
	if err != nil {
		return nil, err
	}
	var res AiAgentResult
	if err := unmarshal(b, &res); err != nil {
		return nil, err
	}
	return &res, nil
}
