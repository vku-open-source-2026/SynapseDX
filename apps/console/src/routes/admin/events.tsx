// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { EventsPage } from '../../pages/admin/EventsPage';

export const Route = createFileRoute('/admin/events')({
  component: EventsPage,
});
