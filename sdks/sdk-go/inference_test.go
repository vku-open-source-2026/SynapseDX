// Copyright 2026 SynapseDX Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package synapsedx

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInferenceEngine(t *testing.T) {
	seen := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen["method"] = r.Method
		seen["path"] = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		seen["body"] = string(b)
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/v1/inference/health":
			json.NewEncoder(w).Encode(map[string]any{
				"status":  "ok",
				"service": "synapsedx-inference",
				"version": "0.5.2",
				"models": map[string]any{
					"llm":       "apodex/apodex-1.1-mini:free",
					"embedding": "sentence-transformers/all-MiniLM-L6-v2",
					"decision":  "vllm-sr/Decision-2.0-Eos-0.8B",
				},
			})
		case "/v1/inference/chat/completions":
			json.NewEncoder(w).Encode(map[string]any{
				"id":     "chatcmpl-123",
				"object": "chat.completion",
				"model":  "apodex/apodex-1.1-mini:free",
				"choices": []any{
					map[string]any{
						"index": 0,
						"message": map[string]any{
							"role":    "assistant",
							"content": "PONG",
						},
						"finish_reason": "stop",
					},
				},
			})
		case "/v1/inference/embeddings":
			json.NewEncoder(w).Encode(map[string]any{
				"object": "list",
				"model":  "sentence-transformers/all-MiniLM-L6-v2",
				"data": []any{
					map[string]any{
						"object":    "embedding",
						"index":     0,
						"embedding": []float64{0.1, 0.2, 0.3},
					},
				},
			})
		case "/v1/inference/decision":
			json.NewEncoder(w).Encode(map[string]any{
				"model": "vllm-sr/Decision-2.0-Eos-0.8B",
				"results": map[string]any{
					"department": map[string]any{
						"choice":     "billing",
						"confidence": 0.95,
					},
				},
			})
		case "/v1/inference/decision/route":
			json.NewEncoder(w).Encode(map[string]any{
				"best_choice": "workflow",
				"confidence":  0.98,
				"probabilities": map[string]any{
					"workflow": 0.98,
					"iam":      0.01,
					"base":     0.01,
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New(srv.URL)

	// 1. Health
	h, err := c.InferenceHealth()
	if err != nil {
		t.Fatalf("InferenceHealth error: %v", err)
	}
	if seen["method"] != "GET" || seen["path"] != "/v1/inference/health" {
		t.Fatalf("unexpected call: %v", seen)
	}
	if h["status"] != "ok" {
		t.Fatalf("unexpected health status: %v", h)
	}

	// 2. Chat
	chatRes, err := c.InferenceChat([]ChatMessage{
		{Role: "user", Content: "PING"},
	}, ChatCompletionOptions{
		Model:       "apodex/apodex-1.1-mini:free",
		Temperature: 0.7,
		MaxTokens:   50,
	})
	if err != nil {
		t.Fatalf("InferenceChat error: %v", err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/inference/chat/completions" {
		t.Fatalf("unexpected chat call: %v", seen)
	}
	var chatBody map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &chatBody); err != nil {
		t.Fatalf("chat body unmarshal: %v", err)
	}
	if chatBody["model"] != "apodex/apodex-1.1-mini:free" {
		t.Fatalf("chat model: %v", chatBody)
	}
	if chatRes["id"] != "chatcmpl-123" {
		t.Fatalf("chat res: %v", chatRes)
	}

	// 3. Embeddings
	embRes, err := c.InferenceEmbeddings([]string{"hello world"}, "sentence-transformers/all-MiniLM-L6-v2")
	if err != nil {
		t.Fatalf("InferenceEmbeddings error: %v", err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/inference/embeddings" {
		t.Fatalf("unexpected embeddings call: %v", seen)
	}
	var embBody map[string]any
	if err := json.Unmarshal([]byte(seen["body"]), &embBody); err != nil {
		t.Fatalf("emb body unmarshal: %v", err)
	}
	if embBody["model"] != "sentence-transformers/all-MiniLM-L6-v2" {
		t.Fatalf("emb model: %v", embBody)
	}
	if embRes["object"] != "list" {
		t.Fatalf("emb res: %v", embRes)
	}

	// 4. Decision
	decRes, err := c.InferenceDecision("User bill issue", map[string]DecisionQuestion{
		"department": {
			Type:         "choice",
			Instructions: "Pick department",
			Criteria: map[string]string{
				"billing": "Invoice or charge problems",
				"support": "Technical bugs",
			},
		},
	})
	if err != nil {
		t.Fatalf("InferenceDecision error: %v", err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/inference/decision" {
		t.Fatalf("unexpected decision call: %v", seen)
	}
	if decRes["model"] != "vllm-sr/Decision-2.0-Eos-0.8B" {
		t.Fatalf("decision res: %v", decRes)
	}

	// 5. Route
	routeRes, err := c.InferenceRoute("Create workflow", map[string]string{
		"workflow": "Trigger workflow execution",
		"iam":      "Manage users or roles",
	})
	if err != nil {
		t.Fatalf("InferenceRoute error: %v", err)
	}
	if seen["method"] != "POST" || seen["path"] != "/v1/inference/decision/route" {
		t.Fatalf("unexpected route call: %v", seen)
	}
	if routeRes["best_choice"] != "workflow" {
		t.Fatalf("route res: %v", routeRes)
	}
}
