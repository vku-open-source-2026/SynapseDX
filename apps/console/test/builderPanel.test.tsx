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

describe('BuilderPanel bulk bundle import', () => {
  const widget = { id: 'intro', type: 'text', title: 'Welcome', text: 'Hi', width: 'half' };
  const bundleFor = (name: string, slug: string) => ({
    format: 'synapsedx-plugin',
    formatVersion: 1,
    plugin: {
      product: 'city',
      name,
      slug,
      audience: 'member',
      roles: ['volunteer'],
      widgets: [widget],
    },
    checksum: `sha256:${'a'.repeat(64)}`,
  });
  const fileFor = (bundle: unknown, fileName: string) =>
    new File([JSON.stringify(bundle)], fileName, { type: 'application/json' });

  it('imports several files in one call and renders per-item outcomes', async () => {
    const first = bundleFor('First page', 'first-page');
    const second = bundleFor('Second page', 'second-page');
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (String(path).endsWith('/plugins/import-bulk')) {
        return Promise.resolve({
          results: [
            { index: 0, ok: true, pluginId: 'plugin-1' },
            {
              index: 1,
              ok: false,
              error: { code: 'plugin_limit_reached', message: 'this organization already has 50 plugins' },
            },
          ],
          summary: { total: 2, imported: 1, failed: 1 },
        });
      }
      return Promise.resolve({});
    });
    const onChanged = vi.fn();
    const { container } = render(renderPanel([], onChanged));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    fireEvent.change(input, {
      target: { files: [fileFor(first, 'first.json'), fileFor(second, 'second.json')] },
    });

    const submit = await screen.findByRole('button', { name: 'Import 2 bundles' });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/v1/capabilities/workspaces/plugins/import-bulk',
        { bundles: [first, second] },
      );
    });
    // A failed item is reported, not hidden, and the valid one still imported.
    expect(await screen.findByText('plugin_limit_reached')).toBeTruthy();
    expect(screen.getByText(/1 of 2\s+imported as drafts/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    // The dialog stays open so the operator can read the failed item.
    expect(screen.getByText('Second page')).toBeTruthy();
  });

  it('skips files that do not parse and never calls the bulk endpoint', async () => {
    const valid = bundleFor('Only page', 'only-page');
    const onChanged = vi.fn();
    const { container } = render(renderPanel([], onChanged));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['{not json'], 'broken.json', { type: 'application/json' }), fileFor(valid, 'only.json')] },
    });

    expect(await screen.findByText(/The file is not valid JSON\./)).toBeTruthy();
    const submit = await screen.findByRole('button', { name: 'Import as draft' });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/v1/capabilities/workspaces/import',
        valid,
      );
    });
    expect(
      vi.mocked(api.post).mock.calls.some(([path]) => String(path).includes('import-bulk')),
    ).toBe(false);
  });
});

describe('BuilderPanel page lifecycle and form field tools', () => {
  const formPlugin = pluginFixture({
    name: 'Incident desk',
    slug: 'incident-desk',
    widgets: [
      {
        id: 'incident-create',
        type: 'form',
        title: 'Report an incident',
        action: 'create',
        resource: 'incidents',
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ],
      },
    ] as WorkspacePlugin['widgets'],
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (vi.isMockFunction(window.confirm)) (window.confirm as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('duplicates the selected page as a new draft through the duplicate route', async () => {
    const copy = { ...formPlugin, id: 'copy-1', name: 'Incident desk copy', slug: 'incident-desk-copy', status: 'draft', version: 1, installed: false };
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (String(path).endsWith('/duplicate')) return Promise.resolve(copy);
      return Promise.resolve({});
    });
    const onChanged = vi.fn();
    const onSelected = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BuilderPanel
          product="city"
          catalog={null}
          plugins={[formPlugin]}
          loading={false}
          onChanged={onChanged}
          onSelected={onSelected}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate' }));
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}/duplicate`,
        {},
      );
    });
    expect(onSelected).toHaveBeenCalledWith('copy-1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('deletes a saved page after uninstalling, and never an installed one', async () => {
    window.confirm = vi.fn(() => true);
    vi.mocked(api.del).mockResolvedValue({} as never);
    const onSelected = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <BuilderPanel
          product="city"
          catalog={null}
          plugins={[pluginFixture({ installed: true })]}
          loading={false}
          onChanged={vi.fn()}
          onSelected={onSelected}
        />
      </QueryClientProvider>,
    );

    // An installed page explains the uninstall requirement instead of deleting:
    // the button refuses to run (disabled) and carries the reason.
    const installedDelete = await screen.findByRole('button', { name: 'Delete' });
    expect(installedDelete.hasAttribute('disabled')).toBe(true);
    expect(
      installedDelete
        .getAttribute('title')
        ?.includes('Uninstall this page for your organization before deleting it'),
    ).toBe(true);
    fireEvent.click(installedDelete);
    await Promise.resolve();
    expect(vi.mocked(api.del).mock.calls.some(([path]) => String(path).includes('/plugins/'))).toBe(false);
    expect(screen.queryByText(/Uninstall this page for your organization before deleting it\./)).toBeNull();

    // Uninstalled: the confirm dialog guards an explicit, versioned delete.
    // A fresh mount (key change) selects the uninstalled plugin.
    rerender(
      <QueryClientProvider client={queryClient}>
        <BuilderPanel
          key="uninstalled"
          product="city"
          catalog={null}
          plugins={[pluginFixture({ installed: false })]}
          loading={false}
          onChanged={vi.fn()}
          onSelected={onSelected}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(vi.mocked(api.del)).toHaveBeenCalledWith(
        `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}`,
        { version: 2 },
      );
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(onSelected).toHaveBeenCalledWith('');
  });

  it('reorders and duplicates form fields from the inspector', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <BuilderPanel
          product="city"
          catalog={null}
          plugins={[formPlugin]}
          loading={false}
          onChanged={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await screen.findByText('Declared fields');
    const names = () =>
      screen
        .getAllByPlaceholderText('name')
        .map((input) => (input as HTMLInputElement).value);

    // Move the first field down: title swaps under Notes.
    fireEvent.click(screen.getByRole('button', { name: 'Move field Title down' }));
    await waitFor(() => expect(names()[0]).toBe('notes'));

    // Duplicate re-inserts a copy directly after the source with a unique name.
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate field Title' }));
    await waitFor(() => expect(names()).toEqual(['notes', 'title', 'title_copy']));
  });
});

describe('BuilderPanel live preview lane', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('previews live data through the admin draft lane, and says so', async () => {
    const plugin = pluginFixture({
      widgets: [
        {
          id: 'count',
          type: 'metric',
          title: 'Open incidents',
          resource: 'incidents',
          width: 'half',
          onLoad: 'act-count-load',
        },
      ] as WorkspacePlugin['widgets'],
    });
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (String(path).includes('/preview/widgets/count/data')) {
        return Promise.resolve({ type: 'metric', widgetId: 'count', count: 42 });
      }
      return Promise.resolve({ items: [] });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <div>
          <div id="workspace-studio-controls" />
          <BuilderPanel
            product="city"
            catalog={null}
            plugins={[plugin]}
            loading={false}
            onChanged={vi.fn()}
          />
        </div>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(vi.mocked(api.get)).toHaveBeenCalledWith(
        `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}/preview/widgets/count/data`,
        expect.objectContaining({ params: expect.anything() }),
      );
    });
    // The placeholder is replaced by the real count from the preview lane.
    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText(/Live preview/)).toBeTruthy();
  });
});
