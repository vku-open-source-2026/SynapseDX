/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0;
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, pathParams, AgentError } from './agent';
import { AgentConfig } from './agent';
import { ChatFn, LlmConfig, LlmError } from './llm';

const cfg: AgentConfig = {
  decision: { baseUrl: 'http://x', apiKey: 'k', model: 'decide' },
  llm: { baseUrl: 'http://x', apiKey: 'k', model: 'gen' },
};

/** Fake chat: route by system prompt (decision vs generate). */
function fakeChat(
  decide: Record<string, unknown>,
  generate: Record<string, unknown>,
) {
  return async (_c: LlmConfig, call: { system: string }) =>
    call.system.includes('routing decision model') ? decide : generate;
}

describe('pathParams', () => {
  it('extracts :params from a path template', () => {
    assert.deepEqual(pathParams('/v1/orgs/:orgId/accounts'), ['orgId']);
    assert.deepEqual(pathParams('/v1/orgs'), []);
    assert.deepEqual(pathParams('/v1/workflows/:id/execute'), ['id']);
  });
});

describe('runAgent', () => {
  it('picks a bodyless GET endpoint and skips body', async () => {
    const r = await runAgent(
      'list all organizations',
      cfg,
      fakeChat(
        { method: 'GET', path: '/v1/orgs', reason: 'lists orgs' },
        { pathValues: {}, body: {}, explanation: 'Gọi danh sách org' },
      ),
    );
    assert.equal(r.ok, true);
    assert.equal(r.method, 'GET');
    assert.equal(r.path, '/v1/orgs');
    assert.deepEqual(r.pathValues, {});
    assert.equal('body' in r, false, 'GET without body schema must not carry body');
    assert.ok(r.explanation.length > 0);
  });

  it('fills path params for a nested endpoint', async () => {
    const r = await runAgent(
      'create a production account in org acme',
      cfg,
      fakeChat(
        { method: 'POST', path: '/v1/orgs/:orgId/accounts', reason: 'creates account' },
        {
          pathValues: { orgId: 'acme' },
          body: { slug: 'prod', displayName: 'Production' },
          explanation: 'Tạo account prod trong org acme',
        },
      ),
    );
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/v1/orgs/:orgId/accounts');
    assert.deepEqual(r.pathValues, { orgId: 'acme' });
    assert.deepEqual(r.body, { slug: 'prod', displayName: 'Production' });
  });

  it('rejects a question that is empty or too long', async () => {
    await assert.rejects(() => runAgent('   ', cfg, fakeChat({}, {})), (e: AgentError) => e.code === 'invalid_question');
    await assert.rejects(() => runAgent('x'.repeat(2001), cfg, fakeChat({}, {})), (e: AgentError) => e.code === 'invalid_question');
  });

  it('rejects when the decision model picks an unknown endpoint', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'do something weird',
          cfg,
          fakeChat({ method: 'GET', path: '/v1/nope', reason: 'nope' }, {}),
        ),
      (e: AgentError) => e.code === 'endpoint_not_found',
    );
  });

  it('rejects pathValues keys that are not path params', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'list accounts',
          cfg,
          fakeChat(
            { method: 'GET', path: '/v1/orgs', reason: 'x' },
            { pathValues: { evil: 'x' }, body: {}, explanation: 'x' },
          ),
        ),
      (e: AgentError) => e.code === 'invalid_output',
    );
  });

  it('rejects a non-object body', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'create org',
          cfg,
          fakeChat(
            { method: 'POST', path: '/v1/orgs', reason: 'x' },
            { pathValues: {}, body: 'not-an-object', explanation: 'x' },
          ),
        ),
      (e: AgentError) => e.code === 'invalid_output',
    );
  });

  it('rejects pathValues with an empty value', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'get template',
          cfg,
          fakeChat(
            { method: 'GET', path: '/v1/templates/:name', reason: 'x' },
            { pathValues: { name: '' }, body: {}, explanation: 'x' },
          ),
        ),
      (e: AgentError) => e.code === 'invalid_output',
    );
  });

  it('answers how-to questions with guidance (no endpoint picked)', async () => {
    const r = await runAgent(
      'mấy api này xài sao ta',
      cfg,
      fakeChat({ method: null, path: null, reason: 'no single endpoint fits' }, {}),
      async () => 'Gọi GET /v1/orgs trước, rồi …',
    );
    assert.equal(r.ok, true);
    assert.equal(r.method, '');
    assert.equal(r.path, '');
    assert.ok((r.guidance || '').includes('/v1/orgs'));
  });

  it('rejects when the guide model returns an empty answer', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'how do I…',
          cfg,
          fakeChat({ method: null, path: null, reason: 'x' }, {}),
          async () => '   ',
        ),
      (e: AgentError) => e.code === 'invalid_output',
    );
  });
});

