// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { ModerationPage } from '../../pages/admin/ModerationPage';

export const Route = createFileRoute('/admin/moderation')({
  component: ModerationPage,
});
