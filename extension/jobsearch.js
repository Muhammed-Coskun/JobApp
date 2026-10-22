// "Job search" tab of the board page: new postings from jobs.ch, the
// Arbeitsagentur and LinkedIn, filtered by region, age and search term.
// Fetching and merging live in lib/search.js (shared with the service worker).

import { t, plural, uiLang } from './lib/i18n.js';
import { createJob, saveJob, today, parseIso } from './lib/store.js';
import { escapeHtml, safeHttpUrl } from './lib/form.js';
import { fetchLogo } from './lib/logo.js';
import { initQuickLinks, showQuickLinks } from './quicklinks.js';
import {
  SOURCES, SEARCH_KEYS, DAY_OPTIONS, FETCH_DAYS, RESULTS_VERSION, defaultSearchConfig, loadSearchConfig, saveSearchConfig,
  loadSearchData, saveDismissed, saveVisit, runSearch, searchProgress, mergeHits,
  hiddenReason, boardKeysOf, boardJobFor, sinceDay, sourceLabel, fetchDetails, locate, wrongCountry, knownGeoId, linkedinGeo,
} from './lib/search.js';

const STALE_MS = 30 * 60 * 1000;     // opening the tab searches again after this
const PRIMARY = ['jobcloud', 'linkedin', 'arbeitsagentur'];
const ICON_GEAR = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.6 2.5h2.8l.4 2.1 1.5.9 2-.8 1.4 2.4-1.6 1.4v1.8l1.6 1.4-1.4 2.4-2-.8-1.5.9-.4 2.1H8.6l-.4-2.1-1.5-.9-2 .8-1.4-2.4 1.6-1.4V9.1L3.3 7.7l1.4-2.4 2 .8 1.5-.9.4-2.1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.7h-3.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let ctx = null;          // { getState, toast, openJob, initials, hueFor }
let root = null;         // the tab (scrolls)
let main = null;         // the search column; the quick links sit next to it
let config = defaultSearchConfig();
let current = { bySource: {}, fetchedAt: 0 };   // the stored results
let sstate = { seen: {}, dismissed: {}, lastVisit: 0 };
let progress = null;     // { done, total } while a search runs
let running = false;     // this page runs one
let active = false;      // tab is shown
let prevVisit = 0;       // "new" = first seen after this
let loaded = false;
let setupShown = false;  // the settings open by themselves once, while nothing is set up
const filter = { region: 'all', terms: new Set(), newOnly: false, showHidden: false, details: false };
const saving = new Set();

export function initJobSearch(container, context) {
  root = container;
  ctx = context;
  root.innerHTML = `
    <div class="search-shell">
      <div class="search-main" id="jsMain"></div>
      <aside class="quick-links" id="jsLinks" aria-labelledby="qlHeading"></aside>
    </div>`;
  main = root.querySelector('#jsMain');
  initQuickLinks(root.querySelector('#jsLinks'), context);
  chrome.storage.onChanged.addListener(onStorage);
  document.addEventListener('visibilitychange', () => {
    if (active && document.visibilityState === 'visible') startVisit().then(render);
  });
  bindSettingsDialog();
}

const results = () => current;
const isStale = () => !current.fetchedAt || current.version !== RESULTS_VERSION || Date.now() - current.fetchedAt > STALE_MS;

export async function showJobSearch() {
  active = true;
  if (!loaded) {
    main.innerHTML = `<div class="search-inner"><p class="hits-empty">${escapeHtml(t('searchLoading'))}</p></div>`;
    await reload();
    loaded = true;
  }
  showQuickLinks().catch((err) => console.error(err));
  await startVisit();
  render();
  if (!hasWork()) {
    // nothing set up yet: straight to the settings
    if (!setupShown) { setupShown = true; openSettings(); }
  } else if (isStale() && !progress) refresh();
}

export function hideJobSearch() {
  active = false;
}

// the board changed (a job saved, deleted, imported)
export function boardChanged() {
  if (active && loaded) render();
}

async function reload() {
  const [c, data, p] = await Promise.all([loadSearchConfig(), loadSearchData(), searchProgress()]);
  config = c;
  current = data.results;
  sstate = data.state;
  if (!running) progress = p;
}

// Everything that came in before now counts as seen; the badge on the icon goes away.
async function startVisit() {
  const { state } = await loadSearchData();
  prevVisit = state.lastVisit || 0;
  state.lastVisit = Date.now();
  await saveVisit(state.lastVisit);
  sstate = state;
}

async function keepVisit() {
  if (!active || document.visibilityState !== 'visible') return;
  const { state } = await loadSearchData();
  state.lastVisit = Date.now();
  await saveVisit(state.lastVisit);
  sstate = state;
}

