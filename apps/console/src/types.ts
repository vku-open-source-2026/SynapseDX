// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export interface DatasetDto {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  entityType?: string;
  license?: string;
  licenseUrl?: string;
  status?: string;
  public?: boolean;
  reviewStatus?: string;
  reviewSubmittedAt?: string;
  reviewNote?: string;
  schemaVersion?: string;
  retentionDays?: number;
  pendingEvents?: unknown[];
  updatedAt?: string;
}

export interface RecordDto {
  id: string;
  data: Record<string, unknown>;
  version?: number;
  published?: boolean;
  updatedAt?: string;
}

export interface ApprovalDto {
  id: string;
  title: string;
  module: string;
  action: string;
  requester: string;
  requiredApprovals: number;
  status: string;
  decisions?: Array<{ decision: string; note?: string; actor?: string; at?: string }>;
  createdAt?: string;
  dueAt?: string;
}

export interface AuditEntryDto {
  id: string;
  at: string;
  actor?: string;
  action?: string;
  datasetId?: string;
  recordId?: string;
  correlationId?: string;
}

export interface TeamDto {
  org?: string;
  account?: string;
  accounts?: Array<{ id: string; slug?: string; displayName?: string }>;
  members?: Array<{
    id: string;
    email?: string;
    displayName?: string;
    roles?: Array<{ id?: string; roleId?: string; slug?: string; name?: string } | string>;
  }>;
  roles?: Array<{ id: string; slug?: string; name?: string }>;
  policies?: Array<{ id: string; name?: string }>;
}

export interface ManagementSummaryDto {
  generatedAt?: string;
  datasets: { total: number; draft: number; published: number; revoked: number; pendingReview: number };
  pendingEvents: number;
  recentAudit: AuditEntryDto[];
  roles: string[];
  permissions: string[];
}

export interface LoginResponse {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
}
