// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';

// The console is served same-origin behind nginx, which proxies /v1 and
// /health to the public gateway. Local dev proxies to the local gateway port.
// Opaque widget frames need the same bootstrap CORS and isolation headers
// during local authoring as they receive from production nginx.
function studioSandboxHeaders(): Plugin {
  const policy = readFileSync(path.resolve(__dirname, 'nginx.conf'), 'utf8')
    .match(/location = \/studio-sandbox\.html \{[\s\S]*?Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy) throw new Error('Studio sandbox CSP is missing from nginx.conf');
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/studio-sandbox.js') res.setHeader('Access-Control-Allow-Origin', '*');
    if (pathname === '/studio-sandbox.html') res.setHeader('Content-Security-Policy', policy);
    next();
  };
  return {
    name: 'studio-sandbox-headers',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
export default defineConfig({
  plugins: [TanStackRouterVite(), react(), studioSandboxHeaders()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: true,
    proxy: {
      '/v1': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
  },
});
