// Tiny wrapper around chrome.i18n. UI language follows the browser
// (German for German browsers, English for everything else).

export function t(key, ...subs) {
  const msg = chrome.i18n.getMessage(key, subs.map(String));
  return msg || key;
}

export const uiLang = () => (chrome.i18n.getUILanguage() || 'en').toLowerCase();

// <span data-i18n="key">, <input data-i18n-placeholder="key">,
// <button data-i18n-title="key" data-i18n-aria-label="key">
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    const dataKey = `data-i18n-${attr}`;
    root.querySelectorAll(`[${dataKey}]`).forEach((el) => el.setAttribute(attr, t(el.getAttribute(dataKey))));
  }
  if (root === document) document.documentElement.lang = uiLang().startsWith('de') ? 'de' : 'en';
}

export function plural(n, oneKey, manyKey) {
  return t(n === 1 ? oneKey : manyKey, String(n));
}
