// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ThemeContext, type ThemeChoice, type ThemeValue } from './theme-context';

export const THEME_KEY = 'synapsedx.theme';
const ORDER: ThemeChoice[] = ['light', 'dark', 'system'];

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* storage blocked: follow the OS */
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

/** Mirrors public/theme-init.js so the first paint already has the right theme. */
function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a111d' : '#f6f8fb');
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    apply(choice);
    if (choice !== 'system' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const cycle = useCallback(() => setChoice(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]), [choice, setChoice]);

  const value = useMemo<ThemeValue>(() => ({ choice, setChoice, cycle }), [choice, setChoice, cycle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