function onStorage(changes, area) {
  if (area !== 'local' || !loaded) return;
  if (changes[SEARCH_KEYS.lock] && !running) {
    progress = changes[SEARCH_KEYS.lock].newValue || null;
    if (active) renderStatus();
  }
  if (changes[SEARCH_KEYS.results]) {
    reload().then(keepVisit).then(() => { if (active) render(); });
    return;
  }
  if (changes[SEARCH_KEYS.config]) {
    const next = changes[SEARCH_KEYS.config].newValue;
    if (next && JSON.stringify(next) !== JSON.stringify(config)) loadSearchConfig().then((c) => { config = c; if (active) render(); });
  }
  // hidden elsewhere (another board tab) or newly found by the background search
  if (changes[SEARCH_KEYS.dismissed] || changes[SEARCH_KEYS.seen]) {
    const dismissed = changes[SEARCH_KEYS.dismissed] ? changes[SEARCH_KEYS.dismissed].newValue || {} : sstate.dismissed;
    const seen = changes[SEARCH_KEYS.seen] ? changes[SEARCH_KEYS.seen].newValue || {} : sstate.seen;
    const changed = JSON.stringify(dismissed) !== JSON.stringify(sstate.dismissed);
    sstate = { ...sstate, dismissed, seen };
    if (changed && active) render();
  }
}

function hasWork() {
  return config.regions.some((r) => r.enabled && r.place) && Object.values(config.sources).some(Boolean)
    && (config.terms || []).some((g) => (g.queries || []).length);
}

async function refresh() {
  if (running || !hasWork()) return;
  running = true;
  progress = { done: 0, total: 0 };
  renderStatus();
  try {
    const res = await runSearch({ onProgress: (p) => { progress = p; renderStatus(); } });
    if (res.busy) {
      // the background is already searching; its results arrive through storage
      running = false;
      progress = await searchProgress();
      renderStatus();
      return;
    }
  } catch (err) {
    console.error(err);
    ctx.toast(t('searchFailed'));
  }
  running = false;
  progress = null;
  await reload();
  await keepVisit();
  if (active) render();
}

// ---------- rendering ----------

function regionName(id) {
  return (config.regions.find((r) => r.id === id) || {}).name || id;
}

function termName(id) {
  return ((config.terms || []).find((g) => g.id === id) || {}).name || id;
}

const isNew = (hit) => prevVisit > 0 && (sstate.seen[hit.key] || 0) > prevVisit;

function primarySource(hit) {
  return [...hit.sources].sort((a, b) => PRIMARY.indexOf(a.source) - PRIMARY.indexOf(b.source))[0];
}

function collect() {
  const boardKeys = boardKeysOf(ctx.getState().jobs);
  const since = sinceDay(config.showDays);
  const terms = config.terms || [];
  const regionIds = new Set(config.regions.filter((r) => r.enabled).map((r) => r.id));
  const all = mergeHits(results(), config)
    .filter((h) => (!h.postedAt || h.postedAt >= since) && h.regions.some((r) => regionIds.has(r)))
    .map((h) => ({ ...h, reason: hiddenReason(h, { config, state: sstate, boardKeys }), jobId: boardJobFor(h, boardKeys) }));
  const inRegion = (h) => filter.region === 'all' || h.regions.includes(filter.region);
  const inTerms = (h) => !filter.terms.size || h.terms.some((x) => filter.terms.has(x));
  const inNew = (h) => !filter.newOnly || isNew(h);
  const visible = all.filter((h) => !h.reason);
  return {
    all,
    regionCounts: Object.fromEntries([['all', visible.filter((h) => inTerms(h) && inNew(h)).length],
      ...config.regions.map((r) => [r.id, visible.filter((h) => h.regions.includes(r.id) && inTerms(h) && inNew(h)).length])]),
    termCounts: Object.fromEntries(terms.map((g) => [g.id, visible.filter((h) => inRegion(h) && inNew(h) && h.terms.includes(g.id)).length])),
    newCount: visible.filter((h) => inRegion(h) && inTerms(h) && isNew(h)).length,
    hidden: all.filter((h) => h.reason && inRegion(h) && inTerms(h)),
    list: all.filter((h) => inRegion(h) && inTerms(h) && inNew(h) && (!h.reason || filter.showHidden)),
  };
}

