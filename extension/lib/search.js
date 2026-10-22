// Job search: asks the portals for postings of the last days and keeps them locally.
//
// Runs in the board page (button, opening the tab) and in the background service
// worker (chrome.alarms). No DOM here, the service worker has none.
//
// Nothing is preset: you add your own regions and search terms in the settings.
// Postings of the last 7 days are kept.
//
// Sources, each checked against the live sites (October 2026):
//   jobs.ch      /api/v1/public/search?query=..&sort=date&rows=20 (max 20 per page),
//                region-ids[] narrow it down, coordinates give the distance,
//                employment-type-ids[]: 5 permanent, 1 temporary, 2 freelance          (CH)
//   Arbeitsagentur  rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs,
//                public key "jobboerse-jobsuche", umkreis in km,
//                angebotsart 1 = work                                                 (DE)
//   LinkedIn     the public job search (logged out): jobs-guest/.../seeMoreJobPostings,
//                f_TPR=r<seconds>, distance in miles, 10 cards per page, keywords
//                understand OR, AND and parentheses (its job type filters do not
//                work logged out)                                                    (DE + CH)
//
// jobs.ch gave the extension's requests an empty list while the same search on the
// site found jobs. So they now look like the site's own: rules.json
// (declarativeNetRequest) sets Referer and Sec-Fetch-Site, and they carry the
// cookies jobs.ch already has in this browser.
//
// Every hit is kept only in regions of its own country: a German job that the
// search for a Swiss region finds near the border is not shown in that region.
//
// Storage:
//   search:config     what to look for (regions, sources, terms, auto refresh)
//   search:results    { bySource: { <source>: { at, items, error } }, fetchedAt }
//   search:seen       { key: when it was first found }        (written by the search)
//   search:dismissed  { key: when you hid it }                (written by the tab)
//   search:visit      when you last looked                    (written by the tab)
//   (one key per writer: the search and the open tab never overwrite each other)
//   search:lock       { at, done, total } while a search runs (page and background)

import { loadState, normalizeUrl } from './store.js';
import { t } from './i18n.js';
import { fetchDirect, fetchViaWorker } from './net.js';

export const SEARCH_ALARM = 'job-search';
const KEY_CONFIG = 'search:config';
const KEY_RESULTS = 'search:results';
const KEY_SEEN = 'search:seen';
const KEY_DISMISSED = 'search:dismissed';
const KEY_VISIT = 'search:visit';
const KEY_LOCK = 'search:lock';
export const FETCH_DAYS = 7;
export const DAY_OPTIONS = [1, 3, 7];
const KEEP_SEEN_DAYS = 45;
// stored results with another version are fetched again when the tab opens
export const RESULTS_VERSION = 1;
const LOCK_MS = 3 * 60 * 1000;

export const SOURCES = {
  jobcloud: { label: 'jobs.ch', countries: ['ch'] },
  arbeitsagentur: { label: 'Arbeitsagentur', countries: ['de'] },
  linkedin: { label: 'LinkedIn', countries: ['de', 'ch'] },
};

// Empty on purpose: regions and search terms are yours to add.
export function defaultSearchConfig() {
  return {
    version: 1,
    autoRefresh: true,
    intervalHours: 3,
    hideSenior: false,
    sources: { jobcloud: true, arbeitsagentur: true, linkedin: true },
    regions: [],
    showDays: 3,
    onlyMatching: true,
    exclude: '',
    terms: [],
  };
}

// ---------- storage ----------

export async function loadSearchConfig() {
  const data = await chrome.storage.local.get(KEY_CONFIG);
  const saved = data[KEY_CONFIG];
  const base = defaultSearchConfig();
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    sources: { ...base.sources, ...(saved.sources || {}) },
    regions: repairRegions(Array.isArray(saved.regions) ? saved.regions : []),
    terms: Array.isArray(saved.terms) ? saved.terms : [],
  };
}

// Numbers stay numbers, and a known town without coordinates gets them.
export function repairRegions(regions) {
  return regions.map((raw) => {
    const r = { ...raw, radiusKm: Number(raw.radiusKm) || 30 };
    r.lat = Number.isFinite(Number(raw.lat)) && raw.lat !== null && raw.lat !== '' ? Number(raw.lat) : null;
    r.lon = Number.isFinite(Number(raw.lon)) && raw.lon !== null && raw.lon !== '' ? Number(raw.lon) : null;
    const known = PLACE_INDEX.get(placeKey(r.place));
    if (r.lat == null && known && known.country === r.country) Object.assign(r, { lat: known.lat, lon: known.lon });
    return r;
  });
}

// A German town as the place of a Swiss region (or the other way round): the
// country it really is in, else ''.
export function wrongCountry(place, country) {
  const known = PLACE_INDEX.get(placeKey(place));
  return known && known.country && known.country !== country ? known.country : '';
}

export async function saveSearchConfig(config) {
  await chrome.storage.local.set({ [KEY_CONFIG]: config });
}

const emptyResults = () => ({ bySource: {}, fetchedAt: 0 });

// state = { seen, dismissed, lastVisit }, read from the three keys
export async function loadSearchData() {
  const data = await chrome.storage.local.get([KEY_RESULTS, KEY_SEEN, KEY_DISMISSED, KEY_VISIT]);
  return {
    results: data[KEY_RESULTS] || emptyResults(),
    state: {
      seen: data[KEY_SEEN] || {},
      dismissed: data[KEY_DISMISSED] || {},
      lastVisit: Number(data[KEY_VISIT]) || 0,
    },
  };
}

export async function saveDismissed(dismissed) {
  const keep = Date.now() - KEEP_SEEN_DAYS * 86400000;
  const clean = Object.fromEntries(Object.entries(dismissed).filter(([, at]) => at >= keep));
  await chrome.storage.local.set({ [KEY_DISMISSED]: clean });
}

export async function saveVisit(at = Date.now()) {
  await chrome.storage.local.set({ [KEY_VISIT]: at });
}

