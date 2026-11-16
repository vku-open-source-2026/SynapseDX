// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * KTTV crawlers — NCHMF (national hydro-meteorological warnings) and VNDMS
 * (disaster-monitoring public S3 bucket + config).
 *
 * The crawlers only fetch allow-listed public hosts, bound every request with a
 * timeout/size cap and return normalised hazards. Persistence, indexing and
 * scheduling are owned by the Tier-2 routes (Base documents + knowledge base).
 */
import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export type HazardEventType = 'flood' | 'storm' | 'rain' | 'landslide' | 'fire' | 'earthquake' | 'outage' | 'pollution' | 'drought' | 'traffic' | 'epidemic' | 'heat' | 'cold' | 'other';
export type HazardSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CrawledHazard {
  hazard_id: string;
  title: string;
  description: string;
  event_type: HazardEventType;
  severity: HazardSeverity;
  source: 'nchmf' | 'vndms';
  url: string;
  published_at: string;
  provinces: string[];
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
  text: string;
  hash: string;
  approximate_geometry: boolean;
}

export interface CrawledDocument {
  document_id: string;
  title: string;
  text: string;
  source: 'nchmf' | 'vndms';
  url: string;
  published_at: string;
  kind: 'pdf' | 'html';
  tags: string[];
}

const NCHMF_HOST = 'www.nchmf.gov.vn';
const VNDMS_HOST = 'vndms.gov.vn';
const VNDMS_S3_HOST = 's3.vndms.gov.vn';
const MAX_ARTICLE = 24;
const MAX_PDF_PER_ARTICLE = 2;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Approximate province centroids used to place text-only warnings on the map. */
const PROVINCES: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Hà Nội', lat: 21.0285, lng: 105.8542 },
  { name: 'Hải Phòng', lat: 20.8449, lng: 106.6881 },
  { name: 'Quảng Ninh', lat: 21.0069, lng: 107.2925 },
  { name: 'Thái Nguyên', lat: 21.5942, lng: 105.8481 },
  { name: 'Bắc Ninh', lat: 21.1861, lng: 106.0763 },
  { name: 'Hưng Yên', lat: 20.6464, lng: 106.0511 },
  { name: 'Hải Dương', lat: 20.9373, lng: 106.3145 },
  { name: 'Ninh Bình', lat: 20.2506, lng: 105.9745 },
  { name: 'Nam Định', lat: 20.4388, lng: 106.1621 },
  { name: 'Thái Bình', lat: 20.4463, lng: 106.3365 },
  { name: 'Thanh Hóa', lat: 19.8067, lng: 105.7852 },
  { name: 'Nghệ An', lat: 18.6796, lng: 105.6813 },
  { name: 'Hà Tĩnh', lat: 18.3559, lng: 105.8877 },
  { name: 'Quảng Bình', lat: 17.469, lng: 106.6223 },
  { name: 'Quảng Trị', lat: 16.7503, lng: 107.1855 },
  { name: 'Huế', lat: 16.4637, lng: 107.5909 },
  { name: 'Đà Nẵng', lat: 16.0544, lng: 108.2022 },
  { name: 'Quảng Nam', lat: 15.5394, lng: 108.0191 },
  { name: 'Quảng Ngãi', lat: 15.1205, lng: 108.7923 },
  { name: 'Bình Định', lat: 13.7829, lng: 109.219 },
  { name: 'Phú Yên', lat: 13.0882, lng: 109.0929 },
  { name: 'Khánh Hòa', lat: 12.2388, lng: 109.1967 },
  { name: 'Ninh Thuận', lat: 11.5659, lng: 108.9885 },
  { name: 'Bình Thuận', lat: 10.9289, lng: 108.1021 },
  { name: 'Kon Tum', lat: 14.3497, lng: 108.0005 },
  { name: 'Gia Lai', lat: 13.9833, lng: 108.0 },
  { name: 'Đắk Lắk', lat: 12.6667, lng: 108.05 },
  { name: 'Đắk Nông', lat: 12.004, lng: 107.6876 },
  { name: 'Lâm Đồng', lat: 11.5753, lng: 108.1429 },
  { name: 'Hồ Chí Minh', lat: 10.7769, lng: 106.7009 },
  { name: 'Tây Ninh', lat: 11.335, lng: 106.109 },
  { name: 'Bình Dương', lat: 11.3254, lng: 106.477 },
  { name: 'Đồng Nai', lat: 10.9574, lng: 106.8427 },
  { name: 'Bà Rịa - Vũng Tàu', lat: 10.5417, lng: 107.2429 },
  { name: 'Long An', lat: 10.6956, lng: 106.2431 },
  { name: 'Tiền Giang', lat: 10.4493, lng: 106.3429 },
  { name: 'Bến Tre', lat: 10.2434, lng: 106.3756 },
  { name: 'Trà Vinh', lat: 9.9347, lng: 106.3453 },
  { name: 'Vĩnh Long', lat: 10.2537, lng: 105.9722 },
  { name: 'Đồng Tháp', lat: 10.4938, lng: 105.6882 },
  { name: 'An Giang', lat: 10.3864, lng: 105.4352 },
  { name: 'Kiên Giang', lat: 10.0125, lng: 105.0809 },
  { name: 'Cần Thơ', lat: 10.0452, lng: 105.7469 },
  { name: 'Hậu Giang', lat: 9.7579, lng: 105.6413 },
  { name: 'Sóc Trăng', lat: 9.6033, lng: 105.98 },
  { name: 'Bạc Liêu', lat: 9.2941, lng: 105.7278 },
  { name: 'Cà Mau', lat: 9.1769, lng: 105.1524 },
  { name: 'Lai Châu', lat: 22.3964, lng: 103.4583 },
  { name: 'Điện Biên', lat: 21.386, lng: 103.023 },
  { name: 'Sơn La', lat: 21.3256, lng: 103.9188 },
  { name: 'Hòa Bình', lat: 20.8172, lng: 105.3376 },
  { name: 'Lào Cai', lat: 22.4856, lng: 103.9707 },
  { name: 'Yên Bái', lat: 21.7168, lng: 104.8986 },
  { name: 'Phú Thọ', lat: 21.3227, lng: 105.402 },
  { name: 'Hà Giang', lat: 22.8233, lng: 104.9836 },
  { name: 'Tuyên Quang', lat: 21.8236, lng: 105.214 },
  { name: 'Cao Bằng', lat: 22.6666, lng: 106.2579 },
  { name: 'Bắc Kạn', lat: 22.147, lng: 105.8348 },
  { name: 'Lạng Sơn', lat: 21.8537, lng: 106.7615 },
  { name: 'Bắc Giang', lat: 21.2731, lng: 106.1946 },
];

