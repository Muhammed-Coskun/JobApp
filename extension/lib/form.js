// Form helpers shared by the side panel and the board dialog.
import { JOB_FIELDS, today, normalizeWorkModel } from './store.js';

export function fillForm(form, job) {
  for (const name of JOB_FIELDS) {
    const el = form.elements.namedItem(name);
    if (!el) continue;
    let value = job && job[name] != null ? String(job[name]) : '';
    if (name === 'workModel') value = normalizeWorkModel(value);
    el.value = value;
  }
}

export function readForm(form) {
  const out = {};
  for (const name of JOB_FIELDS) {
    const el = form.elements.namedItem(name);
    if (!el) continue;
    out[name] = typeof el.value === 'string' ? el.value.trim() : '';
  }
  return out;
}

export function fillStatusSelect(select, columns, value) {
  select.replaceChildren(...columns.map((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    return o;
  }));
  if (value && columns.some((c) => c.id === value)) select.value = value;
}

// Keeps "status" and "applied on" consistent while you type:
// status moves away from the first column -> applied date today (if empty);
// applied date entered while still in the first column -> status "applied".
export function bindStatusDateRules(form, getColumns) {
  const status = form.elements.namedItem('status');
  const applied = form.elements.namedItem('appliedAt');
  if (!status || !applied) return;
  status.addEventListener('change', () => {
    const cols = getColumns();
    if (status.value !== cols[0]?.id && !applied.value) applied.value = today();
  });
  applied.addEventListener('change', () => {
    const cols = getColumns();
    if (applied.value && status.value === cols[0]?.id && cols.length > 1) {
      const target = cols.find((c) => c.kind === 'applied') || cols[1];
      status.value = target.id;
    }
  });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function safeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export function hostOf(url) {
  const safe = safeHttpUrl(url);
  return safe ? new URL(safe).hostname.replace(/^www\./, '') : '';
}
