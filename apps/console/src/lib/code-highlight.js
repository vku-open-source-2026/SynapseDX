/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Tiny dependency-free JavaScript highlighter for the workflow Code editor.
// Produces an HTML string (escaped, span-wrapped) rendered under a transparent
// <textarea> — same technique as rich markdown editors, zero new deps.
// Token classes (inline styles, no Tailwind needed inside injected HTML):
//   keyword, string, number, comment, $variable, property, plain.
const KEYWORDS = new Set(
  'await break case catch class const continue debugger default delete do else export extends finally for function if implements import in instanceof interface let new return switch this throw try typeof var void while with yield async of static get getOwnPropertyNames'.split(
    ' ',
  ),
);

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STYLE = {
  kw: 'color:#7c3aed;font-weight:600',
  str: 'color:#047857',
  num: 'color:#b45309',
  com: 'color:#94a3b8;font-style:italic',
  variable: 'color:#0284c7;font-weight:600',
  prop: 'color:#0f172a',
};

// Master pattern: comment | string | template | number | $var | word | other.
// Cloned per highlightJS call — the function recurses into ${} interpolations
// and a shared /g regex would have its lastIndex clobbered mid-iteration.
const TOKEN_RE =
  /(\/\*[\s\S]*?(?:\*\/|$))|(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*(?:'|$)|"(?:[^"\\\n]|\\.)*(?:"|$))|(`(?:[^`\\]|\\.)*(?:`|$))|\b(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|(\$[A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_$][A-Za-z0-9_$]*)|([\s\S])/g;

function paintTemplate(token) {
  // Highlight ${ … } interpolations inside template literals by recursion.
  const closed = token.endsWith('`') && token.length > 1;
  const inner = token.startsWith('`') ? token.slice(1, closed ? -1 : token.length) : token;
  let out = `<span style="${STYLE.str}">\`</span>`;
  let j = 0;
  while (j < inner.length) {
    const d = inner.indexOf('${', j);
    if (d === -1) {
      out += `<span style="${STYLE.str}">${esc(inner.slice(j))}</span>`;
      break;
    }
    out += `<span style="${STYLE.str}">${esc(inner.slice(j, d))}</span>`;
    let depth = 1;
    let k = d + 2;
    while (k < inner.length && depth > 0) {
      if (inner[k] === '{') depth++;
      else if (inner[k] === '}') depth--;
      k++;
    }
    out += '${' + highlightJS(inner.slice(d + 2, k - 1)) + '}';
    j = k;
  }
  if (closed) out += `<span style="${STYLE.str}">\`</span>`;
  return out;
}

/** Highlight JavaScript source as HTML (escaped). Never throws. */
export function highlightJS(src) {
  const code = String(src || '');
  if (!code) return '';
  const re = new RegExp(TOKEN_RE.source, 'g');
  let out = '';
  let m;
  while ((m = re.exec(code)) !== null) {
    const [tok, blockCom, lineCom, str, tpl, num, variable, word] = m;
    if (blockCom || lineCom) out += `<span style="${STYLE.com}">${esc(tok)}</span>`;
    else if (str) out += `<span style="${STYLE.str}">${esc(tok)}</span>`;
    else if (tpl) out += paintTemplate(tok);
    else if (num) out += `<span style="${STYLE.num}">${esc(tok)}</span>`;
    else if (variable) out += `<span style="${STYLE.variable}">${esc(tok)}</span>`;
    else if (word) {
      out += KEYWORDS.has(word)
        ? `<span style="${STYLE.kw}">${esc(tok)}</span>`
        : `<span style="${STYLE.prop}">${esc(tok)}</span>`;
    } else out += esc(tok);
    if (tok === '') break; // safety: never spin on empty match
  }
  return out;
}

/** True when the source contains a top-level `return` (engine heuristic). */
export function hasTopReturn(src) {
  return /\breturn\b/.test(String(src || ''));
}

/** Looks like statements (needs explicit return) vs a bare expression. */
export function looksLikeStatements(src) {
  const s = String(src || '');
  return /[\n;]/.test(s) || /\b(while|for|let|const|var|function|if|else|switch|try|catch|throw|await)\b/.test(s);
}

/** Syntax-check without executing (mirrors the engine's async wrapper).
 *  Returns { ok:true } or { ok:false, error }. When the page CSP blocks the
 *  Function constructor we report { ok:true, unchecked:true } instead of a
 *  false alarm. */
export function checkJSSyntax(src) {
  const code = String(src || '');
  if (!code.trim()) return { ok: true };
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => { ${code} })();`);
    return { ok: true };
  } catch (e) {
    if (e instanceof SyntaxError) {
      const msg = String(e.message || 'syntax error').slice(0, 300);
      return { ok: false, error: msg };
    }
    return { ok: true, unchecked: true };
  }
}
