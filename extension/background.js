// Service worker: the toolbar icon (and Alt+Shift+J) opens the side panel, and
// the job search refreshes in the background.
//
// We handle the click ourselves instead of letting Chrome toggle the panel,
// because the click is what grants temporary access (activeTab) to the page
// you are looking at. The panel then reads that page.
//
// Browsers without the side panel API (some Chromium forks) get the same page
// as a classic popup instead.

import { SEARCH_ALARM, runSearch, scheduleSearch, updateBadge } from './lib/search.js';
import { handleNetMessage } from './lib/net.js';

const hasSidePanel = Boolean(chrome.sidePanel && chrome.sidePanel.open);

function setup() {
  if (hasSidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    chrome.action.setPopup({ popup: '' }).catch(() => {});
  } else {
    chrome.action.setPopup({ popup: 'sidepanel.html?popup=1' }).catch(() => {});
  }
  scheduleSearch().catch(() => {});
  updateBadge().catch(() => {});
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
// Chrome may drop alarms on an update or restart; recreate it whenever the worker starts
scheduleSearch().catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!hasSidePanel) return;
  // open() must run synchronously inside the click, before any await
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.warn('sidePanel.open', err));
  // If the panel is already open, tell it to read this tab now.
  chrome.runtime.sendMessage({ type: 'read-tab', tabId: tab.id, windowId: tab.windowId }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SEARCH_ALARM) runSearch().catch((err) => console.warn('job search', err));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'search-settings') scheduleSearch({ reset: true }).catch(() => {});
});
// web pages for the board (see lib/net.js)
chrome.runtime.onMessage.addListener(handleNetMessage);

// A job saved to the board (from anywhere) no longer counts as new.
let badgeTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith('job:') || ['search:seen', 'search:dismissed', 'search:visit', 'search:config'].includes(k))) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => updateBadge().catch(() => {}), 400);
});
