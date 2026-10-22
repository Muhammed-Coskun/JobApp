import { t, applyI18n, plural } from './lib/i18n.js';
import {
  loadState, saveJob, saveJobs, deleteJob, saveColumns, replaceAll, deleteEverything, onStoreChange, sameState,
  createJob, applyStatusChange, sortByOrder, newId, today, formatDate, relativeDays, daysSince, COLUMN_COLORS, KINDS,
  buildBackup, mergeBackup, toCSV, downloadFile, workModelLabel, interviewColumns, interviewDepth, roundLabel, ROUND_KINDS,
  parseIso,
} from './lib/store.js';
import { isLogo, imageToLogo } from './lib/logo.js';
import {
  fillForm, readForm, fillStatusSelect, bindStatusDateRules, escapeHtml, safeHttpUrl, hostOf,
} from './lib/form.js';
import { renderStats } from './stats.js';
import { initJobSearch, showJobSearch, hideJobSearch, boardChanged } from './jobsearch.js';
import { storedLinks, importLinks } from './lib/quicklinks.js';
import { countNew } from './lib/search.js';
import {
  readTableFile, guessMapping, guessStatusKind, columnForKind, buildImport, IMPORT_FIELDS, namedRows,
} from './lib/tableimport.js';

const $ = (sel, root = document) => root.querySelector(sel);
const boardEl = $('#board');
const dialog = $('#jobDialog');
const jobForm = $('#jobForm');
const searchInput = $('#search');

const ICON_MORE = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="4" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="16" cy="10" r="1.6" fill="currentColor"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let state = { jobs: [], columns: [] };
let query = '';
let dragId = null;
let editingId = null;
let closeMenu = null;
let view = 'board';
const placeholder = document.createElement('div');
placeholder.className = 'drop-placeholder';

init().catch((err) => {
  console.error(err);
  toast(`${t('errLoad')} ${err.message}`);
});

async function init() {
  applyI18n();
  $('[data-i18n="emptyText"]').textContent = t('emptyText');
  state = await loadState();
  // first start: store the default columns in the user's language
  const { columns } = await chrome.storage.local.get('columns');
  if (!columns) await saveColumns(state.columns);
  bindGlobal();
  initJobSearch($('#viewSearch'), {
    getState: () => state,
    toast,
    openJob: (id) => { location.hash = `#job=${encodeURIComponent(id)}`; },
    initials,
    hueFor,
  });
  setView(viewFromHash(), false);
  render();
  updateSearchCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('search:') || k.startsWith('job:'))) updateSearchCount();
  });
  onStoreChange(async () => {
    const fresh = await loadState();
    // Our own writes trigger this too. Skip those, otherwise an open rename field
    // or menu would be thrown away.
    if (sameState(fresh, state)) return;
    state = fresh;
    render();
    boardChanged();
    if (dialog.open) {
      const status = jobForm.elements.namedItem('status');
      fillStatusSelect(status, state.columns, status.value);
    }
  });
  openFromHash();
  window.addEventListener('hashchange', () => {
    if (location.hash === '#stats' || location.hash === '#search') setView(viewFromHash(), false);
    else openFromHash();
  });
}

function viewFromHash() {
  if (location.hash === '#stats') return 'stats';
  if (location.hash === '#search') return 'search';
  return 'board';
}

// number of new search hits on the tab (the same number as on the toolbar icon)
let countTimer = 0;
function updateSearchCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(async () => {
    const n = await countNew().catch(() => 0);
    const el = $('#tabSearchCount');
    el.hidden = !n || view === 'search';
    el.textContent = n > 99 ? '99+' : String(n);
    $('#tabSearch').setAttribute('aria-label', n && view !== 'search' ? t('tabSearchNew', String(n)) : t('tabSearch'));
  }, 300);
}

// ---------- views ----------

const VIEWS = { board: ['#tabBoard', '#viewBoard'], stats: ['#tabStats', '#viewStats'], search: ['#tabSearch', '#viewSearch'] };

function setView(next, updateHash = true) {
  if (!VIEWS[next]) next = 'board';
  const before = view;
  view = next;
  for (const [id, [tab, panel]] of Object.entries(VIEWS)) {
    $(panel).hidden = id !== next;
    $(tab).setAttribute('aria-selected', String(id === next));
    $(tab).tabIndex = id === next ? 0 : -1;
  }
  $('#searchBox').hidden = next !== 'board';
  $('#statsLine').hidden = next === 'search';
  if (updateHash) history.replaceState(null, '', next === 'board' ? location.pathname : `#${next}`);
  if (next === 'stats') renderStats($('#viewStats'), state);
  if (next === 'search') {
    $('#tabSearchCount').hidden = true;
    showJobSearch().catch((err) => console.error(err));
  }
  else if (before === 'search') hideJobSearch();
  updateSearchCount();
}

