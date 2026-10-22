// Local data layer on top of chrome.storage.local.
// Nothing ever leaves the browser: no server, no account, no analytics.
//
// Storage layout (schema 2):
//   columns          -> [{ id, name, color, kind }]
//   job:<id>         -> one job per key, so two pages saving at the same time
//                       can never overwrite each other's jobs
//   draft:<pageKey>  -> unsaved side panel input, restored when you come back
//   settings         -> { closeAfterSave }
//   schema           -> 2
//
// Fields added later are optional and filled in on load, so an update never
// needs to rewrite or drop stored data:
//   job.interviews   -> [{ id, date, time, kind, note }] one entry per interview round
//                       (derived from the status history for jobs saved before)
//   job.logo         -> small data: URL of the company logo, or ''

import { t } from './i18n.js';

export const SCHEMA = 2;
const JOB_PREFIX = 'job:';
const DRAFT_PREFIX = 'draft:';
const DRAFT_MAX_AGE = 14 * 86400000;

// "kind" tells the statistics what a column means, whatever it is called.
export const KINDS = ['wishlist', 'applied', 'interview', 'offer', 'rejected', 'other'];

export function defaultColumns() {
  return [
    { id: 'saved', name: t('colSaved'), color: '#6b7a86', kind: 'wishlist' },
    { id: 'applied', name: t('colApplied'), color: '#2f4bd9', kind: 'applied' },
    { id: 'interview', name: t('colInterview'), color: '#8a3ffc', kind: 'interview' },
    { id: 'offer', name: t('colOffer'), color: '#1f8a5b', kind: 'offer' },
    { id: 'rejected', name: t('colRejected'), color: '#c8372d', kind: 'rejected' },
  ];
}

const LEGACY_KIND = { saved: 'wishlist', applied: 'applied', interview: 'interview', offer: 'offer', rejected: 'rejected' };

export const COLUMN_COLORS = [
  '#6b7a86', '#2f4bd9', '#0e7c9b', '#8a3ffc', '#c2387a',
  '#d6681f', '#b38600', '#1f8a5b', '#c8372d',
];

export const JOB_FIELDS = [
  'company', 'title', 'location', 'workload', 'workModel', 'url', 'status',
  'savedAt', 'appliedAt', 'description', 'contactName', 'contactEmail',
  'contactPhone', 'notes', 'logo',
];

export const ROUND_KINDS = ['phone', 'video', 'onsite'];

// ---------- Loading ----------

function normalizeColumns(raw) {
  const cols = (Array.isArray(raw) ? raw : [])
    .filter((c) => c && c.id)
    .map((c, i) => ({
      id: String(c.id),
      name: String(c.name || c.id),
      color: c.color || COLUMN_COLORS[i % COLUMN_COLORS.length],
      kind: KINDS.includes(c.kind) ? c.kind : (LEGACY_KIND[c.id] || (i === 0 ? 'wishlist' : 'interview')),
    }));
  return cols.length ? cols : defaultColumns();
}

