// Loads the real extension into Chromium and drives the side panel and the board.
//
// Two test-only changes are made to a temporary copy of the extension:
//   - host_permissions <all_urls> + tabs, because activeTab is only granted by a real
//     click on the toolbar icon, which automation cannot do;
//   - the side panel accepts ?tabId=<id>, because in a test it is opened as a normal
//     tab and would otherwise read itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// the service worker fetches web pages for the board (lib/net.js): let the routes below see those requests too
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FX = path.join(ROOT, 'tests', 'fixtures');
const fx = (name) => readFile(path.join(FX, name), 'utf8');

let context;
let extDir;
let profileDir;
let extId;
let board;

const LINKEDIN_URL = 'https://www.linkedin.com/jobs/search/?currentJobId=4000000042&keywords=software%20engineer&location=Zurich';
const JOBSCH_URL = 'https://www.jobs.ch/de/stellenangebote/?location=Zurich&term=Software&jobid=22222222-aaaa-bbbb-cccc-000000000002';

async function buildTestCopy() {
  extDir = await mkdtemp(path.join(tmpdir(), 'jat-ext-'));
  await cp(path.join(ROOT, 'extension'), extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions = [...manifest.permissions, 'tabs'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const panelPath = path.join(extDir, 'sidepanel.js');
  const panel = await readFile(panelPath, 'utf8');
  const needle = 'const [tab] = await chrome.tabs.query({ active: true, windowId });';
  assert.ok(panel.includes(needle), 'side panel code changed, update the test shim');
  await writeFile(panelPath, panel.replace(needle,
    "const forced = new URLSearchParams(location.search).get('tabId'); if (forced) return chrome.tabs.get(Number(forced)).catch(() => null); " + needle));
}

async function serveFixtures(ctx) {
  const pages = {
    'https://www.linkedin.com/jobs/search/': await fx('linkedin_2026.html'),
    'https://www.jobs.ch/de/stellenangebote/': await fx('jobsch_search.html'),
  };
  const api = {
    '/voyager/api/jobs/jobPostings/4000000042': [await fx('linkedin_voyager.json'), 'application/json'],
    '/jobs-guest/jobs/api/jobPosting/4000000042': [await fx('linkedin_guest_2026.html'), 'text/html'],
    '/api/v1/public/search/job/22222222-aaaa-bbbb-cccc-000000000002': [await fx('jobsch_api_2.json'), 'application/json'],
  };
  const logo = await readFile(path.join(FX, 'logo.png'));
  // company logos come from LinkedIn's image server
  await ctx.route(/^https:\/\/media\.licdn\.com\//, (route) => (route.request().url().includes('alpenwerk')
    ? route.fulfill({ status: 200, body: logo, contentType: 'image/png' })
    : route.fulfill({ status: 404, body: '' })));
  await ctx.route(/^https:\/\/(www\.)?(linkedin\.com|jobs\.ch)\//, (route) => {
    const url = route.request().url();
    for (const [pattern, [body, type]] of Object.entries(api)) {
      if (url.includes(pattern)) return route.fulfill({ status: 200, body, contentType: type });
    }
    for (const [prefix, body] of Object.entries(pages)) {
      if (url.startsWith(prefix)) return route.fulfill({ status: 200, body, contentType: 'text/html; charset=utf-8' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

// Job search: the three portals answer from fixtures. {{D0}} = today, {{D1}} = yesterday, ...
const dayIso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const withDays = (s) => s.replace(/\{\{D(\d+)\}\}/g, (_, n) => dayIso(Number(n)));
let linkedinDown = false;
const searchRequests = [];

async function serveSearchFixtures(ctx) {
  const file = async (name) => withDays(await fx(name));
  const logo = await readFile(path.join(FX, 'logo.png'));
  // registered after serveFixtures, so these run first
  await ctx.route(/^https:\/\/media\.jobs\.ch\//, (route) => route.fulfill({ status: 200, body: logo, contentType: 'image/png' }));
  await ctx.route(/^https:\/\/rest\.arbeitsagentur\.de\//, async (route) => {
    const url = new URL(route.request().url());
    searchRequests.push(url.href);
    await route.fulfill({ status: 200, body: await file('search_ba.json'), contentType: 'application/json' });
  });
  // quick links: jobs.ch names its icon in the page, the Arbeitsagentur has none here
  await ctx.route(/^https:\/\/www\.jobs\.ch\/(touch-icon\.png)?$/, (route) => (route.request().url().endsWith('.png')
    ? route.fulfill({ status: 200, body: logo, contentType: 'image/png' })
    // like the real start page: a Link header that asks to preload the site's scripts
    : route.fulfill({
      status: 200,
      body: '<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/touch-icon.png"></head></html>',
      contentType: 'text/html',
      headers: { link: '</public/scripts/vendors.js>; rel=preload; as=script' },
    })));
  await ctx.route(/^https:\/\/www\.arbeitsagentur\.de\/(apple-touch-icon\.png|favicon\.ico)?$/, (route) => route.fulfill({ status: 404, body: '' }));
  await ctx.route(/^https:\/\/www\.stepstone\.de\//, (route) => route.fulfill({ status: 404, body: '' }));
  await ctx.route(/^https:\/\/www\.arbeitsagentur\.de\/jobsuche\/jobdetail\//, async (route) => route.fulfill({
    status: 200, body: await file('search_ba_job.html'), contentType: 'text/html; charset=utf-8',
  }));
  await ctx.route(/^https:\/\/www\.jobs\.ch\/api\/v1\/public\/search(\?|\/job\/33333333)/, async (route) => {
    const url = new URL(route.request().url());
    searchRequests.push(url.href);
    if (url.pathname.includes('/job/')) return route.fulfill({ status: 200, body: await file('search_jobsch_job.json'), contentType: 'application/json' });
    const body = Number(url.searchParams.get('page') || 1) > 1 ? '{"documents":[]}' : await file('search_jobsch.json');
    return route.fulfill({ status: 200, body, contentType: 'application/json' });
  });
  await ctx.route(/^https:\/\/www\.linkedin\.com\/jobs-guest\/jobs\/api\/(seeMoreJobPostings|jobPosting\/44555700)/, async (route) => {
    const url = new URL(route.request().url());
    searchRequests.push(url.href);
    if (url.pathname.includes('/jobPosting/')) return route.fulfill({ status: 200, body: await fx('linkedin_guest_2026.html'), contentType: 'text/html' });
    if (linkedinDown) return route.fulfill({ status: 429, body: '' });
    const name = `search_linkedin_${/Konstanz/.test(url.searchParams.get('location')) ? 'de' : 'ch'}.html`;
    return route.fulfill({ status: 200, body: Number(url.searchParams.get('start')) ? '' : await file(name), contentType: 'text/html' });
  });
}

const storage = (page) => page.evaluate(() => chrome.storage.local.get(null));
// waitForFunction does not wait for promises: poll an async check instead
async function until(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`timed out: ${fn}`);
    await page.waitForTimeout(100);
  }
}
const jobsIn = async (page) => Object.entries(await storage(page)).filter(([k]) => k.startsWith('job:')).map(([, v]) => v);

async function openPanelFor(url) {
  const site = await context.newPage();
  await site.goto(url);
  const tabId = await board.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 760 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
  await panel.waitForSelector('#source:not([data-state="loading"])');
  return { site, panel };
}

// Column names follow the browser language, so ask the extension for them.
const defaultNames = () => board.evaluate(() => ['colSaved', 'colApplied', 'colInterview', 'colOffer', 'colRejected']
  .map((k) => chrome.i18n.getMessage(k)));

// a message in the language the browser runs in; NUM in a placeholder matches any number
const msg = (key, ...subs) => board.evaluate(([k, s]) => chrome.i18n.getMessage(k, s), [key, subs]);
const msgRe = async (key, ...subs) => new RegExp((await msg(key, ...subs)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/NUM/g, '\\d+'));

const value = (page, name) => page.evaluate((n) => document.querySelector('#jobForm').elements.namedItem(n).value, name);

before(async () => {
  await buildTestCopy();
  profileDir = await mkdtemp(path.join(tmpdir(), 'jat-profile-'));
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    locale: 'de-DE',
    viewport: { width: 1440, height: 880 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--lang=de-DE'],
  });
  context.on('dialog', (d) => d.accept());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extId = new URL(worker.url()).host;
  await serveFixtures(context);
  await serveSearchFixtures(context);
  board = await context.newPage();
  board.on('dialog', (d) => d.accept());
  await board.goto(`chrome-extension://${extId}/board.html`);
  await board.waitForSelector('.column');
});

after(async () => {
  await context?.close();
  await rm(extDir, { recursive: true, force: true });
  await rm(profileDir, { recursive: true, force: true });
});

test('empty board shows the five default columns and a hint', async () => {
  assert.equal(await board.locator('.column').count(), 5);
  assert.ok(await board.locator('#emptyHint').isVisible());
  const names = await board.locator('.column-name').allInnerTexts();
  assert.deepEqual(names, await defaultNames());
});

test('side panel fills the form from a LinkedIn job, keeps a draft and saves', async () => {
  await board.evaluate(() => chrome.storage.local.set({ settings: { closeAfterSave: false } }));
  const { site, panel } = await openPanelFor(LINKEDIN_URL);
  assert.equal(await panel.getAttribute('#source', 'data-state'), 'ok');
  assert.equal(await value(panel, 'company'), 'Alpenwerk Automobil AG');
  assert.equal(await value(panel, 'location'), 'Schlieren, Zürich, Schweiz');
  assert.equal(await value(panel, 'workload'), '80-100 %');
  assert.equal(await value(panel, 'workModel'), 'onsite');
  const description = await value(panel, 'description');
  assert.match(description, /• Konzeption und Entwicklung/);
  assert.doesNotMatch(description, /Mobile Developer Swift|Details zum Jobangebot|Mehr anzeigen/);
  // the company logo is loaded after reading and shown next to the company
  await panel.waitForSelector('#logoTile:not([hidden])');
  assert.match(await value(panel, 'logo'), /^data:image\/png;base64,/);
  // a new job is saved as applied, dated today
  assert.equal(await value(panel, 'status'), 'applied');
  assert.ok(await value(panel, 'appliedAt'));

  // typing, then "closing" the panel: the input must survive
  await panel.fill('[name=notes]', 'Über Kollegin empfohlen');
  await panel.waitForTimeout(500);
  await panel.reload();
  await panel.waitForSelector('#source:not([data-state="loading"])');
  assert.ok(await panel.locator('#draftNotice').isVisible(), 'draft notice shown');
  assert.equal(await value(panel, 'notes'), 'Über Kollegin empfohlen');

  await panel.click('#saveBtn');
  await panel.waitForSelector('.form-msg.ok');
  const jobs = await jobsIn(board);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceKey, 'linkedin:4000000042');
  assert.equal(jobs[0].notes, 'Über Kollegin empfohlen');
  assert.equal(jobs[0].history.length, 1);
  assert.equal(jobs[0].status, 'applied');
  assert.ok(jobs[0].appliedAt);
  assert.match(jobs[0].logo, /^data:image\/png;base64,/, 'logo saved with the job');
  const leftovers = Object.keys(await storage(board)).filter((k) => k.startsWith('draft:'));
  assert.deepEqual(leftovers, [], 'draft is removed after saving');

  // opening the same job again edits the saved card
  await panel.reload();
  await panel.waitForSelector('#source:not([data-state="loading"])');
  assert.ok(await panel.locator('#dupNotice').isVisible());
  await panel.selectOption('[name=status]', 'interview');
  await panel.click('#saveBtn');
  await panel.waitForSelector('.form-msg.ok');
  const after = await jobsIn(board);
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'interview');
  assert.equal(after[0].history.length, 2);
  await site.close();
  await panel.close();
});

