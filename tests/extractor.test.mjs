// Runs extension/lib/extractor.js inside real Chromium against saved portal pages.
// Each case serves its fixture under the real portal URL (so host detection works)
// and mocks the portal's own JSON endpoints.
//
//   npm test            all tests
//   node --test tests/extractor.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url);
const fx = (name) => readFile(new URL(`tests/fixtures/${name}`, ROOT), 'utf8');
const source = await readFile(new URL('extension/lib/extractor.js', ROOT), 'utf8');
const start = source.indexOf('export async function extractJobFromPage');
const end = source.indexOf('\nexport ', start + 10);
const fn = source.slice(start, end > 0 ? end : undefined).replace('export async function', 'async function');
// page.evaluate() needs a real function (a string would be evaluated as an expression)
// eslint-disable-next-line no-new-func
const extract = new Function(`return async (opts) => { ${fn}
; return await extractJobFromPage(opts); }`)();
const OPTS = { labels: { fullTime: 'Vollzeit', partTime: 'Teilzeit' } };

const TRUSTED_TYPES = {
  'content-security-policy': "require-trusted-types-for 'script'; trusted-types default",
};
const TT_POLICY = "<script>trustedTypes.createPolicy('default', { createHTML: () => '' });</script>";

const html = 'text/html; charset=utf-8';
const json = 'application/json';