// ---------- rendering ----------

// render() can be re-entered from a blur handler (rename field loses focus
// while the board is redrawn). Finish first, then draw once more.
let rendering = false;
let renderAgain = false;

function render() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    renderNow();
  } finally {
    rendering = false;
  }
  if (renderAgain) {
    renderAgain = false;
    render();
  }
}

function renderNow() {
  const scrolls = new Map([...boardEl.querySelectorAll('.column')]
    .map((c) => [c.dataset.id, $('.column-body', c).scrollTop]));
  const left = boardEl.scrollLeft;
  const focusedId = document.activeElement && document.activeElement.classList.contains('card') ? document.activeElement.dataset.id : null;
  boardEl.replaceChildren(...state.columns.map(renderColumn), renderAddColumn());
  for (const col of boardEl.querySelectorAll('.column')) {
    const top = scrolls.get(col.dataset.id);
    if (top) $('.column-body', col).scrollTop = top;
  }
  boardEl.scrollLeft = left;
  if (focusedId) boardEl.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  renderStatsLine();
  $('#emptyHint').hidden = state.jobs.length > 0;
  if (view === 'stats') renderStats($('#viewStats'), state);
}

function matches(job) {
  if (!query) return true;
  const hay = [job.company, job.title, job.location, workModelLabel(job.workModel), job.workload, job.notes, job.contactName, job.source]
    .join(' ').toLowerCase();
  return query.split(/\s+/).every((term) => hay.includes(term));
}

function renderColumn(col) {
  const all = state.jobs.filter((j) => j.status === col.id).sort(sortByOrder);
  const shown = all.filter(matches);
  const section = document.createElement('section');
  section.className = 'column';
  section.dataset.id = col.id;
  section.style.setProperty('--col', col.color);
  section.setAttribute('aria-label', col.name);
  section.innerHTML = `
    <header class="column-head">
      <h2 class="column-name" title="${escapeHtml(t('renameHint'))}">${escapeHtml(col.name)}</h2>
      <span class="column-count">${query ? `${shown.length}/${all.length}` : all.length}</span>
      <button type="button" class="btn ghost icon column-menu" aria-label="${escapeHtml(t('columnMenu', col.name))}" aria-haspopup="menu">${ICON_MORE}</button>
    </header>
    <div class="column-body"></div>
    <button type="button" class="add-card">${escapeHtml(t('addCard'))}</button>`;
  const body = $('.column-body', section);
  if (shown.length) body.append(...shown.map(renderCard));
  else body.innerHTML = `<p class="column-empty">${escapeHtml(t(query ? 'noMatches' : 'dropHere'))}</p>`;

  $('.column-name', section).addEventListener('dblclick', () => startRename(col.id));
  $('.column-menu', section).addEventListener('click', (e) => openColumnMenu(e.currentTarget, col.id));
  $('.add-card', section).addEventListener('click', () => openJob(null, col.id));
  bindDropZone(section, col.id);
  return section;
}

function renderAddColumn() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'add-column';
  btn.title = t('addColumn');
  btn.setAttribute('aria-label', t('addColumn'));
  btn.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  btn.addEventListener('click', addColumn);
  return btn;
}

const shortDate = (iso, withDay) => {
  const d = parseIso(iso);
  if (!d) return '';
  const opts = withDay ? { weekday: 'short', day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit' };
  return new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), opts).format(d);
};

