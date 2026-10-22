// Quick links: square tiles next to the job search with your own saved searches
// (LinkedIn, jobs.ch, ...). Click opens the site in a new tab, the pencil edits
// name, link and image, drag to reorder. Data and helpers in lib/quicklinks.js.

import { t } from './lib/i18n.js';
import { escapeHtml } from './lib/form.js';
import { imageToLogo, isLogo } from './lib/logo.js';
import { fetchViaWorker, dataUrlToBlob } from './lib/net.js';
import {
  LINKS_KEY, MAX_LINKS, ICON_RETRY_MS, loadLinks, saveLinks, newLink, cleanLink,
  normalizeLinkUrl, siteName, suggestTitle, iconLinks, moveLink,
} from './lib/quicklinks.js';

const DRAG_TYPE = 'application/x-jat-link';
const ICON_EDIT = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M12.6 4.4 15.6 7.4M4 16l.7-3.4 8.8-8.8a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1l-8.8 8.8L4 16Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

let box = null;
let ctx = null;          // { initials, hueFor, toast }
let items = [];
let loaded = false;
let dragId = null;
let editing = null;      // dialog state: { id, image, iconUrl, iconAt, custom }
let iconJob = 0;         // newer "from the site" click wins
const iconCache = new Map();    // origin -> Promise<{ image, iconUrl }>
const permCache = new Map();    // origin -> may the extension fetch it

const $ = (sel) => document.querySelector(sel);

export function initQuickLinks(container, context) {
  box = container;
  ctx = context;
  bindDialog();
  box.addEventListener('click', onClick);
  box.addEventListener('keydown', onKey);
  box.addEventListener('dragstart', onDragStart);
  box.addEventListener('dragover', onDragOver);
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) clearDrop(); });
  box.addEventListener('drop', onDrop);
  box.addEventListener('dragend', () => { dragId = null; clearDrop(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !loaded || !changes[LINKS_KEY] || dragId) return;
    const next = changes[LINKS_KEY].newValue;
    const list = next && Array.isArray(next.items) ? next.items.map(cleanLink).filter(Boolean) : [];
    if (JSON.stringify(list) === JSON.stringify(items)) return;
    items = list;
    render();
  });
}

export async function showQuickLinks() {
  if (!loaded) {
    items = await loadLinks();
    loaded = true;
    render();
  }
  fillMissingIcons();
}

// ---------- tiles ----------

function imageHtml(link) {
  const site = siteName(link.url);
  const mono = `<span class="monogram" aria-hidden="true">${escapeHtml(ctx.initials(site || link.title))}</span>`;
  if (isLogo(link.image)) return `<img class="logo-img" src="${escapeHtml(link.image)}" alt="" draggable="false">`;
  if (link.iconUrl) return `<img class="logo-img" src="${escapeHtml(link.iconUrl)}" alt="" draggable="false" referrerpolicy="no-referrer" data-fallback="${escapeHtml(ctx.initials(site || link.title))}">`;
  return mono;
}

function tileHtml(link) {
  const site = siteName(link.url);
  return `
    <li class="ql-tile" data-id="${escapeHtml(link.id)}" draggable="true" style="--h:${ctx.hueFor(site || link.title)}">
      <a class="ql-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" draggable="false" title="${escapeHtml(link.url)}">
        <span class="ql-img">${imageHtml(link)}</span>
        <span class="ql-name">${escapeHtml(link.title)}</span>
        <span class="ql-site">${escapeHtml(site)}</span>
      </a>
      <button type="button" class="ql-edit" data-edit="${escapeHtml(link.id)}" title="${escapeHtml(t('qlEdit', link.title))}" aria-label="${escapeHtml(t('qlEdit', link.title))}">${ICON_EDIT}</button>
    </li>`;
}

function render() {
  if (!box) return;
  const focused = document.activeElement && box.contains(document.activeElement)
    ? (document.activeElement.closest('[data-id]')?.dataset.id || document.activeElement.id) : null;
  const add = items.length < MAX_LINKS
    ? `<li class="ql-add-item"><button type="button" class="ql-add" id="qlAdd">${ICON_PLUS}<span>${escapeHtml(t('qlAdd'))}</span></button></li>`
    : '';
  box.innerHTML = `
    <div class="ql-head">
      <h2 id="qlHeading">${escapeHtml(t('qlTitle'))}</h2>
    </div>
    <p class="ql-hint">${escapeHtml(t(items.length ? 'qlHint' : 'qlEmpty'))}</p>
    <ul class="ql-grid" aria-labelledby="qlHeading">${items.map(tileHtml).join('')}${add}</ul>`;
  box.querySelectorAll('img[data-fallback]').forEach((img) => img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = 'monogram';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = img.dataset.fallback;
    img.replaceWith(span);
  }, { once: true }));
  if (focused) {
    const tile = box.querySelector(`[data-id="${CSS.escape(focused)}"] .ql-link`);
    (tile || box.querySelector(`#${CSS.escape(focused)}`))?.focus();
  }
}

