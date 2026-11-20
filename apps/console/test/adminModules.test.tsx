// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// @vitest-environment jsdom
/** Admin modules must surface API errors instead of rendering empty states (#86). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, cleanup, screen } from '@testing-library/react';
import * as React from 'react';
import type { ReactElement } from 'react';
import { api } from '../src/lib/api';
import { AgentsModule } from '../src/pages/admin/modules/AgentsModule';

vi.mock('../src/lib/api', () => ({
  api: {
    get: vi.fn(() => Promise.resolve({ items: [] })),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  },
}));

function renderWithQueries(node: ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

describe('admin module query errors (#86)', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/v1/capabilities/agent-runs') {
        return Promise.reject(new Error('agent traces backend unavailable'));
      }
      return Promise.resolve({
        items: [
          { id: 'agent-1', name: 'Harvest agent', model: 'llama', riskTier: 'low', tools: ['dataset.read'] },
        ],
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('AgentsModule renders an error state when the runs query rejects', async () => {
    renderWithQueries(<AgentsModule />);

    // The registry loads; the runs lane reports the failure with a retry.
    expect(await screen.findByText('Harvest agent')).toBeTruthy();
    expect(await screen.findByText('Recent traces could not be loaded')).toBeTruthy();
    expect(await screen.findByText('agent traces backend unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // The rejection must not fall back to the masked empty state.
    expect(screen.queryByText('No agent runs yet.')).toBeNull();
  });
});
