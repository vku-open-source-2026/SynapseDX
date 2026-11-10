// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Local OCR engine for the I-layer document capability (#43).
 *
 * Runs the Tesseract CLI (Apache-2.0) as a child process: image bytes go in on
 * stdin and TSV comes back on stdout, so nothing touches the filesystem. The
 * engine is deliberately cheap: one job at a time, one OpenMP thread, a short
 * bounded queue and a hard timeout. Idle cost is zero (no resident model).
 */
import { spawn } from 'node:child_process';
import { ServiceConfig } from './config';
import { apiError } from './errors';

export const OCR_IMAGE_TYPES = [
  'image/png', 'image/jpeg', 'image/tiff', 'image/bmp', 'image/webp', 'image/gif',
];

export interface OcrLine { text: string; confidence: number; bbox: number[] }
export interface OcrPage { page: number; text: string; confidence?: number; bbox?: number[]; lines?: OcrLine[] }
export interface OcrResult { pages: OcrPage[]; engine: { name: 'tesseract'; languages: string; durationMs: number } }

const MAX_LINES_PER_PAGE = 2000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;

/** Parse Tesseract TSV (level 5 = word) into pages of lines with bbox + confidence. */
export function parseTesseractTsv(tsv: string): OcrPage[] {
  type Acc = { words: string[]; confs: number[]; x0: number; y0: number; x1: number; y1: number };
  const pages = new Map<number, Map<string, Acc>>();
  for (const raw of tsv.split(/\r?\n/).slice(1)) {
    const cols = raw.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols.slice(11).join('\t').trim();
    if (!text) continue;
    const [page, block, par, line] = [cols[1], cols[2], cols[3], cols[4]].map(Number);
    const [left, top, width, height, conf] = [cols[6], cols[7], cols[8], cols[9], cols[10]].map(Number);
    if (!pages.has(page)) pages.set(page, new Map());
    const lines = pages.get(page)!;
    const key = `${block}.${par}.${line}`;
    const acc = lines.get(key) || { words: [], confs: [], x0: left, y0: top, x1: left + width, y1: top + height };
    acc.words.push(text);
    if (conf >= 0) acc.confs.push(conf);
    acc.x0 = Math.min(acc.x0, left); acc.y0 = Math.min(acc.y0, top);
    acc.x1 = Math.max(acc.x1, left + width); acc.y1 = Math.max(acc.y1, top + height);
    lines.set(key, acc);
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, lines]) => {
    const out: OcrLine[] = [...lines.values()].slice(0, MAX_LINES_PER_PAGE).map((acc) => ({
      text: acc.words.join(' '),
      confidence: acc.confs.length ? Number((acc.confs.reduce((s, c) => s + c, 0) / acc.confs.length / 100).toFixed(3)) : 0,
      bbox: [acc.x0, acc.y0, acc.x1, acc.y1],
    }));
    const confidence = out.length ? Number((out.reduce((s, l) => s + l.confidence, 0) / out.length).toFixed(3)) : 0;
    return { page, text: out.map((l) => l.text).join('\n'), confidence, lines: out };
  });
}

// ---- single-worker queue ----
let running = false;
const waiting: Array<() => void> = [];

async function withWorker<T>(config: ServiceConfig, fn: () => Promise<T>): Promise<T> {
  if (running) {
    if (waiting.length >= config.ocrMaxQueue) {
      throw apiError(429, 'ocr_busy', 'the OCR worker is busy; retry shortly', { queue: waiting.length });
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running = true;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else running = false;
  }
}

function runTesseract(config: ServiceConfig, bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.tesseractBin, ['stdin', 'stdout', '-l', config.ocrLanguages, '--psm', '3', 'tsv'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', OMP_THREAD_LIMIT: '1', ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}) },
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value || '');
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(apiError(504, 'ocr_timeout', 'OCR did not finish in time', { timeoutMs: config.ocrTimeoutMs }));
    }, config.ocrTimeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT'
        ? apiError(503, 'ocr_engine_unavailable', 'the OCR engine is not installed on this service')
        : apiError(502, 'ocr_failed', 'the OCR engine failed to start'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) { child.kill('SIGKILL'); finish(apiError(502, 'ocr_failed', 'OCR output too large')); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 4000) err += chunk.toString('utf8'); });
    child.on('close', (code) => {
      if (code === 0) finish(null, Buffer.concat(out).toString('utf8'));
      else finish(apiError(422, 'ocr_failed', 'the OCR engine could not read this image', { detail: err.trim().split('\n').slice(-2).join(' ').slice(0, 300) }));
    });
    child.stdin.on('error', () => { /* reported through close */ });
    child.stdin.end(Buffer.from(bytes));
  });
}

/** OCR one image. Throws stable API errors (415/413/429/503/504/422). */
export async function recognizeImage(config: ServiceConfig, bytes: Uint8Array, contentType: string): Promise<OcrResult> {
  if (config.ocrEngine === 'off') throw apiError(503, 'ocr_engine_unavailable', 'OCR is disabled on this service');
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!OCR_IMAGE_TYPES.includes(type)) {
    throw apiError(415, 'ocr_unsupported_type', 'OCR accepts images only; render PDF pages to PNG first', { contentType: type, accepted: OCR_IMAGE_TYPES });
  }
  if (bytes.byteLength > config.ocrMaxBytes) {
    throw apiError(413, 'file_too_large', 'the image exceeds the OCR size limit', { maxBytes: config.ocrMaxBytes });
  }
  return withWorker(config, async () => {
    const started = Date.now();
    const tsv = await runTesseract(config, bytes);
    return { pages: parseTesseractTsv(tsv), engine: { name: 'tesseract', languages: config.ocrLanguages, durationMs: Date.now() - started } };
  });
}
