import { t, applyI18n } from './lib/i18n.js';
import {
  loadState, loadSettings, saveSettings, createJob, saveJob, findDuplicate, formatDate, today,
  applyStatusChange, normalizeUrl, loadDraft, saveDraft, deleteDraft, pruneDrafts, onStoreChange,
  panelDefaultStatus,
} from './lib/store.js';
import { extractJobFromPage, logoInPage } from './lib/extractor.js';
import { fetchLogo, captureLogo } from './lib/logo.js';
import { countNew } from './lib/search.js';
import {
  fillForm, readForm, fillStatusSelect, bindStatusDateRules, safeHttpUrl, hostOf,
} from './lib/form.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#jobForm');
const BOARD_URL = chrome.runtime.getURL('board.html');
// Fields that come from the posting. "Read again" refreshes only these;
// status, dates and notes are yours and stay untouched.
const PAGE_FIELDS = ['company', 'title', 'location', 'workload', 'workModel', 'url', 'description',
  'contactName', 'contactEmail', 'contactPhone'];

function fill(data) {
  fillForm(form, data);
  showLogo();
}

// A new job: status "Applied" with today as the application date.
function newStatus() {
  const status = panelDefaultStatus(state.columns);
  return { status, savedAt: today(), appliedAt: status === state.columns[0].id ? '' : today() };
}

function showLogo() {
  const value = form.elements.namedItem('logo').value;
  $('#logoTile').hidden = !value;
  if (value) $('#logoImg').src = value;
  else $('#logoImg').removeAttribute('src');
}

// The logo is loaded after the form is filled, so reading never waits for it:
// first with the page's own access, then with the extension's, then cut out of a
// screenshot of the visible tab. A saved job without a logo gets it right away.
async function resolveLogo(tab, res, seq) {
  const job = res && res.job;
  const candidates = (job && job.logoCandidates) || [];
  if (!job || (!candidates.length && !job.logoRect)) return;
  if (form.elements.namedItem('logo').value) return;
  let data = '';
  if (candidates.length) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: logoInPage, args: [candidates] });
      data = (r && r.result) || '';
    } catch { /* page not reachable */ }
  }
  for (const url of candidates) {
    if (data) break;
    data = await fetchLogo(url);
  }
  if (!data && job.logoRect && tab.active) data = await captureLogo(tab.windowId, job.logoRect);
  const input = form.elements.namedItem('logo');
  if (!data || seq !== readSeq || input.value) return;
  input.value = data;
  showLogo();
  if (dirty) {
    markDirty();
  } else if (editingId) {
    const saved = state.jobs.find((j) => j.id === editingId);
    if (saved && !saved.logo) {
      saved.logo = data;
      await saveJob(saved).catch(() => {});
    }
  }
}

let state = { jobs: [], columns: [] };
let settings = { closeAfterSave: true };
let windowId = null;
let tabId = null;       // tab the form currently belongs to
let tabKey = '';        // quick key of that tab's URL, to ignore reloads of the same job
let pageKey = '';       // key under which drafts of this job are stored
let extracted = null;   // last reading result
let editingId = null;   // set when the form edits a saved job
let dirty = false;      // the user typed something since the last fill
let pendingTabId = null;
let readSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

init().catch((err) => {
  console.error(err);
  setSource('none', `${t('errLoad')} ${err.message}`);
});

async function init() {
  if (new URLSearchParams(location.search).has('popup')) document.documentElement.classList.add('is-popup');
  applyI18n();
  [state, settings] = await Promise.all([loadState(), loadSettings()]);
  windowId = (await chrome.windows.getCurrent()).id;
  fillStatusSelect(form.elements.namedItem('status'), state.columns);
  $('#closeAfterSave').checked = settings.closeAfterSave;
  bindStatusDateRules(form, () => state.columns);
  bindEvents();
  pruneDrafts().catch(() => {});
  const tab = await getActiveTab();
  if (tab) await readTab(tab, { force: true });
  else setSource('none', t('statusNothing'));
}

