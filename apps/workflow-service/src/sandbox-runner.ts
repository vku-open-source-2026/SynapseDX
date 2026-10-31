/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Isolated code-sandbox runner (P0-1). Spawned by engine.execCodeSandbox as
 * a throwaway process with an empty env, the permission model and
 * --disallow-code-generation-from-strings (see sandboxNodeArgs in engine.ts).
 * Protocol: one JSON payload on stdin, exactly one JSON result on stdout.
 *
 * Defense in depth:
 *   1. separate process (nothing shared with the service heap),
 *   2. empty environment (no IAM_JWT_SECRET / DATABASE_URL / credential key),
 *   3. Node permission model (no fs / child_process / workers),
 *   4. vm context with a null-prototype global, no host intrinsics, no
 *      code generation from strings.
 */
import vm from 'vm';

interface SandboxPayload {
  code: string;
  inputJson: string;
  now: string;
  timeoutMs: number;
}

function emit(o: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(o));
}

function safeJson(v: any): string {
  try {
    const s = JSON.stringify(v ?? null);
    return s === undefined ? 'null' : s;
  } catch {
    return 'null';
  }
}

async function run(payload: SandboxPayload): Promise<void> {
  const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 5000, 500), 15000);
  const ctx = vm.createContext(Object.create(null) as any, {
    codeGeneration: { strings: false, wasm: false },
  } as any);
  const boot = [
    'globalThis.__logs = [];',
    'globalThis.console = (() => {'
      + ' const fmt = (a) => Array.prototype.map.call(a, (x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");'
      + ' const push = function () { globalThis.__logs.push(fmt(arguments)); };'
      + ' return { log: push, info: push, warn: push, error: push };'
      + ' })();',
    `globalThis.$json = JSON.parse(${JSON.stringify(String(payload.inputJson ?? 'null'))});`,
    'globalThis.$input = globalThis.$json;',
    'globalThis.input = globalThis.$json;',
    `globalThis.$now = ${JSON.stringify(String(payload.now ?? ''))};`,
  ].join('\n');
  new vm.Script(boot).runInContext(ctx);

  let result: any;
  try {
    const script = new vm.Script(String(payload.code || ''));
    const pending = script.runInContext(ctx, { timeout: timeoutMs } as any);
    if (pending && typeof pending.then === 'function') {
      // User code is wrapped in an async IIFE: await it, but never let a
      // never-settling promise stall the sandbox — the parent process also
      // kills us, this timer just produces a cleaner error first.
      result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms (infinite loop?)`)), timeoutMs + 200);
        Promise.resolve(pending).then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      });
    } else {
      result = pending;
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    emit({
      ok: false,
      error: /Script execution timed out/i.test(msg) ? `timed out after ${timeoutMs}ms (infinite loop?)` : String(msg).slice(0, 500),
    });
    return;
  }
  const hasResult = result !== undefined;
  const logs = Array.isArray((ctx as any).__logs) ? ((ctx as any).__logs as any[]).map(String).slice(0, 200) : [];
  emit({ ok: true, hasResult, resultJson: hasResult ? safeJson(result) : 'null', logs });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  raw += chunk;
  if (raw.length > 4 * 1024 * 1024) {
    emit({ ok: false, error: 'sandbox payload exceeds 4MB' });
    process.exit(1);
  }
});
process.stdin.on('end', () => {
  let payload: SandboxPayload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    emit({ ok: false, error: 'invalid sandbox payload' });
    return;
  }
  try {
    run(payload).catch((e: any) => emit({ ok: false, error: String(e?.message || e).slice(0, 500) }));
  } catch (e: any) {
    emit({ ok: false, error: String(e?.message || e).slice(0, 500) });
  }
});
