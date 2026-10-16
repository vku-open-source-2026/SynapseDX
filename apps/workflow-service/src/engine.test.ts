/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Engine unit tests: sandbox, set/if/http guards, DAG, cron.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, detectCycle, cronIntervalMs, execCodeSandbox, validateCronParams, cronNextRunAt } from './engine';

const N = (name: string, type: string, parameters: any = {}) => ({ name, type, parameters });

describe('engine: set / if / noOp passthrough', () => {
  it('set merges values with templating', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('S', 'n8n-nodes-base.set', { values: { tag: 'big', upper: '={{ $input.name }}' } })],
      connections: { Start: { main: [[{ node: 'S' }]] } } as any,
    }, { name: 'etl' });
    assert.equal(r.status, 'success');
    assert.equal((r.output as any).tag, 'big');
    assert.equal((r.output as any).name, 'etl');
  });
  it('if routes true/false branches', async () => {
    const def = {
      nodes: [
        N('Start', 'n8n-nodes-base.manualTrigger'),
        N('Check', 'n8n-nodes-base.if', { condition: '$input.value > 10' }),
        N('Big', 'n8n-nodes-base.set', { values: { tag: 'big' } }),
        N('Small', 'n8n-nodes-base.set', { values: { tag: 'small' } }),
      ],
      connections: {
        Start: { main: [[{ node: 'Check' }]] },
        Check: { main: [[{ node: 'Big' }], [{ node: 'Small' }]] },
      } as any,
    };
    const big = await runWorkflow(def, { value: 20 });
    assert.equal((big.output as any).tag, 'big');
    const small = await runWorkflow(def, { value: 2 });
    assert.equal((small.output as any).tag, 'small');
  });
  it('empty workflow returns input', async () => {
    const r = await runWorkflow({ nodes: [], connections: {} }, { a: 1 });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.output, { a: 1 });
  });
});

describe('engine: code sandbox', () => {
  it('runs transform code with $input/$now', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('C', 'n8n-nodes-base.code', { code: 'return { doubled: ($input.value ?? 0) * 2 };' })],
      connections: { Start: { main: [[{ node: 'C' }]] } } as any,
    }, { value: 21 });
    assert.equal(r.status, 'success');
    assert.equal((r.output as any).doubled, 42);
  });
  it('expression without return works', async () => {
    const out: any = await execCodeSandbox(N('C', 'n8n-nodes-base.code', { code: '({ a: 1 })' }) as any, {});
    assert.equal(out.a, 1);
  });
  it('blocks process/require escape', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('C', 'n8n-nodes-base.code', { code: 'return process.env;' })],
      connections: { Start: { main: [[{ node: 'C' }]] } } as any,
    }, {});
    assert.equal(r.status, 'error');
    assert.match(String(r.error), /code:/);
  });
  it('times out infinite loops', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('C', 'n8n-nodes-base.code', { code: 'while(true) {}' })],
      connections: { Start: { main: [[{ node: 'C' }]] } } as any,
    }, {});
    assert.equal(r.status, 'error');
    assert.match(String(r.error), /timed out/);
  });
  it('rejects oversized output', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('C', 'n8n-nodes-base.code', { code: "return { s: 'x'.repeat(600*1024) };" })],
      connections: { Start: { main: [[{ node: 'C' }]] } } as any,
    }, {});
    assert.equal(r.status, 'error');
  });
});

