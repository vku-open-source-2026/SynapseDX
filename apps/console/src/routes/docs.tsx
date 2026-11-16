// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { DocsPage } from '../pages/DocsPage';

export const Route = createFileRoute('/docs')({
  component: DocsPage,
});