function render() {
  if (!root || !loaded) return;
  const terms = config.terms || [];
  if (filter.region !== 'all' && !config.regions.some((r) => r.id === filter.region && r.enabled)) filter.region = 'all';
  for (const id of [...filter.terms]) if (!terms.some((g) => g.id === id)) filter.terms.delete(id);
  const data = collect();
  const regions = config.regions.filter((r) => r.enabled);
  const regionButtons = [{ id: 'all', name: t('searchAll') }, ...regions].map((r) => `
    <button type="button" role="radio" aria-checked="${filter.region === r.id}" data-region="${escapeHtml(r.id)}">
      ${escapeHtml(r.name)} <span class="count">${data.regionCounts[r.id] ?? 0}</span>
    </button>`).join('');
  const dayButtons = DAY_OPTIONS.map((d) => `
    <button type="button" role="radio" aria-checked="${config.showDays === d}" data-days="${d}">${escapeHtml(d === 1 ? t('searchToday') : t('searchDays', String(d)))}</button>`).join('');
  const termButtons = terms.map((g) => `
    <button type="button" class="term-chip" aria-pressed="${filter.terms.has(g.id)}" data-term="${escapeHtml(g.id)}">
      ${escapeHtml(g.name)} <span class="count">${data.termCounts[g.id] ?? 0}</span>
    </button>`).join('');

  const scrollTop = root.scrollTop;
  main.innerHTML = `
    <div class="search-inner">
      <div class="search-toolbar">
        <div class="range" role="radiogroup" aria-label="${escapeHtml(t('searchRegionLabel'))}">${regionButtons}</div>
        <div class="range" role="radiogroup" aria-label="${escapeHtml(t('searchDaysLabel'))}">${dayButtons}</div>
        <div class="search-status" id="jsStatus" role="status"></div>
        <button type="button" class="btn" id="jsRefresh">${ICON_REFRESH}<span>${escapeHtml(t('searchRefresh'))}</span></button>
        <button type="button" class="btn icon" id="jsSettings" title="${escapeHtml(t('searchSettings'))}" aria-label="${escapeHtml(t('searchSettings'))}">${ICON_GEAR}</button>
      </div>
      <div class="search-filters">
        <div class="term-chips" role="group" aria-label="${escapeHtml(t('searchTermsLabel'))}">${termButtons}</div>
        <div class="search-toggles">
          <label class="toggle"><input type="checkbox" id="jsNewOnly" ${filter.newOnly ? 'checked' : ''}><span>${escapeHtml(t('searchNewOnly'))} <span class="count">${data.newCount}</span></span></label>
          <label class="toggle"><input type="checkbox" id="jsSenior" ${config.hideSenior ? 'checked' : ''}><span>${escapeHtml(t('searchHideSenior'))}</span></label>
        </div>
      </div>
      <div class="source-line" id="jsSources"></div>
      <div class="hits" id="jsList">${listHtml(data)}</div>
      ${hiddenLine(data)}
    </div>`;
  root.scrollTop = scrollTop;
  bindView();
  renderStatus();
  renderSources();
}

function listHtml(data) {
  if (!data.list.length) {
    if (!hasWork()) {
      return `<div class="hits-empty"><p>${escapeHtml(t('searchNoSetup'))}</p>
        <button type="button" class="btn primary" id="jsSetup">${escapeHtml(t('searchSetup'))}</button></div>`;
    }
    let text = t('searchEmpty');
    if (!results().fetchedAt) text = t('searchFirst');
    else if (allFailed()) text = t('searchOfflineHint');
    return `<p class="hits-empty">${escapeHtml(text)}</p>`;
  }
  const sorted = [...data.list].sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || '')
    || (sstate.seen[b.key] || 0) - (sstate.seen[a.key] || 0)
    || (a.distanceKm ?? 999) - (b.distanceKm ?? 999)
    || a.title.localeCompare(b.title));
  const groups = new Map();
  for (const h of sorted) {
    const day = h.postedAt || '';
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(h);
  }
  return [...groups.entries()].map(([day, hits]) => `
    <section class="day">
      <h3 class="day-head">${escapeHtml(dayLabel(day))} <span>${escapeHtml(plural(hits.length, 'searchJobsOne', 'searchJobsMany'))}</span></h3>
      ${hits.map(hitHtml).join('')}
    </section>`).join('');
}

function dayLabel(iso) {
  if (!iso) return t('searchNoDate');
  if (iso === today()) return t('searchDayToday');
  const d = parseIso(iso);
  const y = parseIso(today());
  y.setDate(y.getDate() - 1);
  if (d.getTime() === y.getTime()) return t('searchDayYesterday');
  return new Intl.DateTimeFormat(uiLang(), { weekday: 'long', day: '2-digit', month: '2-digit' }).format(d);
}

function logoHtml(hit) {
  const url = safeHttpUrl(hit.logoUrl);
  const mono = `<span class="monogram" aria-hidden="true">${escapeHtml(ctx.initials(hit.company || hit.title))}</span>`;
  if (!url) return mono;
  return `<img class="logo-img" src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(ctx.initials(hit.company || hit.title))}">`;
}

