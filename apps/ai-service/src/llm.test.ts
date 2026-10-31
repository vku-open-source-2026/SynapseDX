/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0;
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatComplete, chatJson, LlmError } from './llm';

const cfg = { baseUrl: 'http://x', apiKey: 'k', model: 'm', retries: 1 };
const call = { system: 's', user: 'u', maxTokens: 64 };
const realFetch = globalThis.fetch;

function stubFetch(responder: () => { status: number; json: unknown }) {
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    const r = responder();
    return new Response(JSON.stringify(r.json), { status: r.status });
  };
  return () => calls;
}

beforeEach(() => undefined);
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ok = (content: string) => ({ status: 200, json: { choices: [{ message: { content } }] } });

describe('chatComplete retry', () => {
  it('returns content on first try', async () => {
    const calls = stubFetch(() => ok('hi'));
    assert.equal(await chatComplete(cfg, call), 'hi');
    assert.equal(calls(), 1);
  });

  it('retries once after empty content, then succeeds', async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? ok('') : ok('hi')));
    assert.equal(await chatComplete(cfg, call), 'hi');
    assert.equal(calls(), 2);
  });

  it('throws after all attempts return empty content', async () => {
    const calls = stubFetch(() => ok(''));
    await assert.rejects(() => chatComplete(cfg, call), (e: LlmError) => e.message === 'LLM returned no content');
    assert.equal(calls(), 2);
  });

  it('does not retry on 400 (bad key / unknown model)', async () => {
    const calls = stubFetch(() => ({ status: 400, json: { error: { message: 'bad' } } }));
    await assert.rejects(() => chatComplete(cfg, call), (e: LlmError) => e.status === 400);
    assert.equal(calls(), 1);
  });

  it('retries on 500', async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? { status: 500, json: {} } : ok('hi')));
    assert.equal(await chatComplete(cfg, call), 'hi');
    assert.equal(calls(), 2);
  });
});

describe('chatJson retry', () => {
  it('retries once after malformed JSON, then parses', async () => {
    let n = 0;
    const calls = stubFetch(() => (++n === 1 ? ok('not json {{{') : ok('{"a":1}')));
    assert.deepEqual(await chatJson(cfg, call), { a: 1 });
    assert.equal(calls(), 2);
  });

  it('throws after all attempts return malformed JSON', async () => {
    const calls = stubFetch(() => ok('nope'));
    await assert.rejects(() => chatJson(cfg, call), (e: LlmError) => e.message === 'LLM did not return valid JSON');
    assert.equal(calls(), 2);
  });
});

describe('response size cap', () => {
  it('drops over-cap responses before parsing', async () => {
    (globalThis as any).fetch = async () =>
      new Response('x'.repeat(300 * 1024), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await assert.rejects(() => chatComplete(cfg, call), (e: LlmError) => /exceeds|declares/.test(e.message));
  });
});
