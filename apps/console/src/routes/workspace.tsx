// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { WorkspacePage } from '../pages/WorkspacePage';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});