export const SEARCH_KEYS = {
  config: KEY_CONFIG, results: KEY_RESULTS, lock: KEY_LOCK, seen: KEY_SEEN, dismissed: KEY_DISMISSED, visit: KEY_VISIT,
};

// ---------- text helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const words = (s) => ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim()} `;
const compact = (s) => words(s).replace(/\s+/g, '');

// "Softwareentwickler" also finds "Software-Entwickler/in"; short words like "iOS" only as a whole word
export function matchesQuery(title, query) {
  const w = words(title);
  const q = words(query).trim();
  if (!q) return false;
  if (w.includes(` ${q} `)) return true;
  return q.length >= 8 && compact(title).includes(q.replace(/\s+/g, ''));
}

// Words that hide a title: whole words, or the start of a word ("Manager" also
// hides "Managerin"), but never the middle ("Sales" does not hide "Wholesales").
export function matchesExclude(title, word) {
  const w = words(title);
  const q = words(word).trim();
  if (!q) return false;
  return w.includes(` ${q} `) || (q.length >= 5 && w.includes(` ${q}`));
}

export function termsFor(title, terms) {
  return (terms || []).filter((g) => (g.queries || []).some((q) => matchesQuery(title, q))).map((g) => g.id);
}

export const isSenior = (title) => /\b(senior|sr\.?|lead|principal|head of|staff engineer|chief)\b/i.test(String(title || ''));

// ---------- places and countries ----------

// Towns with country: distances for LinkedIn hits (which come with a place name
// only) and the country of a hit when the portal does not say. Big cities, the
// area around Berlin, and around Lake Constance (where the tests play).
const PLACES = {
  // Germany
  Berlin: [52.5200, 13.4050, 'de'], Potsdam: [52.3906, 13.0645, 'de'], Teltow: [52.4024, 13.2708, 'de'],
  Kleinmachnow: [52.4067, 13.2178, 'de'], Falkensee: [52.5600, 13.0928, 'de'], 'Bernau bei Berlin': [52.6798, 13.5874, 'de'],
  Oranienburg: [52.7545, 13.2370, 'de'], 'Königs Wusterhausen': [52.2965, 13.6266, 'de'], Hennigsdorf: [52.6378, 13.2036, 'de'],
  Hamburg: [53.5511, 9.9937, 'de'], 'München': [48.1351, 11.5820, 'de'], Munich: [48.1351, 11.5820, 'de'],
  'Köln': [50.9375, 6.9603, 'de'], Cologne: [50.9375, 6.9603, 'de'], 'Frankfurt am Main': [50.1109, 8.6821, 'de'],
  Frankfurt: [50.1109, 8.6821, 'de'], Stuttgart: [48.7758, 9.1829, 'de'], 'Düsseldorf': [51.2277, 6.7735, 'de'],
  Leipzig: [51.3397, 12.3731, 'de'], Dresden: [51.0504, 13.7373, 'de'], Hannover: [52.3759, 9.7320, 'de'],
  'Nürnberg': [49.4521, 11.0767, 'de'], Bremen: [53.0793, 8.8017, 'de'], Essen: [51.4556, 7.0116, 'de'],
  Dortmund: [51.5136, 7.4653, 'de'], Karlsruhe: [49.0069, 8.4037, 'de'], Mannheim: [49.4875, 8.4660, 'de'],
  Konstanz: [47.6603, 9.1758, 'de'], Allensbach: [47.7150, 9.0700, 'de'], 'Radolfzell am Bodensee': [47.7400, 8.9700, 'de'],
  Radolfzell: [47.7400, 8.9700, 'de'], Singen: [47.7594, 8.8403, 'de'], 'Überlingen': [47.7672, 9.1591, 'de'],
  Meersburg: [47.6940, 9.2710, 'de'], Friedrichshafen: [47.6500, 9.4800, 'de'], Ravensburg: [47.7810, 9.6120, 'de'],
  Tuttlingen: [47.9850, 8.8200, 'de'], 'Villingen-Schwenningen': [48.0620, 8.4930, 'de'],
  // Switzerland
  'Zürich': [47.3769, 8.5417, 'ch'], Zurich: [47.3769, 8.5417, 'ch'], Winterthur: [47.4988, 8.7237, 'ch'],
  Bern: [46.9480, 7.4474, 'ch'], Genf: [46.2044, 6.1432, 'ch'], 'Genève': [46.2044, 6.1432, 'ch'], Geneva: [46.2044, 6.1432, 'ch'],
  Lausanne: [46.5197, 6.6323, 'ch'], Luzern: [47.0502, 8.3093, 'ch'], 'St. Gallen': [47.4245, 9.3767, 'ch'],
  Lugano: [46.0037, 8.9511, 'ch'], Biel: [47.1368, 7.2468, 'ch'], Zug: [47.1662, 8.5155, 'ch'], Chur: [46.8508, 9.5320, 'ch'],
  Aarau: [47.3925, 8.0444, 'ch'], Baden: [47.4724, 8.3064, 'ch'], Schlieren: [47.3967, 8.4475, 'ch'], Dietikon: [47.4017, 8.4001, 'ch'],
  Schaffhausen: [47.6973, 8.6349, 'ch'], Frauenfeld: [47.5536, 8.8987, 'ch'], Kreuzlingen: [47.6505, 9.1750, 'ch'],
  'Tägerwilen': [47.6566, 9.1356, 'ch'], Bottighofen: [47.6386, 9.2079, 'ch'], Weinfelden: [47.5665, 9.1070, 'ch'],
  Amriswil: [47.5470, 9.2960, 'ch'], Romanshorn: [47.5655, 9.3793, 'ch'], Arbon: [47.5166, 9.4333, 'ch'],
  // Austria
  Wien: [48.2082, 16.3738, 'at'], Vienna: [48.2082, 16.3738, 'at'], Bregenz: [47.5031, 9.7471, 'at'],
};

