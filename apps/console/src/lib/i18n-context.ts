// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext, useContext } from 'react';
import { vi, type Messages } from '../locales/vi';

export type Lang = 'vi' | 'en';

export interface I18nValue {
  lang: Lang;
  m: Messages;
  dicts: Record<Lang, Messages>;
  setLang: (lang: Lang) => void;
  toggle: () => void;
}

export const I18nContext = createContext<I18nValue | null>(null);

// Outside <LanguageProvider> (isolated renders) fall back to Vietnamese instead of throwing.
const FALLBACK: I18nValue = { lang: 'vi', m: vi, dicts: { vi, en: vi }, setLang: () => undefined, toggle: () => undefined };

/** Current language and its copy `m`. Provided by <LanguageProvider> in lib/i18n.tsx. */
export function useI18n(): I18nValue {
  return useContext(I18nContext) ?? FALLBACK;
}

/** Fill `{name}` placeholders in a copy string. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
}
