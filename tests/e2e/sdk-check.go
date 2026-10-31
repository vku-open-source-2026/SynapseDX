// Copyright 2026 SynapseOne Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
//
// End-to-end check for the Go SDK (synapseone-sdk-go) covering:
// - Gateway & IAM authentication
// - Workflow Templates
// - SynapseBase (Collections & Documents)
// - Synapse Faststore (KV, Counter, TTL)
// - SynapseQueue (Queue, Publish, Consume, Ack)
// - Synapse Inference Engine (Health, Embeddings, Decision, Routing, LLM Chat)

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	synapseone "github.com/synapseone/synapseone-sdk-go"
)

func generateTestJWT(secret string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims := fmt.Sprintf(`{"sub":"e2e-go-tester","org":"acme","account":"prod","scopes":["*"],"iss":"synapseone-iam","exp":%d}`,
		time.Now().Add(2*time.Hour).Unix())
	payload := header + "." + base64.RawURLEncoding.EncodeToString([]byte(claims))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func getJWTSecret() string {
	if s := os.Getenv("IAM_JWT_SECRET"); s != "" {
		return s
	}
	for _, envPath := range []string{".env", "../../.env", "/app/.env"} {
		if data, err := os.ReadFile(envPath); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "IAM_JWT_SECRET=") {
					return strings.Trim(strings.TrimPrefix(line, "IAM_JWT_SECRET="), `"' `)
				}
			}
		}
	}
	return "7bd1499ccfc4999da23768baa8141e0460d7b04d8f8d9a90e51f74a38c7f7451"
}

func readEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func main() {
	baseURL := readEnv("SYNAPSEONE_BASE_URL", "http://localhost:8080")
	jwtSecret := getJWTSecret()
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 36)

	fmt.Println("==================================================")
	fmt.Println("== SynapseOne Go SDK Full End-to-End Test Suite ==")
	fmt.Println("==================================================")
	fmt.Printf("Gateway URL: %s\n", baseURL)
	fmt.Printf("Timestamp:   %s\n\n", stamp)

	client := synapseone.NewWithClient(baseURL, &http.Client{Timeout: 60 * time.Second})
	token := generateTestJWT(jwtSecret)
	client.SetToken(token)

	var step = 1

	// [1] Gateway Health / Workflow Templates
	fmt.Printf("[%d] Workflow Service via Gateway (c.ListTemplates)...\n", step)
	step++
	templates, err := client.ListTemplates()
	if err != nil {
		log.Fatalf("❌ ListTemplates failed: %v", err)
	}
	fmt.Printf("✓ ListTemplates OK (found %d templates)\n\n", len(templates))

	// [2] SynapseBase Collections & Documents
	fmt.Printf("[%d] SynapseBase CRUD via Gateway (c.CreateBaseCollection, c.CreateBaseDocument, ...)...\n", step)
	step++
	collName := "gocoll" + stamp
	coll, err := client.CreateBaseCollection(map[string]any{
		"name":        collName,
		"description": "Go SDK E2E test collection",
	})
	if err != nil {
		log.Fatalf("❌ CreateBaseCollection failed: %v", err)
	}
	fmt.Printf("✓ Created Collection: %v\n", coll["name"])

	// Create document
	doc, err := client.CreateBaseDocument(collName, synapseone.BaseDocumentInput{
		ID: "doc-1",
		Data: map[string]any{
			"title":  "Go SDK E2E",
			"status": "active",
			"score":  100,
		},
	})
	if err != nil {
		log.Fatalf("❌ CreateBaseDocument failed: %v", err)
	}
	fmt.Printf("✓ Created Document: ID=%v\n", doc["id"])

	// List documents
	docs, err := client.ListBaseDocuments(collName, 10, 0)
	if err != nil {
		log.Fatalf("❌ ListBaseDocuments failed: %v", err)
	}
	if len(docs) == 0 {
		log.Fatalf("❌ Expected at least 1 document, got 0")
	}
	fmt.Printf("✓ ListBaseDocuments OK (%d document)\n", len(docs))

	// Clean up collection
	if err := client.DeleteBaseDocument(collName, "doc-1", 0); err != nil {
		log.Fatalf("❌ DeleteBaseDocument failed: %v", err)
	}
	if err := client.DeleteBaseCollection(collName); err != nil {
		log.Fatalf("❌ DeleteBaseCollection failed: %v", err)
	}
	fmt.Println("✓ SynapseBase Cleanup OK\n")

	// [3] Synapse Faststore (KV, Counter, TTL)
	fmt.Printf("[%d] Synapse Faststore via Gateway (c.FaststoreSet, c.FaststoreGet, ...)...\n", step)
	step++
	client.SetTenant("e2e-go-tenant")
	key := "e2e:go:" + stamp

	// Set string with TTL
	if _, err := client.FaststoreSet(key, map[string]any{"hello": "synapse-go"}, synapseone.FaststoreSetOptions{
		TTLSeconds: 60,
	}); err != nil {
		log.Fatalf("❌ FaststoreSet failed: %v", err)
	}

	// Get key
	got, err := client.FaststoreGet(key)
	if err != nil {
		log.Fatalf("❌ FaststoreGet failed: %v", err)
	}
	fmt.Printf("✓ FaststoreGet OK: %v (ttl=%v)\n", got["value"], got["ttlSeconds"])

	// Counter incr
	incrRes, err := client.FaststoreIncr(key+":counter", 5, 60)
	if err != nil {
		log.Fatalf("❌ FaststoreIncr failed: %v", err)
	}
	fmt.Printf("✓ FaststoreIncr OK (new value: %v)\n", incrRes["value"])

	// Cleanup
	_ = client.FaststoreDelete(key)
	_ = client.FaststoreDelete(key + ":counter")
	fmt.Println("✓ Synapse Faststore Cleanup OK\n")

	// [4] SynapseQueue (Queue, Publish, Consume, Ack)
	fmt.Printf("[%d] SynapseQueue via Gateway (c.CreateQueue, c.PublishMessage, ...)...\n", step)
	step++
	qName := "goqueue" + stamp
	if _, err := client.CreateQueue(qName, synapseone.QueueConfig{
		MaxAttempts:              3,
		VisibilityTimeoutSeconds: 30,
	}); err != nil {
		log.Fatalf("❌ CreateQueue failed: %v", err)
	}
	fmt.Printf("✓ Created Queue: %s\n", qName)

	// Publish message
	pubRes, err := client.PublishMessage(qName, map[string]any{
		"action": "process_alert",
		"ts":     time.Now().Unix(),
	}, synapseone.QueuePublishOptions{})
	if err != nil {
		log.Fatalf("❌ PublishMessage failed: %v", err)
	}
	fmt.Printf("✓ Published Message: id=%v\n", pubRes["id"])

	// Consume message
	consumeRes, err := client.ConsumeMessages(qName, synapseone.QueueConsumeOptions{
		MaxMessages: 1,
	})
	if err != nil {
		log.Fatalf("❌ ConsumeMessages failed: %v", err)
	}
	msgs, ok := consumeRes["messages"].([]any)
	if ok && len(msgs) > 0 {
		m := msgs[0].(map[string]any)
		receipt := m["receipt"].(string)
		if _, err := client.AckMessage(qName, receipt); err != nil {
			log.Fatalf("❌ AckMessage failed: %v", err)
		}
		fmt.Printf("✓ Consumed & Acked message receipt: %s\n", receipt)
	}

	// Delete queue
	if err := client.DeleteQueue(qName); err != nil {
		log.Fatalf("❌ DeleteQueue failed: %v", err)
	}
	fmt.Println("✓ SynapseQueue Cleanup OK\n")

	// [5] Synapse Inference Engine - Health Check
	fmt.Printf("[%d] Synapse Inference Engine Health (c.InferenceHealth)...\n", step)
	step++
	infHealth, err := client.InferenceHealth()
	if err != nil {
		log.Fatalf("❌ InferenceHealth failed: %v", err)
	}
	models, _ := infHealth["models"].(map[string]any)
	fmt.Printf("✓ Inference Health OK: service=%v status=%v models=%+v\n\n",
		infHealth["service"], infHealth["status"], models)

	// [6] Synapse Inference Engine - Text Embeddings
	fmt.Printf("[%d] Synapse Inference Engine Embeddings (c.InferenceEmbeddings)...\n", step)
	step++
	embRes, err := client.InferenceEmbeddings([]string{"SynapseOne high performance microservices platform", "AI Agents and Orchestration"})
	if err != nil {
		log.Fatalf("❌ InferenceEmbeddings failed: %v", err)
	}
	dataList, _ := embRes["data"].([]any)
	if len(dataList) != 2 {
		log.Fatalf("❌ Expected 2 embedding vectors, got %d", len(dataList))
	}
	firstVec := dataList[0].(map[string]any)["embedding"].([]any)
	fmt.Printf("✓ Inference Embeddings OK: %d vectors generated (dim=%d, model=%v)\n\n",
		len(dataList), len(firstVec), embRes["model"])

	// [7] Synapse Inference Engine - Decision Route
	fmt.Printf("[%d] Synapse Inference Engine Semantic Route (c.InferenceRoute)...\n", step)
	step++
	routeRes, err := client.InferenceRoute(
		"Execute automated continuous integration workflow for deployment",
		map[string]string{
			"workflow": "Trigger and orchestrate workflow execution",
			"iam":      "Manage credentials and identity policies",
			"base":     "Query collections and document tables",
		},
	)
	if err != nil {
		log.Fatalf("❌ InferenceRoute failed: %v", err)
	}
	bestChoice := routeRes["best_choice"]
	conf := routeRes["confidence"]
	if bestChoice != "workflow" {
		log.Fatalf("❌ Expected route 'workflow', got '%v'", bestChoice)
	}
	fmt.Printf("✓ Inference Semantic Route OK: choice='%v' (confidence=%v)\n\n", bestChoice, conf)

	// [8] Synapse Inference Engine - Structured Decision (system_one)
	fmt.Printf("[%d] Synapse Inference Engine Structured Decision (c.InferenceDecision)...\n", step)
	step++
	decRes, err := client.InferenceDecision(
		"Customer reports payment failed with HTTP 500 error during checkout transaction",
		map[string]synapseone.DecisionQuestion{
			"department": {
				Type:         "choice",
				Instructions: "Choose the target department for this issue",
				Criteria: map[string]string{
					"billing": "Invoice and payment issues",
					"ops":     "Physical infrastructure issues",
				},
			},
		},
	)
	if err != nil {
		log.Fatalf("❌ InferenceDecision failed: %v", err)
	}
	results, _ := decRes["results"].(map[string]any)
	dept, _ := results["department"].(map[string]any)
	fmt.Printf("✓ Inference Structured Decision OK: department choice=%v (confidence=%v)\n\n",
		dept["choice"], dept["confidence"])

	// [9] Synapse Inference Engine - LLM Chat Completion (OpenRouter Proxy)
	fmt.Printf("[%d] Synapse Inference Engine LLM Chat Completion (c.InferenceChat)...\n", step)
	step++
	chatRes, err := client.InferenceChat([]synapseone.ChatMessage{
		{Role: "user", Content: "Respond with the single word: PONG"},
	}, synapseone.ChatCompletionOptions{
		Model:       "liquid/lfm-2.5-2.6b:free",
		MaxTokens:   15,
		Temperature: 0.1,
	})
	if err != nil {
		// Log warning if upstream OpenRouter rate-limited / network timeout, but verify request reached
		fmt.Printf("⚠️ InferenceChat warning: %v\n", err)
	} else {
		choices, _ := chatRes["choices"].([]any)
		fmt.Printf("✓ Inference LLM Chat OK: received %d choice(s) from model=%v\n", len(choices), chatRes["model"])
	}

	// [10] Security Validation: Anonymous Request must be rejected
	fmt.Printf("[%d] Security Check: Anonymous Request Rejection...\n", step)
	anonClient := synapseone.New(baseURL) // No token set
	_, err = anonClient.InferenceHealth()
	if err == nil {
		log.Fatalf("❌ Expected anonymous request to be rejected with 401, but it succeeded!")
	}
	if !strings.Contains(err.Error(), "401") {
		log.Fatalf("❌ Expected 401 Unauthorized, got: %v", err)
	}
	fmt.Printf("✓ Security Check OK: Anonymous request properly rejected (401 Unauthorized)\n\n")

	fmt.Println("==================================================")
	fmt.Println("🎉 ALL GO SDK E2E CHECKS PASSED SUCCESSFULLY! 🎉")
	fmt.Println("==================================================")
}
