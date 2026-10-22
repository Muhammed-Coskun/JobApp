// The job search without a browser: parsing what the portals return, matching
// titles, merging the same job from two portals, countries, distances and filters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.chrome = { i18n: { getMessage: (key) => key, getUILanguage: () => 'de' } };
const S = await import('../extension/lib/search.js');

const FX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const today = new Date();
const day = (offset) => {
  const d = new Date(today);
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fx = async (name) => (await readFile(path.join(FX, name), 'utf8')).replace(/\{\{D(\d+)\}\}/g, (_, n) => day(Number(n)));
// a region on each side of the Swiss-German border, where the country rules matter
const BORDER = [
  { id: 'de-konstanz', name: 'Konstanz', country: 'de', place: 'Konstanz', lat: 47.6603, lon: 9.1758, radiusKm: 60, enabled: true, linkedinGeoId: '100000002', linkedinGeoName: 'Konstanz, Baden-Württemberg, Deutschland' },
  { id: 'ch-kreuzlingen', name: 'Kreuzlingen', country: 'ch', place: 'Kreuzlingen', lat: 47.6505, lon: 9.1750, radiusKm: 60, enabled: true, linkedinGeoId: '100000001', linkedinGeoName: 'Kreuzlingen, Thurgau, Schweiz' },
];
// search terms as someone would set them up
const TERMS = [
  { id: 'dev', name: 'Software', queries: ['Softwareentwickler', 'Software Engineer'] },
  { id: 'ml', name: 'Machine Learning', queries: ['Machine Learning Engineer', 'KI Engineer'] },
  { id: 'backend', name: 'Backend', queries: ['Backend', 'Fullstack', 'Java'] },
  { id: 'web', name: 'Web', queries: ['Frontend', 'React'] },
  { id: 'apps', name: 'Apps', queries: ['iOS', 'Flutter'] },
];
const config = { ...S.defaultSearchConfig(), regions: BORDER, terms: TERMS, exclude: 'Werkstudent, Working Student' };
const kreuzlingen = config.regions.find((r) => r.id === 'ch-kreuzlingen');
const konstanz = config.regions.find((r) => r.id === 'de-konstanz');

test('titles match search terms as words, long terms also inside compounds', () => {
  assert.ok(S.matchesQuery('Software-Entwickler/in Java (m/w/d)', 'Softwareentwickler'));
  assert.ok(S.matchesQuery('Senior Softwareentwicklerin', 'Softwareentwickler'));
  assert.ok(S.matchesQuery('Full-Stack Developer', 'Full Stack'));
  assert.ok(S.matchesQuery('iOS-Entwickler', 'iOS'));
  assert.ok(!S.matchesQuery('Biosphere Analyst', 'iOS'));
  assert.ok(!S.matchesQuery('JavaScript Developer', 'Java'));
  assert.ok(!S.matchesQuery('Lagerist', 'Lager'));
  assert.deepEqual(S.termsFor('Machine Learning Engineer (KI)', config.terms), ['ml']);
  assert.deepEqual(S.termsFor('Fullstack Entwickler React', config.terms), ['backend', 'web']);
  assert.ok(S.matchesExclude('Managerin Vertrieb', 'Manager'));
  assert.ok(S.matchesExclude('Working Student in Building Energy', 'Working Student'));
  assert.ok(!S.matchesExclude('Wholesales Analyst', 'Sales'));
  assert.ok(!S.matchesExclude('Internal Audit', 'Lager'));
  assert.ok(S.isSenior('Sr. Software Engineer Java'));
  assert.ok(S.isSenior('(Senior) Computer Vision Engineer'));
  assert.ok(!S.isSenior('Software Engineer'));
});

test('the same job on two portals gets the same key, two offices do not', () => {
  assert.equal(S.hitKey('Helix Labs AG', 'Software Engineer (m/w/d) 80-100%', 'Kreuzlingen'), S.hitKey('Helix Labs', 'Software Engineer', 'Kreuzlingen, Thurgau, Schweiz'));
  assert.equal(S.hitKey('Pixelhafen Web GmbH', 'Frontend Developer (m/w/d)', 'Singen'), S.hitKey('Pixelhafen Web', 'Frontend Developer', 'Singen'));
  assert.equal(S.hitKey('Lumen Health', 'Praktikum IT', 'Kreuzlingen-City'), S.hitKey('Lumen Health', 'Praktikum IT', '8280 Kreuzlingen'));
  assert.notEqual(S.hitKey('Helix Labs', 'Software Engineer', 'Kreuzlingen'), S.hitKey('Northpeak', 'Software Engineer', 'Kreuzlingen'));
  // a staffing agency with the same title in Kreuzlingen and in Ravensburg: two jobs
  assert.notEqual(S.hitKey('Staffwerk', 'Software Engineer', 'Kreuzlingen, Thurgau'), S.hitKey('Staffwerk', 'Software Engineer', 'Ravensburg'));
});

test('country of a place, as the portals write it', () => {
  const c = (s) => S.countryOfPlace(s);
  assert.deepEqual(c('Kreuzlingen, Thurgau, Schweiz'), { country: 'ch', explicit: true });
  assert.deepEqual(c('Frauenfeld (TG), Thurgau, Schweiz'), { country: 'ch', explicit: true });
  assert.deepEqual(c('Baden, Aargau'), { country: 'ch', explicit: true });
  assert.deepEqual(c('Allensbach, Baden-Württemberg, Deutschland'), { country: 'de', explicit: true });
  assert.deepEqual(c('Lyon, Auvergne-Rhône-Alpes, Frankreich'), { country: 'fr', explicit: true });
  assert.deepEqual(c('Ravensburg'), { country: 'de', explicit: false });
  assert.deepEqual(c('Radolfzell (Bodensee)'), { country: 'de', explicit: false });
  assert.deepEqual(c('Meersburg'), { country: 'de', explicit: false });
  assert.deepEqual(c('Kleinkleckersdorf'), { country: '', explicit: false });
});

test('jobs.ch: regions around Kreuzlingen, distance from the coordinates, job types', async () => {
  assert.deepEqual(S.jobcloudRegionIds(kreuzlingen), ['7', '17', '18', '19', '20', '21', '22', '25']);
  const docs = JSON.parse(await fx('search_jobsch.json')).documents;
  const hit = S.parseJobcloud(docs[0], kreuzlingen);
  assert.equal(hit.title, 'Softwareentwickler:in Java (80-100%)');
  assert.equal(hit.company, 'Voltwerk Energie AG');
  assert.equal(hit.country, 'ch');
  assert.equal(hit.postedAt, day(0));
  assert.equal(hit.distanceKm, 1);
  assert.equal(hit.workload, '80-100 %');
  assert.equal(hit.sourceKey, 'jobcloud:33333333-aaaa-bbbb-cccc-000000000001');
  assert.match(hit.logoUrl, /^https:\/\/media\.jobs\.ch\//);
  assert.ok(S.parseJobcloud(docs[4], kreuzlingen).distanceKm > 60, 'Zug is outside 60 km');
  const job = new URL(S.jobcloudUrl({ query: 'Java', region: kreuzlingen, page: 2 }));
  assert.deepEqual(job.searchParams.getAll('employment-type-ids[]'), ['5', '1', '2']);
  assert.deepEqual(job.searchParams.getAll('region-ids[]'), ['7', '17', '18', '19', '20', '21', '22', '25']);
  assert.equal(job.searchParams.get('query'), 'Java');
  assert.equal(job.searchParams.get('page'), '2');
});

test('Arbeitsagentur: the place is not repeated in the title', async () => {
  const list = JSON.parse(await fx('search_ba.json')).ergebnisliste.map(S.parseArbeitsagentur);
  assert.equal(list[0].title, 'Softwareentwickler (m/w/d)');
  assert.equal(list[0].location, 'Allensbach');
  assert.equal(list[0].country, 'de');
  assert.equal(list[0].distanceKm, 4);
  assert.equal(list[0].sourceKey, 'ba:10000-1000000001-S');
  assert.equal(list[0].url, 'https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1000000001-S');
  assert.equal(list[1].title, 'KI Engineer (m/w/d)');
  assert.equal(S.parseArbeitsagentur({ referenznummer: 'x', stellenangebotsTitel: 'Informatiker', stellenlokationen: [{ adresse: { ort: 'Kreuzlingen', land: 'SCHWEIZ' } }] }).country, 'ch');
  const job = new URL(S.baUrl({ query: 'Java', region: konstanz, days: 7, page: 1 }));
  assert.equal(job.searchParams.get('angebotsart'), '1');
  assert.equal(job.searchParams.get('was'), 'Java');
  assert.equal(job.searchParams.get('veroeffentlichtseit'), '7');
  assert.equal(job.searchParams.get('umkreis'), '60');
});

test('LinkedIn: cards from the public search, entities decoded, country kept as a field', async () => {
  const cards = S.parseLinkedinCards(await fx('search_linkedin_ch.html'));
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map((c) => c.id), ['4455570001', '4455570003', '4455570005', '4455570006', '4455570007']);
  // a German place in the Kreuzlingen search: LinkedIn names no country, the town list knows it
  assert.deepEqual([cards[4].location, cards[4].country, cards[4].countryExplicit], ['Allensbach', 'de', false]);
  assert.equal(cards[0].title, 'Software Engineer (w/m/d)');
  assert.equal(cards[0].company, 'Alpenwerk Automobil AG');
  assert.equal(cards[0].location, 'Kreuzlingen, Thurgau');
  assert.equal(cards[0].country, 'ch');
  assert.equal(cards[0].countryExplicit, true);
  assert.equal(cards[0].postedAt, day(0));
  assert.match(cards[0].logoUrl, /^https:\/\/media\.licdn\.com\/.*company-logo.*&v=beta/);
  assert.equal(cards[3].title, 'Mobile Developer & Flutter');
  assert.equal(S.parseLinkedinCards('<ul></ul>').length, 0);
  const keywords = S.linkedinKeywords(config.terms);
  assert.match(keywords, /^Softwareentwickler OR "Software Engineer" OR /);
  assert.ok(!/OR OR|OR $/.test(keywords));
});

test('each hit stays in the regions of its own country, far ones go', () => {
  const regions = config.regions;
  const bySource = {
    jobcloud: { items: [{ region: 'ch-kreuzlingen', location: 'Amriswil', country: 'ch', lat: 47.5208, lon: 7.6936, distanceKm: 8 }] },
    arbeitsagentur: { items: [{ region: 'de-konstanz', location: 'Kreuzlingen', country: 'ch', distanceKm: 3 }, { region: 'de-konstanz', location: 'Allensbach', country: 'de', distanceKm: 4 }] },
    linkedin: {
      items: [
        // the Kreuzlingen search: Swiss places name their country, so a place without one is not Swiss
        { region: 'ch-kreuzlingen', location: 'Amriswil, Thurgau', country: 'ch', countryExplicit: true, distanceKm: null },
        { region: 'ch-kreuzlingen', location: 'Bern, Bern', country: 'ch', countryExplicit: true, distanceKm: null },
        { region: 'ch-kreuzlingen', location: 'Ravensburg', country: 'de', countryExplicit: false, distanceKm: null },
        { region: 'ch-kreuzlingen', location: 'Kleinkleckersdorf', country: '', countryExplicit: false, distanceKm: null },
        // the Konstanz search: German places come without a country
        { region: 'de-konstanz', location: 'Ravensburg', country: 'de', countryExplicit: false, distanceKm: null },
        { region: 'de-konstanz', location: 'Kleinkleckersdorf', country: '', countryExplicit: false, distanceKm: null },
        { region: 'de-konstanz', location: 'Kreuzlingen, Thurgau', country: 'ch', countryExplicit: true, distanceKm: null },
      ],
    },
  };
  S.placeHits(bySource, regions);
  assert.deepEqual(bySource.arbeitsagentur.items.map((x) => x.location), ['Allensbach']);
  assert.deepEqual(bySource.linkedin.items.map((x) => [x.region, x.location, x.distanceKm]), [
    ['ch-kreuzlingen', 'Amriswil, Thurgau', 15],
    ['de-konstanz', 'Ravensburg', 35],
    ['de-konstanz', 'Kleinkleckersdorf', null],
  ]);
  // the numbers behind "Details" under the list
  assert.equal(bySource.linkedin.stats.country, 3);
  assert.equal(bySource.linkedin.stats.far, 1);
  assert.equal(bySource.linkedin.stats.kept, 3);
  assert.deepEqual(bySource.linkedin.stats.byRegion, { 'ch-kreuzlingen': 1, 'de-konstanz': 2 });
  assert.equal(bySource.arbeitsagentur.stats.country, 1);
});

test('regions: numbers stay numbers, known towns get their coordinates, a place in the other country is caught', () => {
  const saved = [
    { id: 'de-konstanz', name: 'Konstanz', country: 'de', place: 'Konstanz', lat: 47.6603, lon: 9.1758, radiusKm: 50, enabled: true },
    { id: 'ch-kreuzlingen', name: 'Kreuzlingen', country: 'ch', place: 'Kreuzlingen', lat: null, lon: null, radiusKm: '50', enabled: true },
    { id: 'own', name: 'Unbekanntdorf', country: 'de', place: 'Unbekanntdorf', lat: '', lon: '', radiusKm: 'x', enabled: true },
  ];
  const fixed = S.repairRegions(saved);
  assert.deepEqual(fixed[0], saved[0]);
  assert.equal(fixed[1].radiusKm, 50);
  assert.ok(Math.abs(fixed[1].lat - 47.65) < 0.05, 'coordinates of a known place are filled in');
  assert.deepEqual([fixed[2].lat, fixed[2].lon, fixed[2].radiusKm], [null, null, 30]);
  assert.equal(S.wrongCountry('Konstanz', 'ch'), 'de');
  assert.equal(S.wrongCountry('Kreuzlingen', 'ch'), '');
  assert.equal(S.wrongCountry('Irgendwo', 'ch'), '');
});

test('LinkedIn searches a place by its id, so Kreuzlingen stays in Switzerland', () => {
  const url = new URL(S.linkedinUrl({ keywords: 'Software', region: kreuzlingen, days: 3, start: 25 }));
  assert.equal(url.searchParams.get('geoId'), '100000001');
  assert.equal(url.searchParams.get('location'), 'Kreuzlingen, Thurgau, Schweiz');
  assert.equal(url.searchParams.get('f_TPR'), 'r259200');
  assert.equal(url.searchParams.get('start'), '25');
  const own = new URL(S.linkedinUrl({ keywords: 'x', region: { place: 'Zürich', country: 'ch', radiusKm: 30 }, days: 1, start: 0 }));
  assert.equal(own.searchParams.get('geoId'), null);
  assert.equal(own.searchParams.get('location'), 'Zürich, Schweiz');
  const resolved = new URL(S.linkedinUrl({ keywords: 'x', region: { place: 'Zürich', country: 'ch', radiusKm: 30, linkedinGeoId: '100000003', linkedinGeoName: 'Zürich, Zürich, Schweiz' }, days: 1, start: 0 }));
  assert.equal(resolved.searchParams.get('geoId'), '100000003');
  assert.equal(S.linkedinUrl({ keywords: 'x', region: konstanz, days: 1, start: 0 }).includes('geoId=100000002'), true);
});

test('merging and filtering: one row per job, reasons for hidden ones', async () => {
  const items = (list, source, region) => list.map((h) => ({ ...h, source, region: region.id }));
  const ba = JSON.parse(await fx('search_ba.json')).ergebnisliste.map(S.parseArbeitsagentur);
  const li = S.parseLinkedinCards(await fx('search_linkedin_de.html')).filter((c) => c.country !== 'ch');
  const results = { bySource: { arbeitsagentur: { items: items(ba, 'arbeitsagentur', konstanz) }, linkedin: { items: items(li, 'linkedin', konstanz) } } };
  const hits = S.mergeHits(results, config);
  const frontend = hits.find((h) => /Frontend Developer/.test(h.title));
  assert.equal(frontend.title, 'Frontend Developer (m/w/d)');
  assert.deepEqual(frontend.sources.map((s) => s.source), ['arbeitsagentur', 'linkedin']);
  assert.equal(hits.length, 5);

  const state = { seen: {}, dismissed: {}, lastVisit: 0 };
  const boardKeys = S.boardKeysOf([{ id: 'j1', company: 'Brückenwerk Software GmbH', title: 'Softwareentwickler (m/w/d)', location: 'Allensbach', url: '', sourceKey: '' }]);
  const reason = (title, cfg = config, st = state) => S.hiddenReason(hits.find((h) => h.title === title), { config: cfg, state: st, boardKeys });
  assert.equal(reason('Softwareentwickler (m/w/d)'), 'board');
  assert.equal(reason('Lagerist (m/w/d)'), 'nomatch');
  assert.equal(reason('KI Engineer (m/w/d)'), '');
  const ki = hits.find((h) => h.title === 'KI Engineer (m/w/d)');
  assert.equal(reason('KI Engineer (m/w/d)', config, { ...state, dismissed: { [ki.key]: 1 } }), 'dismissed');
  assert.equal(reason('iOS Developer', { ...config, exclude: 'iOS' }), 'excluded');
  assert.equal(reason('Lagerist (m/w/d)', { ...config, onlyMatching: false }), '');

  // a hit without a country: the place decides, a German town never shows under Kreuzlingen
  const noCountry = { bySource: { linkedin: { items: [{ ...li[0], country: undefined, region: 'ch-kreuzlingen' }] } } };
  assert.equal(S.mergeHits(noCountry, config).length, 0);
});

test('what is asked: every term at jobs.ch and the Arbeitsagentur, all terms in one LinkedIn search', () => {
  const tasks = S.planSearch(config);
  const terms = new Set(config.terms.flatMap((g) => g.queries)).size;
  assert.equal(tasks.filter((x) => x.source === 'jobcloud').length, terms);
  assert.equal(tasks.filter((x) => x.source === 'arbeitsagentur').length, terms);
  assert.deepEqual(tasks.filter((x) => x.source === 'linkedin').map((x) => x.region.id), ['de-konstanz', 'ch-kreuzlingen']);
  assert.ok(tasks.every((x) => x.args.days === 7));
  assert.match(tasks.find((x) => x.source === 'linkedin').args.keywords, /^Softwareentwickler OR "Software Engineer" OR /);
  assert.deepEqual(S.planSearch({ ...config, terms: [] }), [], 'no terms, nothing to ask');
});

test('out of the box: nothing preset', () => {
  const fresh = S.defaultSearchConfig();
  assert.deepEqual(fresh.regions, []);
  assert.deepEqual(fresh.terms, []);
  assert.equal(fresh.exclude, '');
  assert.deepEqual(S.repairRegions(BORDER), BORDER);
});

test('details: text from portal HTML', () => {
  assert.equal(S.htmlToText('<p>Hallo &amp; willkommen</p><ul><li>Eins</li><li>Zwei</li></ul>'), 'Hallo & willkommen\n• Eins\n• Zwei');
  assert.equal(S.htmlToText('Zeile 1\nZeile 2'), 'Zeile 1\nZeile 2');
});