// "2. Interview · Mo 20.10." for the latest round; planned ones stand out.
function roundChip(job) {
  const depth = interviewDepth(job, state.columns);
  if (!depth) return '';
  const last = (job.interviews || [])[depth - 1];
  const label = roundLabel(depth);
  if (!last || !last.date) return `<span class="chip round" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
  const planned = daysSince(last.date) < 0 || (daysSince(last.date) === 0 && last.time && last.time > new Date().toTimeString().slice(0, 5));
  const when = `${shortDate(last.date, planned)}${planned && last.time ? ` ${last.time}` : ''}`;
  const tip = t(planned ? 'roundPlanned' : 'roundDone', label, formatDate(last.date));
  return `<span class="chip round${planned ? ' planned' : ''}" title="${escapeHtml(tip)}">${escapeHtml(`${label} · ${when}`)}</span>`;
}

function logoHtml(job) {
  return isLogo(job.logo)
    ? `<img class="logo-img" src="${escapeHtml(job.logo)}" alt="" aria-hidden="true" draggable="false">`
    : `<span class="monogram" aria-hidden="true">${escapeHtml(initials(job.company || job.title))}</span>`;
}

function renderCard(job) {
  const card = document.createElement('article');
  card.className = 'card';
  card.draggable = true;
  card.tabIndex = 0;
  card.dataset.id = job.id;
  card.style.setProperty('--h', hueFor(job.company || job.title || '?'));
  card.setAttribute('aria-label', t('cardLabel', job.title || t('untitled'), job.company || t('unknownCompany')));
  card.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');

  const chips = roundChip(job) + [job.location, workModelLabel(job.workModel), job.workload].filter(Boolean)
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  // Imported jobs may have no application date but a dated last step (e.g. the rejection).
  const lastStep = [...(job.history || [])].reverse().find((h) => !h.estimated);
  const dateLine = job.appliedAt
    ? t('appliedRel', relativeDays(job.appliedAt))
    : job.status !== state.columns[0]?.id && lastStep && lastStep.status === job.status
      ? t('stepRel', columnName(job.status), relativeDays(lastStep.at.slice(0, 10)))
      : t('savedRel', relativeDays(job.savedAt));
  const dateTitle = [
    job.savedAt && t('savedOn', formatDate(job.savedAt)),
    job.appliedAt && t('appliedOn', formatDate(job.appliedAt)),
  ].filter(Boolean).join('\n');
  const url = safeHttpUrl(job.url);

  card.innerHTML = `
    <div class="card-top">
      ${logoHtml(job)}
      <div class="card-head">
        <p class="card-company">${escapeHtml(job.company || t('unknownCompany'))}</p>
        <h3 class="card-title">${escapeHtml(job.title || t('untitled'))}</h3>
      </div>
      ${url ? `<a class="card-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" draggable="false" title="${escapeHtml(t('openPosting'))}" aria-label="${escapeHtml(t('openPosting'))}">${ICON_EXTERNAL}</a>` : ''}
    </div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    <footer class="card-foot">
      <span title="${escapeHtml(dateTitle)}">${escapeHtml(dateLine)}</span>
      ${job.source ? `<span class="card-source">${escapeHtml(job.source)}</span>` : ''}
    </footer>`;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-link')) return;
    openJob(job.id);
  });
  card.addEventListener('keydown', (e) => onCardKey(e, job));
  card.addEventListener('dragstart', (e) => {
    dragId = job.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', job.id);
    placeholder.style.height = `${card.offsetHeight}px`;
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragId = null;
    resetDragUi();
  });
  return card;
}

function renderStatsLine() {
  const total = state.jobs.length;
  const applied = state.jobs.filter((j) => j.appliedAt).length;
  const week = state.jobs.filter((j) => {
    const d = daysSince(j.appliedAt);
    return d !== null && d >= 0 && d < 7;
  }).length;
  $('#statsLine').innerHTML = `
    <span>${statPart(total, plural(total, 'statJobsOne', 'statJobsMany'))}</span>
    <span>${statPart(applied, t('statApplied'))}</span>
    <span>${statPart(week, t('statLast7'))}</span>`;
}
function statPart(n, label) {
  return `<strong>${n}</strong>${escapeHtml(label)}`;
}

// ---------- keyboard ----------

async function onCardKey(e, job) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openJob(job.id);
    return;
  }
  if (!e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const colIndex = state.columns.findIndex((c) => c.id === job.status);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const target = state.columns[colIndex + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (target) await moveJob(job.id, target.id, null, true);
  } else {
    const list = state.jobs.filter((j) => j.status === job.status).sort(sortByOrder);
    const i = list.findIndex((j) => j.id === job.id);
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= list.length) return;
    const before = e.key === 'ArrowUp' ? list[j] : list[j + 1];
    await moveJob(job.id, job.status, before ? before.id : null, false);
  }
  boardEl.querySelector(`.card[data-id="${CSS.escape(job.id)}"]`)?.focus();
}

// ---------- drag & drop ----------

function bindDropZone(section, colId) {
  const body = $('.column-body', section);
  section.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    section.classList.add('drag-over');
    $('.column-empty', body)?.setAttribute('hidden', '');
    const after = [...body.querySelectorAll('.card:not(.dragging)')].find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (after) {
      if (placeholder.nextElementSibling !== after) body.insertBefore(placeholder, after);
    } else if (body.lastElementChild !== placeholder) {
      body.append(placeholder);
    }
  });
  section.addEventListener('dragleave', (e) => {
    if (section.contains(e.relatedTarget)) return;
    section.classList.remove('drag-over');
    if (section.contains(placeholder)) placeholder.remove();
    $('.column-empty', body)?.removeAttribute('hidden');
  });
  section.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const next = placeholder.parentElement === body ? placeholder.nextElementSibling : null;
    const beforeId = next && next.classList.contains('card') ? next.dataset.id : null;
    moveJob(dragId, colId, beforeId, true);
  });
}

function resetDragUi() {
  placeholder.remove();
  boardEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  boardEl.querySelectorAll('.column-empty[hidden]').forEach((el) => el.removeAttribute('hidden'));
}

async function moveJob(id, status, beforeId, announce) {
  const job = state.jobs.find((j) => j.id === id);
  dragId = null;
  if (!job) return;
  const prev = job.status;
  job.status = status;
  const list = state.jobs.filter((j) => j.status === status && j.id !== id).sort(sortByOrder);
  let idx = beforeId ? list.findIndex((j) => j.id === beforeId) : list.length;
  if (idx < 0) idx = list.length;
  list.splice(idx, 0, job);
  list.forEach((j, i) => { j.order = i; });
  const hadDate = Boolean(job.appliedAt);
  applyStatusChange(job, prev, state.columns);
  job.updatedAt = Date.now();
  render();
  await saveJobs(list);
  if (prev !== status && announce) {
    toast(!hadDate && job.appliedAt ? t('movedWithDate', columnName(status)) : t('moved', columnName(status)));
  }
}

// ---------- columns ----------

function columnName(id) {
  return state.columns.find((c) => c.id === id)?.name || id;
}

async function persistColumns() {
  render();
  await saveColumns(state.columns);
}

function startRename(colId) {
  const col = state.columns.find((c) => c.id === colId);
  const section = boardEl.querySelector(`.column[data-id="${CSS.escape(colId)}"]`);
  if (!col || !section) return;
  const heading = $('.column-name', section);
  const input = document.createElement('input');
  input.className = 'column-rename';
  input.value = col.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', t('columnName'));
  heading.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== col.name) {
      col.name = name;
      persistColumns();
    } else {
      render();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function addColumn() {
  const used = new Set(state.columns.map((c) => c.color));
  const color = COLUMN_COLORS.find((c) => !used.has(c)) || COLUMN_COLORS[state.columns.length % COLUMN_COLORS.length];
  const col = { id: `col-${newId().slice(0, 8)}`, name: t('newColumn'), color, kind: 'interview' };
  // keep "rejected" (and similar end states) at the right end
  const endIndex = state.columns.findIndex((c) => c.kind === 'rejected');
  if (endIndex > 0) state.columns.splice(endIndex, 0, col); else state.columns.push(col);
  await persistColumns();
  boardEl.querySelector(`.column[data-id="${CSS.escape(col.id)}"]`)?.scrollIntoView({ inline: 'nearest' });
  startRename(col.id);
}

async function moveColumn(colId, dir) {
  const i = state.columns.findIndex((c) => c.id === colId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.columns.length) return;
  [state.columns[i], state.columns[j]] = [state.columns[j], state.columns[i]];
  await persistColumns();
}

async function deleteColumn(colId) {
  const col = state.columns.find((c) => c.id === colId);
  if (!col || state.columns.length <= 1) return;
  const target = state.columns.find((c) => c.id !== colId);
  const affected = state.jobs.filter((j) => j.status === colId);
  if (affected.length && !confirm(t('confirmDeleteColumn', col.name, String(affected.length), target.name))) return;
  affected.forEach((j) => {
    const prev = j.status;
    j.status = target.id;
    applyStatusChange(j, prev, state.columns);
    j.updatedAt = Date.now();
  });
  state.columns = state.columns.filter((c) => c.id !== colId);
  render();
  await saveJobs(affected);
  await saveColumns(state.columns);
  toast(t('columnDeleted', col.name));
}

function openColumnMenu(anchor, colId) {
  const index = state.columns.findIndex((c) => c.id === colId);
  const col = state.columns[index];
  openMenu(anchor, [
    { label: t('rename'), action: () => startRename(colId) },
    { colors: true, value: col.color, onPick: (color) => { col.color = color; persistColumns(); } },
    { heading: t('kindHeading') },
    ...KINDS.map((k) => ({
      label: t(`kind_${k}`),
      checked: col.kind === k,
      action: () => { col.kind = k; persistColumns(); },
    })),
    { separator: true },
    { label: t('moveLeft'), disabled: index === 0, action: () => moveColumn(colId, -1) },
    { label: t('moveRight'), disabled: index === state.columns.length - 1, action: () => moveColumn(colId, 1) },
    { separator: true },
    { label: t('deleteColumn'), danger: true, disabled: state.columns.length <= 1, action: () => deleteColumn(colId) },
  ]);
}

// ---------- menu ----------

function openMenu(anchor, items) {
  if (closeMenu) closeMenu();
  const menu = document.createElement('div');
  menu.className = 'popover';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separator) {
      menu.append(document.createElement('hr'));
    } else if (item.heading) {
      const h = document.createElement('p');
      h.className = 'menu-heading';
      h.textContent = item.heading;
      menu.append(h);
    } else if (item.colors) {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', t('columnColor'));
      for (const c of COLUMN_COLORS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.style.setProperty('--c', c);
        b.setAttribute('aria-pressed', String(c === item.value));
        b.setAttribute('aria-label', t('colorLabel', c));
        b.addEventListener('click', () => { close(); item.onPick(c); });
        wrap.append(b);
      }
      menu.append(wrap);
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `item${item.danger ? ' danger' : ''}`;
      b.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem');
      if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
      b.textContent = item.label;
      b.disabled = Boolean(item.disabled);
      b.addEventListener('click', () => { close(); item.action(); });
      menu.append(b);
    }
  }
  // inside an open dialog the menu has to live in the dialog, or it ends up behind it
  (anchor.closest('dialog[open]') || document.body).append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();

  const buttons = () => [...menu.querySelectorAll('button:not(:disabled)')];
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = buttons();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  };
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    boardEl.removeEventListener('scroll', close);
    closeMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    boardEl.addEventListener('scroll', close);
  });
  closeMenu = close;
}

// ---------- dialog ----------

function openFromHash() {
  const m = /^#job=(.+)$/.exec(location.hash);
  if (m) {
    setView('board', false);
    openJob(decodeURIComponent(m[1]));
  }
}

function openJob(id, status) {
  const job = id ? state.jobs.find((j) => j.id === id) : null;
  if (id && !job) {
    toast(t('jobGone'));
    clearHash();
    return;
  }
  editingId = job ? job.id : null;
  fillStatusSelect(jobForm.elements.namedItem('status'), state.columns);
  fillForm(jobForm, job || { status: status || state.columns[0].id, savedAt: today() });
  rounds = job && Array.isArray(job.interviews) ? job.interviews.map((r) => ({ ...r })) : [];
  renderRounds();
  renderLogoSlot();
  jobForm.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#dialogTitle').textContent = t(job ? 'dialogEdit' : 'dialogNew');
  $('#saveJob').textContent = t(job ? 'saveChanges' : 'saveJob');
  $('#deleteJob').hidden = !job;
  $('#dialogContact').open = Boolean(job && (job.contactName || job.contactEmail || job.contactPhone));
  renderHistory(job);
  updateOpenLink();
  formSnapshot = snapshot();
  if (!dialog.open) dialog.showModal();
  jobForm.elements.namedItem(job ? 'status' : 'company').focus();
}

// ---------- interview rounds in the dialog ----------

let rounds = [];

function renderRounds(focusLast = false) {
  const list = $('#roundList');
  const kindOptions = ['', ...ROUND_KINDS].map((k) => `<option value="${k}">${escapeHtml(t(k ? `roundKind_${k}` : 'roundKindAny'))}</option>`).join('');
  list.replaceChildren(...rounds.map((r, i) => {
    const li = document.createElement('li');
    li.className = 'round-item';
    li.innerHTML = `
      <div class="round-top">
        <span class="round-no">${escapeHtml(roundLabel(i + 1))}</span>
        <input type="date" class="round-date" aria-label="${escapeHtml(t('roundDate'))}">
        <input type="time" class="round-time" aria-label="${escapeHtml(t('roundTime'))}">
        <button type="button" class="btn ghost icon round-del" aria-label="${escapeHtml(t('roundRemove', roundLabel(i + 1)))}" title="${escapeHtml(t('roundRemove', roundLabel(i + 1)))}">
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="round-bottom">
        <select class="round-kind" aria-label="${escapeHtml(t('roundKind'))}">${kindOptions}</select>
        <input class="round-note" placeholder="${escapeHtml(t('roundNotePh'))}" aria-label="${escapeHtml(t('roundNote'))}">
      </div>`;
    const date = $('.round-date', li);
    const time = $('.round-time', li);
    const kind = $('.round-kind', li);
    const note = $('.round-note', li);
    date.value = r.date || '';
    time.value = r.time || '';
    kind.value = r.kind || '';
    note.value = r.note || '';
    date.addEventListener('input', () => { r.date = date.value; });
    time.addEventListener('input', () => { r.time = time.value; });
    kind.addEventListener('change', () => { r.kind = kind.value; });
    note.addEventListener('input', () => { r.note = note.value; });
    $('.round-del', li).addEventListener('click', () => {
      rounds.splice(i, 1);
      renderRounds();
      $('#addRound').focus();
    });
    return li;
  }));
  $('#roundsEmpty').hidden = rounds.length > 0;
  if (focusLast) list.querySelector('.round-item:last-child .round-date')?.focus();
}

function addRound() {
  rounds.push({ id: newId(), date: '', time: '', kind: '', note: '' });
  // an interview moves the job into the matching interview column
  const status = jobForm.elements.namedItem('status');
  const stages = interviewColumns(state.columns);
  if (stages.length) {
    const target = Math.min(rounds.length, stages.length) - 1;
    const col = state.columns.find((c) => c.id === status.value);
    const at = stages.findIndex((c) => c.id === status.value);
    if (col && (col.kind === 'wishlist' || col.kind === 'applied' || (at >= 0 && at < target))) {
      status.value = stages[target].id;
      status.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  renderRounds(true);
}

// ---------- logo in the dialog ----------

function renderLogoSlot() {
  const value = jobForm.elements.namedItem('logo').value;
  const img = $('#dLogoImg');
  const mono = $('#dLogoMono');
  img.hidden = !isLogo(value);
  mono.hidden = !img.hidden;
  if (!img.hidden) img.src = value;
  const name = jobForm.elements.namedItem('company').value || jobForm.elements.namedItem('title').value;
  mono.textContent = initials(name || '+');
  $('#logoSlot').style.setProperty('--h', hueFor(name || '?'));
}

async function setLogoFromBlob(blob) {
  const data = await imageToLogo(blob);
  if (!data) {
    toast(t('logoInvalid'));
    return;
  }
  jobForm.elements.namedItem('logo').value = data;
  renderLogoSlot();
}

function onLogoSlot(e) {
  const input = jobForm.elements.namedItem('logo');
  if (!input.value) {
    $('#logoFile').click();
    return;
  }
  openMenu(e.currentTarget, [
    { label: t('logoPick'), action: () => $('#logoFile').click() },
    { label: t('logoRemove'), danger: true, action: () => { input.value = ''; renderLogoSlot(); } },
  ]);
}

function renderHistory(job) {
  const box = $('#historyBox');
  const entries = job && Array.isArray(job.history) ? job.history : [];
  box.hidden = entries.length < 2;
  if (box.hidden) return;
  const fmt = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { day: '2-digit', month: '2-digit', year: 'numeric' });
  $('#historyList').innerHTML = entries.map((h) => `<li><span>${escapeHtml(columnName(h.status))}</span><time${h.estimated ? ' class="unknown"' : ''}>${escapeHtml(h.estimated ? t('historyNoDate') : fmt.format(new Date(h.at)))}</time></li>`).join('');
}

function updateOpenLink() {
  const url = safeHttpUrl(jobForm.elements.namedItem('url').value.trim());
  const link = $('#openLink');
  link.hidden = !url;
  link.href = url || '#';
}

function clearHash() {
  if (location.hash.startsWith('#job=')) history.replaceState(null, '', location.pathname);
}

async function saveDialog(e) {
  e.preventDefault();
  const data = readForm(jobForm);
  if (!data.company && !data.title) {
    $('#dCompanyField').classList.add('invalid');
    $('#dTitleField').classList.add('invalid');
    jobForm.elements.namedItem('company').focus();
    toast(t('errNeedCompanyOrTitle'));
    return;
  }
  const wasEditing = Boolean(editingId);
  let job;
  if (editingId) {
    job = state.jobs.find((j) => j.id === editingId);
    if (!job) {
      toast(t('jobGone'));
      dialog.close();
      return;
    }
    const prev = job.status;
    Object.assign(job, data);
    job.interviews = rounds.map((r) => ({ ...r }));
    applyStatusChange(job, prev, state.columns);
    if (prev !== job.status) job.order = -Date.now();
  } else {
    job = createJob({ ...data, interviews: rounds.map((r) => ({ ...r })), source: hostOf(data.url) || t('sourceManual') }, state.columns);
    state.jobs.push(job);
  }
  dialog.close();
  render();
  await saveJob(job);
  toast(t(wasEditing ? 'changesSaved' : 'jobSaved'));
}

async function deleteCurrent() {
  const job = state.jobs.find((j) => j.id === editingId);
  if (!job) return;
  state.jobs = state.jobs.filter((j) => j.id !== job.id);
  formSnapshot = snapshot(); // nothing to warn about
  dialog.close();
  render();
  await deleteJob(job.id);
  toast(t('jobDeleted'), {
    label: t('undo'),
    run: async () => {
      state.jobs.push(job);
      render();
      await saveJob(job);
      toast(t('jobRestored'));
    },
  });
}

// ---------- backup ----------

async function exportJson() {
  const backup = buildBackup(state);
  // your quick links from the job search tab travel along
  const links = await storedLinks().catch(() => null);
  if (links) backup.quickLinks = links;
  const json = JSON.stringify(backup, null, 2);
  downloadFile(`bewerbungen-backup-${today()}.json`, json, 'application/json');
  toast(t('backupExported'));
}

function exportCsv() {
  downloadFile(`bewerbungen-${today()}.csv`, toCSV(state), 'text/csv;charset=utf-8');
  toast(t('csvExported'));
}

async function importJson(file) {
  try {
    const backup = JSON.parse(await file.text());
    const result = mergeBackup(state, backup);
    state = result.state;
    render();
    await replaceAll(state);
    await importLinks(backup.quickLinks).catch((err) => console.error(err));
    toast(t('backupImported', String(result.added), String(result.updated)));
  } catch (err) {
    console.error(err);
    toast(err instanceof SyntaxError ? t('errNotJson') : err.message);
  }
}

// ---------- import from Excel / CSV ----------

const importDialog = $('#importDialog');
let importData = null;

function fieldLabel(field) {
  const labels = {
    '': t('importIgnore'), company: t('fieldCompany'), title: t('fieldTitle'), location: t('fieldLocation'),
    status: t('fieldStatus'), interview: t('field_interview'), appliedAt: t('fieldAppliedAt'), savedAt: t('fieldSavedAt'), url: t('fieldUrl'),
    workload: t('fieldWorkload'), workModel: t('fieldWorkModel'), source: t('field_source'),
    contactName: `${t('contactPerson')}: ${t('fieldContactName')}`,
    contactEmail: `${t('contactPerson')}: ${t('fieldContactEmail')}`,
    contactPhone: `${t('contactPerson')}: ${t('fieldContactPhone')}`,
    notes: t('fieldNotes'), description: t('fieldDescription'),
  };
  return labels[field] ?? field;
}

async function openTableImport(file) {
  let table;
  try {
    table = await readTableFile(file);
  } catch (err) {
    console.error(err);
    toast(t(err && err.message === 'xls' ? 'importErrXls' : 'importErrRead'));
    return;
  }
  if (!table.rows.length) {
    toast(t('importErrEmpty'));
    return;
  }
  const mapping = guessMapping(table.headers, table.rows);
  importData = { ...table, fileName: file.name, mapping, statusMap: {} };
  renderImportMapping();
  importDialog.showModal();
}

function statusValues() {
  const i = importData.mapping.indexOf('status');
  if (i < 0) return [];
  const counts = new Map();
  namedRows(importData.rows, importData.mapping).forEach((r) => { const v = (r[i] || '').trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderImportMapping() {
  const { headers, rows, mapping, fileName } = importData;
  $('#importFileInfo').textContent = t('importFileInfo', fileName, String(namedRows(rows, mapping).length));
  $('#importMap').replaceChildren(...headers.map((header, i) => {
    const tr = document.createElement('tr');
    const sample = rows.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ');
    tr.className = mapping[i] ? '' : 'ignored';
    tr.innerHTML = `<td>${escapeHtml(header)}</td><td class="sample" title="${escapeHtml(sample)}">${escapeHtml(sample)}</td><td></td>`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${t('importField')}: ${header}`);
    IMPORT_FIELDS.forEach((f) => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = fieldLabel(f);
      select.append(o);
    });
    select.value = mapping[i] || '';
    select.addEventListener('change', () => {
      // a field can only come from one column
      if (select.value) importData.mapping = importData.mapping.map((m, j) => (j !== i && m === select.value ? '' : m));
      importData.mapping[i] = select.value;
      renderImportMapping();
    });
    tr.lastElementChild.append(select);
    return tr;
  }));
  renderStatusMapping();
  updateImportSummary();
}

