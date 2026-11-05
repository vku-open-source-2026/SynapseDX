// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Capability API modules. Paths are absolute so the client stays proxy-agnostic. */
import { httpClient } from './httpClient';

export const api = {
  get: <T>(path: string, config?: Record<string, unknown>) =>
    httpClient.get<T>(path, config).then((response) => response.data as T),
  post: <T>(path: string, body?: unknown) =>
    httpClient.post<T>(path, body).then((response) => response.data as T),
  put: <T>(path: string, body?: unknown) =>
    httpClient.put<T>(path, body).then((response) => response.data as T),
  patch: <T>(path: string, body?: unknown) =>
    httpClient.patch<T>(path, body).then((response) => response.data as T),
  del: <T = unknown>(path: string) =>
    httpClient.delete<T>(path).then((response) => response.data as T),
};

export interface HealthDependency {
  name: string;
  status: string;
}

export interface GatewayHealth {
  status: string;
  version?: string;
  dependencies?: HealthDependency[];
}

export function getHealth(): Promise<GatewayHealth> {
  return api.get<GatewayHealth>('/health');
}
