// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';

// The console is served same-origin behind nginx, which proxies /v1 and
// /health to the public gateway. Local dev proxies to the local gateway port.
export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
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