const EVENT_RULES: Array<{ type: HazardEventType; words: string[] }> = [
  { type: 'landslide', words: ['sạt lở', 'sụt lún', 'lũ quét', 'đất đá'] },
  { type: 'flood', words: ['lũ', 'lụt', 'ngập', 'nước dâng', 'triều cường'] },
  { type: 'storm', words: ['bão', 'áp thấp nhiệt đới', 'gió mạnh', 'sóng lớn'] },
  { type: 'rain', words: ['mưa lớn', 'mưa dông', 'mưa đá', 'dông', 'lốc', 'sét'] },
  { type: 'heat', words: ['nắng nóng', 'nắng gắt'] },
  { type: 'drought', words: ['hạn hán', 'xâm nhập mặn', 'thiếu nước'] },
  { type: 'cold', words: ['rét', 'gió mùa đông bắc', 'băng giá'] },
];

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function normalizeText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function detectEvent(text: string): HazardEventType {
  const lower = normalizeText(text).toLowerCase();
  for (const rule of EVENT_RULES) if (rule.words.some((word) => lower.includes(word))) return rule.type;
  return 'other';
}

export function detectSeverity(text: string, title = ''): HazardSeverity {
  const lower = `${title} ${text}`.toLowerCase();
  if (/cấp\s*(độ\s*)?4|rất nguy hiểm|thảm họa/.test(lower)) return 'critical';
  if (/cấp\s*(độ\s*)?3|nguy hiểm/.test(lower)) return 'high';
  if (/cấp\s*(độ\s*)?2|cảnh báo/.test(lower)) return 'medium';
  return 'low';
}