// ---------- tabs ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab || null;
}

// A cheap key from the URL (when we may see it) so that reloads, scroll
// events or "complete" notifications of the same job do not re-read the page.
function quickKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const p = u.searchParams;
    if (/linkedin\.com$/.test(u.hostname)) {
      const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/);
      return `li:${p.get('currentJobId') || (m && m[1]) || u.pathname}`;
    }
    if (/(jobs|jobup)\.ch$/.test(u.hostname)) {
      const m = (p.get('jobid') || u.pathname).match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
      return `jc:${m ? m[0] : u.pathname}`;
    }
    if (/indeed\./.test(u.hostname)) return `in:${p.get('vjk') || p.get('jk') || u.pathname}`;
    return normalizeUrl(url);
  } catch {
    return '';
  }
}

let tabTimer = null;
function onTabChanged() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    const key = quickKey(tab.url);
    if (tab.id === tabId && key && key === tabKey) {
      $('#otherPageNotice').hidden = true;
      return;
    }
    if (dirty) {
      // Never throw away what you typed: offer to switch instead.
      pendingTabId = tab.id;
      $('#otherPageNotice').hidden = false;
      return;
    }
    await readTab(tab, { force: false });
  }, 450);
}

// ---------- reading ----------

async function extract(id) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: extractJobFromPage,
      args: [{ labels: { fullTime: t('fullTime'), partTime: t('partTime') } }],
    });
    return { result: res && res.result ? res.result : null, error: null };
  } catch (err) {
    return { result: null, error: String(err && err.message ? err.message : err) };
  }
}

async function readTab(tab, { force = false, keepDraft = true, refreshOnly = false } = {}) {
  const seq = ++readSeq;
  if (!refreshOnly && dirty && pageKey) {
    // switching away: make sure the latest input is in the draft
    clearTimeout(draftTimer);
    await saveDraft(pageKey, { fields: readForm(form), editingId }).catch(() => {});
  }
  setSource('loading', t('statusReading'));
  let { result: res, error } = await extract(tab.id);
  // Single page apps (LinkedIn & co.) load details late: try once more.
  if (res && !res.detected && !res.listPage) {
    await sleep(900);
    const again = await extract(tab.id);
    if (again.result) res = again.result;
  }
  if (seq !== readSeq) return; // a newer read started meanwhile

  if (refreshOnly && res && res.job) {
    const current = readForm(form);
    const fromPage = Object.fromEntries(Object.entries(res.job).filter(([k, v]) => PAGE_FIELDS.includes(k) && v));
    fill({ ...current, ...fromPage });
    extracted = res;
    markDirty();
    showSourceState(res, error);
    resolveLogo(tab, res, seq);
    return;
  }

  if (!force && dirty) return;
  tabId = tab.id;
  tabKey = quickKey(tab.url);
  extracted = res;
  pageKey = (res && res.job && (res.job.sourceKey || normalizeUrl(res.job.url))) || normalizeUrl(tab.url) || `tab:${tab.id}`;
  $('#otherPageNotice').hidden = true;
  $('#draftNotice').hidden = true;
  $('#dupNotice').hidden = true;
  pendingTabId = null;

  const draft = keepDraft ? await loadDraft(pageKey) : null;
  const duplicate = findDuplicate(state.jobs, {
    sourceKey: res && res.job && res.job.sourceKey,
    url: (res && res.job && res.job.url) || tab.url,
  });
  if (draft) {
    editingId = draft.editingId && state.jobs.some((j) => j.id === draft.editingId) ? draft.editingId : null;
    fill(draft.fields || {});
    setMode(editingId ? 'edit' : 'new');
    dirty = true;
    $('#draftNotice').hidden = false;
  } else if (duplicate) {
    startEditing(duplicate, true);
  } else {
    editingId = null;
    fill({
      ...newStatus(),
      url: safeHttpUrl(tab.url || ''),
      ...((res && res.job) || {}),
    });
    setMode('new');
    dirty = false;
  }
  $('#contactGroup').open = ['contactName', 'contactEmail', 'contactPhone'].some((n) => form.elements.namedItem(n).value);
  $('#useSelection').hidden = !(res && res.selection && res.selection.length > 20);
  setMsg('');
  showSourceState(res, error);
  resolveLogo(tab, res, seq);
}

