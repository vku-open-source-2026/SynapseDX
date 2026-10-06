/*
 * Copyright 2026 danax Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, listTemplates } from './index';

describe('workflow templates', () => {
  it('lists 3 built-in templates', () => {
    assert.equal(listTemplates().length, 3);
  });
  it('builds known templates', () => {
    for (const t of listTemplates()) {
      const def: any = buildTemplate(t.name, 'demo');
      assert.ok(def.nodes.length >= 2, t.name);
      assert.ok(def.connections, t.name);
    }
  });
  it('unknown template returns null', () => {
    assert.equal(buildTemplate('nope'), null);
  });
});