// "8001 Zürich", "Zürich, Zürich, Schweiz", "Kanton Zürich", "Region Stuttgart", "Bühl (Baden)",
// "BE Ittigen", "Hamburg und Umgebung" -> one key per town
export function placeKey(s) {
  let p = String(s || '').split(/,|\/|\boder\b|\bund\b(?! umgebung)|&|\|/i)[0];
  p = p.replace(/^\s*\d{4,5}\s+/, '').replace(/^\s*[A-Z]{2}\s+(?=\S)/, '').replace(/\(([^)]*)\)/g, (m, inner) => (/^baden$/i.test(inner.trim()) ? ' baden' : ' '));
  let w = words(p).trim();
  w = w.replace(/^(region|raum|grossraum|metropolregion|kanton|greater|umgebung|stadt|city of)\s+/, '');
  w = w.replace(/\s+(city|stadt|area|region|und umgebung|umgebung|landschaft|land|metropolitan area)$/, '');
  return w.trim();
}

const PLACE_INDEX = new Map(Object.entries(PLACES).map(([name, [lat, lon, cc]]) => [placeKey(name), { lat, lon, country: cc }]));

const COUNTRY_WORDS = [
  ['ch', /^(schweiz|switzerland|suisse|svizzera|ch)$/i],
  ['de', /^(deutschland|germany|allemagne|de)$/i],
  ['fr', /^(frankreich|france|fr)$/i],
  ['at', /^(osterreich|österreich|austria|at)$/i],
  ['li', /^(liechtenstein|li)$/i],
];
const CANTONS = /^(zürich|zurich|bern|berne|luzern|lucerne|uri|schwyz|obwalden|nidwalden|glarus|zug|freiburg ch|fribourg|solothurn|basel-stadt|basel-landschaft|basel-land|baselland|basel|schaffhausen|appenzell.*|st\.? gallen|graubünden|graubunden|aargau|thurgau|tessin|ticino|waadt|vaud|wallis|valais|neuenburg|neuchatel|neuchâtel|genf|geneve|genève|geneva|jura)$/i;
const DE_STATES = /^(baden-württemberg|baden-wurttemberg|bayern|bavaria|hessen|hesse|rheinland-pfalz|rhineland-palatinate|saarland|nordrhein-westfalen|north rhine-westphalia|niedersachsen|lower saxony|berlin|hamburg|bremen|sachsen|saxony|sachsen-anhalt|thüringen|thuringia|brandenburg|mecklenburg-vorpommern|schleswig-holstein)$/i;
const FR_REGIONS = /^(île-de-france|ile-de-france|auvergne-rhône-alpes|auvergne-rhone-alpes|bourgogne-franche-comté|bourgogne-franche-comte|bretagne|centre-val de loire|corse|grand est|hauts-de-france|normandie|nouvelle-aquitaine|occitanie|pays de la loire|provence-alpes-côte d'azur|provence-alpes-cote d'azur)$/i;

// Country of a location string: { country, explicit } (explicit = the text names it).
export function countryOfPlace(location) {
  const parts = String(location || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const part of parts.slice(1).reverse()) {
    for (const [cc, re] of COUNTRY_WORDS) if (re.test(part)) return { country: cc, explicit: true };
    if (DE_STATES.test(part)) return { country: 'de', explicit: true };
    if (FR_REGIONS.test(part)) return { country: 'fr', explicit: true };
    if (CANTONS.test(part)) return { country: 'ch', explicit: true };
  }
  if (/\b(schweiz|switzerland|suisse)\b/i.test(location)) return { country: 'ch', explicit: true };
  if (/\b(deutschland|germany)\b/i.test(location)) return { country: 'de', explicit: true };
  const known = PLACE_INDEX.get(placeKey(location));
  return { country: known ? known.country : '', explicit: false };
}

function distanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return Math.round(12742 * Math.asin(Math.sqrt(h)));
}

// Same job on two portals: same company, same title (without gender tags, workload,
// legal form) and same town. Two offices of the same company stay two hits.
function cleanTitleKey(title) {
  return compact(String(title || '').toLowerCase()
    .replace(/\((?:[mwfdxa*:/ ]|all|alle|genders?|gn|divers)+\)/gi, ' ')
    .replace(/\b[mwfd]\s*\/\s*[mwfd](\s*\/\s*[mwfdx])?\b/gi, ' ')
    .replace(/\(?\d{1,3}\s*%?\s*(-|–|bis)?\s*\d{0,3}\s*%\)?/g, ' ')
    .replace(/\b(all genders|alle geschlechter|w\/m\/d|m\/w\/d|d\/w\/m)\b/gi, ' '));
}
function cleanCompanyKey(company) {
  return compact(String(company || '').toLowerCase()
    .replace(/\b(ag|gmbh|sa|sàrl|sarl|ltd|llc|inc|se|kg|co\.?|& co\.? kg|gruppe|group|holding|schweiz|switzerland|deutschland|germany)\b/g, ' '));
}
export function hitKey(company, title, location = '') {
  return `${cleanCompanyKey(company)}|${cleanTitleKey(title)}|${compact(placeKey(location))}`;
}
const baseKeyOf = (key) => key.slice(0, key.lastIndexOf('|') + 1);

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOf = (value) => {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : isoDay(d);
};
export const cutoffDay = (days) => isoDay(new Date(Date.now() - days * 86400000));
// "last 3 days" = today and the two days before
export const sinceDay = (days) => cutoffDay(Math.max(0, days - 1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A dropped connection, a timeout or an overloaded server: tried again a few
// seconds later before the portal counts as not reachable.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
async function withRetry(fn, retries) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const transient = err && err.name !== 'SyntaxError' && (!err.status || RETRY_STATUS.has(err.status));
      if (attempt >= retries || !transient) throw err;
      await sleep(attempt ? 4000 : 1500);
    }
  }
}
const getJson = (url, init = {}, retries = 0) => withRetry(() => fetchDirect(url, { init, as: 'json' }), retries);
// web pages (LinkedIn's lists, job pages) through the service worker, see lib/net.js
const getText = (url, init = {}) => fetchViaWorker(url, { init, as: 'text' });

// ---------- jobs.ch ----------