describe('runAgent hardening', () => {
  it('rejects when a required path param is missing', async () => {
    await assert.rejects(
      () =>
        runAgent(
          'list accounts',
          cfg,
          fakeChat(
            { method: 'GET', path: '/v1/orgs/:orgId/accounts', reason: 'x' },
            { pathValues: {}, body: {}, explanation: 'x' },
          ),
        ),
      (e: AgentError) => e.code === 'invalid_output',
    );
  });

  it('matches endpoints ignoring query strings', async () => {
    const r = await runAgent(
      'start sso',
      cfg,
      fakeChat(
        { method: 'GET', path: '/v1/auth/oidc/start', reason: 'sso' },
        { pathValues: {}, body: {}, explanation: 'Bắt đầu SSO' },
      ),
    );
    assert.equal(r.method, 'GET');
    assert.ok(r.path.startsWith('/v1/auth/oidc/start'));
  });

  it('drops non-string explanations instead of [object Object]', async () => {
    const r = await runAgent(
      'list orgs',
      cfg,
      fakeChat(
        { method: 'GET', path: '/v1/orgs', reason: 'x' },
        { pathValues: {}, body: {}, explanation: { nope: 1 } },
      ),
    );
    assert.equal(r.explanation, '');
  });

  it('falls back to a second provider when the primary generate fails', async () => {
    const seen: string[] = [];
    const flaky: ChatFn = async (c, call) => {
      if (call.system.includes('routing decision model')) return { method: 'GET', path: '/v1/orgs', reason: 'x' };
      seen.push(c.model);
      if (c.model !== 'fallback') throw new LlmError(502, 'LLM returned no content');
      return { pathValues: {}, body: {}, explanation: 'via fallback' };
    };
    const r = await runAgent(
      'list orgs',
      { ...cfg, llmFallback: { baseUrl: 'http://x', apiKey: 'k', model: 'fallback' } },
      flaky,
    );
    assert.deepEqual(seen, ['gen', 'fallback']);
    assert.equal(r.explanation, 'via fallback');
  });

  it('without fallback the primary error propagates', async () => {
    const down: ChatFn = async (_c, call) => {
      if (call.system.includes('routing decision model')) return { method: 'GET', path: '/v1/orgs', reason: 'x' };
      throw new LlmError(502, 'down');
    };
    await assert.rejects(() => runAgent('list orgs', cfg, down), /down/);
  });
});

describe('conversation history', () => {
  it('injects prior turns into the decision prompt', async () => {
    let seenUser = '';
    const spy: ChatFn = async (_c, call) => {
      if (call.system.includes('routing decision model')) {
        seenUser = call.user;
        return { method: 'GET', path: '/v1/orgs', reason: 'x' };
      }
      return { pathValues: {}, body: {}, explanation: 'x' };
    };
    const hist = [
      { role: 'user', text: 'cho tôi xem org acme' },
      { role: 'ai', text: 'Đã liệt kê org.' },
    ];
    await runAgent('còn account của nó thì sao', cfg, spy, async () => '{}', hist as any);
    assert.ok(seenUser.includes('cho tôi xem org acme'), 'prior user turn present');
    assert.ok(seenUser.includes('còn account của nó thì sao'), 'current question present');
  });

  it('works without history (backwards compatible)', async () => {
    const r = await runAgent(
      'list orgs',
      cfg,
      fakeChat({ method: 'GET', path: '/v1/orgs', reason: 'x' }, { pathValues: {}, body: {}, explanation: 'x' }),
    );
    assert.equal(r.path, '/v1/orgs');
  });
});

describe('decision fallback', () => {
  it('falls back to the LLM model when the decision model fails', async () => {
    const seen: string[] = [];
    const flaky: ChatFn = async (c, call) => {
      if (!call.system.includes('routing decision model')) return { pathValues: {}, body: {}, explanation: 'x' };
      seen.push(c.model);
      if (c.model !== 'gen') throw new LlmError(502, 'decide down');
      return { method: 'GET', path: '/v1/orgs', reason: 'via fallback' };
    };
    const r = await runAgent('list orgs', cfg, flaky);
    assert.deepEqual(seen, ['decide', 'gen']);
    assert.equal(r.reason, 'via fallback');
  });

  it('skips fallback when both models are the same', async () => {
    const same = { ...cfg, llm: { baseUrl: 'http://x', apiKey: 'k', model: 'decide' } };
    const seen: string[] = [];
    const flaky: ChatFn = async (c, call) => {
      if (!call.system.includes('routing decision model')) return { pathValues: {}, body: {}, explanation: 'x' };
      seen.push(c.model);
      throw new LlmError(502, 'down');
    };
    await assert.rejects(() => runAgent('list orgs', same, flaky), /down/);
    assert.deepEqual(seen, ['decide']);
  });
});
