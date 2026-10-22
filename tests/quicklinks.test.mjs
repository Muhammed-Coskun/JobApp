// Quick links on the job search tab: links you paste, icons a site names in
// its HTML, and moving tiles around.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  i18n: { getMessage: (key, subs) => (subs ? `${key}:${[].concat(subs).join('|')}` : key), getUILanguage: () => 'de' },
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
      set: async (obj) => { Object.assign(store, structuredClone(obj)); },
    },
  },
};
const Q = await import('../extension/lib/quicklinks.js');

test('links you type or paste become full web addresses', () => {
  assert.equal(Q.normalizeLinkUrl('jobs.ch/de/stellenangebote/?term=Java'), 'https://jobs.ch/de/stellenangebote/?term=Java');
  assert.equal(Q.normalizeLinkUrl('  https://www.linkedin.com/jobs/search/?keywords=AI  '), 'https://www.linkedin.com/jobs/search/?keywords=AI');
  assert.equal(Q.normalizeLinkUrl('javascript:alert(1)'), '');
  assert.equal(Q.normalizeLinkUrl('chrome://settings'), '');
  assert.equal(Q.normalizeLinkUrl('Kreuzlingen'), '');
  assert.equal(Q.normalizeLinkUrl(''), '');
  assert.equal(Q.siteName('https://ch.linkedin.com/jobs'), 'LinkedIn');
  assert.equal(Q.siteName('https://www.arbeitsagentur.de/jobsuche/suche'), 'Arbeitsagentur');
  assert.equal(Q.siteName('https://www.example.org/x'), 'example.org');
  assert.equal(Q.suggestTitle('https://www.linkedin.com/jobs/search/?keywords=AI&location=Kreuzlingen%2C%20Kreuzlingen%2C%20Schweiz'), 'qlJobsIn:Kreuzlingen');
  assert.equal(Q.suggestTitle('https://www.stepstone.de/jobs/java'), 'StepStone');
});

test('stored links: none at the start, an empty list stays empty, broken entries are dropped', async () => {
  assert.deepEqual(await Q.loadLinks(), []);
  assert.equal(await Q.storedLinks(), null, 'nothing is written on the first look');
  await Q.saveLinks([]);
  assert.deepEqual(await Q.loadLinks(), []);
  store[Q.LINKS_KEY] = { version: 1, items: [
    { id: 'a', title: '  Meine   Suche ', url: 'jobs.ch/de/stellenangebote/?term=AI', image: 'data:image/png;base64,AAAA', custom: true },
    { id: 'b', title: 'kaputt', url: 'javascript:alert(1)' },
    { id: 'a', title: 'doppelt', url: 'https://www.jobs.ch/' },
    { id: 'c', title: '', url: 'https://www.linkedin.com/jobs/search/?keywords=AI', image: 'https://evil.example/x.png', iconUrl: 'https://static.licdn.com/aero/icon' },
  ] };
  const links = await Q.loadLinks();
  assert.deepEqual(links.map((l) => [l.id, l.title, l.url]), [
    ['a', 'Meine Suche', 'https://jobs.ch/de/stellenangebote/?term=AI'],
    ['c', 'LinkedIn', 'https://www.linkedin.com/jobs/search/?keywords=AI'],
  ]);
  assert.equal(links[0].image, 'data:image/png;base64,AAAA');
  assert.equal(links[1].image, '', 'only stored images, no addresses, in the image field');
  assert.equal(links[1].iconUrl, 'https://static.licdn.com/aero/icon');
});

test('icons a page names: apple-touch-icon and big ones first, relative links resolved', () => {
  const html = `<head>
    <link rel="stylesheet" href="/x.css">
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel='shortcut icon' href='https://static.example.com/favicon.ico'>
    <link rel="mask-icon" href="/safari.svg" color="#000">
    <link href="/icons/192.png?v=2&amp;x=1" rel="icon" sizes="192x192">
    <link rel="apple-touch-icon" href="/apple.png">
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
  </head>`;
  assert.deepEqual(Q.iconLinks(html, 'https://www.jobs.ch/'), [
    'https://www.jobs.ch/icons/192.png?v=2&x=1',
    'https://www.jobs.ch/apple.png',
    'https://static.example.com/favicon.ico',
    'https://www.jobs.ch/icon.svg',
    'https://www.jobs.ch/favicon-16.png',
  ]);
  assert.deepEqual(Q.iconLinks('', 'https://x.ch/'), []);
});

test('moving tiles: before another, to the end, by a step', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const ids = (list) => list.map((l) => l.id).join('');
  assert.equal(ids(Q.moveLink(items, 'd', { before: 'a' })), 'dabc');
  assert.equal(ids(Q.moveLink(items, 'a', { before: null })), 'bcda');
  assert.equal(ids(Q.moveLink(items, 'a', { before: 'c' })), 'bacd');
  assert.equal(ids(Q.moveLink(items, 'b', { step: -1 })), 'bacd');
  assert.equal(ids(Q.moveLink(items, 'a', { step: -1 })), 'abcd');
  assert.equal(ids(Q.moveLink(items, 'd', { step: 1 })), 'abcd');
  assert.equal(ids(Q.moveLink(items, 'x', { step: 1 })), 'abcd');
});

test('quick links from a backup: only new ones are added, nothing is replaced', async () => {
  const mine = [
    Q.cleanLink({ id: 'a', title: 'Meine Suche', url: 'https://www.jobs.ch/de/stellenangebote/?term=AI' }),
    Q.cleanLink({ id: 'b', title: 'LinkedIn', url: 'https://www.linkedin.com/jobs/search/?keywords=AI' }),
  ];
  const { items, added } = Q.mergeLinks(mine, [
    { id: 'a', title: 'Andere Suche', url: 'https://www.stepstone.de/jobs/ai' },
    { id: 'x', title: 'Umbenannt', url: 'https://www.jobs.ch/de/stellenangebote/?term=AI' },
    { id: 'y', title: 'kaputt', url: 'javascript:void(0)' },
    'Unsinn',
  ]);
  assert.equal(added, 1);
  assert.deepEqual(items.map((l) => l.title), ['Meine Suche', 'LinkedIn', 'Andere Suche']);
  assert.notEqual(items[2].id, 'a', 'a clashing id gets a new one');
  // restoring on a new computer: the backup's links
  delete store[Q.LINKS_KEY];
  assert.equal(await Q.storedLinks(), null);
  assert.equal(await Q.importLinks(mine), 2);
  assert.deepEqual((await Q.loadLinks()).map((l) => l.id), ['a', 'b']);
  assert.equal(await Q.importLinks(mine), 0);
  assert.equal(await Q.importLinks(undefined), 0);
});