test('jobs.ch search: the selected job is read, not the first one in the list', async () => {
  const { site, panel } = await openPanelFor(JOBSCH_URL);
  assert.equal(await value(panel, 'title'), 'Informatiker/in (100%)');
  assert.equal(await value(panel, 'company'), 'Medica Institut für Gesundheit AG');
  assert.equal(await value(panel, 'workload'), '80-100 %');
  assert.equal(await value(panel, 'contactName'), 'Petra Beispiel');
  await panel.click('#saveBtn');
  await panel.waitForSelector('.form-msg.ok');
  await site.close();
  await panel.close();
});

test('a page the extension may not read falls back to manual input', async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('#source:not([data-state="loading"])');
  await panel.click('#saveBtn');
  assert.ok(await panel.locator('#companyField.invalid').isVisible());
  await panel.close();
});

async function seedDemo(page) {
  await page.evaluate(() => {
    const day = (n) => {
      const d = new Date(Date.now() - n * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const at = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const rows = [
      ['Helix Labs', 'Software Engineer Digital Health', 'Zürich', 'hybrid', '100 %', 'LinkedIn', [['saved', 6]]],
      ['Lacustre SA', 'Développeur Front-End', 'Lausanne', 'remote', '100 %', 'jobup.ch', [['saved', 40], ['applied', 38], ['interview', 25]]],
      ['Helix Pharma', 'Frontend Developer React', 'Zürich', 'onsite', '', 'Indeed', [['saved', 50], ['applied', 48], ['rejected', 30]]],
      ['Messwerk Nord', 'Werkstudent Softwareentwicklung', 'Hamburg', '', 'Teilzeit', 'jobs.ch', [['saved', 45], ['applied', 44], ['interview', 30], ['offer', 9]]],
      ['Bergmarkt Genossenschaft', 'Mobile Engineer iOS/Android', 'Zürich', 'hybrid', '80-100 %', 'LinkedIn', [['saved', 12], ['applied', 4]]],
      ['Lindenbank', 'IT Business Analyst (60-80%)', 'Zürich', '', '60-80 %', 'jobs.ch', [['saved', 30], ['applied', 29]]],
      ['Biovalis', 'Data Engineer', 'Visp', 'hybrid', '100 %', 'LinkedIn', [['saved', 35], ['applied', 33], ['interview', 20], ['rejected', 12]]],
      ['Wolkenwerk', 'Cloud Engineer', 'Zürich', 'hybrid', '100 %', 'jobs.ch', [['saved', 28], ['applied', 27], ['rejected', 20]]],
      ['Hafen Versicherung', 'Junior Developer', 'Zürich', 'onsite', '100 %', 'StepStone', [['saved', 22], ['applied', 21]]],
      ['Lindenhof', 'Frontend Engineer', 'Zürich', 'hybrid', '80-100 %', 'LinkedIn', [['saved', 18], ['applied', 17], ['interview', 6]]],
    ];
    const now = Date.now();
    const patch = {};
    rows.forEach(([company, title, location, workModel, workload, source, path], i) => {
      const status = path[path.length - 1][0];
      const appliedStep = path.find(([s]) => s !== 'saved');
      const id = `demo-${i}`;
      patch[`job:${id}`] = {
        id, company, title, location, workModel, workload, source, sourceKey: '', url: `https://example.com/jobs/${i}`,
        description: '', notes: '', contactName: '', contactEmail: '', contactPhone: '',
        status, savedAt: day(path[0][1]), appliedAt: appliedStep ? day(appliedStep[1]) : '',
        history: path.map(([s, n]) => ({ status: s, at: at(n) })),
        order: i, createdAt: now - path[0][1] * 86400000, updatedAt: now,
      };
    });
    return chrome.storage.local.set(patch);
  });
}

test('board: cards, drag and drop, keyboard moves, search, dialog, undo', async () => {
  await seedDemo(board);
  await board.waitForTimeout(300);
  assert.ok((await board.locator('.card').count()) >= 12);
  assert.ok(!(await board.locator('#emptyHint').isVisible()));

  // drag Helix Labs from "Gespeichert" to "Beworben"
  await board.locator('.card[data-id="demo-0"]').dragTo(board.locator('.column[data-id="applied"] .column-body'));
  await board.waitForTimeout(300);
  let first = (await jobsIn(board)).find((j) => j.id === 'demo-0');
  assert.equal(first.status, 'applied');
  assert.ok(first.appliedAt);
  assert.equal(first.history.at(-1).status, 'applied');

  // keyboard: Alt+ArrowRight moves the focused card one column to the right
  await board.locator('.card[data-id="demo-0"]').focus();
  await board.keyboard.press('Alt+ArrowRight');
  await board.waitForTimeout(300);
  first = (await jobsIn(board)).find((j) => j.id === 'demo-0');
  assert.equal(first.status, 'interview');

  // search
  await board.fill('#search', 'zürich');
  await board.waitForTimeout(100);
  const visible = await board.locator('.card').count();
  assert.ok(visible >= 4 && visible < 12, `search filtered to ${visible}`);
  await board.fill('#search', '');

  // dialog edit
  await board.locator('.card[data-id="demo-1"]').click();
  assert.ok(await board.locator('#jobDialog').isVisible());
  assert.ok(await board.locator('#historyBox').isVisible(), 'status history is shown');
  await board.fill('#jobForm [name=notes]', 'Zweites Gespräch am Freitag');
  await board.click('#saveJob');
  await board.waitForTimeout(200);
  assert.equal((await jobsIn(board)).find((j) => j.id === 'demo-1').notes, 'Zweites Gespräch am Freitag');

  // delete and undo
  await board.locator('.card[data-id="demo-8"]').click();
  await board.click('#deleteJob');
  await board.waitForTimeout(200);
  assert.ok(!(await jobsIn(board)).some((j) => j.id === 'demo-8'));
  await board.click('#toastAction');
  await board.waitForTimeout(300);
  assert.ok((await jobsIn(board)).some((j) => j.id === 'demo-8'), 'undo restores the job');
});

test('columns: rename, add, choose meaning, export and import a backup', async () => {
  await board.locator('.column[data-id="interview"] .column-name').dblclick();
  await board.fill('.column-rename', 'Gespräche');
  await board.keyboard.press('Enter');
  await board.click('.add-column');
  await board.fill('.column-rename', 'Assessment');
  await board.keyboard.press('Enter');
  await board.waitForTimeout(200);
  const names = await board.locator('.column-name').allInnerTexts();
  const [saved, applied, , offer, rejected] = await defaultNames();
  assert.deepEqual(names, [saved, applied, 'Gespräche', offer, 'Assessment', rejected]);

  const download = board.waitForEvent('download');
  await board.click('#menuBtn');
  await board.locator('.popover button.item').first().click();
  const file = await (await download).path();
  const backup = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(backup.jobs.length, (await jobsIn(board)).length);

  await board.evaluate(() => chrome.storage.local.clear());
  await board.reload();
  await board.waitForSelector('.column');
  await board.setInputFiles('#importFile', file);
  await board.waitForTimeout(400);
  assert.equal(await board.locator('.card').count(), backup.jobs.length);
  assert.deepEqual(await board.locator('.column-name').allInnerTexts(), names);
});

test('statistics: Sankey, key numbers and PNG export', async () => {
  await board.click('#tabStats');
  await board.waitForSelector('#sankey svg');
  const nodes = await board.locator('#sankey .sk-node').count();
  assert.ok(nodes >= 4, `sankey has ${nodes} nodes`);
  const kpis = await board.locator('.kpi-value').allInnerTexts();
  assert.equal(kpis.length, 5);
  const download = board.waitForEvent('download');
  await board.click('#exportPng');
  const png = await (await download).path();
  const bytes = await readFile(png);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  await board.click('#tabBoard');
});

test('dark mode and a narrow window stay usable', async () => {
  await board.emulateMedia({ colorScheme: 'dark' });
  await board.waitForTimeout(150);
  await board.click('#tabStats');
  await board.waitForSelector('#sankey svg');
  await board.click('#tabBoard');
  await board.emulateMedia({ colorScheme: 'light' });
  await board.setViewportSize({ width: 420, height: 820 });
  await board.waitForTimeout(150);
  const overflow = await board.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
  await board.setViewportSize({ width: 1440, height: 880 });
});

test('import from Excel and CSV: columns, status values, duplicates, undo', async () => {
  const before = (await jobsIn(board)).length;
  const cols = await board.evaluate(() => chrome.storage.local.get('columns').then((d) => d.columns));
  const colOf = (kind) => cols.find((c) => c.kind === kind).id;

  await board.setInputFiles('#tableFile', path.join(FX, 'bewerbungen.xlsx'));
  await board.waitForSelector('#importDialog[open]');
  const mapping = await board.$$eval('#importMap select', (els) => els.map((e) => e.value));
  assert.deepEqual(mapping, ['company', 'title', 'location', 'appliedAt', 'status', 'url', 'notes', 'workload']);
  const statuses = await board.$$eval('#importStatusMap tr', (rows) => rows.map((r) => [r.cells[0].textContent, r.querySelector('select').value]));
  const map = Object.fromEntries(statuses);
  assert.equal(map.Absage, colOf('rejected'));
  assert.equal(map.Interview, colOf('interview'));
  assert.equal(map.Zusage, colOf('offer'));
  assert.equal(map.beworben, colOf('applied'));
  assert.match(await board.textContent('#importSummary'), /4/);
  await board.click('#runImport');
  await board.waitForTimeout(300);

  const jobs = await jobsIn(board);
  assert.equal(jobs.length, before + 4, 'four new jobs, two duplicates skipped');
  const helix = jobs.find((j) => j.company === 'Helix Labs' && j.title === 'Software Engineer');
  assert.equal(helix.status, colOf('rejected'));
  assert.equal(helix.appliedAt, '2026-02-03');
  assert.equal(helix.workload, '100 %');
  assert.equal(helix.history.length, 2);
  assert.equal(helix.history[1].estimated, true);
  assert.equal(jobs.find((j) => j.company === 'Northpeak').workload, '80 %');
  assert.equal(jobs.find((j) => j.company === 'Kleinwerk GmbH').workload, '60-80 %');
  assert.equal(jobs.find((j) => j.company === 'Lindenbank' && j.title === 'IT Business Analyst').status, colOf('offer'));

  // CSV from Excel on Windows (semicolons, Windows-1252), then undo
  await board.setInputFiles('#tableFile', path.join(FX, 'bewerbungen.csv'));
  await board.waitForSelector('#importDialog[open]');
  const csvStatuses = await board.$$eval('#importStatusMap td:first-child', (tds) => tds.map((td) => td.textContent));
  assert.ok(csvStatuses.includes('Gespräch'), 'umlauts survive the Windows encoding');
  await board.click('#runImport');
  await board.waitForTimeout(300);
  const afterCsv = await jobsIn(board);
  assert.equal(afterCsv.length, before + 5, 'only the one new job from the CSV');
  const biovalis = afterCsv.find((j) => j.title === 'Data Engineer, Python');
  assert.equal(biovalis.appliedAt, '2026-04-01');
  assert.equal(biovalis.status, colOf('applied'));
  await board.click('#toastAction');
  await board.waitForTimeout(300);
  assert.equal((await jobsIn(board)).length, before + 4, 'undo removes the CSV import');
});

test('import from a tracker template: spare rows, source column, interview round, no date', async () => {
  const before = (await jobsIn(board)).length;
  const cols = await board.evaluate(() => chrome.storage.local.get('columns').then((d) => d.columns));
  const colOf = (kind) => cols.find((c) => c.kind === kind).id;

  await board.setInputFiles('#tableFile', path.join(FX, 'tracker-template.xlsx'));
  await board.waitForSelector('#importDialog[open]');
  const headers = await board.$$eval('#importMap td:first-child', (tds) => tds.map((td) => td.textContent));
  assert.ok(!headers.includes('Notes'), 'empty columns are left out');
  const mapping = Object.fromEntries(await board.$$eval('#importMap tr', (rows) => rows.map((r) => [r.cells[0].textContent, r.querySelector('select').value])));
  assert.equal(mapping['Company'], 'company');
  assert.equal(mapping['Position'], 'title');
  assert.equal(mapping['Job Link'], 'source', 'a link column without links is the source');
  assert.equal(mapping['Date Applied'], 'appliedAt');
  assert.equal(mapping['Interview Round'], 'interview');
  assert.equal(mapping['Contact'], 'contactName');
  assert.equal(mapping['Extra'], '', 'one stray link does not make a link column');
  assert.match(await board.textContent('#importFileInfo'), /: 6 /, 'rows with only a default status do not count');
  const statuses = await board.$$eval('#importStatusMap td:first-child', (tds) => tds.map((td) => td.textContent));
  assert.ok(!statuses.includes('To do'), 'template rows do not show up as a status');
  const statusMap = Object.fromEntries(await board.$$eval('#importStatusMap tr', (rows) => rows.map((r) => [r.cells[0].textContent, r.querySelector('select').value])));
  assert.equal(statusMap.Ghosted, colOf('applied'), 'ghosted means no reply');
  const summary = await board.textContent('#importSummary');
  assert.match(summary, /6/);
  assert.doesNotMatch(summary, /ignor/i, 'template rows are skipped silently');
  await board.click('#runImport');
  await board.waitForTimeout(300);

  const jobs = await jobsIn(board);
  assert.equal(jobs.length, before + 6);
  const companySite = await board.evaluate(() => chrome.i18n.getMessage('sourceCompanySite'));
  const by = (c) => jobs.find((j) => j.company === c);
  const northwind = by('Northwind Analytics AG');
  assert.equal(northwind.source, companySite, '"Karriereseite" is the company website');
  assert.equal(northwind.contactName, 'Mi 18.02. Jana Klein');
  assert.equal(northwind.url, '');
  assert.deepEqual(northwind.interviews.map((r) => [r.date, r.note]), [['', 'First Round']]);
  assert.deepEqual(northwind.history.map((h) => [h.status, Boolean(h.estimated)]),
    [[colOf('applied'), false], [colOf('interview'), true], [colOf('rejected'), true]]);
  assert.equal(by('Kestrel Software').source, 'LinkedIn');
  assert.equal(by('Kestrel Software').status, colOf('applied'));
  const lindenwerk = by('Lindenwerk Bank');
  assert.equal(lindenwerk.status, colOf('interview'));
  assert.deepEqual(lindenwerk.history.map((h) => [h.at.slice(0, 10), Boolean(h.estimated)]), [['2026-03-02', false], ['2026-03-16', false]]);
  assert.deepEqual(lindenwerk.interviews.map((r) => r.date), ['2026-03-16']);
  const orbis = by('Orbis Systems');
  assert.equal(orbis.source, companySite, 'a source naming the company itself is its website');
  assert.equal(orbis.appliedAt, '', 'no date in the file stays empty');
  assert.ok(orbis.history.every((h) => h.estimated));

  // the history shows "date unknown" instead of the import day
  await board.click(`.card[data-id="${orbis.id}"]`);
  await board.waitForSelector('#jobDialog[open]');
  assert.match(await board.textContent('#historyList'), /Datum unbekannt|date unknown/);
  await board.click('#cancelDialog');
});

test('interview rounds: card chip, dialog, stats, and jobs saved before rounds existed', async () => {
  const cols = await board.evaluate(() => chrome.storage.local.get('columns').then((d) => d.columns));
  const colOf = (kind) => cols.find((c) => c.kind === kind).id;
  const iso = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // a job from an older version: no interview rounds, only a move into the interview column
  await board.evaluate(({ interview, applied, at }) => chrome.storage.local.set({
    'job:legacy-1': {
      id: 'legacy-1', company: 'Altbestand AG', title: 'Entwickler', status: interview, savedAt: '2026-02-02', appliedAt: '2026-02-02',
      history: [{ status: applied, at: '2026-02-02T10:00:00.000Z' }, { status: interview, at }], order: -1, createdAt: 1, updatedAt: 1,
    },
  }), { interview: colOf('interview'), applied: colOf('applied'), at: `${iso(-5)}T10:00:00.000Z` });
  await board.reload();
  await board.waitForSelector('.card[data-id="legacy-1"]');
  assert.match(await board.textContent('.card[data-id="legacy-1"] .chip.round'), /Interview/);
  const legacy = (await jobsIn(board)).find((j) => j.id === 'legacy-1');
  assert.equal(legacy.interviews, undefined, 'nothing is rewritten just by opening the board');

  // a new job: adding a round moves it to the interview column
  await board.click('#addJob');
  await board.waitForSelector('#jobDialog[open]');
  await board.fill('[name=company]', 'Rundenwerk GmbH');
  await board.fill('[name=title]', 'Backend Engineer');
  await board.setInputFiles('#logoFile', path.join(FX, 'logo.png'));
  await board.waitForSelector('#dLogoImg:not([hidden])');
  await board.click('#addRound');
  assert.equal(await board.inputValue('#jobForm [name=status]'), colOf('interview'));
  await board.fill('#roundList .round-item:nth-child(1) .round-date', iso(-3));
  await board.selectOption('#roundList .round-item:nth-child(1) .round-kind', 'video');
  await board.click('#addRound');
  await board.fill('#roundList .round-item:nth-child(2) .round-date', iso(4));
  await board.fill('#roundList .round-item:nth-child(2) .round-note', 'Mit dem Teamlead');
  await board.click('#saveJob');
  await board.waitForTimeout(300);
  const job = (await jobsIn(board)).find((j) => j.company === 'Rundenwerk GmbH');
  // the second round goes to the second interview column, if the board has one
  const stages = cols.filter((c) => c.kind === 'interview');
  assert.equal(job.status, stages[Math.min(2, stages.length) - 1].id);
  assert.deepEqual(job.interviews.map((r) => [r.date, r.kind, r.note]), [[iso(-3), 'video', ''], [iso(4), '', 'Mit dem Teamlead']]);
  assert.match(job.logo, /^data:image\/png;base64,/);
  const chip = board.locator(`.card[data-id="${job.id}"] .chip.round`);
  assert.match(await chip.textContent(), /2/);
  assert.ok(await chip.evaluate((el) => el.classList.contains('planned')), 'a future round is shown as planned');
  assert.equal(await board.locator(`.card[data-id="${job.id}"] img.logo-img`).count(), 1);

  // rejected after the second round: the chip stays, the Sankey shows where it ended
  await board.evaluate(({ id, rejected }) => chrome.storage.local.get(`job:${id}`).then((d) => {
    const j = d[`job:${id}`];
    j.history.push({ status: rejected, at: new Date().toISOString() });
    j.status = rejected;
    return chrome.storage.local.set({ [`job:${id}`]: j });
  }), { id: job.id, rejected: colOf('rejected') });
  await board.waitForTimeout(300);
  assert.equal(await board.locator(`.card[data-id="${job.id}"] .chip.round`).count(), 1);
  await board.click('#tabStats');
  await board.waitForSelector('#sankey svg');
  const tips = await board.$$eval('#sankey [data-tip]', (els) => els.map((e) => e.getAttribute('data-tip')));
  assert.ok(tips.some((x) => /Interview 2|2\. Interview/.test(x)), 'second round in the Sankey');
  assert.ok(tips.some((x) => /(nach|after) (Interview 2|2\. Interview)/.test(x)), 'rejection after round 2 is its own node');
  assert.match(await board.textContent('#interviews'), /Rundenwerk GmbH/);
  assert.match(await board.textContent('#interviews'), /Altbestand AG/);
  assert.equal(await board.locator('#pie svg .pie-slice').count() > 0, true, 'pie chart drawn');
  await board.click('[data-pie="source"]');
  assert.ok(await board.locator('#pie .pie-legend li').count() > 0);
  // labels are never cut off at the right edge
  const overflow = await board.$eval('#sankey svg', (svg) => {
    const box = svg.viewBox.baseVal;
    return [...svg.querySelectorAll('text')].some((tx) => { const b = tx.getBBox(); return b.x < 0 || b.x + b.width > box.width + 1; });
  });
  assert.equal(overflow, false);
  await board.click('#tabBoard');

  // the add-column button is a slim "+"
  const w = await board.$eval('.add-column', (el) => el.getBoundingClientRect().width);
  assert.ok(w <= 48, `add column is ${w}px wide`);
});

test('job search: three portals, filters, save to the board, hide, badge, settings', async () => {
  // a site's scripts must never be pulled into the board (Chrome reports that as an error of the extension)
  const cspErrors = [];
  board.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  const visible = () => board.$$eval('#jsList .hit:not(.is-hidden) .hit-title a', (els) => els.map((e) => e.textContent.trim()).sort());
  const settled = () => board.waitForFunction(() => document.querySelector('#jsStatus') && !document.querySelector('#jsStatus.busy')
    && document.querySelector('#jsRefresh') && !document.querySelector('#jsRefresh').disabled, null, { timeout: 40000 });
  const hitRow = (title) => board.locator('#jsList .hit', { has: board.locator('.hit-title a', { hasText: title }) }).first();

  // first visit, nothing set up: the settings open by themselves, with nothing preset
  await board.click('#tabSearch');
  assert.equal(new URL(board.url()).hash, '#search');
  await board.waitForSelector('#searchDialog[open]');
  assert.equal(await board.locator('#ssRegions .ss-row').count(), 1);
  assert.equal(await board.inputValue('#ssRegions [data-f="name"]'), '');
  assert.equal(await board.inputValue('#ssRegions [data-f="place"]'), '');
  assert.equal(await board.locator('#ssTerms .ss-row').count(), 1);
  assert.equal(await board.inputValue('#ssTerms [data-f="queries"]'), '');
  assert.equal(await board.inputValue('#searchForm [name="exclude"]'), '');
  assert.equal(await board.evaluate(() => document.activeElement.dataset.f), 'name');
  await board.click('#ssSave');
  assert.equal(await board.textContent('#ssMsg'), await msg('ssNeedRegion'));
  await board.click('#ssCancel');
  // no quick links either: an empty start
  await board.waitForSelector('#jsLinks #qlAdd');
  assert.equal(await board.locator('#jsLinks .ql-tile').count(), 0);
  assert.ok(await board.locator('#jsSetup').isVisible());
  assert.equal(searchRequests.length, 0, 'nothing is searched without a setup');

  // set up (as if typed in): a region on each side of the Swiss-German border, five groups of search terms
  await board.evaluate(async () => {
    const S = await import(chrome.runtime.getURL('lib/search.js'));
    const config = S.defaultSearchConfig();
    config.regions = [
      { id: 'de-konstanz', name: 'Konstanz', country: 'de', place: 'Konstanz', lat: 47.6603, lon: 9.1758, radiusKm: 60, enabled: true, linkedinGeoId: '100000002', linkedinGeoName: 'Konstanz, Baden-Württemberg, Deutschland' },
      { id: 'ch-kreuzlingen', name: 'Kreuzlingen', country: 'ch', place: 'Kreuzlingen', lat: 47.6505, lon: 9.1750, radiusKm: 60, enabled: true, linkedinGeoId: '100000001', linkedinGeoName: 'Kreuzlingen, Thurgau, Schweiz' },
    ];
    config.terms = [
      { id: 'dev', name: 'Software', queries: ['Softwareentwickler', 'Software Engineer'] },
      { id: 'ml', name: 'Machine Learning', queries: ['Machine Learning Engineer', 'KI Engineer'] },
      { id: 'backend', name: 'Backend', queries: ['Backend', 'Fullstack', 'Java'] },
      { id: 'web', name: 'Web', queries: ['Frontend', 'React'] },
      { id: 'apps', name: 'Apps', queries: ['iOS', 'Flutter'] },
    ];
    config.exclude = 'Werkstudent, Working Student';
    await S.saveSearchConfig(config);
  });
  await board.waitForFunction(() => !document.querySelector('#jsSetup'));
  await board.click('#jsRefresh');
  await board.waitForSelector('#jsList .hit', { timeout: 40000 });
  await settled();
  const all = [
    'Frontend Developer (m/w/d)', 'KI Engineer (m/w/d)', 'Machine Learning Engineer', 'Mobile Developer & Flutter',
    'Senior Frontend Engineer (React)', 'Software Engineer (w/m/d)', 'Softwareentwickler (m/w/d)',
    'Softwareentwickler:in Java (80-100%)', 'iOS Developer',
  ].sort();
  assert.deepEqual(await visible(), all);
  // the requests: jobs.ch for Kreuzlingen by region, the Arbeitsagentur for Konstanz with 60 km, LinkedIn for both
  assert.ok(searchRequests.some((u) => u.includes('jobs.ch/api/v1/public/search?') && u.includes('region-ids%5B%5D=18') && u.includes('sort=date')));
  assert.ok(searchRequests.some((u) => u.includes('rest.arbeitsagentur.de') && u.includes('wo=Konstanz') && u.includes('umkreis=60')));
  assert.ok(searchRequests.some((u) => u.includes('seeMoreJobPostings') && u.includes('location=Kreuzlingen') && u.includes('f_TPR=r604800')));
  assert.ok(searchRequests.some((u) => u.includes('seeMoreJobPostings') && u.includes('location=Konstanz')));
  // LinkedIn gets the id of the place, so "Kreuzlingen" cannot turn into German postings; shown per country
  assert.ok(searchRequests.some((u) => u.includes('seeMoreJobPostings') && u.includes('geoId=100000001')));
  assert.ok(searchRequests.some((u) => u.includes('seeMoreJobPostings') && u.includes('geoId=100000002')));
  const sourceLine = await board.textContent('#jsSources');
  assert.match(sourceLine, /LinkedIn DE/);
  assert.match(sourceLine, /LinkedIn CH/);
  // "Details": what each portal sent and why postings were left out, and where it searched
  await board.click('#jsSourceDetails');
  const details = await board.textContent('.src-details');
  assert.match(details, new RegExp(`jobs\\.ch ${(await msgRe('searchDetailsRequests', 'NUM')).source} · ${(await msgRe('searchDetailsReceived', 'NUM')).source}`));
  assert.match(details, await msgRe('searchDetailsCountry', '2'));
  assert.ok(details.includes(`Kreuzlingen: Kreuzlingen, ${await msg('ssCountry_ch')}, 60 km`));
  assert.ok(!details.includes(await msg('searchDetailsNoCoords')));
  await board.click('#jsSourceDetails');
  assert.equal(await board.locator('.src-details').count(), 0);

  // place, distance, workload; the same job on two portals is one row with both links
  const voltwerk = hitRow('Softwareentwickler:in Java');
  assert.match(await voltwerk.locator('.hit-meta').textContent(), /Voltwerk Energie AG.*Kreuzlingen.*80-100 %/);
  assert.match(await voltwerk.locator('.hit-distance').textContent(), /^1 km$/);
  assert.deepEqual(await hitRow('Frontend Developer').locator('.src-link').allTextContents(), ['Arbeitsagentur', 'LinkedIn']);
  assert.match(await hitRow('Softwareentwickler (m/w/d)').locator('.hit-meta').textContent(), /Brückenwerk Software GmbH.*Allensbach/);
  // far away (Zug, and Bern on LinkedIn), older than a week, or in the other country than the
  // region it was found for (Allensbach in the Kreuzlingen search, Kreuzlingen in the Konstanz search): not there at all
  const everything = await board.textContent('#viewSearch');
  for (const gone of ['Zuger Fintech', 'Appfabrik Bern', 'Altes Inserat', 'Querfeld Digital', 'Uferwerk Software']) assert.ok(!everything.includes(gone), gone);
  // jobs.ch gets its own Referer and Sec-Fetch-Site (rules.json), like requests from its own pages
  assert.deepEqual(await board.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()), ['portals']);
  // other titles and excluded words are counted and can be shown
  await board.click('#jsShowHidden');
  assert.deepEqual(await board.$$eval('#jsList .hit.is-hidden .hit-title a', (els) => els.map((e) => e.textContent.trim()).sort()),
    ['Lagerist (m/w/d)', 'Sales Manager DACH', 'Software Architekt:in', 'Werkstudent:in Softwareentwickler']);
  await board.click('#jsShowHidden');

  // region, age, search term, senior
  await board.click('[data-region="ch-kreuzlingen"]');
  assert.deepEqual(await visible(), ['Machine Learning Engineer', 'Mobile Developer & Flutter', 'Senior Frontend Engineer (React)',
    'Software Engineer (w/m/d)', 'Softwareentwickler:in Java (80-100%)']);
  await board.click('[data-region="de-konstanz"]');
  assert.deepEqual(await visible(), ['Frontend Developer (m/w/d)', 'KI Engineer (m/w/d)', 'Softwareentwickler (m/w/d)', 'iOS Developer']);
  await board.click('[data-region="all"]');
  await board.click('[data-days="1"]');
  assert.deepEqual(await visible(), ['Software Engineer (w/m/d)', 'Softwareentwickler (m/w/d)', 'Softwareentwickler:in Java (80-100%)']);
  await board.click('[data-days="3"]');
  await board.click('[data-term="ml"]');
  assert.deepEqual(await visible(), ['KI Engineer (m/w/d)', 'Machine Learning Engineer']);
  await board.click('[data-term="ml"]');
  await board.click('#jsSenior');
  assert.ok(!(await visible()).includes('Senior Frontend Engineer (React)'));
  await board.click('#jsSenior');
  assert.equal((await visible()).length, all.length);

  // "Merken": a card in the first column with the description, contact and logo from the portal
  const firstColumn = (await storage(board)).columns[0].id;
  await voltwerk.locator('[data-save]').click();
  await until(board, () => chrome.storage.local.get(null).then((d) => Object.values(d)
    .some((v) => v && v.sourceKey === 'jobcloud:33333333-aaaa-bbbb-cccc-000000000001')));
  let saved = (await jobsIn(board)).find((j) => j.sourceKey === 'jobcloud:33333333-aaaa-bbbb-cccc-000000000001');
  assert.equal(saved.company, 'Voltwerk Energie AG');
  assert.equal(saved.status, firstColumn);
  assert.equal(saved.workload, '80-100 %');
  assert.equal(saved.source, 'jobs.ch');
  assert.match(saved.description, /• Du entwickelst unsere Plattform für Netzdaten weiter/);
  assert.equal(saved.contactName, 'Lea Beispiel');
  assert.equal(saved.contactEmail, 'jobs@voltwerk.example');
  assert.match(saved.logo, /^data:image\/png;base64,/);
  await board.waitForFunction(() => ![...document.querySelectorAll('#jsList .hit:not(.is-hidden) .hit-title a')].some((a) => a.textContent.includes('Voltwerk') || a.textContent.includes('Java (80')));
  // from the Arbeitsagentur: the description comes from the job page
  await hitRow('Softwareentwickler (m/w/d)').locator('[data-save]').click();
  await until(board, () => chrome.storage.local.get(null).then((d) => Object.values(d).some((v) => v && v.sourceKey === 'ba:10000-1000000001-S')));
  saved = (await jobsIn(board)).find((j) => j.sourceKey === 'ba:10000-1000000001-S');
  assert.equal(saved.source, 'Arbeitsagentur');
  assert.equal(saved.url, 'https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1000000001-S');
  assert.match(saved.description, /Weiterentwicklung unserer Branchensoftware/);
  assert.equal(saved.logo, '');
  // saved jobs are listed as "on your board" and open the card
  await board.click('#jsShowHidden');
  await hitRow('Softwareentwickler (m/w/d)').locator('[data-open]').click();
  await board.waitForSelector('#jobDialog[open]');
  assert.equal(await value(board, 'company'), 'Brückenwerk Software GmbH');
  await board.keyboard.press('Escape');
  await board.click('#tabSearch');
  await settled();
  await board.click('#jsShowHidden');

  // hide one, then undo
  await hitRow('Machine Learning Engineer').locator('[data-dismiss]').click();
  assert.ok(!(await visible()).includes('Machine Learning Engineer'));
  await board.click('#toastAction');
  await board.waitForFunction(() => [...document.querySelectorAll('#jsList .hit:not(.is-hidden) .hit-title a')].some((a) => a.textContent === 'Machine Learning Engineer'));

  // badge: everything seen before the last visit is old; pretend the last visit was long ago
  const openHits = all.length - 2;
  await board.evaluate(() => chrome.storage.local.set({ 'search:visit': 1 }));
  await until(board, (n) => chrome.action.getBadgeText({}).then((x) => x === String(n)), openHits);
  await board.click('#tabBoard');
  await board.waitForFunction((n) => document.querySelector('#tabSearchCount') && !document.querySelector('#tabSearchCount').hidden
    && document.querySelector('#tabSearchCount').textContent === String(n), openHits);
  await board.click('#tabSearch');
  await until(board, () => chrome.action.getBadgeText({}).then((x) => x === ''));
  assert.ok(await board.locator('#tabSearchCount').isHidden());

  // LinkedIn has a bad moment: its last results stay, the line says so
  linkedinDown = true;
  await board.click('#jsRefresh');
  await settled();
  assert.ok((await visible()).includes('Software Engineer (w/m/d)'), 'LinkedIn results are kept');
  // once per country, both searches failed
  assert.deepEqual(await board.$$eval('#jsSources .src.warn', (els) => els.map((e) => e.firstChild.textContent.trim())), ['LinkedIn DE', 'LinkedIn CH']);
  linkedinDown = false;

  // settings: without LinkedIn, the search runs again and the background refresh is scheduled
  await board.click('#jsSettings');
  await board.waitForSelector('#searchDialog[open]');
  assert.equal(await board.locator('#ssRegions .ss-row').count(), 2);
  assert.equal(await board.locator('#ssTerms .ss-row').count(), 5);
  assert.equal(await board.inputValue('#ssTerms .ss-row:first-child [data-f="queries"]'), 'Softwareentwickler, Software Engineer');
  // a German town as the place of the Swiss region is caught
  const swissPlace = '#ssRegions .ss-row[data-i="1"] [data-f="place"]';
  assert.equal(await board.inputValue(swissPlace), 'Kreuzlingen');
  await board.fill(swissPlace, 'Konstanz');
  await board.click('#ssSave');
  await board.waitForFunction(() => document.querySelector('#ssMsg').textContent.includes('Konstanz'));
  assert.ok((await board.textContent('#ssMsg')).includes(await msg('ssCountry_de')));
  assert.equal(await board.locator('#ssRegions .ss-row[data-i="1"] .ss-place.invalid').count(), 1);
  assert.equal(await board.locator('#searchDialog[open]').count(), 1);
  assert.equal(await board.evaluate(() => document.activeElement.dataset.f), 'place');
  await board.fill(swissPlace, 'Kreuzlingen');
  await board.uncheck('#searchForm [name="src_linkedin"]');
  await board.selectOption('#searchForm [name="intervalHours"]', '6');
  await board.click('#ssSave');
  await board.waitForSelector('#searchDialog', { state: 'hidden' });
  await settled();
  await board.waitForFunction(() => ![...document.querySelectorAll('#jsList .hit-title a')].some((a) => a.textContent === 'Software Engineer (w/m/d)'));
  assert.deepEqual(await hitRow('Frontend Developer').locator('.src-link').allTextContents(), ['Arbeitsagentur']);
  const config = (await storage(board))['search:config'];
  assert.equal(config.sources.linkedin, false);
  assert.equal(config.intervalHours, 6);
  await until(board, () => chrome.alarms.get('job-search').then((a) => Boolean(a && a.periodInMinutes === 360)));

  // quick links next to the search: empty until you add some; the site's icon is loaded
  const tiles = () => board.$$eval('#jsLinks .ql-tile .ql-name', (els) => els.map((e) => e.textContent.trim()));
  const storedLinks = async () => (await storage(board))['search:links'].items;
  assert.deepEqual(await tiles(), []);
  await board.click('#qlAdd');
  await board.waitForSelector('#linkDialog[open]');
  await board.fill('#linkForm [name="url"]', 'https://www.jobs.ch/de/stellenangebote/?term=Java&location=Kreuzlingen');
  assert.equal(await board.getAttribute('#linkForm [name="title"]', 'placeholder'), 'Jobs Kreuzlingen');
  await board.click('#linkForm [type="submit"]');
  await board.waitForSelector('#linkDialog', { state: 'hidden' });
  assert.deepEqual(await tiles(), ['Jobs Kreuzlingen']);
  assert.equal(await board.textContent('#jsLinks .ql-site'), 'jobs.ch');
  // jobs.ch names its icon in the page: kept as a small image
  await until(board, () => chrome.storage.local.get('search:links').then((d) => /^data:image\/png/.test(d['search:links'].items[0].image)));
  await board.waitForSelector('#jsLinks .ql-tile:nth-child(1) img.logo-img');
  // a click opens the search in a new tab
  const [site] = await Promise.all([context.waitForEvent('page'), board.click('#jsLinks .ql-tile:nth-child(1) .ql-link')]);
  await site.waitForLoadState('domcontentloaded');
  assert.match(site.url(), /^https:\/\/www\.jobs\.ch\/de\/stellenangebote\/\?term=Java/);
  await site.close();

  // your own: link, name and an image of your own; a wrong address is caught
  await board.click('#qlAdd');
  await board.waitForSelector('#linkDialog[open]');
  assert.equal(await board.evaluate(() => document.activeElement.name), 'url');
  await board.fill('#linkForm [name="url"]', 'javascript:alert(1)');
  await board.click('#linkForm [type="submit"]');
  assert.equal(await board.textContent('#qlMsg'), await msg('qlUrlInvalid'));
  assert.equal(await board.locator('#linkDialog[open]').count(), 1);
  await board.fill('#linkForm [name="url"]', 'www.stepstone.de/jobs/softwareentwickler/in-bremen');
  assert.equal(await board.getAttribute('#linkForm [name="title"]', 'placeholder'), 'StepStone');
  await board.fill('#linkForm [name="title"]', 'StepStone Bremen');
  await board.setInputFiles('#qlFile', path.join(FX, 'logo.png'));
  await board.waitForSelector('#qlPreview img.logo-img');
  await board.click('#linkForm [type="submit"]');
  await board.waitForSelector('#linkDialog', { state: 'hidden' });
  assert.equal((await tiles()).at(-1), 'StepStone Bremen');
  let links = await storedLinks();
  const own = links.at(-1);
  assert.equal(own.url, 'https://www.stepstone.de/jobs/softwareentwickler/in-bremen');
  assert.match(own.image, /^data:image\/png/);
  assert.equal(own.custom, true);
  // Alt + arrow key moves it, focus stays on it
  await board.focus(`#jsLinks [data-id="${own.id}"] .ql-link`);
  await board.keyboard.press('Alt+ArrowLeft');
  await until(board, (id) => chrome.storage.local.get('search:links').then((d) => d['search:links'].items.findIndex((l) => l.id === id) === 0), own.id);
  assert.equal((await tiles())[0], 'StepStone Bremen');
  assert.equal(await board.evaluate(() => document.activeElement.closest('.ql-tile')?.dataset.id), own.id);
  // dragging works too: drop the jobs.ch tile on the left half of the first one
  const other = links[0].id;
  await board.locator(`#jsLinks [data-id="${other}"]`).dragTo(board.locator(`#jsLinks [data-id="${own.id}"]`), { targetPosition: { x: 8, y: 40 } });
  await until(board, (id) => chrome.storage.local.get('search:links').then((d) => d['search:links'].items[0].id === id), other);
  await board.locator(`#jsLinks [data-id="${own.id}"]`).dragTo(board.locator(`#jsLinks [data-id="${other}"]`), { targetPosition: { x: 8, y: 40 } });
  await until(board, (id) => chrome.storage.local.get('search:links').then((d) => d['search:links'].items[0].id === id), own.id);
  assert.equal((await tiles())[0], 'StepStone Bremen');
  // the pencil: rename
  await board.click(`#jsLinks [data-id="${own.id}"] .ql-edit`);
  await board.waitForSelector('#linkDialog[open]');
  assert.equal(await board.inputValue('#linkForm [name="title"]'), 'StepStone Bremen');
  await board.fill('#linkForm [name="title"]', 'StepStone Nord');
  await board.click('#linkForm [type="submit"]');
  await board.waitForFunction(() => document.querySelector('#jsLinks .ql-tile:first-child .ql-name').textContent === 'StepStone Nord');
  // delete, then undo
  await board.click(`#jsLinks [data-id="${own.id}"] .ql-edit`);
  await board.waitForSelector('#linkDialog[open]');
  await board.click('#qlDelete');
  await board.waitForFunction(() => document.querySelectorAll('#jsLinks .ql-tile').length === 1);
  await board.click('#toastAction');
  await board.waitForFunction(() => document.querySelectorAll('#jsLinks .ql-tile').length === 2);
  links = await storedLinks();
  assert.equal(links[0].title, 'StepStone Nord');
  assert.match(links[0].image, /^data:image\/png/);

  assert.deepEqual(cspErrors, []);

  // back to the defaults for the tests after this one
  await board.evaluate(() => chrome.storage.local.remove(['search:config', 'search:links']));
  await board.click('#tabBoard');
});