function hitHtml(hit) {
  const main = primarySource(hit);
  const fresh = isNew(hit);
  const meta = [
    hit.company ? `<strong>${escapeHtml(hit.company)}</strong>` : '',
    hit.location ? escapeHtml(hit.location) : '',
    hit.workload ? escapeHtml(hit.workload) : '',
  ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
  const showRegions = filter.region === 'all' && config.regions.filter((r) => r.enabled).length > 1;
  const chips = [
    ...hit.terms.map((id) => `<span class="chip term">${escapeHtml(termName(id))}</span>`),
    ...(showRegions ? hit.regions.map((id) => `<span class="chip region">${escapeHtml(regionName(id))}</span>`) : []),
    ...hit.sources.map((s) => `<a class="src-link" href="${escapeHtml(safeHttpUrl(s.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLabel(s.source))}${ICON_EXTERNAL}</a>`),
  ].join('');
  let actions;
  if (hit.reason === 'board') {
    actions = `<button type="button" class="btn small" data-open="${escapeHtml(hit.jobId)}">${escapeHtml(t('searchOnBoard'))}</button>`;
  } else if (hit.reason === 'dismissed') {
    actions = `<button type="button" class="btn small" data-restore>${escapeHtml(t('searchRestore'))}</button>`;
  } else {
    const busy = saving.has(hit.key);
    actions = `
      <button type="button" class="btn small primary" data-save ${busy ? 'disabled' : ''}>${escapeHtml(busy ? t('searchSaving') : t('searchSave'))}</button>
      <button type="button" class="btn small ghost icon" data-dismiss title="${escapeHtml(t('searchDismiss'))}" aria-label="${escapeHtml(t('searchDismissLabel', hit.title))}">${ICON_CLOSE}</button>`;
  }
  const reason = hit.reason && hit.reason !== 'board' && hit.reason !== 'dismissed'
    ? `<span class="chip reason">${escapeHtml(t(`reason_${hit.reason}`))}</span>` : '';
  return `
    <article class="hit${fresh ? ' is-new' : ''}${hit.reason ? ' is-hidden' : ''}" data-key="${escapeHtml(hit.key)}" style="--h:${ctx.hueFor(hit.company || hit.title)}">
      <div class="hit-logo">${logoHtml(hit)}</div>
      <div class="hit-body">
        <h4 class="hit-title">
          <a href="${escapeHtml(safeHttpUrl(main.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(hit.title)}</a>
          ${fresh ? `<span class="new-badge">${escapeHtml(t('searchNew'))}</span>` : ''}
        </h4>
        <p class="hit-meta">${meta}</p>
        <div class="hit-tags">${chips}${reason}</div>
      </div>
      <div class="hit-side">
        ${hit.distanceKm != null ? `<span class="hit-distance">${escapeHtml(t('searchKm', String(hit.distanceKm)))}</span>` : ''}
        <div class="hit-actions">${actions}</div>
      </div>
    </article>`;
}

function hiddenLine(data) {
  if (!data.hidden.length) return '';
  const counts = {};
  for (const h of data.hidden) counts[h.reason] = (counts[h.reason] || 0) + 1;
  const parts = ['board', 'dismissed', 'nomatch', 'senior', 'excluded']
    .filter((r) => counts[r])
    .map((r) => escapeHtml(t(`searchSum_${r}`, String(counts[r]))));
  return `
    <p class="hidden-line">${parts.join('<span class="sep" aria-hidden="true">·</span>')}
      <button type="button" class="link-btn" id="jsShowHidden">${escapeHtml(filter.showHidden ? t('searchHideHidden') : t('searchShowHidden'))}</button>
    </p>`;
}

function relTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  const rtf = new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto' });
  if (mins < 1) return t('relJustNow');
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

function renderStatus() {
  const box = root && root.querySelector('#jsStatus');
  if (!box) return;
  const btn = root.querySelector('#jsRefresh');
  const busy = running || Boolean(progress);
  const r = results();
  if (btn) btn.disabled = busy;
  box.classList.toggle('busy', busy);
  const offline = !busy && allFailed();
  box.classList.toggle('warn', offline);
  if (busy) {
    box.textContent = (progress && progress.total ? t('searchRunning', String(progress.done), String(progress.total)) : t('searchStarting'));
  } else if (offline) {
    box.textContent = t('searchOffline');
  } else if (!r.fetchedAt) {
    box.textContent = t('searchNever');
  } else {
    box.textContent = Date.now() - r.fetchedAt < 60000 ? t('searchUpdatedNow') : t('searchUpdated', relTime(r.fetchedAt));
  }
}

function activeSources() {
  const countries = new Set(config.regions.filter((r) => r.enabled).map((r) => r.country));
  return Object.entries(SOURCES).filter(([id, info]) => config.sources[id] && info.countries.some((c) => countries.has(c))).map(([id]) => id);
}

// every source failed and there is nothing to show from before
function allFailed() {
  const entries = activeSources().map((id) => results().bySource[id]).filter(Boolean);
  return entries.length > 0 && entries.every((e) => e.error && !(e.items || []).length);
}

// One entry per portal; LinkedIn once per country, because it is searched once per region.
function sourceParts() {
  const parts = [];
  const enabled = config.regions.filter((r) => r.enabled);
  for (const id of activeSources()) {
    const entry = results().bySource[id];
    if (!entry) continue;
    const countries = [...new Set(enabled.map((r) => r.country))].filter((c) => SOURCES[id].countries.includes(c));
    const split = id === 'linkedin' && countries.length > 1;
    for (const country of split ? countries : [null]) {
      const items = (entry.items || []).filter((x) => !country || (enabled.find((r) => r.id === x.region) || {}).country === country);
      parts.push({ id, label: split ? `${SOURCES[id].label} ${country.toUpperCase()}` : SOURCES[id].label, n: new Set(items.map((x) => x.sourceKey)).size, entry });
    }
  }
  return parts;
}

function renderSources() {
  const box = root.querySelector('#jsSources');
  if (!box) return;
  const html = sourceParts().map(({ label, n, entry }) => {
    if (entry.error && entry.partial) {
      // this search, but some of its requests failed
      return `<span class="src warn">${escapeHtml(label)} <strong>${n}</strong><span class="src-err">${escapeHtml(t('searchErrPartial', entry.error))}</span></span>`;
    }
    if (entry.error && n && entry.at) {
      // older results are still shown
      return `<span class="src warn">${escapeHtml(label)} <strong>${n}</strong><span class="src-err">${escapeHtml(entry.error)}, ${escapeHtml(t('searchFrom', relTime(entry.at)))}</span></span>`;
    }
    if (entry.error && !n) return `<span class="src warn">${escapeHtml(label)}<span class="src-err">${escapeHtml(entry.error)}</span></span>`;
    return `<span class="src">${escapeHtml(label)} <strong>${n}</strong></span>`;
  });
  if (!html.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="src-label">${escapeHtml(t('searchSources'))}</span>${html.join('')}
    <button type="button" class="link-btn src-details-btn" id="jsSourceDetails" aria-expanded="${filter.details}">${escapeHtml(t(filter.details ? 'searchDetailsHide' : 'searchDetails'))}</button>
    ${filter.details ? `<div class="src-details">${detailsHtml()}</div>` : ''}`;
  box.querySelector('#jsSourceDetails').addEventListener('click', () => {
    filter.details = !filter.details;
    renderSources();
    root.querySelector('#jsSourceDetails')?.focus();
  });
}

// What each portal sent and why hits were left out: requests, received, too old,
// too far, other country, kept.
function detailsHtml() {
  const rows = [];
  for (const id of activeSources()) {
    const entry = results().bySource[id];
    if (!entry) continue;
    const st = entry.stats;
    if (!st) { rows.push(`<li><strong>${escapeHtml(SOURCES[id].label)}</strong> ${escapeHtml(t('searchDetailsNone'))}</li>`); continue; }
    const bits = [
      t('searchDetailsRequests', String(st.requests)),
      st.failed ? t('searchDetailsFailed', String(st.failed), entry.error || '') : '',
      t('searchDetailsReceived', String(st.received)),
      st.older ? t('searchDetailsOlder', String(st.older), String(FETCH_DAYS)) : '',
      st.far ? t('searchDetailsFar', String(st.far)) : '',
      st.country ? t('searchDetailsCountry', String(st.country)) : '',
      t('searchDetailsKept', String(st.kept)),
    ].filter(Boolean);
    const regions = Object.entries(st.byRegion || {}).map(([rid, n]) => `${regionName(rid)} ${n}`).join(', ');
    rows.push(`<li><strong>${escapeHtml(SOURCES[id].label)}</strong> ${escapeHtml(bits.join(' · '))}${regions ? ` <span class="src-regions">(${escapeHtml(regions)})</span>` : ''}${entry.error ? ` <span class="src-err">${escapeHtml(entry.error)}</span>` : ''}</li>`);
  }
  const places = config.regions.filter((r) => r.enabled).map((r) => `${r.name}: ${r.place}, ${t(`ssCountry_${r.country}`)}, ${r.radiusKm} km${r.lat == null ? ` (${t('searchDetailsNoCoords')})` : ''}`);
  return `<ul>${rows.join('')}</ul><p class="src-places">${escapeHtml(places.join(' · '))}</p>`;
}

function bindView() {
  root.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => {
    filter.region = b.dataset.region;
    render();
  }));
  root.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', async () => {
    config.showDays = Number(b.dataset.days);
    render();
    await saveSearchConfig(config);
  }));
  root.querySelectorAll('[data-term]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.term;
    if (filter.terms.has(id)) filter.terms.delete(id);
    else filter.terms.add(id);
    render();
    root.querySelector(`[data-term="${CSS.escape(id)}"]`)?.focus();
  }));
  root.querySelector('#jsNewOnly').addEventListener('change', (e) => {
    filter.newOnly = e.target.checked;
    render();
    root.querySelector('#jsNewOnly').focus();
  });
  root.querySelector('#jsSenior')?.addEventListener('change', async (e) => {
    config.hideSenior = e.target.checked;
    render();
    root.querySelector('#jsSenior').focus();
    await saveSearchConfig(config);
  });
  root.querySelector('#jsRefresh').addEventListener('click', () => refresh());
  root.querySelector('#jsSetup')?.addEventListener('click', openSettings);
  root.querySelector('#jsSettings').addEventListener('click', openSettings);
  root.querySelector('#jsShowHidden')?.addEventListener('click', () => {
    filter.showHidden = !filter.showHidden;
    render();
    root.querySelector('#jsShowHidden')?.focus();
  });
  root.querySelectorAll('img.logo-img[data-fallback]').forEach((img) => img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = 'monogram';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = img.dataset.fallback;
    img.replaceWith(span);
  }, { once: true }));
  root.querySelectorAll('.hit').forEach((el) => {
    const hit = () => collect().all.find((h) => h.key === el.dataset.key);
    el.querySelector('[data-save]')?.addEventListener('click', (e) => { const h = hit(); if (h) saveHit(h, e.currentTarget); });
    el.querySelector('[data-dismiss]')?.addEventListener('click', () => { const h = hit(); if (h) dismiss(h, el); });
    el.querySelector('[data-restore]')?.addEventListener('click', () => { const h = hit(); if (h) restore(h); });
    el.querySelector('[data-open]')?.addEventListener('click', (e) => ctx.openJob(e.currentTarget.dataset.open));
  });
}

// ---------- actions ----------

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function saveHit(hit, button) {
  if (saving.has(hit.key)) return;
  saving.add(hit.key);
  button.disabled = true;
  button.textContent = t('searchSaving');
  try {
    const main = primarySource(hit);
    const [details, logo] = await Promise.all([
      withTimeout(fetchDetails(main), 10000).catch(() => ({})),
      hit.logoUrl ? fetchLogo(hit.logoUrl) : Promise.resolve(''),
    ]);
    const others = hit.sources.filter((s) => s !== main).map((s) => `${sourceLabel(s.source)}: ${s.url}`);
    const { columns } = ctx.getState();
    const job = createJob({
      company: hit.company,
      title: hit.title,
      location: hit.location,
      workload: hit.workload,
      url: main.url,
      source: sourceLabel(main.source),
      sourceKey: main.sourceKey,
      description: details.description || '',
      contactName: details.contactName || '',
      contactEmail: details.contactEmail || '',
      contactPhone: details.contactPhone || '',
      notes: others.length ? `${t('searchAlsoOn')}\n${others.join('\n')}` : '',
      logo,
    }, columns);
    await saveJob(job);
    ctx.toast(t('searchSaved', hit.title), { label: t('searchOpen'), run: () => ctx.openJob(job.id) });
  } catch (err) {
    console.error(err);
    ctx.toast(t('errSave', err.message));
  } finally {
    saving.delete(hit.key);
    render();
  }
}

async function dismiss(hit, el) {
  const next = el.nextElementSibling || el.previousElementSibling;
  const nextKey = next && next.dataset ? next.dataset.key : '';
  const at = Date.now();
  // gone right away, saved after
  sstate = { ...sstate, dismissed: { ...sstate.dismissed, [hit.key]: at } };
  render();
  if (nextKey) root.querySelector(`.hit[data-key="${CSS.escape(nextKey)}"] .hit-title a`)?.focus();
  const { state } = await loadSearchData();
  state.dismissed[hit.key] = at;
  sstate = { ...sstate, dismissed: state.dismissed };
  await saveDismissed(state.dismissed);
  ctx.toast(t('searchDismissed', hit.title), { label: t('undo'), run: () => restore(hit) });
}

async function restore(hit) {
  const { state } = await loadSearchData();
  delete state.dismissed[hit.key];
  sstate = { ...sstate, dismissed: state.dismissed };
  await saveDismissed(state.dismissed);
  render();
}

// ---------- settings dialog ----------

const $ = (sel, r = document) => r.querySelector(sel);
let draftRegions = [];
let draftTerms = [];

function bindSettingsDialog() {
  const dlg = $('#searchDialog');
  const form = $('#searchForm');
  $('#ssClose').addEventListener('click', () => dlg.close());
  $('#ssCancel').addEventListener('click', () => dlg.close());
  $('#ssAddRegion').addEventListener('click', () => {
    readDraft();
    draftRegions.push(blankRegion());
    renderDraft();
    $('#ssRegions .ss-row:last-child [data-f="name"]').focus();
  });
  $('#ssAddTerm').addEventListener('click', () => {
    readDraft();
    draftTerms.push(blankTerm());
    renderDraft();
    $('#ssTerms .ss-row:last-child [data-f="name"]').focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveSettings(); }
  });
}

const blankRegion = () => ({ id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, name: '', country: 'de', place: '', radiusKm: 30, enabled: true });
const blankTerm = () => ({ id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, name: '', queries: [] });

function openSettings() {
  fillSettings(config);
  $('#ssMsg').textContent = '';
  $('#searchDialog').showModal();
  // nothing set up yet: start with the place
  if (!config.regions.length) $('#ssRegions [data-f="name"]')?.focus();
}

function fillSettings(c) {
  const form = $('#searchForm');
  draftRegions = c.regions.map((r) => ({ ...r }));
  draftTerms = (c.terms || []).map((g) => ({ ...g, queries: [...(g.queries || [])] }));
  // empty lists get one empty row each, so you see what to fill in
  if (!draftRegions.length) draftRegions.push(blankRegion());
  if (!draftTerms.length) draftTerms.push(blankTerm());
  renderDraft();
  form.elements.exclude.value = c.exclude || '';
  form.elements.onlyMatching.checked = Boolean(c.onlyMatching);
  form.elements.autoRefresh.checked = Boolean(c.autoRefresh);
  form.elements.intervalHours.value = String(c.intervalHours || 3);
  for (const id of Object.keys(SOURCES)) form.elements[`src_${id}`].checked = Boolean(c.sources[id]);
}

function renderDraft() {
  const remove = (label) => `<button type="button" class="btn ghost icon ss-remove" data-remove aria-label="${escapeHtml(label)}" title="${escapeHtml(t('ssRemove'))}">${ICON_CLOSE}</button>`;
  $('#ssRegions').innerHTML = draftRegions.map((r, i) => `
    <div class="ss-row region-row" data-i="${i}">
      <label class="ss-on" title="${escapeHtml(t('ssActive'))}"><input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''} aria-label="${escapeHtml(t('ssActiveLabel', r.name || String(i + 1)))}"></label>
      <label class="field ss-name"><span>${escapeHtml(t('ssRegionName'))}</span><input data-f="name" value="${escapeHtml(r.name)}" autocomplete="jat-region-name" required></label>
      <label class="field ss-country"><span>${escapeHtml(t('ssCountry'))}</span>
        <select data-f="country">
          <option value="de" ${r.country === 'de' ? 'selected' : ''}>${escapeHtml(t('ssCountry_de'))}</option>
          <option value="ch" ${r.country === 'ch' ? 'selected' : ''}>${escapeHtml(t('ssCountry_ch'))}</option>
        </select></label>
      <label class="field ss-place"><span>${escapeHtml(t('ssPlace'))}</span><input data-f="place" value="${escapeHtml(r.place)}" autocomplete="jat-region-place" required></label>
      <label class="field ss-radius"><span>${escapeHtml(t('ssRadius'))}</span><input type="number" data-f="radiusKm" min="5" max="200" step="5" value="${escapeHtml(String(r.radiusKm))}" autocomplete="off"></label>
      ${remove(t('ssRemoveRegion', r.name || String(i + 1)))}
    </div>`).join('');
  $('#ssTerms').innerHTML = draftTerms.map((g, i) => `
    <div class="ss-row term-row" data-i="${i}">
      <label class="field ss-name"><span>${escapeHtml(t('ssTermName'))}</span><input data-f="name" value="${escapeHtml(g.name)}" autocomplete="off"></label>
      <label class="field ss-queries"><span>${escapeHtml(t('ssTermQueries'))}</span><input data-f="queries" value="${escapeHtml(g.queries.join(', '))}" autocomplete="off"></label>
      ${remove(t('ssRemoveTerm', g.name || String(i + 1)))}
    </div>`).join('');
  document.querySelectorAll('#searchDialog [data-remove]').forEach((b) => b.addEventListener('click', () => {
    readDraft();
    const row = b.closest('.ss-row');
    const list = row.classList.contains('region-row') ? draftRegions : draftTerms;
    list.splice(Number(row.dataset.i), 1);
    renderDraft();
  }));
}

function readDraft() {
  document.querySelectorAll('#ssRegions .ss-row').forEach((row) => {
    const r = draftRegions[Number(row.dataset.i)];
    const f = (name) => row.querySelector(`[data-f="${name}"]`);
    r.enabled = f('enabled').checked;
    r.name = f('name').value.trim();
    r.country = f('country').value;
    r.place = f('place').value.trim();
    r.radiusKm = Math.min(200, Math.max(5, Math.round(Number(f('radiusKm').value) || 30)));
  });
  document.querySelectorAll('#ssTerms .ss-row').forEach((row) => {
    const g = draftTerms[Number(row.dataset.i)];
    g.name = row.querySelector('[data-f="name"]').value.trim();
    g.queries = [...new Set(row.querySelector('[data-f="queries"]').value.split(/[,;\n]/).map((q) => q.trim()).filter(Boolean))];
  });
}

async function saveSettings() {
  readDraft();
  const form = $('#searchForm');
  const msg = $('#ssMsg');
  const regions = draftRegions.filter((r) => r.place).map((r) => ({ ...r, name: r.name || r.place }));
  const terms = draftTerms.filter((g) => g.queries.length).map((g) => ({ ...g, name: g.name || g.queries[0] }));
  if (!regions.some((r) => r.enabled) || !terms.length) {
    msg.textContent = t('ssNeedRegion');
    return;
  }
  // a German town as the place of a Swiss region (or the other way round): say so
  // instead of searching the wrong country
  document.querySelectorAll('#ssRegions .ss-place').forEach((el) => el.classList.remove('invalid'));
  const wrong = draftRegions.findIndex((r) => r.place && wrongCountry(r.place, r.country));
  if (wrong >= 0) {
    const r = draftRegions[wrong];
    msg.textContent = t('ssWrongCountry', r.place, t(`ssCountry_${wrongCountry(r.place, r.country)}`) || wrongCountry(r.place, r.country), t(`ssCountry_${r.country}`));
    msg.classList.add('error');
    const field = document.querySelector(`#ssRegions .ss-row[data-i="${wrong}"] .ss-place`);
    field?.classList.add('invalid');
    field?.querySelector('input')?.focus();
    return;
  }
  msg.classList.remove('error');
  const saveBtn = $('#ssSave');
  saveBtn.disabled = true;
  msg.textContent = t('ssLocating');
  try {
    // new or moved places need coordinates for the distance
    const missing = [];
    for (const r of regions) {
      const old = config.regions.find((x) => x.id === r.id);
      const moved = !old || old.place !== r.place || old.country !== r.country;
      if (moved || r.lat == null) {
        const pos = await locate(r.place, r.country);
        r.lat = pos ? pos.lat : null;
        r.lon = pos ? pos.lon : null;
        if (!pos) missing.push(r.place);
      }
      // LinkedIn's own id for the place, so it does not guess the town (or the country)
      if (moved || !r.linkedinGeoId) {
        const geo = (!moved && knownGeoId(r)) || await linkedinGeo(r.place, r.country);
        if (geo) Object.assign(r, { linkedinGeoId: geo.geoId, linkedinGeoName: geo.geoName });
        else { delete r.linkedinGeoId; delete r.linkedinGeoName; }
      }
    }
    const next = {
      ...config,
      regions,
      terms,
      exclude: form.elements.exclude.value.trim(),
      onlyMatching: form.elements.onlyMatching.checked,
      autoRefresh: form.elements.autoRefresh.checked,
      intervalHours: Number(form.elements.intervalHours.value) || 3,
      sources: Object.fromEntries(Object.keys(SOURCES).map((id) => [id, form.elements[`src_${id}`].checked])),
    };
    const placesChanged = JSON.stringify([config.regions, config.sources]) !== JSON.stringify([next.regions, next.sources]);
    const termsChanged = JSON.stringify(config.terms) !== JSON.stringify(next.terms);
    config = next;
    await saveSearchConfig(config);
    chrome.runtime.sendMessage({ type: 'search-settings' }).catch(() => {});
    $('#searchDialog').close();
    render();
    if (missing.length) ctx.toast(t('ssPlaceNotFound', missing.join(', ')));
    // new places, portals or terms: search again
    if (placesChanged || termsChanged || !current.fetchedAt) refresh();
  } catch (err) {
    console.error(err);
    msg.textContent = t('errSave', err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