function onClick(e) {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    openDialog(items.find((l) => l.id === edit.dataset.edit) || null);
    return;
  }
  if (e.target.closest('#qlAdd')) openDialog(null);
}

// Alt + arrow keys move the focused tile
async function onKey(e) {
  const tile = e.target.closest('.ql-tile[data-id]');
  if (!tile || !e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  items = moveLink(items, tile.dataset.id, { step });
  await persist();
  box.querySelector(`[data-id="${CSS.escape(tile.dataset.id)}"] .ql-link`)?.focus();
}

async function persist() {
  render();
  try {
    await saveLinks(items);
  } catch (err) {
    console.error(err);
    ctx.toast(t('qlSaveFailed'));
  }
}

// ---------- drag and drop: sort tiles, or drop a link from another tab ----------

function onDragStart(e) {
  const tile = e.target.closest && e.target.closest('.ql-tile[data-id]');
  if (!tile) return;
  dragId = tile.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_TYPE, dragId);
  const link = items.find((l) => l.id === dragId);
  if (link) e.dataTransfer.setData('text/uri-list', link.url);
  tile.classList.add('dragging');
}

function dropTarget(e) {
  const tile = e.target.closest('.ql-tile[data-id], .ql-add-item');
  if (!tile) return null;
  const r = tile.getBoundingClientRect();
  const after = tile.classList.contains('ql-add-item') ? false
    : (e.clientY > r.bottom - r.height * 0.15) || (e.clientY >= r.top && e.clientX > r.left + r.width / 2);
  return { tile, after };
}

function clearDrop() {
  box.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
  box.classList.remove('drop-new');
}

function isExternalLink(e) {
  const types = [...(e.dataTransfer?.types || [])];
  return !types.includes(DRAG_TYPE) && (types.includes('text/uri-list') || types.includes('text/plain'));
}

function onDragOver(e) {
  if (dragId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = dropTarget(e);
    box.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (target && target.tile.dataset.id !== dragId) target.tile.classList.add(target.after ? 'drop-after' : 'drop-before');
    return;
  }
  if (isExternalLink(e) && items.length < MAX_LINKS) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    box.classList.add('drop-new');
  }
}

async function onDrop(e) {
  e.preventDefault();
  if (dragId) {
    const id = dragId;
    const target = dropTarget(e);
    clearDrop();
    dragId = null;
    if (!target || target.tile.dataset.id === id) return;
    let before = null;
    if (target.tile.dataset.id) {
      if (!target.after) before = target.tile.dataset.id;
      else {
        const rest = items.filter((l) => l.id !== id);
        const i = rest.findIndex((l) => l.id === target.tile.dataset.id);
        before = rest[i + 1] ? rest[i + 1].id : null;
      }
    }
    items = moveLink(items, id, { before });
    await persist();
    return;
  }
  clearDrop();
  const raw = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  const url = normalizeLinkUrl(raw);
  if (url) openDialog(null, url);
}

// ---------- icons from the sites ----------

async function canFetch(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return false; }
  if (!permCache.has(origin)) {
    let ok = false;
    try { ok = await chrome.permissions.contains({ origins: [`${origin}/*`] }); } catch { ok = false; }
    permCache.set(origin, ok);
  }
  return permCache.get(origin);
}

// Shows the image without reading it (sites the extension may not fetch).
function imageLoads(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; resolve(false); }, 5000);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth >= 8); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

