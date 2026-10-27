/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faDatabase,
  faInbox,
  faGaugeHigh,
  faLink,
  faMagnifyingGlass,
  faXmark,
  faCode,
  faBrain,
  faStream,
} from '@fortawesome/free-solid-svg-icons';

export const PLATFORM_SERVICES = [
  {
    to: '/workflows',
    label: 'SynapseFlow',
    category: 'Automation & AI Agents',
    desc: 'Visual pipelines, AI agents, decision routing & DAGs',
    icon: faBolt,
    iconColor: 'from-amber-400 to-amber-500',
    bgGradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    shadowColor: 'rgba(245, 158, 11, 0.28)',
    match: (p) => p.startsWith('/workflows'),
    keywords: ['synapseflow', 'workflow', 'ai agent', 'decision', 'dag', 'automation', 'cron', 'trigger', 'pipeline', 'execution'],
  },
  {
    to: '/base',
    label: 'SynapseBase',
    category: 'Document Database',
    desc: 'JSON documents with object ↔ data mapping & queries',
    icon: faDatabase,
    iconColor: 'from-blue-500 to-indigo-600',
    bgGradient: 'linear-gradient(135deg, #3b82f6 0%, #4338ca 100%)',
    shadowColor: 'rgba(59, 130, 246, 0.28)',
    match: (p) => p.startsWith('/base'),
    keywords: ['base', 'document', 'database', 'json', 'nosql', 'mapping', 'query', 'collections'],
  },
  {
    to: '/queue',
    label: 'SynapseQueue',
    category: 'Message Queue',
    desc: 'At-least-once message queues, leases & dead letters',
    icon: faInbox,
    iconColor: 'from-emerald-400 to-teal-500',
    bgGradient: 'linear-gradient(135deg, #10b981 0%, #0d9488 100%)',
    shadowColor: 'rgba(16, 185, 129, 0.28)',
    match: (p) => p.startsWith('/queue'),
    keywords: ['queue', 'message', 'broker', 'dlq', 'dead letter', 'visibility', 'lease', 'pubsub'],
  },
  {
    to: '/stream',
    label: 'SynapseStream',
    category: 'Event Streaming',
    desc: 'Distributed event stream log, consumer groups & time-series replay',
    icon: faStream,
    iconColor: 'from-amber-500 to-rose-500',
    bgGradient: 'linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)',
    shadowColor: 'rgba(244, 63, 94, 0.28)',
    match: (p) => p.startsWith('/stream'),
    keywords: ['stream', 'streaming', 'kafka', 'events', 'consumer group', 'replay', 'telemetry', 'topic', 'log'],
  },
  {
    to: '/faststore',
    label: 'Synapse Faststore',
    category: 'Cache & KV Store',
    desc: 'Redis-backed cache, counters, hashes & distributed locks',
    icon: faGaugeHigh,
    iconColor: 'from-cyan-400 to-blue-500',
    bgGradient: 'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)',
    shadowColor: 'rgba(6, 182, 212, 0.28)',
    match: (p) => p.startsWith('/faststore'),
    keywords: ['faststore', 'cache', 'redis', 'key-value', 'kv', 'ttl', 'counter', 'hash', 'lock'],
  },
  {
    to: '/lds',
    label: 'SynapseLDS',
    category: 'Linked Data',
    desc: 'NGSI-LD datasources, entity schemas & open-data licenses',
    icon: faLink,
    iconColor: 'from-purple-500 to-indigo-500',
    bgGradient: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
    shadowColor: 'rgba(139, 92, 246, 0.28)',
    match: (p) => p.startsWith('/lds'),
    keywords: ['lds', 'linked data', 'ngsi-ld', 'datasource', 'license', 'schema', 'entities'],
  },
  {
    to: '/inference',
    label: 'SynapseInference',
    category: 'AI & Inference',
    desc: 'LLM proxy, local embeddings & Decision-2.0 routing',
    icon: faBrain,
    iconColor: 'from-violet-500 to-purple-600',
    bgGradient: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
    shadowColor: 'rgba(139, 92, 246, 0.28)',
    match: (p) => p.startsWith('/inference'),
    keywords: ['inference', 'ai', 'llm', 'embedding', 'decision', 'openrouter', 'routing', 'agent', 'model'],
  },
];

export default function ServicesSidebar({ open = true, onToggle }) {
  const { pathname } = useLocation();
  const [query, setQuery] = useState('');

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = PLATFORM_SERVICES.filter((svc) => {
    if (!q) return true;
    if (svc.label.toLowerCase().includes(q)) return true;
    if (svc.category.toLowerCase().includes(q)) return true;
    if (svc.desc.toLowerCase().includes(q)) return true;
    return svc.keywords.some((k) => k.includes(q));
  });

  return (
    <aside
      aria-label="Services Navigation"
      className="fixed right-3 xl:right-5 top-0 h-screen w-64 xl:w-72 hidden lg:flex flex-col z-30 pt-4 pb-6"
    >
      <div className="w-full bg-white rounded-3xl p-4 shadow-md max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <h2 className="font-semibold text-sm text-main-text">Platform Services</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-main-blue bg-main-blue/10 px-2 py-0.5 rounded-full">
              {filtered.length} active
            </span>
            {onToggle && (
              <button
                type="button"
                onClick={onToggle}
                title="Collapse services sidebar"
                className="text-normal-text hover:text-main-text p-1 text-xs"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            )}
          </div>
        </div>

        {/* Search Input */}
        <div className="relative mt-3 mb-3">
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            className="absolute left-3 top-2.5 text-xs text-normal-text"
          />
          <input
            type="text"
            placeholder="Search services..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-7 py-1.5 rounded-2xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue transition-colors bg-background/50 focus:bg-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-2 text-xs text-normal-text hover:text-main-text"
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          )}
        </div>

        {/* Services List */}
        <nav className="flex-1 overflow-y-auto space-y-2 pr-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-normal-text">
              <p>No services match &ldquo;{query}&rdquo;</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-2 text-main-blue underline hover:text-main-end"
              >
                Clear search
              </button>
            </div>
          ) : (
            filtered.map((svc) => {
              const active = svc.match(pathname);
              return (
                <Link
                  key={svc.to}
                  to={svc.to}
                  className={`group block p-2.5 rounded-2xl border transition-all ${
                    active
                      ? 'border-main-blue bg-main-blue/10 shadow-sm'
                      : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      style={{
                        background: svc.bgGradient,
                        boxShadow: `0 3px 8px ${svc.shadowColor}`,
                      }}
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-white shrink-0 group-hover:scale-105 transition-transform"
                    >
                      <FontAwesomeIcon icon={svc.icon} className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-xs font-semibold truncate ${
                            active ? 'text-main-blue' : 'text-main-text group-hover:text-main-blue'
                          }`}
                        >
                          {svc.label}
                        </span>
                        {active && (
                          <span className="w-1.5 h-1.5 rounded-full bg-main-blue shrink-0" />
                        )}
                      </div>
                      <p className="text-[10px] text-normal-text truncate">{svc.category}</p>
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </nav>

        {/* Footer info */}
        <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-normal-text flex items-center justify-between">
          <span>Tier-1 Distributed</span>
          <Link to="/api-docs" className="text-main-blue hover:underline flex items-center gap-1">
            <FontAwesomeIcon icon={faCode} className="text-[10px]" /> API
          </Link>
        </div>
      </div>
    </aside>
  );
}
