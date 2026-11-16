// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext, useContext } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface ThemeValue {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  cycle: () => void;
}

export const ThemeContext = createContext<ThemeValue | null>(null);

const FALLBACK: ThemeValue = { choice: 'system', setChoice: () => undefined, cycle: () => undefined };

/** Current theme choice. Provided by <ThemeProvider> in lib/theme.tsx. */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext) ?? FALLBACK;
}
