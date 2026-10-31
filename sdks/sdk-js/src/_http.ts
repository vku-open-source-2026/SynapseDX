/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Shared fetch-based HTTP plumbing for the synapseone JavaScript SDK.
 */

export interface SynapseOneClientOptions {
  baseUrl?: string; // gateway, defaults to https://synapseone.space or $SYNAPSEONE_BASE_URL
  token?: string; // Bearer JWT
  apiKey?: string; // X-API-Key
  tenant?: string; // x-synapseone-tenant (platform callers of faststore/queue)
  timeoutMs?: number; // per-request timeout (default 15000)
}

/** All SDK failures surface as SynapseOneError (network or HTTP). */
export class SynapseOneError extends Error {
  /** HTTP status code when the failure came from a response, undefined for network errors. */
  status?: number;
  /** Parsed error body when the response carried JSON. */
  body?: unknown;

  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'SynapseOneError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

/**
 * @deprecated Use {@link SynapseOneError}. Kept for the SynapseDX -> SynapseOne
 * rebrand window; identical class (so `instanceof` works across both names).
 */
export { SynapseOneError as SynapseDXError };

/** @deprecated Use {@link SynapseOneClientOptions}. */
export type SynapseDXClientOptions = SynapseOneClientOptions;

/** Emit a deprecation notice through Node's warning channel (console fallback). */
export function warnDeprecated(name: string, replacement: string): void {
  const message = `synapseone: ${name}() is deprecated; use ${replacement}() instead`;
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(message, { type: 'DeprecationWarning' });
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn(message);
  }
}

export class HttpClient {
  baseUrl: string;
  token?: string;
  apiKey?: string;
  tenant?: string;
  timeoutMs: number;

  constructor(opts: SynapseOneClientOptions = {}) {
    const raw = opts.baseUrl ?? (typeof process !== 'undefined' ? (process.env?.SYNAPSEONE_BASE_URL || process.env?.SYNAPSEDX_BASE_URL) : undefined) ?? 'https://synapseone.space';
    this.baseUrl = raw.replace(/\/$/, '');
    this.token = opts.token;
    this.apiKey = opts.apiKey;
    this.tenant = opts.tenant;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  setToken(t: string): void { this.token = t; }
  setApiKey(k: string): void { this.apiKey = k; }
  setTenant(t: string | undefined): void { this.tenant = t; }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    if (this.apiKey) h['X-API-Key'] = this.apiKey;
    if (this.tenant) h['x-synapseone-tenant'] = this.tenant;
    return h;
  }

  async req<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      r = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? ctl.signal,
        headers: this.headers((init?.headers as Record<string, string>) || {}),
      });
    } catch (e: any) {
      throw new SynapseOneError(`synapseone network ${path}: ${e?.message || e}`);
    } finally {
      clearTimeout(to);
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 2000);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      throw new SynapseOneError(`synapseone ${r.status} ${path}: ${text}`, { status: r.status, body });
    }
    const text = await r.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Generic escape hatch (forward-compat with endpoints added after this SDK). */
  call(method: string, path: string, body?: unknown) {
    const m = String(method || 'GET').toUpperCase();
    return this.req(path.startsWith('/') ? path : `/${path}`, {
      method: m,
      body: body === undefined || m === 'GET' || m === 'HEAD' ? undefined : JSON.stringify(body),
    });
  }
}
