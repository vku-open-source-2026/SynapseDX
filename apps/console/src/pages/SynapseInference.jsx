/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBrain,
  faRotateRight,
  faBolt,
  faNetworkWired,
  faMicrochip,
  faComments,
  faLayerGroup,
  faCheckCircle,
  faArrowRight,
  faSliders,
  faCopy,
  faCheck,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import {
  Badge,
  Btn,
  Card,
  Code,
  Err,
  Field,
  Input,
  PageTitle,
} from '../components/ui.jsx';

export default function SynapseInference() {
  const { headers } = useAuth();
  const [activeTab, setActiveTab] = useState('decision'); // 'decision' | 'embedding' | 'llm'
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  // Tab 1: Decision & Routing
  const [routeInput, setRouteInput] = useState('Where can I set up automated webhooks and retry workflows?');
  const [routeInstruction, setRouteInstruction] = useState('Choose the best system module for the query');
  const [choices, setChoices] = useState([
    { key: 'workflow', desc: 'Visual workflows, webhooks, cron, and DAG automation' },
    { key: 'iam', desc: 'User accounts, permissions, roles, and API keys' },
    { key: 'base', desc: 'Document collections, queries, and JSON storage' },
  ]);
  const [routingResult, setRoutingResult] = useState(null);
  const [routingLoading, setRoutingLoading] = useState(false);

  // Tab 2: Embeddings
  const [embInput, setEmbInput] = useState('Customer invoice for cloud compute subscription');
  const [embResult, setEmbResult] = useState(null);
  const [embLoading, setEmbLoading] = useState(false);

  // Tab 3: LLM
  const [llmSystem, setLlmSystem] = useState('You are an expert AI assistant on the SynapseDX cloud platform.');
  const [llmPrompt, setLlmPrompt] = useState('Explain how workflows and queues communicate in SynapseDX in two concise sentences.');
  const [llmModel, setLlmModel] = useState('liquid/lfm-2.5-2.6b:free');
  const [llmTemp, setLlmTemp] = useState(0.7);
  const [llmMaxTokens, setLlmMaxTokens] = useState(256);
  const [llmResult, setLlmResult] = useState(null);
  const [llmLoading, setLlmLoading] = useState(false);

  const fetchHealth = async () => {
    setHealthLoading(true);
    setErr(null);
    try {
      const data = await api.inferenceHealth(headers());
      setHealth(data);
    } catch (e) {
      setErr(e.message || 'Failed to load inference engine health');
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  const handleCopy = (text) => {
    if (!text) return;
    navigator.clipboard?.writeText(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRoute = async () => {
    setRoutingLoading(true);
    setErr(null);
    try {
      const choiceDict = {};
      for (const c of choices) {
        if (c.key.trim()) choiceDict[c.key.trim()] = c.desc.trim();
      }
      const data = await api.inferenceRoute(
        {
          input: routeInput,
          choices: choiceDict,
          instruction: routeInstruction,
        },
        headers()
      );
      setRoutingResult(data);
    } catch (e) {
      setErr(e.message || 'Routing evaluation failed');
    } finally {
      setRoutingLoading(false);
    }
  };

  const handleEmbeddings = async () => {
    setEmbLoading(true);
    setErr(null);
    try {
      const lines = embInput.split('\n').map((s) => s.trim()).filter(Boolean);
      const data = await api.inferenceEmbeddings(
        {
          input: lines.length > 1 ? lines : embInput,
        },
        headers()
      );
      setEmbResult(data);
    } catch (e) {
      setErr(e.message || 'Embedding generation failed');
    } finally {
      setEmbLoading(false);
    }
  };

  const handleChat = async () => {
    setLlmLoading(true);
    setErr(null);
    try {
      const messages = [];
      if (llmSystem.trim()) messages.push({ role: 'system', content: llmSystem.trim() });
      messages.push({ role: 'user', content: llmPrompt.trim() });

      const data = await api.inferenceChat(
        {
          model: llmModel,
          messages,
          temperature: Number(llmTemp),
          max_tokens: Number(llmMaxTokens),
          stream: false,
        },
        headers()
      );
      setLlmResult(data);
    } catch (e) {
      setErr(e.message || 'LLM completion failed');
    } finally {
      setLlmLoading(false);
    }
  };

  const addChoice = () => {
    setChoices([...choices, { key: `option_${choices.length + 1}`, desc: 'Description of candidate action' }]);
  };

  const removeChoice = (idx) => {
    setChoices(choices.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <PageTitle
            title="Synapse Inference Engine"
            desc="Multi-modal AI inference: OpenRouter LLM proxy, self-hosted lightweight embeddings, and Decision-2.0-Eos-0.8B semantic routing"
          />
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="secondary" onClick={fetchHealth} disabled={healthLoading}>
            <FontAwesomeIcon icon={faRotateRight} className={`mr-2 ${healthLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Btn>
        </div>
      </div>

      {err && <Err error={err} />}

      {/* Subsystem Health Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* LLM Card */}
        <Card className="p-4 bg-gradient-to-br from-white to-violet-50/30 border border-violet-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-violet-600 flex items-center gap-1.5">
              <FontAwesomeIcon icon={faComments} />
              LLM Engine
            </span>
            <Badge variant="success">Online</Badge>
          </div>
          <div className="text-sm font-medium text-slate-800 truncate" title={health?.models?.llm || 'OpenRouter'}>
            {health?.models?.llm || 'liquid/lfm-2.5-2.6b:free'}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex items-center justify-between">
            <span>Provider: {health?.components?.llm?.provider || 'OpenRouter'}</span>
            <span className="text-emerald-600 font-medium">Ready</span>
          </div>
        </Card>

        {/* Embedding Card */}
        <Card className="p-4 bg-gradient-to-br from-white to-cyan-50/30 border border-cyan-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-cyan-600 flex items-center gap-1.5">
              <FontAwesomeIcon icon={faLayerGroup} />
              Embedding Model
            </span>
            <Badge variant="info">384 Dim</Badge>
          </div>
          <div className="text-sm font-medium text-slate-800 truncate" title={health?.models?.embedding || 'all-MiniLM-L6-v2'}>
            {health?.models?.embedding || 'sentence-transformers/all-MiniLM-L6-v2'}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex items-center justify-between">
            <span>Device: {health?.components?.embedding?.device || 'CPU'}</span>
            <span className="text-cyan-700 font-medium">Self-hosted</span>
          </div>
        </Card>

        {/* Decision Card */}
        <Card className="p-4 bg-gradient-to-br from-white to-amber-50/30 border border-amber-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 flex items-center gap-1.5">
              <FontAwesomeIcon icon={faBrain} />
              Decision Model
            </span>
            <Badge variant="warning">0.8B SLM</Badge>
          </div>
          <div className="text-sm font-medium text-slate-800 truncate" title={health?.models?.decision || 'Decision-2.0-Eos-0.8B'}>
            {health?.models?.decision || 'vllm-sr/Decision-2.0-Eos-0.8B'}
          </div>
          <div className="text-xs text-slate-500 mt-1 flex items-center justify-between">
            <span>Architecture: Qwen3.5-0.8B</span>
            <span className="text-amber-700 font-medium">system_one</span>
          </div>
        </Card>
      </div>

      {/* Navigation Tabs */}
      <div className="border-b border-slate-200 flex space-x-6">
        <button
          onClick={() => setActiveTab('decision')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'decision'
              ? 'border-main-blue text-main-blue'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FontAwesomeIcon icon={faNetworkWired} />
          Decision & Workflow Routing
        </button>
        <button
          onClick={() => setActiveTab('embedding')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'embedding'
              ? 'border-main-blue text-main-blue'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FontAwesomeIcon icon={faLayerGroup} />
          Text Embeddings
        </button>
        <button
          onClick={() => setActiveTab('llm')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'llm'
              ? 'border-main-blue text-main-blue'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FontAwesomeIcon icon={faComments} />
          LLM Chat Playground
        </button>
      </div>

      {/* Tab 1: Decision & Routing */}
      {activeTab === 'decision' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <FontAwesomeIcon icon={faBolt} className="text-amber-500" />
              Workflow Semantic Routing (Decision-2.0-Eos-0.8B)
            </h3>
            <p className="text-xs text-slate-500">
              Evaluates incoming user request or event payload against candidate branches in a single forward pass.
            </p>

            <Field label="Input State / Text">
              <textarea
                value={routeInput}
                onChange={(e) => setRouteInput(e.target.value)}
                rows={3}
                className="w-full text-sm rounded-xl border border-slate-200 p-2.5 focus:border-main-blue focus:ring-1 focus:ring-main-blue outline-none"
                placeholder="Enter request or trigger payload text..."
              />
            </Field>

            <Field label="Routing Instruction">
              <Input
                value={routeInstruction}
                onChange={(e) => setRouteInstruction(e.target.value)}
                placeholder="e.g. Choose the best system service"
              />
            </Field>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Candidate Branches ({choices.length})
                </label>
                <button
                  type="button"
                  onClick={addChoice}
                  className="text-xs font-medium text-main-blue hover:underline"
                >
                  + Add Branch
                </button>
              </div>
              <div className="space-y-2">
                {choices.map((c, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-slate-50 p-2 rounded-xl border border-slate-100">
                    <input
                      type="text"
                      value={c.key}
                      onChange={(e) => {
                        const copy = [...choices];
                        copy[idx].key = e.target.value;
                        setChoices(copy);
                      }}
                      className="w-28 text-xs font-mono font-medium rounded-lg border border-slate-200 p-1.5 bg-white"
                      placeholder="key"
                    />
                    <input
                      type="text"
                      value={c.desc}
                      onChange={(e) => {
                        const copy = [...choices];
                        copy[idx].desc = e.target.value;
                        setChoices(copy);
                      }}
                      className="flex-1 text-xs rounded-lg border border-slate-200 p-1.5 bg-white"
                      placeholder="Semantic criteria for this branch..."
                    />
                    {choices.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeChoice(idx)}
                        className="text-xs text-slate-400 hover:text-red-500 px-1"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <Btn onClick={handleRoute} disabled={routingLoading} className="w-full">
              {routingLoading ? 'Evaluating with Decision-2.0...' : 'Run Decision Evaluation'}
            </Btn>
          </Card>

          {/* Results Side */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">Routing Decision Output</h3>
              {routingResult && (
                <button
                  onClick={() => handleCopy(routingResult)}
                  className="text-xs text-slate-500 hover:text-main-blue flex items-center gap-1"
                >
                  <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                  {copied ? 'Copied' : 'Copy JSON'}
                </button>
              )}
            </div>

            {routingResult ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-violet-50 border border-violet-100 flex items-center justify-between">
                  <div>
                    <span className="text-xs text-violet-600 font-semibold uppercase">Winner Branch</span>
                    <div className="text-xl font-bold text-violet-900 mt-0.5">
                      {routingResult.best_choice}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-violet-600 font-semibold uppercase">Confidence</span>
                    <div className="text-xl font-bold text-violet-900 mt-0.5">
                      {Math.round((routingResult.confidence || 0) * 100)}%
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">
                    Probability Distribution
                  </label>
                  <div className="space-y-2">
                    {Object.entries(routingResult.probabilities || {}).map(([k, p]) => (
                      <div key={k} className="space-y-1">
                        <div className="flex justify-between text-xs font-medium">
                          <span className={k === routingResult.best_choice ? 'font-bold text-violet-700' : 'text-slate-600'}>
                            {k}
                          </span>
                          <span className="text-slate-500">{Math.round(p * 100)}%</span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              k === routingResult.best_choice ? 'bg-violet-600' : 'bg-slate-300'
                            }`}
                            style={{ width: `${Math.round(p * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-slate-400 flex items-center justify-between pt-2 border-t border-slate-100">
                  <span>Model: {routingResult.model}</span>
                  <span>Latency: {routingResult.duration_ms} ms</span>
                </div>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs text-center border-2 border-dashed border-slate-100 rounded-2xl">
                <FontAwesomeIcon icon={faBrain} className="text-3xl mb-2 text-slate-300" />
                Provide input and click Run Decision Evaluation to see real-time routing output.
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Tab 2: Embeddings */}
      {activeTab === 'embedding' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <FontAwesomeIcon icon={faLayerGroup} className="text-cyan-500" />
              Generate Vector Embeddings (all-MiniLM-L6-v2)
            </h3>
            <p className="text-xs text-slate-500">
              Generates 384-dimensional dense vectors for semantic search, document retrieval, and similarity matching.
            </p>

            <Field label="Input Text (Separate lines for batch generation)">
              <textarea
                value={embInput}
                onChange={(e) => setEmbInput(e.target.value)}
                rows={5}
                className="w-full text-sm rounded-xl border border-slate-200 p-2.5 focus:border-main-blue focus:ring-1 focus:ring-main-blue outline-none"
                placeholder="Enter text or sentences (one per line)..."
              />
            </Field>

            <Btn onClick={handleEmbeddings} disabled={embLoading} className="w-full">
              {embLoading ? 'Generating Vectors...' : 'Compute Embeddings'}
            </Btn>
          </Card>

          {/* Embedding Results */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">Embedding Vectors Output</h3>
              {embResult && (
                <button
                  onClick={() => handleCopy(embResult)}
                  className="text-xs text-slate-500 hover:text-main-blue flex items-center gap-1"
                >
                  <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                  {copied ? 'Copied' : 'Copy Vectors'}
                </button>
              )}
            </div>

            {embResult ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-center">
                  <div>
                    <span className="text-[10px] uppercase text-slate-400 font-semibold">Vectors</span>
                    <div className="text-base font-bold text-slate-800">{embResult.data?.length || 0}</div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-400 font-semibold">Dimensions</span>
                    <div className="text-base font-bold text-slate-800">{embResult.data?.[0]?.embedding?.length || 384}</div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-400 font-semibold">Total Tokens</span>
                    <div className="text-base font-bold text-slate-800">{embResult.usage?.total_tokens || 0}</div>
                  </div>
                </div>

                <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                  {embResult.data?.map((item, idx) => (
                    <div key={idx} className="p-3 bg-white rounded-xl border border-slate-200 space-y-1.5">
                      <div className="flex justify-between text-xs font-semibold text-slate-600">
                        <span>Vector #{item.index + 1}</span>
                        <span className="text-slate-400 font-mono text-[11px]">dim: {item.embedding?.length}</span>
                      </div>
                      <div className="text-xs font-mono text-slate-500 bg-slate-50 p-2 rounded-lg break-all max-h-24 overflow-y-auto">
                        [{item.embedding?.slice(0, 16).join(', ')}, ...]
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs text-center border-2 border-dashed border-slate-100 rounded-2xl">
                <FontAwesomeIcon icon={faLayerGroup} className="text-3xl mb-2 text-slate-300" />
                Submit text to compute dense normalized vector embeddings.
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Tab 3: LLM Chat Playground */}
      {activeTab === 'llm' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <FontAwesomeIcon icon={faComments} className="text-violet-500" />
              OpenRouter LLM Proxy Playground
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Model">
                <Input
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder="e.g. liquid/lfm-2.5-2.6b:free"
                />
              </Field>
              <Field label={`Max Tokens (${llmMaxTokens})`}>
                <input
                  type="range"
                  min="32"
                  max="1024"
                  step="32"
                  value={llmMaxTokens}
                  onChange={(e) => setLlmMaxTokens(e.target.value)}
                  className="w-full mt-2"
                />
              </Field>
            </div>

            <Field label="System Prompt">
              <textarea
                value={llmSystem}
                onChange={(e) => setLlmSystem(e.target.value)}
                rows={2}
                className="w-full text-xs rounded-xl border border-slate-200 p-2 focus:border-main-blue outline-none"
              />
            </Field>

            <Field label="User Message">
              <textarea
                value={llmPrompt}
                onChange={(e) => setLlmPrompt(e.target.value)}
                rows={3}
                className="w-full text-sm rounded-xl border border-slate-200 p-2.5 focus:border-main-blue outline-none"
                placeholder="Ask anything..."
              />
            </Field>

            <Btn onClick={handleChat} disabled={llmLoading} className="w-full">
              {llmLoading ? 'Querying OpenRouter...' : 'Send Completion Request'}
            </Btn>
          </Card>

          {/* LLM Results */}
          <Card className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">Completion Response</h3>
              {llmResult && (
                <button
                  onClick={() => handleCopy(llmResult)}
                  className="text-xs text-slate-500 hover:text-main-blue flex items-center gap-1"
                >
                  <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>

            {llmResult ? (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-sm text-slate-800 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
                  {llmResult.choices?.[0]?.message?.content ||
                    llmResult.choices?.[0]?.message?.reasoning ||
                    JSON.stringify(llmResult, null, 2)}
                </div>

                <div className="text-xs text-slate-400 flex items-center justify-between pt-2 border-t border-slate-100">
                  <span>Model: {llmResult.model}</span>
                  <span>Tokens: {llmResult.usage?.total_tokens || 0}</span>
                </div>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs text-center border-2 border-dashed border-slate-100 rounded-2xl">
                <FontAwesomeIcon icon={faComments} className="text-3xl mb-2 text-slate-300" />
                Send a prompt to receive token completion from OpenRouter.
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
