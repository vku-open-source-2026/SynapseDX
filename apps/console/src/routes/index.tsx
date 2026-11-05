// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { PublicHomePage } from '../pages/PublicHomePage';
import { useAuthStore } from '../stores/authStore';

function RootIndex() {
  const session = useAuthStore((state) => state.session);
  if (session) return <Navigate to="/admin" />;
  return <PublicHomePage />;
}

export const Route = createFileRoute('/')({
  component: RootIndex,
});