// Best icon of a site: stored as a small image when the extension may load it,
// otherwise its address (loaded like a logo on a job card).
async function findIcon(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return { image: '', iconUrl: '' }; }
  const candidates = [];
  // the start page names the icons; fetched by the service worker (see lib/net.js)
  if (await canFetch(origin)) candidates.push(...iconLinks(await fetchViaWorker(`${origin}/`).catch(() => ''), `${origin}/`));
  candidates.push(`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`);
  for (const c of [...new Set(candidates)].slice(0, 6)) {
    if (await canFetch(c)) {
      const data = await fetchViaWorker(c, { as: 'image' }).catch(() => '');
      const image = data ? await imageToLogo(await dataUrlToBlob(data)) : '';
      if (image) return { image, iconUrl: '' };
    } else if (await imageLoads(c)) {
      return { image: '', iconUrl: c };
    }
  }
  return { image: '', iconUrl: '' };
}

function iconFor(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { return Promise.resolve({ image: '', iconUrl: '' }); }
  if (!iconCache.has(origin)) {
    const p = findIcon(url).catch(() => ({ image: '', iconUrl: '' }));
    iconCache.set(origin, p);
    // a failed search may be tried again later
    p.then((r) => { if (!r.image && !r.iconUrl) setTimeout(() => iconCache.delete(origin), 60000); });
  }
  return iconCache.get(origin);
}

async function fillMissingIcons() {
  const now = Date.now();
  const todo = items.filter((l) => !l.custom && !l.image && !l.iconUrl && now - (l.iconAt || 0) > ICON_RETRY_MS);
  for (const link of todo) {
    const icon = await iconFor(link.url);
    const current = items.find((l) => l.id === link.id);
    if (!current || current.custom || current.image || current.iconUrl || current.url !== link.url) continue;
    Object.assign(current, icon, { iconAt: Date.now() });
    await persist();
  }
}

// ---------- dialog ----------

function bindDialog() {
  const dialog = $('#linkDialog');
  const form = $('#linkForm');
  const close = () => dialog.close();
  $('#qlClose').addEventListener('click', close);
  $('#qlCancel').addEventListener('click', close);
  $('#qlDelete').addEventListener('click', deleteEditing);
  form.addEventListener('submit', (e) => { e.preventDefault(); saveDialog(); });
  form.addEventListener('input', (e) => {
    e.target.closest('.field')?.classList.remove('invalid');
    if (e.target.name === 'url' || e.target.name === 'title') {
      setMsg('');
      updateTitlePlaceholder();
      renderPreview();
    }
  });
  // "linkedin.com/jobs/..." becomes a full address when you leave the field
  form.elements.namedItem('url').addEventListener('change', () => {
    const input = form.elements.namedItem('url');
    const url = normalizeLinkUrl(input.value);
    if (url) input.value = url;
    renderPreview();
  });
  $('#qlFetchIcon').addEventListener('click', loadSiteIcon);
  $('#qlPickImage').addEventListener('click', () => $('#qlFile').click());
  $('#qlRemoveImage').addEventListener('click', () => {
    Object.assign(editing, { image: '', iconUrl: '', custom: true });
    setMsg('');
    renderPreview();
  });
  $('#qlFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) setImageFromBlob(file);
    e.target.value = '';
  });
  const preview = $('#qlPreview');
  preview.addEventListener('click', () => $('#qlFile').click());
  preview.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); preview.classList.add('drop'); }
  });
  preview.addEventListener('dragleave', () => preview.classList.remove('drop'));
  preview.addEventListener('drop', (e) => {
    e.preventDefault();
    preview.classList.remove('drop');
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) setImageFromBlob(file);
  });
  dialog.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    const typing = e.target.closest('input') && e.clipboardData.types.includes('text/plain');
    if (!file || typing) return;
    e.preventDefault();
    setImageFromBlob(file);
  });
  dialog.addEventListener('close', () => { editing = null; iconJob += 1; });
}

function openDialog(link, presetUrl = '') {
  const form = $('#linkForm');
  editing = link
    ? { id: link.id, image: link.image, iconUrl: link.iconUrl, iconAt: link.iconAt, custom: link.custom, url: link.url }
    : { id: null, image: '', iconUrl: '', iconAt: 0, custom: false, url: '' };
  form.reset();
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  form.elements.namedItem('title').value = link ? link.title : '';
  form.elements.namedItem('url').value = link ? link.url : presetUrl;
  $('#qlDialogTitle').textContent = t(link ? 'qlDialogEdit' : 'qlDialogNew');
  $('#qlDelete').hidden = !link;
  setMsg('');
  updateTitlePlaceholder();
  renderPreview();
  $('#linkDialog').showModal();
  form.elements.namedItem(link || presetUrl ? 'title' : 'url').focus();
}

