/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Canonical app host helpers (multi-domain deploy).
// Prod: @ (synapsedx.sbs) la web chinh/landing, cloud.* la frontend app chinh.
// Nut Dang nhap / Mo Console o domain phu phai tro ve canonical APP_URL theo env.
export function appUrl() {
  if (typeof window !== 'undefined' && window.SYNAPSEDX_CONFIG?.APP_URL) {
    return String(window.SYNAPSEDX_CONFIG.APP_URL).replace(/\/$/, '');
  }
  return (import.meta.env?.VITE_CONSOLE_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// true khi dang dung dung domain app chinh (cloud.* o prod, localhost:3000 o dev).
// Dev (localhost): luon true de giu SPA routing noi bo.
export function isCanonicalAppHost() {
  if (typeof window === 'undefined') return true;
  const canonical = hostOf(appUrl());
  if (!canonical) return true;
  if (canonical.startsWith('localhost')) return true;
  return window.location.host === canonical;
}

// URL tuyet doi toi trang login tren canonical host.
export function appLoginUrl() {
  return `${appUrl()}/login`;
}

// URL tuyet doi toi dashboard tren canonical host.
export function appDashboardUrl() {
  return `${appUrl()}/dashboard`;
}
