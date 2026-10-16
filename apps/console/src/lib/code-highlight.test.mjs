/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Offline tests for the dependency-free JS highlighter (pure logic, no DOM).
// Run: node --test src/lib/*.test.mjs (Node 18+).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highlightJS, checkJSSyntax, hasTopReturn, looksLikeStatements } from './code-highlight.js';

describe('highlightJS', () => {
  it('paints keywords, strings, numbers, comments and $vars', () => {
    const html = highlightJS('return { doubled: ($input.value ?? 0) * 2 }; // done');
    assert.ok(html.includes('color:#7c3aed'), 'keyword style');
    assert.ok(html.includes('$input') && html.includes('color:#0284c7'), '$var style');
    assert.ok(html.includes('color:#b45309'), 'number style');
    assert.ok(html.includes('color:#94a3b8'), 'comment style');
  });
  it('escapes HTML so code cannot break out', () => {
    const html = highlightJS('return "<script>alert(1)</script>";');
    assert.ok(!html.includes('<script>'), 'raw tag must not appear');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped tag present');
  });
  it('highlights ${} inside template literals', () => {
    const html = highlightJS('return `hello ${$input.name}!`;');
    assert.ok(html.includes('$input'), 'interpolated $var painted');
    assert.ok(html.includes('color:#047857'), 'template string style');
  });
  it('handles empty and unterminated input without throwing', () => {
    assert.equal(highlightJS(''), '');
    assert.ok(highlightJS('const x = "oops').length > 0);
    assert.ok(highlightJS('/* never closed').includes('color:#94a3b8'));
  });
});

describe('checkJSSyntax', () => {
  it('accepts valid transform code and bare expressions', () => {
    assert.equal(checkJSSyntax('return { a: 1 };').ok, true);
    assert.equal(checkJSSyntax('({ a: 1 })').ok, true);
    assert.equal(checkJSSyntax('').ok, true);
  });
  it('reports syntax errors with a message', () => {
    const r = checkJSSyntax('return { a: ;');
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  });
  it('return/statement heuristics match the engine', () => {
    assert.equal(hasTopReturn('return 1'), true);
    assert.equal(hasTopReturn('({a:1})'), false);
    assert.equal(looksLikeStatements('while(true){}'), true);
    assert.equal(looksLikeStatements('({a:1})'), false);
  });
});
