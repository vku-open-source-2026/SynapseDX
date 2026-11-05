// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '../../pages/admin/SettingsPage';

export const Route = createFileRoute('/admin/settings')({
  component: SettingsPage,
});
