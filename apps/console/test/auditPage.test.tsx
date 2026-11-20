// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// @vitest-environment jsdom
/**
 * Audit page filters: the per-plugin lane sends `pluginId` to the server-side
 * audit query instead of filtering rows in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { api } from '../src/lib/api';
import { AuditPage } from '../src/pages/admin/AuditPage';
import { useAuthStore } from '../src/stores/authStore';

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ items: [] })),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  },
}));

function renderPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    context: { user: { id: 'admin-1' }, roles: ['admin'], permissions: ['audit:read'] },
  });
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (String(path).startsWith('/v1/capabilities/audit')) {
      return Promise.resolve({ items: [], total: 0 });
    }
    return Promise.resolve({ totals: { requests: 0, errors: 0 }, window: '24h' });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ context: null });
});

describe('AuditPage filters', () => {
  it('sends the plugin id as a server-side audit filter', async () => {
    renderPage();

    const pluginInput = screen.getByPlaceholderText('Plugin id');
    fireEvent.change(pluginInput, {
      target: { value: '11111111-2222-4333-8444-555555555555' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => {
      const paths = vi.mocked(api.get).mock.calls.map(([path]) => String(path));
      expect(
        paths.some((path) =>
          path.includes(
            'pluginId=11111111-2222-4333-8444-555555555555',
          ),
        ),
      ).toBe(true);
    });
  });
});