// jobs.ch has no radius filter. Its regions narrow the search (a region counts
// when one of its towns is in reach), the coordinates of each posting give the
// exact distance.
const JOBCLOUD_REGIONS = {
  4: [[46.00, 8.95], [46.19, 9.02]], 5: [[47.14, 9.52]], 6: [[46.20, 6.15]], 7: [[47.37, 8.54]],
  9: [[46.80, 7.15], [46.99, 6.93]], 10: [[46.52, 6.63], [46.23, 7.36]], 11: [[46.85, 9.53]],
  12: [[47.55, 7.79], [47.35, 7.90], [47.39, 8.04], [47.21, 7.54], [47.47, 8.31]],
  13: [[47.36, 7.34], [47.42, 7.08], [47.14, 7.25], [46.95, 7.45]], 14: [[47.56, 7.59], [47.48, 7.73], [47.42, 7.50]],
  15: [[47.05, 8.31], [47.17, 8.52]], 17: [[47.46, 9.05]], 18: [[47.56, 8.90]], 19: [[47.37, 8.54]],
  20: [[47.33, 8.75]], 21: [[47.42, 9.37]], 22: [[47.40, 8.40], [47.48, 8.46]], 23: [[47.04, 9.07]],
  25: [[47.50, 8.72], [47.70, 8.63]],
};
const JOBCLOUD_TYPES = ['5', '1', '2'];   // permanent, temporary, freelance
const JOBCLOUD_HEADERS = { accept: 'application/json' };
// with the cookies jobs.ch already set in this browser, like the site's own requests
const JOBCLOUD_INIT = { headers: JOBCLOUD_HEADERS, credentials: 'include' };

export function jobcloudRegionIds(region) {
  return Object.entries(JOBCLOUD_REGIONS)
    .filter(([, towns]) => towns.some(([lat, lon]) => (distanceKm({ lat, lon }, region) ?? 1e9) <= region.radiusKm))
    .map(([id]) => id);
}

export function parseJobcloud(doc, region) {
  const coords = doc.coordinates && Number.isFinite(doc.coordinates.lat) ? { lat: doc.coordinates.lat, lon: doc.coordinates.lon } : null;
  const grades = (Array.isArray(doc.employment_grades) ? doc.employment_grades : []).map(Number).filter((n) => n > 0 && n <= 100);
  const lo = grades.length ? Math.min(...grades) : 0;
  const hi = grades.length ? Math.max(...grades) : 0;
  const links = doc._links || {};
  const link = links.detail_de || links.detail_en || links.detail_fr;
  const logo = doc.company_logo_file || ((doc.images || []).find((i) => i.context === 'logo') || {}).url || '';
  const location = stripTags(doc.place).replace(/^Arbeitsort\s*/i, '');
  const place = countryOfPlace(location);
  return {
    title: stripTags(doc.title),
    company: stripTags(doc.company_name),
    location,
    country: place.explicit && place.country ? place.country : 'ch',
    postedAt: dayOf(doc.publication_date),
    firstPublishedAt: dayOf(doc.initial_publication_date),
    distanceKm: distanceKm(region, coords),
    lat: coords ? coords.lat : null,
    lon: coords ? coords.lon : null,
    workload: hi ? (lo === hi ? `${hi} %` : `${lo}-${hi} %`) : '',
    logoUrl: /^https:\/\//.test(logo) ? logo : '',
    url: (link && link.href) || `https://www.jobs.ch/de/stellenangebote/detail/${doc.job_id}/`,
    sourceKey: `jobcloud:${String(doc.job_id).toLowerCase()}`,
    id: String(doc.job_id),
  };
}

export function jobcloudUrl({ query, region, page }) {
  const params = new URLSearchParams({ rows: '20', sort: 'date', page: String(page) });
  if (query) params.set('query', query);
  const ids = region.lat != null ? jobcloudRegionIds(region) : [];
  if (ids.length) ids.forEach((id) => params.append('region-ids[]', id));
  else params.set('location', region.place);
  JOBCLOUD_TYPES.forEach((id) => params.append('employment-type-ids[]', id));
  return `https://www.jobs.ch/api/v1/public/search?${params}`;
}

// stats: counters for the details line (requests, received, older, far, ...)
const newStats = () => ({ requests: 0, failed: 0, received: 0, older: 0, far: 0, country: 0, kept: 0, total: 0 });
const statKey = (regionId, hit) => `${regionId}|${hit.sourceKey || `${hit.title}|${hit.location}`}`;
// Each posting counts once per region, even when several search terms find it.
function tally(stats, field, key) {
  const keys = (stats._keys ||= {});
  const set = (keys[field] ||= new Set());
  set.add(key);
  stats[field] = set.size;
}

async function searchJobcloud({ query, region, days, maxPages, stats = newStats() }) {
  const cutoff = cutoffDay(days);
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    stats.requests += 1;
    const json = await getJson(jobcloudUrl({ query, region, page }), JOBCLOUD_INIT, 2);
    // an answer without a list is not "no jobs": say so instead of showing 0
    if (!json || !Array.isArray(json.documents)) throw Object.assign(new Error('unexpected answer'), { unexpected: true });
    const docs = json.documents;
    if (page === 1) stats.total += Number(json.total_hits) || 0;
    let older = false;
    for (const doc of docs) {
      const hit = parseJobcloud(doc, region);
      tally(stats, 'received', statKey(region.id, hit));
      if (hit.postedAt && hit.postedAt < cutoff) { older = true; tally(stats, 'older', statKey(region.id, hit)); continue; }
      if (hit.distanceKm != null && hit.distanceKm > Number(region.radiusKm)) { tally(stats, 'far', statKey(region.id, hit)); continue; }
      out.push(hit);
    }
    if (older || docs.length < 20) break;
    await sleep(250);
  }
  return out;
}

// ---------- Arbeitsagentur ----------

