// Requests to the portals. Web pages (HTML) are fetched by the service worker,
// not by the board or the side panel: Chrome follows "Link: rel=preload" headers
// of a fetch() response inside a page and tries to load the site's scripts into
// it. The extension's CSP blocks that, but Chrome lists it as an error of the
// extension (jobs.ch sends such headers on its start page).

const inPage = typeof document !== 'undefined';
const MAX_IMAGE = 1000000;

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// as: 'json' | 'text' | 'image' (a data: URL, '' when the answer is no image)
export async function fetchDirect(url, { init = {}, as = 'text', timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'omit', ...init, signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    if (as === 'json') return await res.json();
    if (as === 'image') {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) return '';
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 40 || buffer.byteLength > MAX_IMAGE) return '';
      return `data:${type};base64,${base64(buffer)}`;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// From a page: through the service worker. In the service worker: directly.
export async function fetchViaWorker(url, { init = {}, as = 'text' } = {}) {
  if (!inPage || !(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) return fetchDirect(url, { init, as });
  const answer = await chrome.runtime.sendMessage({
    type: 'net-fetch',
    url,
    as,
    headers: init.headers || {},
    credentials: init.credentials === 'include' ? 'include' : 'omit',
  });
  if (!answer) throw new Error('no answer from the service worker');
  if (!answer.ok) {
    const err = new Error(answer.message || 'request failed');
    if (answer.status) err.status = answer.status;
    if (answer.name) err.name = answer.name;
    throw err;
  }
  return answer.value;
}

// The service worker's side. Only for the extension's own pages, only https.
export function handleNetMessage(msg, sender, sendResponse) {
  if (!msg || msg.type !== 'net-fetch') return false;
  const own = sender && sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  let url = null;
  try { url = new URL(msg.url); } catch { url = null; }
  if (!own || !url || url.protocol !== 'https:') {
    sendResponse({ ok: false, message: 'not allowed' });
    return false;
  }
  const headers = msg.headers && typeof msg.headers === 'object' ? msg.headers : {};
  const as = ['text', 'image', 'json'].includes(msg.as) ? msg.as : 'text';
  fetchDirect(url.href, { init: { headers, credentials: msg.credentials === 'include' ? 'include' : 'omit' }, as })
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err) => sendResponse({ ok: false, status: err.status || 0, name: err.name || 'Error', message: String(err.message || err) }));
  return true;
}

// data: URL from the worker -> Blob for lib/logo.js
export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}
