// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// @vitest-environment jsdom
/**
 * Admin modules must surface API errors instead of rendering empty states
 * (#86), and the agents lane must stay honest about the unconfigured runtime
 * (#79): no traces/status/cost lane is rendered because no run can exist.
 */
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
      if (path === '/v1/capabilities/agents') {
        return Promise.reject(new Error('agent registry backend unavailable'));
      }
      return Promise.resolve({ items: [] });
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('AgentsModule renders an error state when the registry query rejects', async () => {
    renderWithQueries(<AgentsModule />);

    // The registry lane reports the failure with a retry, never a masked
    // "no agents" empty state.
    expect(await screen.findByText('Agents could not be loaded')).toBeTruthy();
    expect(await screen.findByText('agent registry backend unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('No agents registered yet.')).toBeNull();
  });
});

describe('agents runtime honesty (#79)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the unconfigured-runtime panel instead of a traces/status/cost lane', async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/v1/capabilities/agents') {
        return Promise.resolve({
          items: [
            { id: 'agent-1', name: 'Harvest agent', model: 'llama', riskTier: 'low', tools: ['dataset.read'] },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    });

    renderWithQueries(<AgentsModule />);

    // The registry (a real governance surface) still loads.
    expect(await screen.findByText('Harvest agent')).toBeTruthy();
    // The runtime panel states the deployment fact honestly.
    expect(
      screen.getByText('Agent runtime is not configured on this deployment'),
    ).toBeTruthy();
    expect(screen.getByText(/501 not_implemented/)).toBeTruthy();
    expect(screen.getByText(/capability_unavailable/)).toBeTruthy();
    // The dead lanes and the promises they carried are gone.
    expect(screen.queryByText('Recent traces')).toBeNull();
    expect(screen.queryByText('Cost')).toBeNull();
    expect(
      screen.queryByText(/high-risk runs pause for HITL/i),
    ).toBeNull();
    // No runs/traces request is issued at all: no run can exist.
    const calls = vi
      .mocked(api.get)
      .mock.calls.map(([path]) => String(path));
    expect(calls).toEqual(['/v1/capabilities/agents']);
  });
});