const BA_BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6';
const BA_HEADERS = { 'X-API-Key': 'jobboerse-jobsuche', accept: 'application/json' };
// the API only knows these values for "published within"; longer means: no limit
const baDays = (days) => [0, 1, 7, 14, 28].find((d) => d >= days);
const BA_LANDS = { DEUTSCHLAND: 'de', SCHWEIZ: 'ch', FRANKREICH: 'fr', OESTERREICH: 'at', 'ÖSTERREICH': 'at', LIECHTENSTEIN: 'li' };

const km = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

export function parseArbeitsagentur(x) {
  const place = (x.stellenlokationen || [])[0] || x.arbeitsort || {};
  const address = place.adresse || place;
  const ref = String(x.referenznummer || x.refnr || '');
  const ort = stripTags(address.ort || '');
  let title = stripTags(x.stellenangebotsTitel || x.titel || x.beruf);
  // "Softwareentwickler (m/w/d) – Hamburg": the place is shown anyway
  if (ort && title.length > ort.length + 3) {
    const tail = title.slice(-ort.length - 3);
    if (/^\s[–-]\s$/.test(tail.slice(0, 3)) && tail.slice(3).toLowerCase() === ort.toLowerCase()) title = title.slice(0, -ort.length - 3).trim();
  }
  const land = String(address.land || '').toUpperCase();
  return {
    title,
    company: stripTags(x.firma || x.arbeitgeber),
    location: ort,
    country: BA_LANDS[land] || (land ? 'other' : 'de'),
    postedAt: dayOf((x.veroeffentlichungszeitraum && x.veroeffentlichungszeitraum.von) || x.aktuelleVeroeffentlichungsdatum || x.datumErsteVeroeffentlichung),
    firstPublishedAt: dayOf(x.datumErsteVeroeffentlichung),
    distanceKm: km(x.entfernung ?? place.entfernung),
    lat: Number.isFinite(place.breite) ? place.breite : null,
    lon: Number.isFinite(place.laenge) ? place.laenge : null,
    workload: '',
    logoUrl: '',
    url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`,
    sourceKey: `ba:${ref}`,
    id: ref,
  };
}

export function baUrl({ query, region, days, page }) {
  const params = new URLSearchParams({ wo: region.place, umkreis: String(region.radiusKm), angebotsart: '1', size: '100', page: String(page) });
  if (query) params.set('was', query);
  const since = baDays(days);
  if (since != null) params.set('veroeffentlichtseit', String(since));
  return `${BA_BASE}/jobs?${params}`;
}

async function searchArbeitsagentur({ query, region, days, maxPages, stats = newStats() }) {
  const cutoff = cutoffDay(days);
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    stats.requests += 1;
    const json = await getJson(baUrl({ query, region, days, page }), { headers: BA_HEADERS }, 2);
    const list = Array.isArray(json.ergebnisliste) ? json.ergebnisliste : (json.stellenangebote || []);
    if (page === 1) stats.total += Number(json.maxErgebnisse) || 0;
    const hits = list.map(parseArbeitsagentur).filter((h) => h.id);
    const fresh = hits.filter((h) => !h.postedAt || h.postedAt >= cutoff);
    for (const h of hits) {
      tally(stats, 'received', statKey(region.id, h));
      if (!fresh.includes(h)) tally(stats, 'older', statKey(region.id, h));
    }
    out.push(...fresh);
    const total = Number(json.maxErgebnisse) || 0;
    if (list.length < 100 || page * 100 >= total) break;
    await sleep(250);
  }
  return out;
}

// ---------- LinkedIn (public search) ----------

export function parseLinkedinCards(html) {
  return String(html || '').split(/<li[\s>]/).slice(1).map((li) => {
    const id = (li.match(/urn:li:jobPosting:(\d+)/) || [])[1];
    if (!id) return null;
    const pick = (re) => stripTags((li.match(re) || [])[1] || '');
    const logo = decodeEntities((li.match(/data-delayed-url="([^"]*company-logo[^"]*)"/) || [])[1] || '');
    const rawLocation = pick(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
    const place = countryOfPlace(rawLocation);
    return {
      title: pick(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
      company: pick(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
      location: rawLocation.replace(/,\s*(Schweiz|Switzerland|Suisse|Svizzera|Deutschland|Germany|Allemagne)$/i, ''),
      country: place.country,
      countryExplicit: place.explicit,
      postedAt: dayOf((li.match(/<time[^>]*datetime="([^"]+)"/) || [])[1]),
      firstPublishedAt: '',
      distanceKm: null,
      workload: '',
      logoUrl: /^https:\/\/media\.licdn\.com\//.test(logo) ? logo : '',
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      sourceKey: `linkedin:${id}`,
      id,
    };
  }).filter(Boolean);
}

const quoted = (q) => (/\s/.test(q) ? `"${q}"` : q);

export function linkedinKeywords(terms) {
  return [...new Set((terms || []).flatMap((g) => g.queries || []).map((q) => q.trim()).filter(Boolean))].map(quoted).join(' OR ');
}

const COUNTRY_NAMES = { de: 'Deutschland', ch: 'Schweiz', fr: 'Frankreich', at: 'Österreich', li: 'Liechtenstein' };

// LinkedIn's own id for a place ("Zürich, Zürich, Schweiz"), looked up when you save
// a region; without it, LinkedIn guesses the place from the text and can land on
// the wrong side of a border.
export function knownGeoId(region) {
  return region && region.linkedinGeoId ? { geoId: region.linkedinGeoId, geoName: region.linkedinGeoName || region.place } : null;
}

export function linkedinUrl({ keywords, region, days, start }) {
  const geo = knownGeoId(region);
  const params = new URLSearchParams({ keywords });
  if (geo) {
    params.set('geoId', geo.geoId);
    params.set('location', geo.geoName || region.place);
  } else {
    // a town name alone can be ambiguous for LinkedIn: say which country
    params.set('location', `${region.place}, ${COUNTRY_NAMES[region.country] || ''}`.replace(/,\s*$/, ''));
  }
  params.set('distance', String(Math.max(5, Math.round(Number(region.radiusKm) / 1.609))));
  params.set('f_TPR', `r${days * 86400}`);
  params.set('sortBy', 'DD');
  params.set('start', String(start));
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
}

// The geoId of a place you add yourself, from LinkedIn's place suggestions.
export async function linkedinGeo(place, country) {
  try {
    const url = `https://www.linkedin.com/jobs-guest/api/typeaheadHits?${new URLSearchParams({
      origin: 'jserp', typeaheadType: 'GEO', geoTypes: 'POPULATED_PLACE', query: place,
    })}`;
    const hits = JSON.parse(await getText(url));
    const want = COUNTRY_NAMES[country];
    const hit = (Array.isArray(hits) ? hits : []).find((h) => h && h.id && (!want || String(h.displayName || '').endsWith(want)));
    return hit ? { geoId: String(hit.id), geoName: String(hit.displayName || place) } : null;
  } catch {
    return null;
  }
}

async function searchLinkedin({ keywords, region, days, maxPages, stats = newStats() }) {
  const cutoff = cutoffDay(days);
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = linkedinUrl({ keywords, region, days, start: page * 10 });
    stats.requests += 1;
    let html;
    try {
      html = await getText(url);
    } catch (err) {
      if (err.status !== 429) throw err;
      // LinkedIn slows down guests that ask too often: wait once, then keep what we have
      await sleep(6000);
      try {
        html = await getText(url);
      } catch (again) {
        if (out.length) break;
        throw again;
      }
    }
    const cards = parseLinkedinCards(html);
    const fresh = cards.filter((c) => !c.postedAt || c.postedAt >= cutoff);
    for (const c of cards) {
      tally(stats, 'received', statKey(region.id, c));
      if (!fresh.includes(c)) tally(stats, 'older', statKey(region.id, c));
    }
    out.push(...fresh);
    if (cards.length < 10) break;
    await sleep(1500);
  }
  return out;
}

// ---------- region and distance of each hit ----------

function gazetteer(bySource) {
  const map = new Map(PLACE_INDEX);
  for (const entry of Object.values(bySource)) {
    for (const it of (entry && entry.items) || []) {
      const k = placeKey(it.location);
      if (k && it.lat != null && !map.has(k)) map.set(k, { lat: it.lat, lon: it.lon, country: it.country || '' });
    }
  }
  return map;
}

// LinkedIn shows places in your own country without the country ("Konstanz"),
// foreign ones with it ("Zürich, Zürich, Schweiz"). So within one
// LinkedIn search: if the region's country is ever named, a place that names no
// country is from somewhere else.
export function belongsToRegion(item, region, { countryNamed }) {
  if (item.country) return item.country === region.country;
  return !countryNamed;
}

// Distances for hits that came without one, then: every hit only in regions of its
// country, and nothing clearly outside the radius.
export function placeHits(bySource, regions) {
  const places = gazetteer(bySource);
  for (const [source, entry] of Object.entries(bySource)) {
    if (!entry || !Array.isArray(entry.items)) continue;
    const named = {};
    for (const it of entry.items) {
      const region = regions.find((r) => r.id === it.region);
      if (region && it.countryExplicit && it.country === region.country) named[region.id] = true;
    }
    const stats = entry.stats || newStats();
    entry.items = entry.items.filter((it) => {
      const region = regions.find((r) => r.id === it.region);
      if (!region) return false;
      const pos = places.get(placeKey(it.location));
      if (!it.country && pos && pos.country) it.country = pos.country;
      if (!belongsToRegion(it, region, { countryNamed: source === 'linkedin' && named[region.id] })) { tally(stats, 'country', statKey(region.id, it)); return false; }
      if (it.distanceKm == null && region.lat != null && pos) it.distanceKm = distanceKm(region, pos);
      if (it.distanceKm != null && it.distanceKm > Number(region.radiusKm) + 5) { tally(stats, 'far', statKey(region.id, it)); return false; }
      return true;
    });
    const kept = new Set(entry.items.map((it) => statKey(it.region, it)));
    stats.kept = kept.size;
    stats.byRegion = {};
    for (const k of kept) {
      const rid = k.slice(0, k.indexOf('|'));
      stats.byRegion[rid] = (stats.byRegion[rid] || 0) + 1;
    }
    delete stats._keys;
    entry.stats = stats;
  }
  return bySource;
}

// ---------- running a search ----------

async function takeLock() {
  const { [KEY_LOCK]: lock } = await chrome.storage.local.get(KEY_LOCK);
  if (lock && Date.now() - lock.at < LOCK_MS) return false;
  await chrome.storage.local.set({ [KEY_LOCK]: { at: Date.now(), done: 0, total: 0 } });
  return true;
}
const releaseLock = () => chrome.storage.local.remove(KEY_LOCK);

function errorText(err) {
  if (err && (err.unexpected || err.name === 'SyntaxError')) return t('searchErrAnswer');
  if (err && err.status === 429) return t('searchErrBusy');
  if (err && err.status) return t('searchErrHttp', String(err.status));
  if (err && err.name === 'AbortError') return t('searchErrTimeout');
  return t('searchErrNetwork');
}

// What to ask for: every search term per region at jobs.ch and the Arbeitsagentur,
// all terms in one LinkedIn search per region.
export function planSearch(config) {
  const days = FETCH_DAYS;
  const regions = config.regions.filter((r) => r.enabled && r.place);
  const queries = [...new Set((config.terms || []).flatMap((g) => g.queries || []).map((q) => q.trim()).filter(Boolean))];
  const tasks = [];
  if (!queries.length) return tasks;
  for (const region of regions) {
    if (config.sources.jobcloud && region.country === 'ch') {
      queries.forEach((q) => tasks.push({ source: 'jobcloud', region, args: { query: q, region, days, maxPages: 6 } }));
    }
    if (config.sources.arbeitsagentur && region.country === 'de') {
      queries.forEach((q) => tasks.push({ source: 'arbeitsagentur', region, args: { query: q, region, days, maxPages: 1 } }));
    }
    if (config.sources.linkedin) {
      tasks.push({ source: 'linkedin', region, args: { keywords: linkedinKeywords(config.terms), region, days, maxPages: 8 } });
    }
  }
  return tasks;
}

const RUNNERS = { jobcloud: searchJobcloud, arbeitsagentur: searchArbeitsagentur, linkedin: searchLinkedin };

// Asks every enabled source for every region. A source that fails keeps its
// previous results, so one bad moment at LinkedIn does not empty the list.
export async function runSearch({ onProgress } = {}) {
  if (!(await takeLock())) return { busy: true };
  try {
    const config = await loadSearchConfig();
    const regions = config.regions.filter((r) => r.enabled && r.place);
    const tasks = planSearch(config);
    const { results: previous } = await loadSearchData();
    const bySource = {};
    let done = 0;
    // The lock doubles as progress (the page shows it) and keeps the service
    // worker awake: every extension API call resets its idle timer.
    const report = () => {
      chrome.storage.local.set({ [KEY_LOCK]: { at: Date.now(), done, total: tasks.length } }).catch(() => {});
      if (onProgress) onProgress({ done, total: tasks.length });
    };
    report();
    // one queue per source, the sources in parallel
    await Promise.all(Object.keys(SOURCES).map(async (source) => {
      const mine = tasks.filter((x) => x.source === source);
      if (!mine.length) return;
      const items = [];
      const stats = newStats();
      let error = '';
      for (const task of mine) {
        try {
          const hits = await RUNNERS[source]({ ...task.args, stats });
          for (const h of hits) items.push({ ...h, source, region: task.region.id });
        } catch (err) {
          error = errorText(err);
          stats.failed += 1;
        }
        done += 1;
        report();
        await sleep(source === 'linkedin' ? 1500 : 200);
      }
      // nothing came back and something failed: keep the old list (with its date)
      const before = previous.bySource[source];
      if (!items.length && error) {
        bySource[source] = before && (before.items || []).length
          ? { ...before, error, failedAt: Date.now() }
          : { at: 0, items: [], error, failedAt: Date.now(), stats };
      } else {
        // some requests failed, the others brought this list
        bySource[source] = { at: Date.now(), items, error, partial: Boolean(error), stats };
      }
    }));
    placeHits(bySource, regions);
    const results = { version: RESULTS_VERSION, bySource, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [KEY_RESULTS]: results });
    await markSeen(results, config);
    await updateBadge();
    return { results };
  } finally {
    await releaseLock();
  }
}

// ---------- merging and filtering ----------

// All sources -> one list. The same job from two portals becomes one hit with both links.
export function mergeHits(results, config) {
  const map = new Map();
  const regions = new Map(config.regions.map((r) => [r.id, r]));
  // fixed order, so the same job always gets the same title and link
  for (const source of Object.keys(SOURCES)) {
    const entry = (results.bySource || {})[source];
    if (!entry || !config.sources[source]) continue;
    for (const h of entry.items || []) {
      const region = regions.get(h.region);
      if (!region || !h.title) continue;
      const country = h.country || countryOfPlace(h.location).country;
      if (country && country !== region.country) continue;
      const key = hitKey(h.company, h.title, h.location);
      let hit = map.get(key);
      if (!hit) {
        hit = {
          key, baseKey: baseKeyOf(key), title: h.title, company: h.company, location: h.location, postedAt: h.postedAt,
          firstPublishedAt: h.firstPublishedAt || '', distanceKm: h.distanceKm, workload: h.workload,
          logoUrl: h.logoUrl, regions: [], sources: [], terms: termsFor(h.title, config.terms),
        };
        map.set(key, hit);
      }
      if (!hit.regions.includes(h.region)) hit.regions.push(h.region);
      if (!hit.sources.some((s) => s.source === source)) hit.sources.push({ source, url: h.url, sourceKey: h.sourceKey, id: h.id });
      if (h.postedAt && (!hit.postedAt || h.postedAt < hit.postedAt)) hit.postedAt = h.postedAt;
      if (!hit.logoUrl && h.logoUrl) hit.logoUrl = h.logoUrl;
      if (!hit.workload && h.workload) hit.workload = h.workload;
      if (hit.distanceKm == null && h.distanceKm != null) hit.distanceKm = h.distanceKm;
      if (!hit.location && h.location) hit.location = h.location;
    }
  }
  return [...map.values()];
}

// Why a hit is not shown in the normal list ('' = shown)
export function hiddenReason(hit, { config, state, boardKeys }) {
  if (boardJobFor(hit, boardKeys)) return 'board';
  if (state.dismissed[hit.key]) return 'dismissed';
  if (config.onlyMatching && !hit.terms.length) return 'nomatch';
  if (config.hideSenior && isSenior(hit.title)) return 'senior';
  const exclude = String(config.exclude || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (exclude.some((x) => matchesExclude(hit.title, x))) return 'excluded';
  return '';
}

// sourceKey, link and company|title|town of every job on the board -> its id
export function boardKeysOf(jobs) {
  const keys = new Map();
  for (const j of jobs) {
    if (j.sourceKey) keys.set(j.sourceKey, j.id);
    const u = normalizeUrl(j.url);
    if (u) keys.set(u, j.id);
    const key = hitKey(j.company, j.title, j.location);
    keys.set(key, j.id);
    // the same company and title on the board in any town counts too
    if (!keys.has(baseKeyOf(key))) keys.set(baseKeyOf(key), j.id);
  }
  return keys;
}

export function boardJobFor(hit, boardKeys) {
  for (const s of hit.sources) {
    const id = boardKeys.get(s.sourceKey) || boardKeys.get(normalizeUrl(s.url));
    if (id) return id;
  }
  return boardKeys.get(hit.key) || boardKeys.get(hit.baseKey) || '';
}

async function markSeen(results, config) {
  const { state } = await loadSearchData();
  const seen = { ...state.seen };
  const now = Date.now();
  for (const hit of mergeHits(results, config)) if (!seen[hit.key]) seen[hit.key] = now;
  const keep = now - KEEP_SEEN_DAYS * 86400000;
  for (const [k, at] of Object.entries(seen)) if (at < keep) delete seen[k];
  await chrome.storage.local.set({ [KEY_SEEN]: seen });
}

// New hits since you last looked.
export function newHits({ results, state, config, boardKeys }) {
  const cutoff = sinceDay(config.showDays);
  return mergeHits(results, config).filter((h) => (state.seen[h.key] || 0) > (state.lastVisit || 0)
    && (!h.postedAt || h.postedAt >= cutoff)
    && !hiddenReason(h, { config, state, boardKeys }));
}

// Number on the toolbar icon.
export async function countNew() {
  const [config, board, { results, state }] = await Promise.all([loadSearchConfig(), loadState(), loadSearchData()]);
  return newHits({ results, state, config, boardKeys: boardKeysOf(board.jobs) }).length;
}

export async function updateBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const n = await countNew().catch(() => 0);
  await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
  if (n) await chrome.action.setBadgeBackgroundColor({ color: '#2f4bd9' });
  if (n && chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
}

// Background refresh with chrome.alarms. `reset` after a settings change; without
// it an existing alarm is kept (Chrome may drop alarms on restart or update).
export async function scheduleSearch({ reset = false } = {}) {
  if (!chrome.alarms) return;
  const config = await loadSearchConfig();
  if (!config.autoRefresh) { await chrome.alarms.clear(SEARCH_ALARM); return; }
  if (!reset && await chrome.alarms.get(SEARCH_ALARM)) return;
  const minutes = Math.max(30, Math.round((Number(config.intervalHours) || 3) * 60));
  const { results } = await loadSearchData();
  // never searched: the first search runs when you open the tab
  const since = results.fetchedAt ? (Date.now() - results.fetchedAt) / 60000 : 0;
  const delay = results.fetchedAt ? Math.max(1, minutes - since) : minutes;
  await chrome.alarms.create(SEARCH_ALARM, { delayInMinutes: delay, periodInMinutes: minutes });
}

export async function searchProgress() {
  const { [KEY_LOCK]: lock } = await chrome.storage.local.get(KEY_LOCK);
  return lock && Date.now() - lock.at < LOCK_MS ? lock : null;
}

// Place name -> coordinates, with the portals' own geocoding (no extra service).
export async function locate(place, country) {
  try {
    if (country === 'de') {
      const json = await getJson(`${BA_BASE}/jobs?${new URLSearchParams({ wo: place, size: '1', page: '1' })}`, { headers: BA_HEADERS });
      const c = json.woOutput && json.woOutput.koordinaten && json.woOutput.koordinaten[0];
      return c ? { lat: c.lat, lon: c.lon } : null;
    }
    const known = PLACE_INDEX.get(placeKey(place));
    if (known && known.country === country) return { lat: known.lat, lon: known.lon };
    const json = await getJson(`https://www.jobs.ch/api/v1/public/search?${new URLSearchParams({ location: place, rows: '20' })}`, JOBCLOUD_INIT);
    const want = place.trim().toLowerCase();
    const pts = (json.documents || []).filter((d) => d.coordinates && String(d.place || '').toLowerCase().includes(want)).map((d) => d.coordinates);
    if (!pts.length) return null;
    const mid = (k) => pts.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
    return { lat: mid('lat'), lon: mid('lon') };
  } catch {
    return null;
  }
}

