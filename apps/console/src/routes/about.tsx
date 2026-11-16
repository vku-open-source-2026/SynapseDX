// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import { AboutPage } from '../pages/AboutPage';

export const Route = createFileRoute('/about')({
  component: AboutPage,
});