const CASES = [
  // ---------- jobs.ch / jobup.ch ----------
  {
    name: 'jobs.ch search, second job selected: uses the portal JSON for that job',
    url: 'https://www.jobs.ch/de/stellenangebote/?location=Zurich&term=Software&jobid=22222222-aaaa-bbbb-cccc-000000000002',
    page: 'jobsch_search.html',
    routes: { '/api/v1/public/search/job/22222222-aaaa-bbbb-cccc-000000000002': [200, 'jobsch_api_2.json', json] },
    expect: {
      title: 'Informatiker/in (100%)', company: 'Medica Institut für Gesundheit AG', location: 'Zürich',
      workload: '80-100 %', contactName: 'Petra Beispiel', contactPhone: '0611234567', contactEmail: 'jobs@medica.example',
      url: 'https://www.jobs.ch/de/stellenangebote/detail/22222222-aaaa-bbbb-cccc-000000000002/',
      sourceKey: 'jobcloud:22222222-aaaa-bbbb-cccc-000000000002',
    },
    contains: ['• Betreuung der IT-Systeme', 'Wir sind ein Institut'],
    excludes: ['Sr. Software Engineer', 'long template'],
  },
  {
    name: 'jobs.ch search, JSON unavailable: reads the detail pane, not the first list item',
    url: 'https://www.jobs.ch/de/stellenangebote/?location=Zurich&term=Software&jobid=22222222-aaaa-bbbb-cccc-000000000002',
    page: 'jobsch_search.html',
    routes: { '/api/v1/public/search/job/': [500, 'error', 'text/plain'] },
    expect: {
      title: 'Informatiker/in (100%)', company: 'Medica Institut AG', location: 'Musterstrasse 1, 8001 Zürich', workload: '100 %',
      url: 'https://www.jobs.ch/de/stellenangebote/detail/22222222-aaaa-bbbb-cccc-000000000002/',
      sourceKey: 'jobcloud:22222222-aaaa-bbbb-cccc-000000000002',
    },
    contains: ['Du betreust unsere IT-Systeme', '• Support für alle Standorte'],
    excludes: ['Sr. Software Engineer', 'Du passt sehr gut', 'Match anzeigen', 'Über den Job'],
  },
  {
    name: 'jobs.ch search without a selected job: asks to pick one',
    url: 'https://www.jobs.ch/de/stellenangebote/?location=Zurich&term=Software',
    page: 'jobsch_search_nosel.html',
    expect: { title: '', company: '' },
    flags: { listPage: true, detected: false },
  },
  {
    name: 'jobup.ch detail page (French)',
    url: 'https://www.jobup.ch/fr/emplois/detail/33333333-aaaa-bbbb-cccc-000000000003/',
    page: 'jobup_detail.html',
    routes: { '/api/v1/public/search/job/33333333-aaaa-bbbb-cccc-000000000003': [200, 'jobup_api.json', json] },
    expect: {
      title: 'Ingénieur Développement IA', company: 'Exemple SA', location: 'Renens', workload: '100 %',
      contactName: 'Madame Claire Dupont', workModel: 'hybrid',
      url: 'https://www.jobup.ch/fr/emplois/detail/33333333-aaaa-bbbb-cccc-000000000003/',
    },
  },

  // ---------- LinkedIn ----------
  {
    name: 'LinkedIn logged in (2026 layout): job JSON + public view + pane',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4000000042&keywords=software%20engineer&location=Zurich',
    page: 'linkedin_2026.html',
    routes: {
      '/voyager/api/jobs/jobPostings/4000000042': [200, 'linkedin_voyager.json', json],
      '/jobs-guest/jobs/api/jobPosting/4000000042': [200, 'linkedin_guest_2026.html', html],
    },
    expect: {
      title: 'Senior Software Entwickler .NET 80-100% (m/w)', company: 'Alpenwerk Automobil AG',
      location: 'Schlieren, Zürich, Schweiz', workModel: 'onsite', workload: '80-100 %',
      url: 'https://www.linkedin.com/jobs/view/4000000042/', sourceKey: 'linkedin:4000000042',
    },
    flags: { via: 'api', detected: true },
    logo: 'https://media.licdn.com/dms/image/v2/D4E0BAQ/company-logo_200_200/alpenwerk-api.png',
    noLogo: ['bergmarkt'],
    contains: ['• Konzeption und Entwicklung mit .NET & C#', 'vollständige Bewerbung'],
    excludes: ['Mobile Developer Swift', 'Northpeak', 'Details zum Jobangebot', 'Mehr anzeigen'],
  },
  {
    name: 'LinkedIn logged in, page enforces Trusted Types (DOMParser blocked)',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4000000042&keywords=software%20engineer',
    page: 'linkedin_2026.html',
    pageHeaders: TRUSTED_TYPES,
    inject: TT_POLICY,
    routes: {
      '/voyager/api/jobs/jobPostings/4000000042': [403, 'nope', 'text/plain'],
      '/jobs-guest/jobs/api/jobPosting/4000000042': [200, 'linkedin_guest_2026.html', html],
    },
    expect: { title: 'Senior Software Entwickler .NET 80-100% (m/w)', company: 'Alpenwerk Automobil AG', location: 'Schlieren, Zürich, Schweiz' },
    flags: { via: 'guest' },
    contains: ['• Konzeption und Entwicklung mit .NET & C#', 'vollständige Bewerbung mit Foto'],
    excludes: ['Mehr anzeigen', '<p>', '&amp;'],
  },
  {
    name: 'LinkedIn logged in, both JSON sources blocked: detail pane only',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4000000042&keywords=software%20engineer',
    page: 'linkedin_2026.html',
    routes: { '/voyager/': [403, 'nope', 'text/plain'], '/jobs-guest/': [429, 'Too many requests', 'text/plain'] },
    expect: {
      title: 'Senior Software Entwickler .NET 80-100% (m/w)', company: 'Alpenwerk Automobil AG',
      location: 'Schlieren, Zürich, Schweiz', workModel: 'onsite', workload: '80-100 %',
    },
    flags: { via: 'dom' },
    logo: 'https://media.licdn.com/dms/image/v2/D4E0BAQ/company-logo_100_100/alpenwerk-dom.png',
    noLogo: ['bergmarkt'],
    contains: ['Gestalten Sie mit uns die Mobilität', '• Konzeption und Entwicklung mit .NET / C#', 'Bewerbung mit Foto'],
    excludes: ['Details zum Jobangebot', 'Mehr anzeigen', 'Mobile Developer Swift', 'Northpeak'],
  },
  {
    name: 'LinkedIn job page still loading: description from the job JSON',
    url: 'https://www.linkedin.com/jobs/view/4000000042/',
    html: '<!doctype html><html lang="de"><head><title>LinkedIn</title><script>document.cookie=\'JSESSIONID="ajax:1"; path=/\'</script></head><body><main><div class="job-view-layout"></div></main></body></html>',
    routes: {
      '/voyager/api/jobs/jobPostings/4000000042': [200, 'linkedin_voyager.json', json],
      '/jobs-guest/': [429, 'Too many requests', 'text/plain'],
    },
    expect: { title: 'Senior Software Entwickler .NET 80-100% (m/w)', company: 'Alpenwerk Automobil AG', location: 'Schlieren, Zürich, Schweiz', workModel: 'onsite' },
    contains: ['Ihre Aufgaben\n• Konzeption und Entwicklung mit .NET / C#\n• Analyse von fachlichen Anforderungen'],
  },
  {
    name: 'LinkedIn older logged-in layout + public view',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=frontend',
    page: 'linkedin_loggedin.html',
    routes: { '/jobs-guest/jobs/api/jobPosting/4012345678': [200, 'linkedin_guest.html', html] },
    expect: {
      title: 'Frontend Engineer', company: 'Lindenhof', location: 'Zürich, Zürich, Schweiz', workModel: 'hybrid', workload: 'Vollzeit',
      url: 'https://www.linkedin.com/jobs/view/4012345678/', sourceKey: 'linkedin:4012345678',
      contactName: 'Herr Marco Rossi', contactEmail: 'marco.rossi@lindenhof.example',
    },
    contains: ['Das ist der Teil nach weiterlesen', '• React Native'],
    excludes: ['Mobile Developer Swift', 'Northpeak', 'Mehr anzeigen'],
  },
  {
    name: 'LinkedIn public job page (logged out)',
    url: 'https://ch.linkedin.com/jobs/view/software-engineer-at-helix-labs-3912345678?trk=public_jobs',
    page: 'linkedin_public.html',
    routes: { '/jobs-guest/': [404, 'nope', 'text/plain'] },
    expect: { title: 'Software Engineer', company: 'Helix Labs', location: 'Zürich, Zürich, Switzerland', sourceKey: 'linkedin:3912345678' },
    contains: ['• TypeScript'],
  },

  // ---------- Indeed ----------
  {
    name: 'Indeed search with a job open in the right pane',
    url: 'https://ch.indeed.com/jobs?q=software&l=Zurich&vjk=85d061f0554359f2',
    page: 'indeed_new.html',
    expect: {
      title: 'Senior Game Developer', company: 'Pixelfabrik AG', location: 'Zürich', workload: '80-100 %', workModel: 'hybrid',
      url: 'https://ch.indeed.com/viewjob?jk=85d061f0554359f2', sourceKey: 'indeed:85d061f0554359f2',
    },
    contains: ['We build games', '• Unity'],
    excludes: ['react-native-html-content', 'margin:0', 'Kantwerk'],
  },
  {
    name: 'Indeed older job page layout',
    url: 'https://ch.indeed.com/viewjob?jk=abc123def&from=serp',
    page: 'indeed_view.html',
    expect: {
      title: 'Junior Web Developer', company: 'Muster Digital AG', location: 'Zürich', workModel: 'hybrid', workload: '80 %',
      contactName: 'Frau Lea Beispiel', contactPhone: '+41 44 555 12 34',
    },
  },

  // ---------- applicant tracking systems ----------
  {
    name: 'StepStone job ad',
    url: 'https://www.stepstone.de/stellenangebote--Softwareentwickler-m-w-d-Muenchen-Hamburg-Ulm-Kleinwerk-GmbH--14603639-inline.html',
    page: 'stepstone.html',
    expect: {
      title: 'Softwareentwickler (m/w/d)', company: 'Kleinwerk GmbH', location: 'München, Hamburg, Ulm', workModel: 'hybrid',
      workload: 'Vollzeit', sourceKey: 'stepstone:14603639',
    },
    contains: ['Wir bauen Software für die Logistik', '• Backend mit Java', 'Ihr Profil'],
    excludes: ['Jetzt bewerben', 'Gehaltsschätzung'],
  },
  {
    name: 'Greenhouse job board',
    url: 'https://job-boards.greenhouse.io/fernwood/jobs/8883003002',
    page: 'greenhouse.html',
    expect: { title: 'Director, Analytics Engineering', company: 'Fernwood', location: 'Remote, United States', workModel: 'remote', sourceKey: 'greenhouse:8883003002' },
    logo: 'https://s2-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/fernwood.png',
    contains: ['Fernwood is an open-core software company', '• Lead the analytics engineering team'],
    excludes: ['Submit application', 'First Name'],
  },
  {
    name: 'Lever job page',
    url: 'https://jobs.lever.co/brightline/ac978161-6f46-4f6b-ad9e-a258e642751c',
    page: 'lever.html',
    expect: {
      title: 'Administrative Business Partner', company: 'Brightline Systems', location: 'London, United Kingdom',
      workModel: 'hybrid', workload: 'Vollzeit', sourceKey: 'lever:ac978161-6f46-4f6b-ad9e-a258e642751c',
    },
    contains: ['Brightline builds tools that help', '• Travel coordination'],
    excludes: ['Apply for this job'],
  },
  {
    name: 'Workday job board with a job open',
    url: 'https://helix.wd3.myworkdayjobs.com/en-US/Careers/details/Software-Engineer_REQ-10089538',
    page: 'workday.html',
    expect: { title: 'Software Engineer', company: 'Helix', location: 'Zürich', workModel: 'hybrid', workload: 'Vollzeit', sourceKey: 'workday:helix:req-10089538' },
    contains: ['• Build internal tools'],
    excludes: ['Data Analyst'],
  },

  // ---------- any other site ----------
  {
    name: 'career page listing many jobs: no false match',
    url: 'https://karriere.muster.example/jobs',
    page: 'generic_list.html',
    expect: { company: 'Muster Gruppe' },
    flags: { listPage: true, detected: false },
    notEqual: { title: 'Erste Stelle' },
  },
  {
    name: 'career page with one schema.org JobPosting',
    url: 'https://karriere.beispiel.de/jobs/123',
    page: 'generic_jsonld.html',
    expect: { title: 'Data Engineer', company: 'Beispiel GmbH', location: 'Hamburg', workModel: 'remote', workload: 'Teilzeit' },
    logo: 'https://karriere.beispiel.de/apple-touch-icon.png',
  },
  {
    name: 'single page career site with a stale JobPosting: ignores it',
    url: 'https://karriere.beispiel.ch/jobs/frontend',
    page: 'generic_stale_jsonld.html',
    expect: { title: 'Frontend Developer (80-100%)', company: 'Beispiel AG', location: 'Zürich', workload: '80-100 %' },
    contains: ['TypeScript und React', '• Tests schreiben'],
    excludes: ['Old job'],
  },
  {
    name: 'career page without structure: main content heuristic',
    url: 'https://beispiel.example/jobs/software-engineer',
    page: 'generic_article.html',
    expect: { title: 'Software Engineer (80-100%)', company: 'Beispiel AG Karriere', workload: '80-100 %', workModel: 'hybrid' },
    logo: 'https://beispiel.example/img/logo.svg',
    contains: ['Wir entwickeln Software für Spitäler', '• Entwicklung neuer Funktionen'],
    excludes: ['Projektleiter Bau', 'Copyright', 'Über uns'],
  },
  {
    name: 'unknown job board: its own logo is not the employer\'s',
    url: 'https://www.jobboerse-xyz.example/job/1',
    html: '<!doctype html><html><head><title>Data Analyst - Kestrel Software</title></head><body><header><img class="logo" src="/board-logo.png" alt="Jobbörse XYZ" width="40" height="40"></header><main><h1>Data Analyst</h1><p>Wir suchen eine Person für Datenanalysen mit Python und SQL in unserem Team in Zürich, ab sofort.</p><p>Deine Aufgaben sind Berichte, Modelle und die Zusammenarbeit mit vielen Fachbereichen im ganzen Unternehmen.</p></main></body></html>',
    expect: { title: 'Data Analyst', company: 'Kestrel Software' },
    logo: '',
  },
  {
    name: 'plain company page',
    url: 'https://muster-ag.example/stelle?utm_source=x',
    page: 'generic_plain.html',
    expect: {
      title: 'Projektleiter IT (100%)', company: 'Muster AG', location: 'Hamburg', workload: '100 %', workModel: 'hybrid',
      contactName: 'Herr Jonas Keller', url: 'https://muster-ag.example/stelle',
    },
  },
];

