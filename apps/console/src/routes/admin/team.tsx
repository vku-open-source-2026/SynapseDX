// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '../../pages/admin/TeamPage';

export const Route = createFileRoute('/admin/team')({
  component: TeamPage,
});
