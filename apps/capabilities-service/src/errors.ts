// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Stable JSON error envelope.
 *
 * Every 4xx/5xx response is `{error: {code, message, requestId, details?}}`.
 * Upstream (Tier-1) error text, paths and collection names are never copied
 * into the public envelope; they are logged server-side with the request id.
 */
import { SynapseOneError } from '@synapseone/sdk';

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'invalid_limit'
  | 'invalid_offset'
  | 'invalid_cursor'
  | 'invalid_dataset_id'
  | 'invalid_record_id'
  | 'invalid_slug'
  | 'invalid_license'
  | 'invalid_schema_version'
  | 'invalid_retention'
  | 'retention_not_configured'
  | 'field_required'
  | 'data_must_be_an_object'
  | 'no_updatable_fields'
  | 'public_must_be_boolean'
  | 'pagination_both_offset_and_cursor'
  | 'unauthorized'
  | 'invalid_credential'
  | 'invalid_credentials'
  | 'auth_rejected'
  | 'rate_limited'
  | 'authentication_unavailable'
  | 'insufficient_scope'
  | 'not_found'
  | 'dataset_not_found'
  | 'record_not_found'
  | 'dataset_already_exists'
  | 'record_already_exists'
  | 'dataset_not_public'
  | 'dataset_not_published'
  | 'dataset_not_empty'
  | 'already_published'
  | 'moderation_forbidden'
  | 'review_note_required'
  | 'review_not_pending'
  | 'review_required'
  | 'org_required'
  | 'user_token_required'
  | 'account_required'
  | 'invalid_role_slug'
  | 'approval_not_found'
  | 'approval_not_pending'
  | 'self_approval_forbidden'
  | 'approver_role_required'
  | 'duplicate_decision'
  | 'cancel_forbidden'
  | 'job_not_found'
  | 'job_kind_unknown'
  | 'job_not_runnable'
  | 'job_run_in_progress'
  | 'job_run_not_found'
  | 'job_lease_invalid'
  | 'file_not_found'
  | 'file_already_exists'
  | 'file_too_large'
  | 'file_type_not_allowed'
  | 'quota_exceeded'
  | 'upload_incomplete'
  | 'presign_unsupported'
  | 'notification_not_found'
  | 'notification_not_cancellable'
  | 'notification_suppressed'
  | 'template_not_found'
  | 'template_invalid'
  | 'org_not_allowed'
  | 'audience_not_allowed'
  | 'exchange_forbidden'
  | 'illegal_transition'
  | 'version_conflict'
  | 'idempotency_key_required'
  | 'idempotency_key_reuse'
  | 'idempotency_in_progress'
  | 'idempotency_unavailable'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'file_storage_unavailable'
  | 'notification_delivery_unavailable'
  | 'geocoder_unavailable'
  | 'tier1_capability_unavailable'
  | 'forbidden'
  | 'workspace_not_found'
  | 'page_not_found'
  | 'inbox_item_not_found'
  | 'kpi_not_found'
  | 'person_not_found'
  | 'timesheet_not_found'
  | 'period_locked'
  | 'timesheet_pending'
  | 'invalid_transition'
  | 'form_not_found'
  | 'process_not_found'
  | 'process_not_published'
  | 'invalid_process'
  | 'instance_not_found'
  | 'project_not_found'
  | 'task_not_found'
  | 'dependency_cycle'
  | 'gate_not_found'
  | 'stage_gate_blocked'
  | 'report_not_found'
  | 'dashboard_not_found'
  | 'incompatible_schema'
  | 'quality_gate_failed'
  | 'ocr_job_not_found'
  | 'field_not_found'
  | 'ocr_empty'
  | 'ocr_no_text'
  | 'ocr_busy'
  | 'ocr_timeout'
  | 'ocr_failed'
  | 'ocr_engine_unavailable'
  | 'ocr_unsupported_type'
  | 'agent_not_found'
  | 'agent_run_not_found'
  | 'tool_not_allowed'
  | 'run_not_paused'
  | 'approval_required'
  | 'agent_kill_switch'
  | 'prompt_injection_blocked'
  | 'dependency_unavailable'
  | 'upstream_auth_failed'
  | 'upstream_conflict'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'query_rejected'
  | 'invalid_sql'
  | 'invalid_columns'
  | 'invalid_rows'
  | 'invalid_widgets'
  | 'warehouse_upstream_error'
  | 'internal_error'
  | 'route_not_found'
  | 'method_not_allowed'  | 'invalid_url'
  | 'blocked_url'
  | 'invalid_document'
  | 'invalid_question'
  | 'pdf_fetch_failed'
  | 'pdf_too_large'
  | 'pdf_no_text'
  | 'pdf_not_catalogued'
  | 'crawl_running'
  | 'admin_required'
  | 'crawl_failed'
;

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message?: string, details?: unknown) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function apiError(status: number, code: ErrorCode, message?: string, details?: unknown): ApiError {
  return new ApiError(status, code, message, details);
}

export function envelope(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorEnvelope {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

interface ResolvedError {
  status: number;
  body: ErrorEnvelope;
}

function upstreamStatus(status: number | undefined): { status: number; code: ErrorCode } {
  if (status === 404) return { status: 404, code: 'not_found' };
  if (status === 409) return { status: 409, code: 'upstream_conflict' };
  if (status === 413) return { status: 413, code: 'payload_too_large' };
  if (status === 415) return { status: 415, code: 'unsupported_media_type' };
  if (status === 400 || status === 422) return { status: status, code: 'query_rejected' };
  if (status === 401 || status === 403) return { status: 503, code: 'upstream_auth_failed' };
  if (status === 429) return { status: 503, code: 'upstream_unavailable' };
  return { status: 503, code: 'upstream_unavailable' };
}

/**
 * Convert any thrown value into a public status + envelope. `requestId` is the
 * correlation id already returned to the caller.
 */
export function resolveError(error: unknown, requestId: string): ResolvedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: envelope(error.code, error.message, requestId, error.details),
    };
  }
  if (error instanceof SynapseOneError) {
    const mapped = upstreamStatus(error.status);
    const message = mapped.code === 'upstream_conflict'
      ? 'The upstream service reported a conflict'
      : mapped.code === 'upstream_auth_failed'
        ? 'The Tier-2 service credential was rejected by SynapseOne'
        : mapped.code === 'query_rejected'
          ? 'SynapseOne rejected the request'
          : 'SynapseOne is unavailable';
    return { status: mapped.status, body: envelope(mapped.code, message, requestId) };
  }
  const maybe = error as { type?: string; status?: number; message?: string };
  if (maybe?.type === 'entity.parse.failed' || maybe?.type === 'entity.too.large') {
    const code: ErrorCode = maybe.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_json';
    return { status: maybe.type === 'entity.too.large' ? 413 : 400, body: envelope(code, code === 'invalid_json' ? 'Request body is not valid JSON' : 'Request body is too large', requestId) };
  }
  return { status: 500, body: envelope('internal_error', 'Internal error', requestId) };
}

/** Log the full internal detail (never sent to the caller). */
export function logError(error: unknown, requestId: string, method: string, path: string): void {
  const status = error instanceof ApiError
    ? error.status
    : error instanceof SynapseOneError
      ? error.status
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[synapsedx] ${requestId} ${method} ${path} status=${status} error=${message}`);
}