function normalizeJob(raw, columns) {
  const job = { ...raw };
  for (const f of JOB_FIELDS) job[f] = job[f] == null ? '' : String(job[f]);
  job.workModel = normalizeWorkModel(job.workModel);
  if (!/^data:image\//.test(job.logo)) job.logo = '';
  if (!columns.some((c) => c.id === job.status)) job.status = columns[0].id;
  if (!Array.isArray(job.history) || !job.history.length) {
    // Jobs from version 1 had no history. Reconstruct what we know.
    const created = new Date(job.createdAt || Date.now()).toISOString();
    job.history = [{ status: job.status, at: created }];
  }
  if (typeof job.order !== 'number') job.order = -(job.createdAt || 0);
  job.interviews = Array.isArray(job.interviews)
    ? cleanRounds(job.interviews, job.id)
    : roundsFromHistory(job, columns);
  return job;
}

// ---------- Interview rounds ----------

export function interviewColumns(columns) {
  return columns.filter((c) => c.kind === 'interview');
}

function cleanRounds(list, jobId) {
  return list.filter((r) => r && typeof r === 'object').map((r, i) => ({
    id: r.id ? String(r.id) : `${jobId}-r${i + 1}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : '',
    time: /^\d{2}:\d{2}$/.test(r.time || '') ? r.time : '',
    kind: ROUND_KINDS.includes(r.kind) ? r.kind : '',
    note: r.note == null ? '' : String(r.note),
  }));
}

// Jobs saved before interview rounds existed: every interview column the job went
// through counts as one round, dated by the move (unless that date is unknown).
function roundsFromHistory(job, columns) {
  const stages = interviewColumns(columns);
  const rounds = [];
  const seen = new Set();
  for (const h of Array.isArray(job.history) ? job.history : []) {
    if (!stages.some((c) => c.id === h.status) || seen.has(h.status)) continue;
    seen.add(h.status);
    const at = new Date(h.at);
    rounds.push({ id: `${job.id}-r${rounds.length + 1}`, date: h.estimated || Number.isNaN(at.getTime()) ? '' : isoDate(at), time: '', kind: '', note: '' });
  }
  const index = stages.findIndex((c) => c.id === job.status);
  while (rounds.length < index + 1) rounds.push({ id: `${job.id}-r${rounds.length + 1}`, date: '', time: '', kind: '', note: '' });
  return rounds;
}

// Entering the n-th interview column means at least n rounds.
export function ensureRounds(job, columns) {
  const index = interviewColumns(columns).findIndex((c) => c.id === job.status);
  const rounds = Array.isArray(job.interviews) ? job.interviews : [];
  while (rounds.length < index + 1) rounds.push({ id: newId(), date: '', time: '', kind: '', note: '' });
  job.interviews = rounds;
  return job;
}

// How far a job got: the rounds you recorded, or the interview columns it passed.
export function interviewDepth(job, columns) {
  const visited = new Set([job.status, ...(Array.isArray(job.history) ? job.history : []).map((h) => h.status)]);
  let byColumn = 0;
  interviewColumns(columns).forEach((c, i) => { if (visited.has(c.id)) byColumn = i + 1; });
  return Math.max(byColumn, Array.isArray(job.interviews) ? job.interviews.length : 0);
}

export function roundLabel(n) {
  return t('roundLabel', String(n));
}

// Version 1 kept every job in one array under "jobs". Move them to one key each.
async function migrate(data) {
  if (!Array.isArray(data.jobs)) return data;
  const columns = normalizeColumns(data.columns);
  const patch = { columns, schema: SCHEMA };
  for (const raw of data.jobs) {
    if (!raw || !raw.id) continue;
    const key = JOB_PREFIX + raw.id;
    if (!data[key]) patch[key] = normalizeJob(raw, columns);
  }
  await chrome.storage.local.set(patch);
  await chrome.storage.local.remove('jobs');
  const next = { ...data, ...patch };
  delete next.jobs;
  return next;
}

export async function loadState() {
  let data = await chrome.storage.local.get(null);
  data = await migrate(data);
  const columns = normalizeColumns(data.columns);
  const jobs = Object.entries(data)
    .filter(([k, v]) => k.startsWith(JOB_PREFIX) && v && typeof v === 'object')
    .map(([, v]) => normalizeJob(v, columns));
  return { jobs, columns };
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { closeAfterSave: true, ...(settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// ---------- Saving ----------

export async function saveJob(job) {
  job.updatedAt = Date.now();
  await chrome.storage.local.set({ [JOB_PREFIX + job.id]: job });
  return job;
}

export async function saveJobs(jobs) {
  if (!jobs.length) return;
  await chrome.storage.local.set(Object.fromEntries(jobs.map((j) => [JOB_PREFIX + j.id, j])));
}

export async function deleteJob(id) {
  await chrome.storage.local.remove(JOB_PREFIX + id);
}

export async function saveColumns(columns) {
  await chrome.storage.local.set({ columns });
}

export async function replaceAll({ jobs, columns }) {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(JOB_PREFIX) && !jobs.some((j) => JOB_PREFIX + j.id === k));
  if (stale.length) await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({
    columns,
    schema: SCHEMA,
    ...Object.fromEntries(jobs.map((j) => [JOB_PREFIX + j.id, j])),
  });
}

export async function deleteEverything() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(JOB_PREFIX) || k.startsWith(DRAFT_PREFIX) || k.startsWith('search:') || k === 'columns');
  await chrome.storage.local.remove(keys);
}

export function onStoreChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === 'columns' || k.startsWith(JOB_PREFIX))) callback(changes);
  });
}

// chrome.storage sorts object keys, so compare in a key-order independent way.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

export function sameState(a, b) {
  const byId = (s) => ({ columns: s.columns, jobs: [...s.jobs].sort((x, y) => (x.id < y.id ? -1 : 1)) });
  return JSON.stringify(canonical(byId(a))) === JSON.stringify(canonical(byId(b)));
}

// ---------- Drafts ----------

export async function loadDraft(pageKey) {
  if (!pageKey) return null;
  const key = DRAFT_PREFIX + pageKey;
  const data = await chrome.storage.local.get(key);
  const draft = data[key];
  if (!draft || Date.now() - (draft.at || 0) > DRAFT_MAX_AGE) return null;
  return draft;
}

export async function saveDraft(pageKey, draft) {
  if (!pageKey) return;
  await chrome.storage.local.set({ [DRAFT_PREFIX + pageKey]: { ...draft, at: Date.now() } });
}

export async function deleteDraft(pageKey) {
  if (!pageKey) return;
  await chrome.storage.local.remove(DRAFT_PREFIX + pageKey);
}

export async function pruneDrafts() {
  const all = await chrome.storage.local.get(null);
  const old = Object.entries(all)
    .filter(([k, v]) => k.startsWith(DRAFT_PREFIX) && (!v || Date.now() - (v.at || 0) > DRAFT_MAX_AGE))
    .map(([k]) => k);
  if (old.length) await chrome.storage.local.remove(old);
}

// ---------- Jobs ----------

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createJob(data, columns) {
  const now = Date.now();
  const job = {
    id: newId(),
    company: '', title: '', location: '', workload: '', workModel: '', url: '',
    description: '', contactName: '', contactEmail: '', contactPhone: '', notes: '', logo: '',
    source: '', sourceKey: '', interviews: [],
    status: columns[0].id,
    savedAt: today(),
    appliedAt: '',
    order: -now, // new cards go to the top of their column
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  for (const [k, v] of Object.entries(data || {})) {
    if (v !== undefined && v !== null) job[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (!job.savedAt) job.savedAt = today();
  if (!columns.some((c) => c.id === job.status)) job.status = columns[0].id;
  if (job.status !== columns[0].id && !job.appliedAt) job.appliedAt = today();
  job.history = [{ status: job.status, at: new Date(now).toISOString() }];
  job.interviews = Array.isArray(job.interviews) ? cleanRounds(job.interviews, job.id) : [];
  if (!/^data:image\//.test(job.logo || '')) job.logo = '';
  ensureRounds(job, columns);
  return job;
}

// The side panel saves a job as applied (the "Applied" column, else the first one).
export function panelDefaultStatus(columns) {
  return (columns.find((c) => c.kind === 'applied') || columns[0]).id;
}

// Call after changing job.status. Records the move for the statistics and,
// when a card leaves the first column without an application date, sets today.
export function applyStatusChange(job, previousStatus, columns) {
  if (job.status === previousStatus) return job;
  const first = columns[0] && columns[0].id;
  if (job.status !== first && !job.appliedAt) job.appliedAt = today();
  job.history = [...(Array.isArray(job.history) ? job.history : []), { status: job.status, at: new Date().toISOString() }];
  ensureRounds(job, columns);
  return job;
}

export function sortByOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

// ---------- Duplicates ----------

const TRACKING_PARAM = /^(utm_|trk|ref|tracking|fbclid|gclid|mc_|_hs|lipi|ebp|from|src|source|origin|position|pagenum|xkcb|advn|tk)$|^(utm_|trk)/i;

export function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const qs = keep.map(([k, v]) => `${k}=${v}`).join('&');
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${qs ? `?${qs}` : ''}`.toLowerCase();
  } catch {
    return '';
  }
}

export function findDuplicate(jobs, { sourceKey, url } = {}) {
  if (sourceKey) {
    const hit = jobs.find((j) => j.sourceKey && j.sourceKey === sourceKey);
    if (hit) return hit;
  }
  const n = normalizeUrl(url);
  if (!n) return null;
  return jobs.find((j) => j.url && normalizeUrl(j.url) === n) || null;
}

// ---------- Dates ----------

export function today() {
  return isoDate(new Date());
}

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export function formatDate(iso) {
  const d = parseIso(iso);
  if (!d) return iso || '';
  return new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function daysSince(iso) {
  const d = parseIso(iso);
  if (!d) return null;
  return Math.round((parseIso(today()) - d) / 86400000);
}

export function relativeDays(iso) {
  const n = daysSince(iso);
  if (n === null) return '';
  if (n <= 0) return t('relToday');
  if (n === 1) return t('relYesterday');
  if (n < 30) return t('relDaysAgo', String(n));
  return t('relOnDate', formatDate(iso));
}

// ---------- Backup / export ----------

export function buildBackup(state) {
  return {
    app: 'bewerbungs-tracker',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    columns: state.columns,
    jobs: state.jobs,
  };
}

export function mergeBackup(state, backup) {
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.jobs)) {
    throw new Error(t('errNotABackup'));
  }
  const backupColumns = normalizeColumns(backup.columns);
  // Empty board (new computer): take the backup's columns as they are.
  // Otherwise keep the current columns and only add missing ones.
  const columns = state.jobs.length === 0 && Array.isArray(backup.columns) && backup.columns.length
    ? backupColumns
    : state.columns.map((c) => ({ ...c }));
  for (const c of backupColumns) if (!columns.some((x) => x.id === c.id)) columns.push(c);

  const byId = new Map(state.jobs.map((j) => [j.id, j]));
  let added = 0;
  let updated = 0;
  for (const raw of backup.jobs) {
    if (!raw || typeof raw !== 'object') continue;
    const job = normalizeJob({ ...raw, id: raw.id ? String(raw.id) : newId() }, columns);
    const existing = byId.get(job.id);
    if (!existing) {
      byId.set(job.id, job);
      added += 1;
    } else if ((job.updatedAt || 0) > (existing.updatedAt || 0)) {
      byId.set(job.id, { ...existing, ...job });
      updated += 1;
    }
  }
  return { state: { columns, jobs: [...byId.values()] }, added, updated };
}

export function toCSV(state) {
  const colName = Object.fromEntries(state.columns.map((c) => [c.id, c.name]));
  const headers = [
    t('fieldCompany'), t('fieldTitle'), t('fieldStatus'), t('fieldLocation'), t('fieldWorkload'),
    t('fieldWorkModel'), t('fieldSavedAt'), t('fieldAppliedAt'), t('fieldUrl'), t('fieldContactName'),
    t('fieldContactEmail'), t('fieldContactPhone'), t('fieldNotes'), t('fieldDescription'), t('csvSource'), t('interviewsTitle'),
  ];
  const rows = state.jobs.map((j) => [
    j.company, j.title, colName[j.status] || j.status, j.location, j.workload, workModelLabel(j.workModel),
    j.savedAt, j.appliedAt, j.url, j.contactName, j.contactEmail, j.contactPhone, j.notes, j.description, j.source,
    (j.interviews || []).map((r, i) => [roundLabel(i + 1), r.date && formatDate(r.date)].filter(Boolean).join(' ')).join('; '),
  ]);
  const esc = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formulas in Excel
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[headers, ...rows].map((r) => r.map(esc).join(';')).join('\r\n')}`;
}

// Work model values are stored language-neutral ('onsite' | 'hybrid' | 'remote').
// Version 1 stored German labels; map those too.
const WORK_MODEL_LEGACY = { 'Vor Ort': 'onsite', Hybrid: 'hybrid', Remote: 'remote' };
export function normalizeWorkModel(v) {
  if (!v) return '';
  if (['onsite', 'hybrid', 'remote'].includes(v)) return v;
  return WORK_MODEL_LEGACY[v] || '';
}
export function workModelLabel(v) {
  const k = normalizeWorkModel(v);
  return k ? t(`wm_${k}`) : '';
}

export function downloadFile(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