function showSourceState(res, error) {
  if (!res) {
    if (error && /chrome:\/\/|chrome-extension:|edge:\/\/|webstore|extensions gallery|Cannot access a chrome/i.test(error)) {
      setSource('none', t('statusRestricted'));
    } else {
      setSource('none', t('statusNoAccess'));
    }
    return;
  }
  const name = res.site || res.host;
  if (res.detected) setSource('ok', t('statusDetected', name));
  else if (res.listPage) setSource('list', t('statusListPage', name));
  else if (res.job.title || res.job.company) setSource('partial', t('statusPartial', name));
  else setSource('none', t('statusNothing'));
}

function setSource(kind, text) {
  $('#source').dataset.state = kind;
  $('#sourceText').textContent = text;
}

// ---------- editing state ----------

function setMode(mode) {
  $('#heading').textContent = t(mode === 'edit' ? 'panelTitleEdit' : 'panelTitleNew');
  $('#saveBtn').textContent = t(mode === 'edit' ? 'saveChanges' : 'save');
}

function startEditing(job, fromDuplicate) {
  editingId = job.id;
  fill(job);
  setMode('edit');
  dirty = false;
  if (fromDuplicate) {
    const col = state.columns.find((c) => c.id === job.status);
    $('#dupText').textContent = t('dupText', col ? col.name : job.status, formatDate(job.savedAt));
    $('#dupNotice').hidden = false;
  }
}

let draftTimer = null;
function markDirty() {
  dirty = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveDraft(pageKey, { fields: readForm(form), editingId }).catch(() => {});
  }, 350);
}

// ---------- saving ----------

async function save(e) {
  e.preventDefault();
  const data = readForm(form);
  if (!data.company && !data.title) {
    $('#companyField').classList.add('invalid');
    $('#titleField').classList.add('invalid');
    setMsg(t('errNeedCompanyOrTitle'), 'error');
    form.elements.namedItem('company').focus();
    return;
  }
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    state = await loadState();
    const existing = editingId ? state.jobs.find((j) => j.id === editingId) : null;
    let job;
    if (existing) {
      job = { ...existing, ...data };
      applyStatusChange(job, existing.status, state.columns);
      if (job.status !== existing.status) job.order = -Date.now();
    } else {
      const fromPage = Boolean(extracted && extracted.job && data.url && data.url === extracted.job.url);
      job = createJob({
        ...data,
        source: fromPage ? extracted.job.source : (hostOf(data.url) || t('sourceManual')),
        sourceKey: fromPage ? extracted.job.sourceKey : '',
      }, state.columns);
    }
    await saveJob(job);
    clearTimeout(draftTimer);
    await deleteDraft(pageKey);
    $('#draftNotice').hidden = true;
    const wasNew = !existing;
    startEditing(job, false);
    if (settings.closeAfterSave) {
      btn.textContent = t('saved');
      btn.classList.add('done');
      await sleep(650);
      await closePanel();
      btn.classList.remove('done');
      setMode('edit');
    } else {
      setMsg(t(wasNew ? 'saved' : 'changesSaved'), 'ok');
    }
  } catch (err) {
    console.error(err);
    setMsg(t('errSave', err.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

function setMsg(text, kind = '') {
  const el = $('#formMsg');
  el.textContent = text;
  el.className = `form-msg ${kind}`;
}

async function closePanel() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.close) {
      await chrome.sidePanel.close({ windowId });
      return;
    }
  } catch { /* older Chrome */ }
  window.close();
}