// ---------- details when you save a hit ----------

export function sourceLabel(source) {
  return (SOURCES[source] || {}).label || source;
}

const cleanText = (s) => String(s || '')
  .replace(/ /g, ' ').replace(/\r/g, '').replace(/[ \t\f\v]+/g, ' ')
  .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// HTML from a portal -> readable text, without a DOM (works in the service worker too)
export function htmlToText(html) {
  let src = String(html || '');
  if (/&lt;\/?[a-z]/i.test(src)) src = decodeEntities(src);
  if (!/<[a-z][\s\S]*>/i.test(src)) return cleanText(decodeEntities(src));
  return cleanText(decodeEntities(src
    .replace(/<(script|style|noscript|head|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|h[1-6])>/gi, '\n\n')
    .replace(/<\/?(div|ul|ol|li|tr|section|table|p|h[1-6]|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))).replace(/\n{2,}(?=• )/g, '\n');
}

// Description and more for one hit, from the portal it came from.
export async function fetchDetails(src) {
  if (src.source === 'jobcloud') {
    const j = await getJson(`https://www.jobs.ch/api/v1/public/search/job/${src.id}`, JOBCLOUD_INIT);
    const person = j.contact_person && !Array.isArray(j.contact_person) ? j.contact_person : (Array.isArray(j.contacts) && j.contacts[0]) || null;
    let description = htmlToText(j.template_text || '');
    if (description.length < 80 && j.template) description = htmlToText(j.template);
    return {
      description,
      contactName: person ? [person.firstName, person.lastName].filter(Boolean).join(' ') : '',
      contactEmail: j.application_email || (person && person.email) || '',
      contactPhone: (person && person.phone) || '',
    };
  }
  if (src.source === 'linkedin') {
    const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${src.id}`);
    const m = html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<button|<\/section|<\/div)/);
    return { description: m ? htmlToText(m[1]) : '' };
  }
  if (src.source === 'arbeitsagentur') {
    // The API's detail endpoint does not answer cross-origin, but the job page
    // carries the same data as Angular state in the HTML.
    const html = await getText(`https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(src.id)}`);
    const m = html.match(/<script id="ng-state"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { description: '' };
    let state;
    try {
      state = JSON.parse(m[1]);
    } catch {
      // older Angular escaped the JSON
      state = JSON.parse(m[1].replace(/&q;/g, '"').replace(/&l;/g, '<').replace(/&g;/g, '>').replace(/&s;/g, "'").replace(/&a;/g, '&'));
    }
    const jd = (state && state.jobdetail) || {};
    const text = jd.stellenangebotsBeschreibung || '';
    return { description: text ? htmlToText(/<[a-z][\s\S]*>/i.test(text) ? text : text.replace(/\n/g, '<br>')) : '' };
  }
  return { description: '' };
}
