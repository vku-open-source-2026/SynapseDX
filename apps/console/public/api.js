// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Small JSON client with a stable error shape and an auth-expiry hook. */

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'request_failed';
    this.details = details;
    this.requestId = requestId;
  }
}

export function createApi({ baseUrl = '', getToken = () => null, fetchImpl = globalThis.fetch, onUnauthorized } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

  async function request(path, options = {}) {
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(0, 'network_error', 'the control plane is unreachable');
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const error = body?.error;
      if (response.status === 401 && typeof onUnauthorized === 'function') onUnauthorized();
      throw new ApiError(
        response.status,
        error?.code,
        error?.message || response.statusText,
        error?.details,
        error?.requestId || response.headers.get('x-request-id') || undefined,
      );
    }
    return body;
  }

  return {
    request,
    get: (path, options = {}) => request(path, options),
    post: (path, body, options = {}) => request(path, { ...options, method: 'POST', ...(body === undefined ? {} : { body }) }),
    put: (path, body, options = {}) => request(path, { ...options, method: 'PUT', ...(body === undefined ? {} : { body }) }),
    patch: (path, body, options = {}) => request(path, { ...options, method: 'PATCH', ...(body === undefined ? {} : { body }) }),
    del: (path, options = {}) => request(path, { ...options, method: 'DELETE' }),
  };
}