function formUrl() {
  return normalizeLinkUrl($('#linkForm').elements.namedItem('url').value);
}

function updateTitlePlaceholder() {
  const url = formUrl();
  $('#linkForm').elements.namedItem('title').placeholder = url ? suggestTitle(url) : t('qlNamePh');
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function renderPreview() {
  if (!editing) return;
  const form = $('#linkForm');
  const url = formUrl();
  const title = form.elements.namedItem('title').value.trim() || (url ? suggestTitle(url) : '');
  // an icon from another site does not fit a changed link
  const siteImage = !editing.custom && editing.url && url && !sameOrigin(editing.url, url) ? { image: '', iconUrl: '' } : editing;
  const preview = $('#qlPreview');
  const site = url ? siteName(url) : '';
  preview.style.setProperty('--h', ctx.hueFor(site || title || '?'));
  preview.innerHTML = url || title || siteImage.image
    ? imageHtml({ url, title, image: siteImage.image, iconUrl: siteImage.iconUrl })
    : `<span class="monogram ql-empty-img" aria-hidden="true">${ICON_PLUS}</span>`;
  preview.querySelector('img[data-fallback]')?.addEventListener('error', (e) => {
    const span = document.createElement('span');
    span.className = 'monogram';
    span.textContent = e.target.dataset.fallback;
    e.target.replaceWith(span);
  }, { once: true });
  $('#qlFetchIcon').disabled = !url;
}

async function setImageFromBlob(blob) {
  const data = await imageToLogo(blob);
  if (!editing) return;
  if (!data) {
    setMsg(t('logoInvalid'), true);
    return;
  }
  Object.assign(editing, { image: data, iconUrl: '', custom: true, url: formUrl() || editing.url });
  setMsg('');
  renderPreview();
}

async function loadSiteIcon() {
  const url = formUrl();
  if (!url || !editing) return;
  const job = ++iconJob;
  const btn = $('#qlFetchIcon');
  btn.disabled = true;
  setMsg(t('qlImageLoading'));
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* checked above */ }
  iconCache.delete(origin);
  const icon = await iconFor(url);
  if (job !== iconJob || !editing) return;
  btn.disabled = false;
  if (!icon.image && !icon.iconUrl) {
    setMsg(t('qlImageNotFound'), true);
    return;
  }
  Object.assign(editing, icon, { custom: false, iconAt: Date.now(), url });
  setMsg('');
  renderPreview();
}

function setMsg(text, error = false) {
  const el = $('#qlMsg');
  el.textContent = text;
  el.classList.toggle('error', error);
}

async function saveDialog() {
  const form = $('#linkForm');
  const urlInput = form.elements.namedItem('url');
  const url = formUrl();
  if (!url) {
    urlInput.closest('.field').classList.add('invalid');
    setMsg(t('qlUrlInvalid'), true);
    urlInput.focus();
    return;
  }
  const title = form.elements.namedItem('title').value.trim() || suggestTitle(url);
  const keepImage = editing.custom || (editing.url && sameOrigin(editing.url, url));
  const fields = {
    title,
    url,
    image: keepImage ? editing.image : '',
    iconUrl: keepImage ? editing.iconUrl : '',
    iconAt: keepImage ? editing.iconAt : 0,
    custom: editing.custom,
  };
  let link;
  if (editing.id && items.some((l) => l.id === editing.id)) {
    link = cleanLink({ ...fields, id: editing.id });
    items = items.map((l) => (l.id === editing.id ? link : l));
  } else {
    link = newLink(fields);
    items = [...items, link].slice(0, MAX_LINKS);
  }
  $('#linkDialog').close();
  await persist();
  box.querySelector(`[data-id="${CSS.escape(link.id)}"] .ql-link`)?.focus();
  if (!link.custom && !link.image && !link.iconUrl) fillMissingIcons();
}

async function deleteEditing() {
  if (!editing || !editing.id) return;
  const index = items.findIndex((l) => l.id === editing.id);
  if (index < 0) return;
  const removed = items[index];
  items = items.filter((l) => l.id !== removed.id);
  $('#linkDialog').close();
  await persist();
  box.querySelector('#qlAdd')?.focus();
  ctx.toast(t('qlDeleted'), {
    label: t('undo'),
    run: async () => {
      if (items.some((l) => l.id === removed.id)) return;
      items = [...items.slice(0, index), removed, ...items.slice(index)];
      await persist();
    },
  });
}
