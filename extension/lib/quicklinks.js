// Quick links on the "Job search" tab: your own saved searches on LinkedIn,
// jobs.ch, the Arbeitsagentur and so on, one click away. Stored locally in
// chrome.storage like everything else. The UI is in ../quicklinks.js.

import { t } from './i18n.js';

export const LINKS_KEY = 'search:links';
export const MAX_LINKS = 60;
export const ICON_RETRY_MS = 7 * 86400000;

const SITE_NAMES = [
  ['linkedin.com', 'LinkedIn'],
  ['jobs.ch', 'jobs.ch'],
  ['jobup.ch', 'jobup.ch'],
  ['arbeitsagentur.de', 'Arbeitsagentur'],
  ['indeed.com', 'Indeed'],
  ['stepstone.de', 'StepStone'],
  ['xing.com', 'XING'],
  ['glassdoor.com', 'Glassdoor'],
  ['glassdoor.de', 'Glassdoor'],
  ['jobscout24.ch', 'JobScout24'],
  ['monster.de', 'Monster'],
  ['stellenwerk.de', 'Stellenwerk'],
];

const linkId = () => `ql-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// "linkedin.com/jobs/..." or "www.jobs.ch" -> full https link; '' if it is not a web address
export function normalizeLinkUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return '';
    return u.href;
  } catch {
    return '';
  }
}

export function hostOfLink(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function siteName(url) {
  const host = hostOfLink(url);
  if (!host) return '';
  for (const [domain, name] of SITE_NAMES) if (host === domain || host.endsWith(`.${domain}`)) return name;
  return host;
}

// A name for a link you paste: "Jobs Hamburg" from ...&location=Hamburg%2C%20Deutschland, else the site.
export function suggestTitle(url) {
  try {
    const u = new URL(url);
    const place = u.searchParams.get('location') || u.searchParams.get('wo') || u.searchParams.get('l') || u.searchParams.get('where') || '';
    const short = place.split(',')[0].trim();
    if (short && short.length <= 40) return t('qlJobsIn', short);
  } catch { /* not a URL */ }
  return siteName(url);
}

const isDataImage = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v) && v.length < 200000;

export function cleanLink(x) {
  if (!x || typeof x !== 'object') return null;
  const url = normalizeLinkUrl(x.url);
  if (!url) return null;
  return {
    id: typeof x.id === 'string' && x.id ? x.id.slice(0, 60) : linkId(),
    title: String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 60) || siteName(url),
    url,
    image: isDataImage(x.image) ? x.image : '',
    iconUrl: normalizeLinkUrl(x.iconUrl) || '',
    iconAt: Number(x.iconAt) || 0,
    custom: x.custom === true,
  };
}

export function newLink(fields) {
  return cleanLink({ ...fields, id: linkId() });
}

// Empty until you add your own links.
export async function loadLinks() {
  const got = await chrome.storage.local.get(LINKS_KEY);
  const saved = got[LINKS_KEY];
  if (!saved || !Array.isArray(saved.items)) return [];
  const seen = new Set();
  return saved.items.map(cleanLink).filter((l) => l && !seen.has(l.id) && seen.add(l.id)).slice(0, MAX_LINKS);
}

export async function saveLinks(items) {
  await chrome.storage.local.set({ [LINKS_KEY]: { version: 1, items: items.slice(0, MAX_LINKS) } });
}

// Icons a page names in its <head>, biggest first. apple-touch-icon is usually 180 px.
export function iconLinks(html, baseUrl) {
  const found = [];
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    };
    const rel = attr('rel').toLowerCase();
    if (!/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = attr('href').replace(/&amp;/g, '&');
    if (!href || href.startsWith('data:')) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    const sizes = attr('sizes').toLowerCase();
    let size = /apple-touch-icon/.test(rel) ? 180 : 32;
    const m = sizes.match(/(\d+)x(\d+)/g);
    if (m) size = Math.max(...m.map((s) => Number(s.split('x')[0])));
    if (/\.svg(\?|$)/i.test(url) || attr('type').includes('svg')) size = 20;   // often drawn without a size
    found.push({ url, size });
  }
  // ~64-192 px is ideal; huge ones cost time
  const score = (s) => (s >= 48 && s <= 256 ? 1000 + s : s > 256 ? 900 : s);
  return found.sort((a, b) => score(b.size) - score(a.size)).map((f) => f.url).filter((u, i, all) => all.indexOf(u) === i);
}

// Move a link before another (drag and drop) or by a step (keyboard).
export function moveLink(items, id, { before, step }) {
  const from = items.findIndex((l) => l.id === id);
  if (from < 0) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  let to;
  if (step) to = Math.max(0, Math.min(next.length, from + step));
  else if (before === null) to = next.length;
  else {
    to = next.findIndex((l) => l.id === before);
    if (to < 0) return items;
  }
  next.splice(to, 0, item);
  return next;
}

// Quick links from a backup: links you do not have yet are added at the end,
// nothing you have is changed or removed.
export function mergeLinks(current, incoming) {
  const items = (current || []).slice();
  const ids = new Set(items.map((l) => l.id));
  const urls = new Set(items.map((l) => l.url));
  let added = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const link = cleanLink(raw);
    if (!link || urls.has(link.url) || items.length >= MAX_LINKS) continue;
    if (ids.has(link.id)) link.id = linkId();
    items.push(link);
    ids.add(link.id);
    urls.add(link.url);
    added += 1;
  }
  return { items, added };
}

// For the backup file: the stored list, or null when the tab was never opened.
export async function storedLinks() {
  const got = await chrome.storage.local.get(LINKS_KEY);
  const saved = got[LINKS_KEY];
  return saved && Array.isArray(saved.items) ? saved.items.map(cleanLink).filter(Boolean) : null;
}

export async function importLinks(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return 0;
  const { items, added } = mergeLinks((await storedLinks()) || [], incoming);
  if (added) await saveLinks(items);
  return added;
}
