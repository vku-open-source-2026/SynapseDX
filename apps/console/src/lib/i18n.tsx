// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { vi, type Messages } from '../locales/vi';
import { en } from '../locales/en';
import { I18nContext, type I18nValue, type Lang } from './i18n-context';

export const LANG_KEY = 'synapsedx.lang';

/**
 * Vietnamese words are separate syllables, so browsers break "dữ liệu" into
 * "dữ / liệu". Joining common compounds with a non-breaking space keeps each
 * word on one line (same approach as SynapseOne and SynapseCity).
 */
const VI_COMPOUNDS = [
  'mã nguồn mở', 'mã nguồn', 'bộ dữ liệu', 'dữ liệu', 'bản ghi', 'hạ tầng', 'nền tảng', 'giấy phép',
  'tài khoản', 'tổ chức', 'người dùng', 'vai trò', 'phân quyền', 'xác thực', 'đăng nhập', 'đăng xuất',
  'quy trình', 'hàng đợi', 'sự kiện', 'lưu trữ', 'thông báo', 'ứng dụng', 'dịch vụ', 'hệ thống',
  'quản lý', 'quản trị', 'nhật ký', 'kiểm toán', 'kiểm duyệt', 'phê duyệt', 'xuất bản', 'tài liệu',
  'mật khẩu', 'phiên bản', 'trải nghiệm', 'đóng góp', 'Việt Nam', 'phát triển', 'triển khai',
  'tự cài đặt', 'cài đặt', 'đô thị', 'khẩn cấp', 'năng lực', 'dùng chung', 'sản phẩm', 'hộp thư',
  'biểu mẫu', 'báo cáo', 'trích dẫn', 'định danh', 'nhân sự', 'chất lượng', 'công khai', 'hệ sinh thái',
  'thiên tai', 'ứng cứu', 'người duyệt', 'phụ thuộc',
];
const COMPOUND_RE = new RegExp(
  [...VI_COMPOUNDS].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, '\\s')).join('|'),
  'giu',
);

function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}

const keepCompounds = (text: string) => text.replace(COMPOUND_RE, (word) => word.replace(/\s/g, ' '));
// Licence and tier names must not break at their hyphen ("Apache-" / "2.0").
const keepNames = (text: string) => text.replace(/(Apache|Tier|H-P-D)-(\w)/g, '$1‑$2');

const DICTS: Record<Lang, Messages> = {
  vi: mapStrings(mapStrings(vi, keepCompounds), keepNames),
  en: mapStrings(en, keepNames),
};

function readLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch {
    /* storage blocked */
  }
  // Vietnamese is the default audience; only switch for browsers that ask for something else.
  const browser = typeof navigator !== 'undefined' && navigator.language ? navigator.language.toLowerCase() : 'vi';
  return browser.startsWith('vi') ? 'vi' : 'en';
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = DICTS[lang].meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', DICTS[lang].meta.description);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => setLang(lang === 'vi' ? 'en' : 'vi'), [lang, setLang]);

  const value = useMemo<I18nValue>(
    () => ({ lang, m: DICTS[lang], dicts: DICTS, setLang, toggle }),
    [lang, setLang, toggle],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