let browser;
let context;

before(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ locale: 'de-DE' });
});

after(async () => {
  await browser?.close();
});

async function body(spec) {
  if (spec.endsWith('.html') || spec.endsWith('.json')) return fx(spec);
  return spec;
}

for (const c of CASES) {
  test(c.name, async () => {
    const page = await context.newPage();
    let doc = c.html ?? await fx(c.page);
    if (c.inject) doc = doc.replace('<head>', `<head>${c.inject}`);
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      for (const [pattern, [status, content, type]] of Object.entries(c.routes || {})) {
        if (url.includes(pattern)) return route.fulfill({ status, body: await body(content), contentType: type });
      }
      if (route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, body: doc, contentType: html, headers: c.pageHeaders || {} });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(c.url);
    const res = await page.evaluate(extract, OPTS);
    await page.close();

    const { job } = res;
    for (const [key, want] of Object.entries(c.expect || {})) assert.equal(job[key], want, `${key}`);
    for (const [key, want] of Object.entries(c.flags || {})) assert.equal(res[key], want, `flag ${key}`);
    if (c.logo !== undefined) assert.equal(job.logoCandidates[0] || '', c.logo, `logo ${JSON.stringify(job.logoCandidates)}`);
    for (const s of c.noLogo || []) assert.ok(!job.logoCandidates.some((u) => u.includes(s)), `logo must not be ${s}`);
    for (const [key, not] of Object.entries(c.notEqual || {})) assert.notEqual(job[key], not, `${key}`);
    for (const s of c.contains || []) assert.ok(job.description.includes(s), `description should contain ${JSON.stringify(s)}\n---\n${job.description}`);
    for (const s of c.excludes || []) assert.ok(!job.description.toLowerCase().includes(s.toLowerCase()), `description should not contain ${JSON.stringify(s)}\n---\n${job.description}`);
  });
}