// ---------- board ----------

async function openBoard(hash = editingId ? `#job=${editingId}` : '') {
  const url = BOARD_URL + hash;
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const open = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(BOARD_URL) && c.tabId >= 0);
      if (open) {
        await chrome.tabs.update(open.tabId, { active: true, url });
        if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
        return;
      }
    }
  } catch (err) {
    console.warn(err);
  }
  await chrome.tabs.create({ url, windowId });
}

// new hits of the job search, the same number as on the icon
let countTimer = 0;
function showSearchCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(async () => {
    const n = await countNew().catch(() => 0);
    $('#searchCount').hidden = !n;
    $('#searchCount').textContent = n > 99 ? '99+' : String(n);
    $('#openSearch').setAttribute('aria-label', n ? t('tabSearchNew', String(n)) : t('tabSearch'));
  }, 300);
}

// ---------- events ----------

function bindEvents() {
  form.addEventListener('submit', save);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const onEdit = (e) => {
    e.target.closest('.field')?.classList.remove('invalid');
    if ($('#formMsg').classList.contains('ok')) setMsg('');
    markDirty();
  };
  form.addEventListener('input', onEdit);
  form.addEventListener('change', onEdit);

  $('#reread').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    // Same job: refresh the posting fields only. Other page: load it (your draft is kept).
    if (tab.id === tabId && quickKey(tab.url) === tabKey && (dirty || editingId)) await readTab(tab, { refreshOnly: true });
    else await readTab(tab, { force: true });
  });
  $('#loadOther').addEventListener('click', async () => {
    const tab = pendingTabId != null ? await chrome.tabs.get(pendingTabId).catch(() => null) : await getActiveTab();
    if (tab) await readTab(tab, { force: true });
  });
  $('#discardDraft').addEventListener('click', async () => {
    await deleteDraft(pageKey);
    dirty = false;
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (tab) await readTab(tab, { force: true, keepDraft: false });
  });
  $('#clearForm').addEventListener('click', async () => {
    await deleteDraft(pageKey);
    editingId = null;
    fill({ ...newStatus(), url: (extracted && extracted.job && extracted.job.url) || '' });
    setMode('new');
    dirty = false;
    ['#draftNotice', '#dupNotice'].forEach((s) => { $(s).hidden = true; });
    form.elements.namedItem('company').focus();
  });
  $('#useSelection').addEventListener('click', () => {
    if (!extracted || !extracted.selection) return;
    form.elements.namedItem('description').value = extracted.selection;
    markDirty();
  });
  $('#logoRemove').addEventListener('click', () => {
    form.elements.namedItem('logo').value = '';
    showLogo();
    markDirty();
  });
  $('#openBoard').addEventListener('click', () => openBoard());
  $('#openSearch').addEventListener('click', () => openBoard('#search'));
  showSearchCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('search:') || k.startsWith('job:'))) showSearchCount();
  });
  $('#closePanel').addEventListener('click', closePanel);
  $('#closeAfterSave').addEventListener('change', async (e) => {
    settings.closeAfterSave = e.target.checked;
    await saveSettings(settings);
  });

  chrome.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) onTabChanged(); });
  chrome.tabs.onUpdated.addListener((id, info, tab) => {
    if (tab.windowId !== windowId || !tab.active) return;
    if (info.url || info.status === 'complete') onTabChanged();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'read-tab' || (msg.windowId != null && msg.windowId !== windowId)) return;
    chrome.tabs.get(msg.tabId).then((tab) => readTab(tab, { force: true })).catch(() => {});
  });
  onStoreChange(async () => {
    state = await loadState();
    const select = form.elements.namedItem('status');
    fillStatusSelect(select, state.columns, select.value);
    if (editingId && !state.jobs.some((j) => j.id === editingId)) {
      editingId = null;
      setMode('new');
      $('#dupNotice').hidden = true;
    }
  });
}
