// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Apply the saved theme and language before first paint (mirrors src/lib/theme.tsx and src/lib/i18n.tsx).
// A file, not an inline <script>: the nginx CSP is `script-src 'self'`.
(function () {
  var root = document.documentElement;
  var choice = 'system';
  try { choice = localStorage.getItem('synapsedx.theme') || 'system'; } catch (e) {}
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) root.classList.add('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
  var lang = null;
  try { lang = localStorage.getItem('synapsedx.lang'); } catch (e) {}
  if (lang !== 'vi' && lang !== 'en') {
    var nav = (navigator.language || 'vi').toLowerCase();
    lang = nav.indexOf('vi') === 0 ? 'vi' : 'en';
  }
  root.lang = lang;
})();