function normalizeProvince(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function detectProvinces(text: string): string[] {
  const lower = normalizeProvince(text);
  const found: string[] = [];
  for (const province of PROVINCES) {
    if (lower.includes(normalizeProvince(province.name))) found.push(province.name);
  }
  return [...new Set(found)].slice(0, 8);
}

function geometryFor(provinces: string[]): { geometry: CrawledHazard['geometry']; approximate: boolean } {
  for (const name of provinces) {
    const match = PROVINCES.find((province) => province.name === name);
    if (match) return { geometry: { type: 'Point', coordinates: [match.lng, match.lat] }, approximate: true };
  }
  return { geometry: { type: 'Point', coordinates: [105.8542, 21.0285] }, approximate: true };
}

function allowedHost(url: URL): boolean {
  return url.hostname === NCHMF_HOST || url.hostname === VNDMS_HOST || url.hostname === VNDMS_S3_HOST;
}

async function fetchText(url: string): Promise<{ text: string; contentType: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!allowedHost(parsed)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'SynapseCity-KTTV-Crawler/1.0 (+https://synapsecity.sbs)' },
    });
    if (!response.ok) return null;
    const contentType = String(response.headers.get('content-type') || '');
    const buffer = Buffer.from(await response.arrayBuffer());
    return { text: buffer.toString('utf8'), contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPdfText(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!allowedHost(parsed)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_PDF_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PDF_BYTES) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdf = require('pdf-parse') as (data: Buffer) => Promise<{ text?: string }>;
    const parsedPdf = await pdf(buffer);
    return normalizeText(parsedPdf.text || '').slice(0, 60_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDmy(value: string): string | null {
  const match = /\((\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\)/.exec(value);
  if (!match) return null;
  const [, d, m, y, hh, mm, ss] = match;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss || '00'}+07:00`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stripDateSuffix(title: string): string {
  return normalizeText(title.replace(/\(\d{1,2}\/\d{1,2}\/\d{4}[^)]*\)\s*$/, ''));
}

function articleBody(html: string): { text: string; pdfs: string[] } {
  const $ = load(html);
  const pdfs: string[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    if (/\.pdf(\?|$)/i.test(href)) {
      try {
        pdfs.push(new URL(href, 'https://www.nchmf.gov.vn').toString());
      } catch {
        // ignore malformed hrefs
      }
    }
  });
  // NCHMF pages are malformed: an unclosed <form> wraps the whole body, so
  // removing it would delete the article. Pick the article container first and
  // only strip inline scripts/styles from that subtree.
  const selectors = ['.text-content-news', '.content-news', 'article', '#content', '.body-content'];
  let main = $();
  for (const selector of selectors) {
    const found = $(selector);
    if (found.length && normalizeText(found.text()).length > 80) {
      main = found;
      break;
    }
  }
  if (!main.length) main = $('body').clone();
  main.find('script,style,noscript,iframe,svg').remove();
  const text = normalizeText(main.text()).slice(0, 60_000);
  return { text, pdfs: [...new Set(pdfs)] };
}

/** Crawl NCHMF /kttv/ listing and today's warning articles. */
export async function crawlNchmf(now = Date.now()): Promise<CrawledHazard[]> {
  const listing = await fetchText(`https://${NCHMF_HOST}/kttv/`);
  if (!listing) return [];
  const $ = load(listing.text);
  const candidates: Array<{ url: string; title: string; publishedAt: string | null }> = [];
  const seen = new Set<string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const title = normalizeText($(element).text());
    if (!href.includes('/kttv/') || title.length < 20) return;
    let absolute: string;
    try {
      absolute = new URL(href, `https://${NCHMF_HOST}`).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    // Only real articles; category/navigation anchors are also under /kttv/.
    if (!/-post\d+\.html/i.test(absolute)) return;
    const publishedAt = parseDmy(title);
    if (publishedAt && now - new Date(publishedAt).getTime() > 72 * 3600_000) return;
    seen.add(absolute);
    candidates.push({ url: absolute, title: stripDateSuffix(title), publishedAt });
  });
  candidates.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));

  const hazards: CrawledHazard[] = [];
  for (const candidate of candidates.slice(0, MAX_ARTICLE)) {
    const page = await fetchText(candidate.url);
    if (!page) continue;
    const { text, pdfs } = articleBody(page.text);
    let fullText = text;
    for (const pdfUrl of pdfs.slice(0, MAX_PDF_PER_ARTICLE)) {
      const pdfText = await fetchPdfText(pdfUrl);
      if (pdfText) fullText += `\n\n[PDF] ${pdfText}`;
    }
    if (fullText.length < 40) continue;
    const titleEvent = detectEvent(candidate.title);
    const eventType = titleEvent !== 'other' ? titleEvent : detectEvent(`${candidate.title} ${fullText}`);
    if (eventType === 'other' && !/cảnh báo|dự báo|tin/i.test(candidate.title)) continue;
    const provinceList = detectProvinces(`${candidate.title} ${fullText}`);
    // Generic bulletins whose body is only site chrome (e.g. a hydrology page
    // whose report is rendered by JS) must not become a map hazard. Keep them
    // out of the hazard feed; the title-only page has no locatable content.
    const chromeOnly = fullText.length < 160 && /chi tiết tin|xem chi tiết/i.test(fullText);
    if (chromeOnly || (eventType === 'other' && provinceList.length === 0)) continue;
    const { geometry } = geometryFor(provinceList);
    const publishedAt = candidate.publishedAt || new Date().toISOString();
    const hash = sha1(fullText);
    hazards.push({
      hazard_id: `nchmf-${sha1(candidate.url).slice(0, 16)}`,
      title: candidate.title.slice(0, 240),
      description: fullText.slice(0, 1200),
      event_type: eventType,
      severity: detectSeverity(fullText, candidate.title),
      source: 'nchmf',
      url: candidate.url,
      published_at: publishedAt,
      provinces: provinceList,
      geometry,
      text: fullText,
      hash,
      approximate_geometry: true,
    });
  }
  return hazards;
}

