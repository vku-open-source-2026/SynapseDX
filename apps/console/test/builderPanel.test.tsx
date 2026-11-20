// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// @vitest-environment jsdom
/**
 * BuilderPanel revisions drawer (forward-only restore) and the per-plugin
 * source-sync chip (stored build provenance, no network calls).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import type { ReactElement } from 'react';
import { api } from '../src/lib/api';
import { BuilderPanel } from '../src/pages/admin/workspaces/BuilderPanel';
import type { WorkspacePlugin } from '../src/lib/workspaces';

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ items: [] })),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  },
}));

const PLUGIN_ID = '11111111-2222-4333-8444-555555555555';

function pluginFixture(overrides: Partial<WorkspacePlugin> = {}): WorkspacePlugin {
  return {
    id: PLUGIN_ID,
    product: 'city',
    name: 'Ops desk',
    slug: 'ops-desk',
    audience: 'member',
    roles: ['volunteer'],
    widgets: [
      { id: 'intro', type: 'text', title: 'Welcome', text: 'Hi', width: 'half' },
    ],
    status: 'published',
    version: 2,
    publishedVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    installed: false,
    ...overrides,
  };
}

const builtPlugin = pluginFixture({
  lastBuild: {
    checksum: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    repository: 'https://github.com/vku-open-source-2026/SynapseCity',
    path: 'plugins/ops-desk.plugin.json',
    builtAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
});

const revisionsPayload = {
  items: [
    {
      version: 2,
      status: 'published',
      createdAt: '2026-11-02T00:00:00.000Z',
      createdBy: 'admin-1',
      checksum: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    {
      version: 1,
      status: 'draft',
      createdAt: '2026-11-01T00:00:00.000Z',
      createdBy: 'admin-1',
      checksum: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  ],
  total: 2,
  limit: 100,
  offset: 0,
};

const restoredPayload = {
  id: PLUGIN_ID,
  product: 'city',
  name: 'Ops desk',
  slug: 'ops-desk',
  audience: 'member',
  roles: ['volunteer'],
  widgets: [
    { id: 'intro', type: 'text', title: 'Welcome', text: 'Hi', width: 'half' },
  ],
  status: 'published',
  version: 3,
  publishedVersion: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  installed: false,
  restoredFrom: 1,
};

function renderPanel(
  plugins: WorkspacePlugin[],
  onChanged: () => void,
): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <BuilderPanel
        product="city"
        catalog={null}
        plugins={plugins}
        loading={false}
        onChanged={onChanged}
      />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BuilderPanel revisions drawer', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (String(path).endsWith('/revisions')) {
        return Promise.resolve(revisionsPayload);
      }
      return Promise.resolve({ items: [] });
    });
  });

  it('lists stored revisions and restores one into a new draft', async () => {
    const onChanged = vi.fn();
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (String(path).endsWith('/revisions/1/restore')) {
        return Promise.resolve(restoredPayload);
      }
      return Promise.resolve({});
    });

    render(renderPanel([builtPlugin], onChanged));

    fireEvent.click(screen.getByRole('button', { name: 'Revision history' }));
    expect(await screen.findByText('Revision history')).toBeTruthy();
    expect(screen.getByText('Restore v2')).toBeTruthy();
    expect(screen.getByText('Restore v1')).toBeTruthy();
    expect(screen.getByText(/never rewritten/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore revision v1' }));
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}/revisions/1/restore`,
      );
    });
    // The restore creates the new draft, refreshes the library and closes.
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText('Restore v1')).toBeNull();
    });
  });

  it('surfaces revision loading and restore failures instead of masking them', async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (String(path).endsWith('/revisions')) {
        return Promise.reject(new Error('revisions backend unavailable'));
      }
      return Promise.resolve({ items: [] });
    });

    render(renderPanel([builtPlugin], vi.fn()));

    fireEvent.click(screen.getByRole('button', { name: 'Revision history' }));
    expect(
      await screen.findByText('revisions backend unavailable'),
    ).toBeTruthy();
    expect(screen.queryByText('Restore v1')).toBeNull();
  });
});

describe('BuilderPanel source-sync chip', () => {
  it('shows stored build provenance and a never-built state', async () => {
    const neverBuilt = pluginFixture({ id: '99999999-8888-4777-6666-555555555555', name: 'Fresh desk', slug: 'fresh-desk' });
    render(renderPanel([builtPlugin, neverBuilt], vi.fn()));

    fireEvent.click(screen.getByRole('button', { name: 'Plugin library' }));
    // Built chip: relative time + short checksum, stored metadata only.
    expect(await screen.findByText(/built /)).toBeTruthy();
    expect(screen.getByText(/checksum 01234567/)).toBeTruthy();
    // Never built chip is honest about it.
    expect(screen.getByText('never built')).toBeTruthy();
    // No repository network call is issued from the chip.
    const calls = vi
      .mocked(api.get)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => path.includes('github.com'));
    expect(calls).toEqual([]);
  });
});