describe('engine: http + ssrf + cycle + cron', () => {
  it('blocks internal httpRequest at runtime', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'http://169.254.169.254/latest', method: 'GET' })],
      connections: { Start: { main: [[{ node: 'H' }]] } } as any,
    }, {});
    assert.equal(r.status, 'error');
    assert.match(String(r.error), /blocked/);
  });
  it('detects cycles', () => {
    const cyc = detectCycle(
      [N('A', 'n8n-nodes-base.noOp'), N('B', 'n8n-nodes-base.noOp')],
      { A: { main: [[{ node: 'B' }]] }, B: { main: [[{ node: 'A' }]] } } as any,
    );
    assert.ok(cyc && /cycle/i.test(cyc));
    const ok = detectCycle(
      [N('A', 'n8n-nodes-base.noOp'), N('B', 'n8n-nodes-base.noOp')],
      { A: { main: [[{ node: 'B' }]] } } as any,
    );
    assert.equal(ok, null);
  });
  it('parses cron intervals', () => {
    assert.equal(cronIntervalMs(N('C', 'n8n-nodes-base.cron', { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } }) as any), 24 * 3600_000);
    assert.equal(cronIntervalMs(N('C', 'n8n-nodes-base.cron', { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }) as any), 5 * 60_000);
    assert.equal(cronIntervalMs(N('C', 'n8n-nodes-base.cron', { cronExpression: '*/5 * * * *' }) as any), 5 * 60_000);
    assert.equal(cronIntervalMs(N('C', 'n8n-nodes-base.cron', {}) as any), null);
  });
  it('marks unknown node types skipped, still passing data through (B4)', async () => {
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('X', 'custom.future'), N('End', 'n8n-nodes-base.noOp', {})],
      connections: { Start: { main: [[{ node: 'X' }]] }, X: { main: [[{ node: 'End' }]] } } as any,
    }, { a: 1 });
    assert.equal(r.status, 'success');
    const run = r.nodeRuns.find((x) => x.node === 'X')!;
    assert.equal(run.status, 'skipped');
    assert.match(String(run.error), /unknown node type/);
    assert.deepEqual((r.output as any).a, 1);
  });
  it('does not auto-forward input as http body (m3)', async () => {
    let seenBody: string | null | undefined = 'unset';
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      seenBody = init?.body;
      return { status: 200, ok: true, text: async () => '{"ok":true}', headers: new Map() } as any;
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'https://api.example.com/x', method: 'POST' })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, { secret: 'should-not-send' });
      assert.equal(r.status, 'success');
      assert.equal(seenBody, undefined);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
  it('blocks redirect hops onto internal hosts (B3)', async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      if (String(url).includes('api.example.com')) {
        return { status: 302, ok: false, text: async () => '', headers: new Map([['location', 'http://169.254.169.254/latest']]), arrayBuffer: async () => new ArrayBuffer(0) } as any;
      }
      throw new Error('must not fetch internal');
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'https://api.example.com/go', method: 'GET' })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, {});
      assert.equal(r.status, 'error');
      assert.match(String(r.error), /blocked internal/);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
  it('follows safe redirects hop-by-hop', async () => {
    const orig = globalThis.fetch;
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: any) => {
      seen.push(String(url));
      if (String(url).endsWith('/go')) {
        return { status: 301, ok: false, text: async () => '', headers: new Map([['location', '/done']]), arrayBuffer: async () => new ArrayBuffer(0) } as any;
      }
      return { status: 200, ok: true, text: async () => '{"ok":true}', headers: new Map() } as any;
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'https://api.example.com/go', method: 'GET' })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, {});
      assert.equal(r.status, 'success');
      assert.deepEqual(seen, ['https://api.example.com/go', 'https://api.example.com/done']);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
  it('keeps user _logs key, stashing console output aside (m3)', async () => {
    const out: any = await execCodeSandbox(
      N('C', 'n8n-nodes-base.code', { code: 'console.log("hi"); return { _logs: ["mine"] };' }) as any, {},
    );
    assert.deepEqual(out._logs, undefined);
    assert.deepEqual(out.value._logs, ['mine']);
    assert.deepEqual(out._consoleLogs, ['hi']);
  });
  it('diamond fan-out runs the join once per incoming edge (documented)', async () => {
    const r = await runWorkflow({
      nodes: [
        N('Start', 'n8n-nodes-base.manualTrigger'),
        N('B', 'n8n-nodes-base.set', { values: { side: 'b' } }),
        N('C', 'n8n-nodes-base.set', { values: { side: 'c' } }),
        N('Join', 'n8n-nodes-base.noOp', {}),
      ],
      connections: {
        Start: { main: [[{ node: 'B' }], [{ node: 'C' }]] },
        B: { main: [[{ node: 'Join' }]] },
        C: { main: [[{ node: 'Join' }]] },
      } as any,
    }, { v: 1 });
    assert.equal(r.status, 'success');
    assert.equal(r.nodeRuns.filter((x) => x.node === 'Join').length, 2);
    // Multi-terminal outputs are keyed by terminal node name (M9) — here a
    // single terminal, so the last Join write wins.
    assert.ok(['b', 'c'].includes((r.output as any).side));
  });
});