interface S3Object { key: string; lastModified: string }

async function listVndmsObjects(prefix: string): Promise<S3Object[]> {
  const url = `https://${VNDMS_S3_HOST}/public?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=100`;
  const page = await fetchText(url);
  if (!page) return [];
  const objects: S3Object[] = [];
  const blocks = page.text.split('<Contents>').slice(1);
  for (const block of blocks) {
    const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
    const lastModified = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1];
    if (key && lastModified) objects.push({ key, lastModified });
  }
  return objects;
}

/** Crawl VNDMS public S3 (SOS PDFs + disaster media) and its config endpoint. */
export async function crawlVndms(now = Date.now()): Promise<{
  hazards: CrawledHazard[];
  documents: CrawledDocument[];
  sourceOk: boolean;
}> {
  const config = await fetchText(`https://${VNDMS_HOST}/api/config`);
  const sourceOk = Boolean(config && /"status"\s*:\s*"OK"/i.test(config.text));

  const objects = [
    ...(await listVndmsObjects('sos-message/')),
    ...(await listVndmsObjects('thongtin-thientai/')),
  ].filter((object) => !object.key.endsWith('/'));
  // PDFs are the only VNDMS objects that carry alert text. Filter them before
  // choosing a page so images/videos can never shadow a recent PDF.
  const pdfs = objects
    .filter((object) => /\.pdf$/i.test(object.key))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  const recentCutoff = now - 7 * 24 * 3600_000;
  const recentPdfs = pdfs.filter((object) => new Date(object.lastModified).getTime() >= recentCutoff);

  const hazards: CrawledHazard[] = [];
  const documents: CrawledDocument[] = [];
  const extracted = new Map<string, string>();
  for (const object of pdfs.slice(0, 24)) {
    const url = `https://${VNDMS_S3_HOST}/public/${object.key}`;
    const text = (await fetchPdfText(url)) || '';
    if (text.length < 40) continue;
    extracted.set(object.key, text);
    const publishedAt = new Date(object.lastModified).toISOString();
    const titleLine = text.split(/[.\n]/).map((line) => normalizeText(line)).find((line) => line.length > 20) || object.key;
    documents.push({
      document_id: `k-vndms-${sha1(url).slice(0, 24)}`,
      title: titleLine.slice(0, 300),
      text,
      source: 'vndms',
      url,
      published_at: publishedAt,
      kind: 'pdf',
      tags: ['kttv', 'vndms', 'pdf'],
    });
    // Only recent PDFs become map hazards; historical bulletins stay in the
    // knowledge base with their real publication date.
    if (!recentPdfs.some((candidate) => candidate.key === object.key)) continue;
    const eventType = detectEvent(text);
    const provinceList = detectProvinces(text);
    const { geometry } = geometryFor(provinceList);
    hazards.push({
      hazard_id: `vndms-${sha1(url).slice(0, 16)}`,
      title: titleLine.slice(0, 240),
      description: text.slice(0, 1200),
      event_type: eventType === 'other' ? 'other' : eventType,
      severity: detectSeverity(text, titleLine),
      source: 'vndms',
      url,
      published_at: publishedAt,
      provinces: provinceList,
      geometry,
      text,
      hash: sha1(text),
      approximate_geometry: true,
    });
  }
  return { hazards, documents, sourceOk };
}

export async function crawlAll(now = Date.now()): Promise<{
  hazards: CrawledHazard[];
  documents: CrawledDocument[];
  stats: { nchmf: number; vndms: number; vndmsDocuments: number; sourceOk: boolean; startedAt: string; finishedAt: string };
}> {
  const startedAt = new Date(now).toISOString();
  const [nchmf, vndms] = await Promise.all([
    crawlNchmf(now).catch(() => [] as CrawledHazard[]),
    crawlVndms(now).catch(() => ({ hazards: [] as CrawledHazard[], documents: [] as CrawledDocument[], sourceOk: false })),
  ]);
  const byId = new Map<string, CrawledHazard>();
  for (const hazard of [...nchmf, ...vndms.hazards]) byId.set(hazard.hazard_id, hazard);
  return {
    hazards: [...byId.values()],
    documents: vndms.documents,
    stats: {
      nchmf: nchmf.length,
      vndms: vndms.hazards.length,
      vndmsDocuments: vndms.documents.length,
      sourceOk: vndms.sourceOk,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
  };
}
