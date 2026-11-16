// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext } from 'react';
export interface SelectedRecord { resource: string; row: Record<string, unknown>; widgetId?: string; actionId?: string }
export const RecordSelection = createContext<{
  selected: SelectedRecord | null;
  select: (resource: string, row: Record<string, unknown>, origin?: { widgetId: string; actionId: string }) => void;
}>({ selected: null, select: () => {} });