describe('engine: validateCronParams (M8)', () => {
  it('rejects sub-10s intervals and bad expressions', () => {
    assert.match(validateCronParams({ rule: { interval: [{ field: 'seconds', secondsInterval: 5 }] } })!, /10s/);
    assert.match(validateCronParams({ cronExpression: '*/7 1,2 * * 1' })!, /unsupported/);
    assert.match(validateCronParams({ cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' })!, /timezone/);
    assert.equal(validateCronParams({ rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } }), null);
    assert.equal(validateCronParams({ cronExpression: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh' }), null);
    assert.equal(validateCronParams({}), null);
  });
  it('keys multi-terminal outputs by node name (M9)', async () => {
    const r = await runWorkflow({
      nodes: [
        N('Start', 'n8n-nodes-base.manualTrigger'),
        N('Left', 'n8n-nodes-base.set', { values: { tag: 'left' } }),
        N('Right', 'n8n-nodes-base.set', { values: { tag: 'right' } }),
      ],
      connections: { Start: { main: [[{ node: 'Left' }], [{ node: 'Right' }]] } } as any,
    }, { v: 1 });
    assert.equal(r.status, 'success');
    assert.equal((r.output as any).Left.tag, 'left');
    assert.equal((r.output as any).Right.tag, 'right');
  });
  it('computes wall-clock next runs with timezones (P2)', () => {
    // 2026-10-15T18:30:00Z = 01:30 +07:00 next day. "30 9 * * *" in
    // Asia/Ho_Chi_Minh fires 09:30+07 = 02:30Z same UTC date.
    const from = Date.UTC(2026, 9, 15, 18, 30, 0);
    const next = cronNextRunAt({ cronExpression: '30 9 * * *', timezone: 'Asia/Ho_Chi_Minh' }, from)!;
    assert.equal(new Date(next).toISOString(), '2026-10-16T02:30:00.000Z');
    const utc = cronNextRunAt({ cronExpression: '0 9 * * *' }, from)!;
    assert.equal(new Date(utc).toISOString(), '2026-10-16T09:00:00.000Z');
    assert.equal(cronNextRunAt({ cronExpression: '*/5 * * * *' }, from), null);
    assert.equal(cronNextRunAt({}, from), null);
  });
});

describe('engine: disabled, retry, onError, credentials, principal (P0/P2)', () => {
  it('skips disabled nodes but keeps data flowing (P2)', async () => {
    const r = await runWorkflow({
      nodes: [
        N('Start', 'n8n-nodes-base.manualTrigger'),
        { ...N('Skip', 'n8n-nodes-base.set', { values: { tag: 'x' } }), disabled: true },
        N('End', 'n8n-nodes-base.noOp', {}),
      ],
      connections: { Start: { main: [[{ node: 'Skip' }]] }, Skip: { main: [[{ node: 'End' }]] } } as any,
    }, { v: 1 });
    assert.equal(r.status, 'success');
    const run = r.nodeRuns.find((x) => x.node === 'Skip')!;
    assert.equal(run.status, 'skipped');
    assert.match(String(run.error), /disabled/);
    assert.equal((r.output as any).v, 1);
  });
  it('retries failing http nodes per parameters.retry (P2)', async () => {
    let calls = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls < 3) return { status: 500, ok: false, text: async () => 'boom', headers: new Map() } as any;
      return { status: 200, ok: true, text: async () => '{"ok":true}', headers: new Map() } as any;
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'https://api.example.com/x', method: 'GET', retry: { attempts: 3, delayMs: 1 } })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, {});
      assert.equal(r.status, 'success');
      assert.equal(calls, 3);
      assert.equal(r.nodeRuns.find((x) => x.node === 'H')!.attempts, 3);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
  it('continues past failures with settings.onError=continue (P2)', async () => {
    const r = await runWorkflow({
      nodes: [
        N('Start', 'n8n-nodes-base.manualTrigger'),
        N('Bad', 'n8n-nodes-base.code', { code: 'throw new Error("kaput")' }),
        N('End', 'n8n-nodes-base.set', { values: { tag: 'end' } }),
      ],
      connections: { Start: { main: [[{ node: 'Bad' }]] }, Bad: { main: [[{ node: 'End' }]] } } as any,
      settings: { onError: 'continue' },
    }, {});
    assert.equal(r.status, 'success');
    assert.ok((r.partialErrors || []).some((m) => /kaput/.test(m)));
    assert.equal((r.output as any).tag, 'end');
  });
  it('resolves httpRequest auth via credentialResolver, never logging secrets (P0-4)', async () => {
    let seenAuth: string | undefined;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      seenAuth = init?.headers?.Authorization;
      return { status: 200, ok: true, text: async () => '{"ok":true}', headers: new Map() } as any;
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'https://api.example.com/x', method: 'GET', auth: { credentialId: 'cred-1' } })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, {}, { credentialResolver: async (id) => (id === 'cred-1' ? { kind: 'bearer', secret: 's3cr3t' } : null) });
      assert.equal(r.status, 'success');
      assert.equal(seenAuth, 'Bearer s3cr3t');
      const dump = JSON.stringify(r.nodeRuns);
      assert.ok(!dump.includes('s3cr3t'), 'secret must not appear in nodeRuns');
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
  it('propagates the principal downstream on self calls (P0-3)', async () => {
    process.env.SYNAPSEDX_SELF_BASE_URLS = 'http://gateway:8080';
    let seen: any = {};
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      seen = init?.headers || {};
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() } as any;
    };
    try {
      const r = await runWorkflow({
        nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('H', 'n8n-nodes-base.httpRequest', { url: 'http://gateway:8080/v1/orgs', method: 'GET' })],
        connections: { Start: { main: [[{ node: 'H' }]] } } as any,
      }, {}, { principal: { sub: 'u1', org: 'acme', account: 'prod', kind: 'user' } });
      assert.equal(r.status, 'success');
      assert.equal(seen['X-SynapseDX-User'], 'u1');
      assert.equal(seen['X-SynapseDX-Org'], 'acme');
    } finally {
      (globalThis as any).fetch = orig;
      delete process.env.SYNAPSEDX_SELF_BASE_URLS;
    }
  });
  it('builds audit actors (P0-2)', async () => {
    const { actorFor } = await import('./engine');
    assert.equal(actorFor('w1', { sub: 'u9' }), 'workflow:w1 principal:u9');
    assert.equal(actorFor('w1', null), 'workflow:w1 principal:anonymous');
  });
});
