/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Engine unit tests: sandbox, set/if/http guards, DAG, cron.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, detectCycle, cronIntervalMs, execCodeSandbox, validateCronParams, cronNextRunAt, validateSynapseDXParams, isBlockedUrl, assertUrlAllowed } from './engine';

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
  it('runs workflow with native node types (no n8n-nodes-base prefix)', async () => {
    const def = {
      nodes: [
        N('Start', 'manualTrigger'),
        N('SetData', 'set', { values: { x: 5 } }),
        N('Double', 'code', { code: 'return { result: $input.x * 2 };' }),
        N('Pass', 'noOp'),
      ],
      connections: {
        Start: { main: [[{ node: 'SetData' }]] },
        SetData: { main: [[{ node: 'Double' }]] },
        Double: { main: [[{ node: 'Pass' }]] },
      } as any,
    };
    const r = await runWorkflow(def, {});
    assert.equal(r.status, 'success');
    assert.equal((r.output as any).result, 10);
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
  it('blocks host-constructor escapes via host intrinsics (RCE regression, #4)', async () => {
    // These payloads worked before the fix because host Math/Object/console
    // were passed into the vm context, making codeGeneration:false useless.
    const payloads = [
      "return { pid: Math.constructor.constructor('return process')().pid };",
      "return Object.constructor('return process')().env;",
      "return (1).constructor.constructor('return process')().env;",
      "return console.log.constructor('return process')().env;",
      "return (async () => {}).constructor('return process')().env;",
    ];
    for (const code of payloads) {
      await assert.rejects(execCodeSandbox(N('C', 'n8n-nodes-base.code', { code }) as any, {}), /code:/, code);
    }
  });
  it('exposes no process/require/module/global escape hatch inside code nodes', async () => {
    const out: any = await execCodeSandbox(N('C', 'n8n-nodes-base.code', {
      code: 'return { process: typeof process, require: typeof require, module: typeof module, global: typeof globalThis.process, env: typeof process === "undefined" ? 0 : Object.keys(process.env).length };',
    }) as any, {});
    assert.equal(out.process, 'undefined');
    assert.equal(out.require, 'undefined');
    assert.equal(out.module, 'undefined');
    assert.equal(out.global, 'undefined');
    assert.equal(out.env, 0);
  });
  it('kills never-settling async code instead of hanging the service (#4)', async () => {
    const started = Date.now();
    const r = await runWorkflow({
      nodes: [N('Start', 'n8n-nodes-base.manualTrigger'), N('C', 'n8n-nodes-base.code', { code: 'await new Promise(() => {});', timeoutMs: 1000 })],
      connections: { Start: { main: [[{ node: 'C' }]] } } as any,
    }, {});
    assert.equal(r.status, 'error');
    assert.match(String(r.error), /timed out/);
    assert.ok(Date.now() - started < 8000, 'sandbox timeout must be enforced by the parent');
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
  it('blocks IPv4-mapped IPv6 and other private/reserved literals (SSRF #11)', () => {
    const blocked = [
      'http://[::ffff:127.0.0.1]:8080/',
      'http://[::ffff:7f00:1]:8080/',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://172.20.1.1/',
      'http://192.168.1.1/',
      'http://100.100.100.200/',
      'http://2130706433/',   // decimal 127.0.0.1
      'http://0x7f000001/',   // hex 127.0.0.1
      'http://localhost/',
      'http://postgres:5432/',
    ];
    for (const url of blocked) assert.equal(isBlockedUrl(url), true, url);
    const allowed = [
      'https://example.com/',
      'http://93.184.216.34/',
      'http://[2606:4700::1111]/',
    ];
    for (const url of allowed) assert.equal(isBlockedUrl(url), false, url);
  });
  it('blocks public names that resolve to private address space (rebinding, #11)', async () => {
    await assert.rejects(assertUrlAllowed('https://rebind.example/', async () => ['10.1.2.3']), /blocked internal URL/);
    await assert.rejects(assertUrlAllowed('https://rebind.example/', async () => ['93.184.216.34', '169.254.169.254']), /blocked internal URL/);
    await assert.rejects(assertUrlAllowed('https://rebind.example/', async () => ['::ffff:127.0.0.1']), /blocked internal URL/);
    await assert.rejects(assertUrlAllowed('https://rebind.example/', async () => ['/tmp/socket']), /blocked internal URL/);
    await assert.doesNotReject(assertUrlAllowed('https://public.example/', async () => ['93.184.216.34']));
    // Unresolvable names pass the guard and simply fail at fetch time.
    await assert.doesNotReject(assertUrlAllowed('https://nxdomain.example/', async () => { throw new Error('ENOTFOUND'); }));
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

describe('engine: synapsedx.api first-party block', () => {
  const apiNode = (parameters: any) => ({ name: 'S', type: 'synapsedx.api', parameters });
  const defOf = (parameters: any) => ({
    nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, apiNode(parameters)],
    connections: { Start: { main: [[{ node: 'S' }]] } } as any,
  });
  it('calls the wired caller with templated args', async () => {
    let seen: any = null;
    const r = await runWorkflow(defOf({ resource: 'users', operation: 'list', input: { orgId: '={{ $json.org }}' } }), { org: 'acme' }, {
      synapsedxCall: async (resource, operation, args, principal) => {
        seen = { resource, operation, args, principal };
        return [{ email: 'a@x' }];
      },
      principal: { sub: 'u1' },
    });
    assert.equal(r.status, 'success');
    assert.deepEqual(seen, { resource: 'users', operation: 'list', args: { orgId: 'acme' }, principal: { sub: 'u1' } });
    assert.deepEqual(r.output, [{ email: 'a@x' }]);
  });
  it('rejects unknown resource/operation and missing required args', async () => {
    assert.match(validateSynapseDXParams({ resource: 'nope', operation: 'list' }) || '', /unknown resource/);
    assert.match(validateSynapseDXParams({ resource: 'orgs', operation: 'delete' }) || '', /unknown operation/);
    assert.match(validateSynapseDXParams({}) || '', /'resource' is required/);
    const noCall = runWorkflow(defOf({ resource: 'orgs', operation: 'list', input: {} }), {});
    assert.match((await noCall).error || '', /does not expose a SynapseDX caller/);
    const missing = await runWorkflow(defOf({ resource: 'users', operation: 'list', input: {} }), {}, {
      synapsedxCall: async () => { throw new Error('must not be called'); },
    });
    assert.equal(missing.status, 'error');
    assert.match(missing.error || '', /needs 'orgId'/);
  });
  it('validates required args at save time too (templates are allowed)', () => {
    assert.match(validateSynapseDXParams({ resource: 'lds', operation: 'publish-record', input: {} }) || '', /needs 'datasourceId'/);
    assert.match(validateSynapseDXParams({ resource: 'lds', operation: 'publish-record', input: { datasourceId: '  ' } }) || '', /needs 'datasourceId'/);
    assert.equal(
      validateSynapseDXParams({ resource: 'lds', operation: 'publish-record', input: { datasourceId: '={{ $json.datasourceId }}', record: '={{ $json }}' } }),
      null,
    );
    assert.equal(validateSynapseDXParams({ resource: 'orgs', operation: 'list', input: {} }), null);
  });
  it('supports the lds.publish-record resource with templated args (SynapseLDS)', async () => {
    let seen: any = null;
    const input = { ds: 'ds-1', id: '55001', name: 'ACME' };
    const r = await runWorkflow(
      defOf({ resource: 'lds', operation: 'publish-record', input: { datasourceId: '={{ $json.ds }}', record: '={{ $json }}' } }),
      input,
      { synapsedxCall: async (resource, operation, args) => { seen = { resource, operation, args }; return { ingested: 1, created: 1 }; } },
    );
    assert.equal(r.status, 'success');
    assert.equal(seen.resource, 'lds');
    assert.equal(seen.operation, 'publish-record');
    assert.equal(seen.args.datasourceId, 'ds-1');
    // a full-object template passes the whole payload through as the record
    assert.deepEqual(seen.args.record, input);
    assert.deepEqual(r.output, { ingested: 1, created: 1 });
    // datasourceId stays required at run time
    const missing = await runWorkflow(defOf({ resource: 'lds', operation: 'publish-record', input: { record: '={{ $json }}' } }), input, {
      synapsedxCall: async () => { throw new Error('must not be called'); },
    });
    assert.equal(missing.status, 'error');
    assert.match(missing.error || '', /needs 'datasourceId'/);
    // list-datasources needs no args
    const list = await runWorkflow(defOf({ resource: 'lds', operation: 'list-datasources', input: {} }), {}, {
      synapsedxCall: async () => ([{ id: 'ds-1', license: 'CC-BY-4.0' }]),
    });
    assert.equal(list.status, 'success');
  });
  it('caps oversized responses', async () => {
    const r = await runWorkflow(defOf({ resource: 'orgs', operation: 'list', input: {} }), {}, {
      synapsedxCall: async () => ({ s: 'x'.repeat(600 * 1024) }),
    });
    assert.equal(r.status, 'error');
    assert.match(r.error || '', /exceeds 500KB/);
  });
  it('supports base, faststore, queue and inference sub-services', async () => {
    const calls: any[] = [];
    const mockCall = async (resource: string, operation: string, args: any) => {
      calls.push({ resource, operation, args });
      return { ok: true, resource, operation };
    };

    // Base query
    const rBase = await runWorkflow(
      defOf({ resource: 'base', operation: 'query-documents', input: { collection: 'products', filter: { active: true } } }),
      {},
      { synapsedxCall: mockCall }
    );
    assert.equal(rBase.status, 'success');

    // Faststore set
    const rFs = await runWorkflow(
      defOf({ resource: 'faststore', operation: 'set', input: { key: 'user:123', value: 'active', ttlSeconds: 300 } }),
      {},
      { synapsedxCall: mockCall }
    );
    assert.equal(rFs.status, 'success');

    // Queue publish
    const rQ = await runWorkflow(
      defOf({ resource: 'queue', operation: 'publish', input: { queue: 'tasks', payload: { id: 1 } } }),
      {},
      { synapsedxCall: mockCall }
    );
    assert.equal(rQ.status, 'success');

    // Inference route
    const rInf = await runWorkflow(
      defOf({ resource: 'inference', operation: 'route', input: { input: 'hello', choices: { a: 'A', b: 'B' } } }),
      {},
      { synapsedxCall: mockCall }
    );
    assert.equal(rInf.status, 'success');

    assert.equal(calls.length, 4);
    assert.equal(calls[0].resource, 'base');
    assert.equal(calls[1].resource, 'faststore');
    assert.equal(calls[2].resource, 'queue');
    assert.equal(calls[3].resource, 'inference');
  });
});

describe('engine: SynapseFlow Decision & AI Agent', () => {
  it('routes multi-branch execution with synapseflow.decision', async () => {
    const def = {
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        {
          name: 'Decider',
          type: 'synapseflow.decision',
          parameters: {
            input: '={{ $json.query }}',
            choices: ['billing', 'support', 'technical'],
            instruction: 'Classify user query into routing branch',
          },
        },
        { name: 'Branch0', type: 'set', parameters: { values: { department: 'billing' } } },
        { name: 'Branch1', type: 'set', parameters: { values: { department: 'support' } } },
        { name: 'Branch2', type: 'set', parameters: { values: { department: 'technical' } } },
      ],
      connections: {
        Start: { main: [[{ node: 'Decider' }]] },
        Decider: {
          main: [
            [{ node: 'Branch0' }],
            [{ node: 'Branch1' }],
            [{ node: 'Branch2' }],
          ],
        },
      } as any,
    };

    // Test with synapsedxCall routing to 'support' (index 1)
    const res = await runWorkflow(def, { query: 'I need customer support' }, {
      synapsedxCall: async (resource, operation, args) => {
        if (resource === 'inference' && operation === 'route') {
          return { best_choice: 'support', confidence: 0.98, probabilities: { support: 0.98, billing: 0.01, technical: 0.01 } };
        }
        throw new Error('unexpected call');
      },
    });

    assert.equal(res.status, 'success');
    assert.equal(res.output.department, 'support');
    assert.equal(res.output.decision.branch, 1);
    assert.equal(res.output.decision.route, 'support');
  });

  it('runs synapseflow.aiAgent with tool calling and data logic', async () => {
    const def = {
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        {
          name: 'Agent',
          type: 'synapseflow.aiAgent',
          parameters: {
            core: 'synapse-inference',
            userPrompt: 'Calculate revenue and save to faststore',
            tools: ['logic_calculator', 'code_sandbox', 'faststore_cache'],
          },
        },
      ],
      connections: {
        Start: { main: [[{ node: 'Agent' }]] },
      } as any,
    };

    let faststoreSetArgs: any = null;
    let chatCalls = 0;

    const res = await runWorkflow(def, { initial: true }, {
      synapsedxCall: async (resource, operation, args) => {
        if (resource === 'inference' && operation === 'chat') {
          chatCalls++;
          if (chatCalls === 1) {
            // First LLM turn requests tool execution: logic_calculator
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'logic_calculator',
                      arguments: JSON.stringify({ expression: '25 * 40' }),
                    },
                  }],
                },
              }],
            };
          } else if (chatCalls === 2) {
            // Second turn requests faststore_cache
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'faststore_cache',
                      arguments: JSON.stringify({ action: 'set', key: 'revenue', value: 1000 }),
                    },
                  }],
                },
              }],
            };
          } else {
            // Final LLM turn returns natural response
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Calculated total revenue is $1000, and it has been stored in faststore.',
                },
              }],
            };
          }
        }
        if (resource === 'faststore' && operation === 'set') {
          faststoreSetArgs = args;
          return { ok: true, created: true };
        }
        throw new Error(`Unexpected synapsedxCall: ${resource}.${operation}`);
      },
    });

    assert.equal(res.status, 'success');
    assert.equal(chatCalls, 3);
    assert.deepEqual(faststoreSetArgs, { key: 'revenue', value: 1000, ttlSeconds: 3600 });
    assert.match(res.output.agent.response, /Calculated total revenue is \$1000/);
    assert.equal(res.output.agent.steps_count, 2);
    assert.equal(res.output.agent.tools_used[0], 'logic_calculator');
    assert.equal(res.output.agent.tools_used[1], 'faststore_cache');
  });
});