function renderStatusMapping() {
  const values = statusValues();
  $('#importStatusBox').hidden = !values.length;
  $('#importStatusMap').replaceChildren(...values.map(([value, count]) => {
    if (!(value in importData.statusMap)) importData.statusMap[value] = columnForKind(state.columns, guessStatusKind(value));
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(value)}</td><td class="count">${count}×</td><td></td>`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${t('fieldStatus')}: ${value}`);
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('importStatusAuto');
    select.append(auto, ...state.columns.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      return o;
    }));
    select.value = importData.statusMap[value] || '';
    select.addEventListener('change', () => {
      importData.statusMap[value] = select.value;
      updateImportSummary();
    });
    tr.lastElementChild.append(select);
    return tr;
  }));
}

function dryRun() {
  return buildImport({
    rows: importData.rows,
    mapping: importData.mapping,
    statusMap: importData.statusMap,
    columns: state.columns,
    existing: state.jobs,
    sourceLabel: t('sourceImport'),
  });
}

function updateImportSummary() {
  const summary = $('#importSummary');
  const button = $('#runImport');
  const named = importData.mapping.includes('company') || importData.mapping.includes('title');
  if (!named) {
    summary.textContent = t('importNeedName');
    summary.className = 'import-summary error';
    button.disabled = true;
    button.textContent = t('importRun', '0');
    return;
  }
  const res = dryRun();
  summary.className = 'import-summary';
  summary.textContent = [
    t('importSummary', String(res.jobs.length)),
    res.duplicates ? t('importSummaryDup', String(res.duplicates)) : '',
    res.empty ? t('importSummaryEmpty', String(res.empty)) : '',
  ].filter(Boolean).join(' ');
  button.disabled = !res.jobs.length;
  button.textContent = t('importRun', String(res.jobs.length));
}

async function runTableImport(e) {
  e.preventDefault();
  if (!importData) return;
  const { jobs } = dryRun();
  if (!jobs.length) return;
  importDialog.close();
  state.jobs.push(...jobs);
  render();
  await saveJobs(jobs);
  const ids = new Set(jobs.map((j) => j.id));
  toast(t('importDone', String(jobs.length)), {
    label: t('undo'),
    run: async () => {
      state.jobs = state.jobs.filter((j) => !ids.has(j.id));
      render();
      await Promise.all([...ids].map((id) => deleteJob(id)));
      toast(t('importUndone'));
    },
  });
  importData = null;
}

async function wipe() {
  if (!confirm(t('confirmWipe'))) return;
  await deleteEverything();
  state = await loadState();
  await saveColumns(state.columns);
  render();
  toast(t('wiped'));
}

// ---------- global events ----------

function bindGlobal() {
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !dialog.open && !importDialog.open && view === 'board') {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === 'Escape' && e.target === searchInput && searchInput.value) {
      searchInput.value = '';
      query = '';
      render();
    }
  });

  const tabs = Object.entries(VIEWS).map(([id, [tab]]) => [id, $(tab)]);
  tabs.forEach(([id, tab], i) => {
    tab.addEventListener('click', () => setView(id));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const other = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length][1];
      other.focus();
      other.click();
    });
  });

  $('#addJob').addEventListener('click', () => openJob(null));
  $('#menuBtn').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { label: t('exportJson'), action: exportJson },
    { label: t('importJson'), action: () => $('#importFile').click() },
    { separator: true },
    { label: t('importTable'), action: () => $('#tableFile').click() },
    { label: t('exportCsv'), action: exportCsv },
    { separator: true },
    { label: t('wipeAll'), danger: true, action: wipe },
  ]));
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importJson(file);
    e.target.value = '';
  });
  $('#tableFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) openTableImport(file);
    e.target.value = '';
  });
  $('#importForm').addEventListener('submit', runTableImport);
  $('#closeImport').addEventListener('click', () => importDialog.close());
  $('#cancelImport').addEventListener('click', () => importDialog.close());
  importDialog.addEventListener('close', () => { importData = null; });

  jobForm.addEventListener('submit', saveDialog);
  jobForm.addEventListener('input', (e) => {
    e.target.closest('.field')?.classList.remove('invalid');
    if (e.target.name === 'url') updateOpenLink();
    if (e.target.name === 'company' || e.target.name === 'title') renderLogoSlot();
  });
  $('#addRound').addEventListener('click', addRound);
  $('#logoSlot').addEventListener('click', onLogoSlot);
  $('#logoFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) setLogoFromBlob(file);
    e.target.value = '';
  });
  // drop an image on the logo, or paste one (a screenshot) while the dialog is open
  const slot = $('#logoSlot');
  slot.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); slot.classList.add('drop'); }
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('drop'));
  slot.addEventListener('drop', (e) => {
    e.preventDefault();
    slot.classList.remove('drop');
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) setLogoFromBlob(file);
  });
  dialog.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    const typing = e.target.closest('input:not([type="hidden"]), textarea') && e.clipboardData.types.includes('text/plain');
    if (!file || typing) return;
    e.preventDefault();
    setLogoFromBlob(file);
  });
  jobForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      jobForm.requestSubmit();
    }
  });
  bindStatusDateRules(jobForm, () => state.columns);
  $('#closeDialog').addEventListener('click', requestClose);
  $('#cancelDialog').addEventListener('click', requestClose);
  $('#deleteJob').addEventListener('click', deleteCurrent);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => {
    editingId = null;
    clearHash();
  });
  // a click on the dimmed backdrop closes, but only if it also started there
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && downOnBackdrop) requestClose();
  });
}

let formSnapshot = '';
function snapshot() {
  return JSON.stringify({ form: readForm(jobForm), rounds });
}
function requestClose() {
  if (snapshot() !== formSnapshot && !confirm(t('confirmDiscard'))) return;
  dialog.close();
}

let toastTimer = null;
function toast(text, action) {
  const el = $('#toast');
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      el.classList.remove('show');
      action.run();
    };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2600);
}

function hueFor(str) {
  let h = 0;
  for (const ch of String(str).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function initials(name) {
  const words = String(name || '?')
    .replace(/\(.*?\)/g, ' ')
    .split(/[\s\-/&,.+]+/)
    .filter((w) => w && !/^(ag|gmbh|sa|sàrl|sarl|ltd|llc|inc|kg|se|co|und|and|the|der|die|das)$/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
}
