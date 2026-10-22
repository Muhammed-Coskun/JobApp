// Reads the job that is currently shown on the page.
//
// IMPORTANT: this function is injected into the job page with
// chrome.scripting.executeScript({ func }). It must be fully self-contained:
// no imports, no references to anything outside its own body.
//
// Strategy per site, most reliable source first. Every source was checked
// against the live sites (October 2026):
//   jobs.ch / jobup.ch  the portal's own JSON for the selected job (?jobid= or /detail/<id>)
//   LinkedIn            the JSON LinkedIn's own job page loads (when logged in), then the
//                       public job view, then the detail pane on screen
//   Indeed              detail pane of the selected job (vjk / jk)
//   StepStone, Workday, Greenhouse, Lever   their stable data attributes
//   any other site      schema.org JobPosting (only if the page has exactly one and it
//                       matches what is on screen), otherwise a readability-style
//                       "main content" heuristic
//
// Returns { ok, site, host, detected, listPage, job, selection }.
// job.logoCandidates lists image URLs of the company logo (best first) and
// job.logoRect where it is on screen; the side panel turns one of them into a
// small stored image afterwards (see logoInPage below), so reading stays fast.

export async function extractJobFromPage(options = {}) {
  const labels = { fullTime: 'Full-time', partTime: 'Part-time', ...(options.labels || {}) };

  // ---------- text helpers ----------
  const clean = (s) => String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const line = (s) => clean(s).replace(/\s*\n\s*/g, ' ').trim();
  const textOf = (el) => {
    if (!el) return '';
    const raw = typeof el.innerText === 'string' && el.innerText.trim() ? el.innerText : el.textContent;
    return clean(raw);
  };
  const first = (selectors, root = document) => {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector */ }
    }
    return null;
  };
  const pick = (selectors, root = document) => {
    for (const sel of selectors) {
      let els = [];
      try { els = root.querySelectorAll(sel); } catch { continue; }
      for (const el of els) if (textOf(el)) return el;
    }
    return null;
  };
  const pickText = (selectors, root) => line(textOf(pick(selectors, root)));
  const metaContent = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const v = el && el.getAttribute('content');
      if (v && v.trim()) return clean(v);
    }
    return '';
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'SECTION', 'ARTICLE', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'HEADER', 'FOOTER']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SVG', 'svg',
    'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA', 'NAV', 'FORM']);

  // Like innerText, but keeps list bullets and paragraph breaks.
  const richText = (root, skip) => {
    if (!root) return '';
    const out = [];
    let bullet = false;
    const walk = (node, pre, inLi) => {
      if (node.nodeType === 3) {
        let s = node.nodeValue || '';
        if (!pre) s = s.replace(/\s+/g, ' ');
        if (bullet && s.trim()) { out.push('• '); bullet = false; }
        out.push(s);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag) || (skip && skip(node))) return;
      if (node.getAttribute('aria-hidden') === 'true' && !node.textContent.trim().length) return;
      if (tag === 'BR') { out.push('\n'); return; }
      let display = '';
      let ws = '';
      try {
        const cs = getComputedStyle(node);
        display = cs.display;
        ws = cs.whiteSpace;
      } catch { /* detached */ }
      if (display === 'none') return;
      const block = display ? !display.startsWith('inline') && display !== 'contents' : BLOCK_TAGS.has(tag);
      if (block) out.push('\n');
      if (tag === 'LI') bullet = true;
      const childPre = pre || /^pre/.test(ws || '') || tag === 'PRE';
      for (const c of node.childNodes) walk(c, childPre, inLi || tag === 'LI');
      if (block) out.push('\n');
      if (!inLi && (tag === 'P' || /^H[1-6]$/.test(tag))) out.push('\n');
    };
    walk(root, false, false);
    return clean(out.join('')).replace(/\n{2,}(?=• )/g, '\n');
  };

  // Text of every leaf element on its own line (keeps adjacent labels apart).
  const leafText = (root) => {
    const parts = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount || SKIP_TAGS.has(el.tagName) && el.tagName !== 'BUTTON') continue;
      const s = line(el.textContent);
      if (s) parts.push(s);
      if (parts.length > 400) break;
    }
    return parts.join('\n');
  };

  // Some sites (LinkedIn) enforce Trusted Types: DOMParser then returns an empty
  // document instead of the markup. Detect that and fall back to plain string work.
  const parseHtml = (html) => {
    const src = String(html);
    try {
      const doc = new DOMParser().parseFromString(src, 'text/html');
      // markup in, but no elements out: the page's policy stripped it
      if (doc && doc.body && (doc.body.childElementCount || !/<[a-z][^>]*>/i.test(src))) return doc;
    } catch { /* blocked */ }
    return null;
  };
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const decodeEntities = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  const stripTags = (html) => line(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')));
  const htmlToTextPlain = (html) => clean(decodeEntities(String(html)
    .replace(/<(script|style|noscript|head|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|h[1-6])>/gi, '\n\n')
    .replace(/<\/?(div|ul|ol|li|tr|section|table|p|h[1-6]|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))).replace(/\n{2,}(?=• )/g, '\n');

  // HTML string -> readable text (used for API / JSON-LD descriptions).
  const htmlToText = (html) => {
    if (!html) return '';
    let src = String(html);
    if (/&lt;\/?[a-z]/i.test(src)) src = decodeEntities(src);
    if (!/<[a-z][\s\S]*>/i.test(src)) return clean(decodeEntities(src));
    const doc = parseHtml(src);
    if (!doc) return htmlToTextPlain(src);
    doc.querySelectorAll('script, style, noscript, head, title').forEach((n) => n.remove());
    // whitespace in the HTML source is not a line break
    const walker = doc.createTreeWalker(doc.body, 4);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach((n) => { n.nodeValue = n.nodeValue.replace(/\s+/g, ' '); });
    doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    doc.querySelectorAll('li').forEach((n) => n.prepend('• '));
    doc.querySelectorAll('li').forEach((n) => n.append('\n'));
    doc.querySelectorAll('p, div, ul, ol, h1, h2, h3, h4, h5, h6, tr, section, table').forEach((n) => {
      n.prepend('\n');
      n.append('\n');
    });
    doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6').forEach((n) => { if (!n.closest('li')) n.append('\n'); });
    return clean(doc.body ? doc.body.textContent : '');
  };

  // Elements like "Arbeitspensum: 80 – 100%" (the smallest matching element wins).
  const findLabeled = (labelList, root = document) => {
    const re = new RegExp(`^\\s*(?:${labelList.map(escapeRe).join('|')})\\s*:?\\s*(.{1,120})$`, 'is');
    let best = null;
    for (const el of root.querySelectorAll('li, dt, dd, div, span, p, td, th')) {
      if (el.childElementCount > 6) continue;
      const s = line(el.textContent);
      if (!s || s.length > 140) continue;
      const m = s.match(re);
      const value = m ? m[1].replace(/^[\s:]+/, '').trim() : '';
      if (value && /[\p{L}\p{N}]/u.test(value) && (!best || s.length < best.len)) best = { len: s.length, value };
    }
    return best ? best.value : '';
  };

  // ---------- field detectors ----------
  const detectWorkload = (text, allowSingle = true) => {
    if (!text) return '';
    const r = text.match(/(\d{1,3})\s*%?\s*(?:-|–|—|bis|to|à)\s*(\d{1,3})\s*%/i);
    if (r && +r[1] >= 10 && +r[1] < +r[2] && +r[2] <= 100) return `${r[1]}-${r[2]} %`;
    if (allowSingle) {
      const s = text.match(/(?:^|[^\d.,])(\d{2,3})\s*%/);
      if (s && +s[1] >= 10 && +s[1] <= 100) return `${s[1]} %`;
    }
    return '';
  };
  const detectLabeledWorkload = (text) => {
    if (!text) return '';
    const m = text.match(/(?:Arbeitspensum|Pensum|Beschäftigungsgrad|Anstellungsgrad|Taux d['’]activité|Workload)\s*:?\s*(\d{1,3}\s*%?\s*(?:-|–|bis|à)?\s*\d{0,3}\s*%)/i);
    return m ? detectWorkload(m[1]) : '';
  };
  const detectEmployment = (text) => {
    if (!text) return '';
    if (/\b(vollzeit|full[- ]?time|plein temps|temps plein|tempo pieno)\b/i.test(text)) return labels.fullTime;
    if (/\b(teilzeit|part[- ]?time|temps partiel|tempo parziale)\b/i.test(text)) return labels.partTime;
    return '';
  };
  // mode 'header': short labels such as LinkedIn pills; otherwise free text.
  const detectWorkModel = (text, mode) => {
    if (!text) return '';
    if (/\bhybrid/i.test(text)) return 'hybrid';
    if (/(full[- ]?remote|fully remote|100\s*%\s*remote|remote[- ]first|vollständig remote|komplett remote|remote only|télétravail (?:complet|à 100))/i.test(text)) return 'remote';
    if (mode === 'header') {
      if (/\b(remote|télétravail)\b/i.test(text)) return 'remote';
      if (/\b(homeoffice|home[- ]office)\b/i.test(text)) return 'hybrid';
      if (/\b(on[- ]?site|vor ort|sur site|in[- ]office|présentiel)\b/i.test(text)) return 'onsite';
      return '';
    }
    if (/\b(remote|télétravail|teletravail|homeoffice|home[- ]office|mobiles arbeiten|mobile work)\b/i.test(text)) return 'hybrid';
    return '';
  };
  const NOT_A_NAME = /^(Bei|Für|Fur|Wir|Haben|Sie|Fragen|Ihre|Ihr|Unser|Unsere|Das|Die|Der|Gerne|Weitere|Details|Information|Informationen|Jetzt|Bitte|Team|Human|Recruiting|HR|Personal|Zur|Zum|Mit|Kontaktieren|Contact|Please|For|We|Our|The|If|Pour|Nous|Votre|Vos)\b/;
  const detectContact = (text) => {
    const res = { name: '', email: '', phone: '' };
    if (!text) return res;
    const emails = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .filter((e) => !/^(no-?reply|donotreply|datenschutz|privacy|dpo)@/i.test(e));
    if (emails.length) res.email = emails[0];
    const labeledPhone = text.match(/\b(?:Tel(?:efon)?(?:nummer)?|Phone|Tél|Mobile|Natel|Handy)\.?\s*:?\s*((?:\+|00)?\d[\d\s()/.-]{7,18}\d)|\bT\s*:\s*((?:\+|00)?\d[\d\s()/.-]{7,18}\d)/);
    const intlPhone = text.match(/(?:\+|00)(?:41|49|43|33|39)[\s\d()/.-]{8,17}\d/);
    if (labeledPhone) res.phone = line(labeledPhone[1] || labeledPhone[2]);
    else if (intlPhone) res.phone = line(intlPhone[0]);
    const word = "[A-ZÄÖÜÉÈÀ][a-zäöüéèàçëïâêîôûß'’-]+";
    const labeled = text.match(new RegExp(
      `(?:Kontaktperson|Ansprechperson|Ansprechpartner(?:in)?|Personne de contact|Contact person|Recruiter(?:in)?|Kontakt|Contact)\\s*(?::|\\n)\\s*((?:(?:Frau|Herr|Mme|Madame|Monsieur|Mr\\.?|Mrs\\.?|Ms\\.?)\\s+)?${word}(?:\\s+(?:von|van|de|del|da|di|von der)\\s+${word}|\\s+${word}){1,2})\\s*(?:\\n|,|$|\\(|–|-|\\|)`,
      'm',
    ));
    if (labeled && !NOT_A_NAME.test(labeled[1])) res.name = line(labeled[1]);
    if (!res.name) {
      const sal = text.match(new RegExp(`((?:Frau|Herr|Madame|Monsieur|Mme)\\s+${word}(?:\\s+${word}){0,2})`));
      if (sal) res.name = line(sal[1]);
    }
    return res;
  };

  const cleanHref = () => {
    try {
      const u = new URL(location.href);
      u.hash = '';
      [...u.searchParams.keys()].forEach((k) => {
        if (/^(utm_|trk|refId|trackingId|tracking|fbclid|gclid|mc_|lipi|eBP|ebp)/i.test(k)) u.searchParams.delete(k);
      });
      return u.toString();
    } catch {
      return location.href;
    }
  };

  const fetchText = async (url, init = {}, ms = 7000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { credentials: 'include', ...init, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  };

  const PORTALS = /linkedin|indeed|jobs\.ch|jobup|stepstone|xing|glassdoor|monster|jobscout|jobsuche|arbeitsagentur/i;
  const docTitleParts = () => {
    let s = line(document.title).replace(/^\(\d+\+?\)\s*/, '');
    s = s.replace(/\s*[|\-–—]\s*(LinkedIn|jobs\.ch|jobup\.ch|Indeed(?:\.com)?|StepStone|XING|Glassdoor)\s*$/i, '');
    return s.split(/\s+[|–—]\s+|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  };
  const timeish = /(ago|vor\s|il y a|applicant|bewerb|candidat|reposted|neu eingestellt|erneut|promoted|gesponsert|clicked|klick|people|personen|erste|first \d+)/i;

  // ---------- schema.org JobPosting ----------
  const findJobPostings = () => {
    const found = [];
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 8) return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
      const type = n['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) { found.push(n); return; }
      for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (n[k]) walk(n[k], depth + 1);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = s.textContent || '';
      let data = null;
      try { data = JSON.parse(raw); } catch {
        try { data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')); } catch { /* broken JSON */ }
      }
      walk(data, 0);
    }
    return found;
  };
  const fromJsonLd = (jp) => {
    if (!jp) return {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const org = one(jp.hiringOrganization);
    const company = typeof org === 'string' ? org : (org && org.name) || '';
    const locs = [].concat(jp.jobLocation || []).map((l) => {
      const a = l && (l.address || l);
      if (!a) return '';
      if (typeof a === 'string') return a;
      const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry && a.addressCountry.name;
      return a.addressLocality || a.addressRegion || a.streetAddress || country || '';
    }).map((x) => line(x)).filter(Boolean);
    const typeMap = { FULL_TIME: labels.fullTime, PART_TIME: labels.partTime };
    const employment = [].concat(jp.employmentType || [])
      .map((x) => typeMap[String(x).toUpperCase().replace(/[- ]/g, '_')] || '')
      .filter(Boolean)[0] || '';
    return {
      title: line(htmlToText(jp.title || jp.name || '')),
      company: line(company),
      location: [...new Set(locs)].join(' / '),
      description: htmlToText(jp.description || ''),
      workload: employment,
      workModel: /TELECOMMUTE/i.test(String(jp.jobLocationType || '')) ? 'remote' : '',
      logoUrl: org && typeof org === 'object' ? absUrl(typeof org.logo === 'string' ? org.logo : (one(org.logo) || {}).url || (one(org.logo) || {}).contentUrl || '') : '',
    };
  };

  // ---------- company logo helpers ----------
  const absUrl = (u) => {
    if (!u || typeof u !== 'string') return '';
    try {
      const url = new URL(u.trim(), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  };
  // LinkedIn's JSON: { rootUrl, artifacts: [{ width, fileIdentifyingUrlPathSegment }] }
  const vectorImageUrl = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return '';
    if (typeof node.rootUrl === 'string' && Array.isArray(node.artifacts) && node.artifacts.length) {
      const sorted = [...node.artifacts].filter((a) => a && a.fileIdentifyingUrlPathSegment)
        .sort((a, b) => Math.abs((a.width || 0) - 200) - Math.abs((b.width || 0) - 200));
      if (sorted.length) return absUrl(node.rootUrl + sorted[0].fileIdentifyingUrlPathSegment);
    }
    for (const v of Object.values(node)) {
      const found = vectorImageUrl(v, depth + 1);
      if (found) return found;
    }
    return '';
  };
  // Any "...logo..." key holding an image URL (the portals' JSON changes now and then).
  const jsonLogo = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 5) return '';
    for (const [k, v] of Object.entries(node)) {
      if (!/logo/i.test(k)) continue;
      if (typeof v === 'string' && /^(https?:)?\/\/|^\//.test(v)) return absUrl(v);
      if (v && typeof v === 'object') {
        const u = v.url || v.href || v.src || (v._links && v._links.self && v._links.self.href);
        if (typeof u === 'string') return absUrl(u);
      }
    }
    for (const v of Object.values(node)) {
      const found = v && typeof v === 'object' ? jsonLogo(v, depth + 1) : '';
      if (found) return found;
    }
    return '';
  };

  // ---------- jobs.ch / jobup.ch (JobCloud) ----------
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const jobcloud = async () => {
    const params = new URLSearchParams(location.search);
    let id = params.get('jobid') || params.get('jobId') || '';
    if (!UUID.test(id)) id = (location.pathname.match(UUID) || [''])[0];
    if (!id) {
      const active = document.querySelector('[data-cy="vacancy-serp-item-active"] [data-cy^="serp-item-"]');
      id = active ? ((active.getAttribute('data-cy') || '').match(UUID) || [''])[0] : '';
    }
    id = id.toLowerCase();
    const sourceKey = id ? `jobcloud:${id}` : '';

    let api = null;
    if (id && !options.offline) {
      try { api = JSON.parse(await fetchText(`${location.origin}/api/v1/public/search/job/${id}`)); } catch { api = null; }
    }
    if (api && api.title) {
      const lang = (location.pathname.match(/^\/(de|fr|en)\//) || [])[1] || 'de';
      const links = api._links || {};
      const link = links[`detail_${lang}`] || links.detail_de || links.detail_fr || links.detail_en;
      const grades = (Array.isArray(api.employment_grades) ? api.employment_grades : [])
        .map(Number).filter((n) => n > 0 && n <= 100);
      const lo = grades.length ? Math.min(...grades) : 0;
      const hi = grades.length ? Math.max(...grades) : 0;
      let description = htmlToText(api.template_text || '');
      if (description.length < 80 && api.template) description = htmlToText(api.template);
      const person = api.contact_person && !Array.isArray(api.contact_person)
        ? api.contact_person
        : (Array.isArray(api.contacts) && api.contacts[0]) || null;
      let contactName = person ? line([person.firstName, person.lastName].filter(Boolean).join(' ')) : '';
      if (!contactName && api.template_contact_address) {
        const lines = htmlToText(api.template_contact_address).split('\n').map((x) => line(x)).filter(Boolean);
        contactName = lines.find((x) => /^(Frau|Herr|Mme|Madame|Monsieur|Mr|Ms)\b/.test(x))
          || lines.find((x) => x !== api.company_name && /^[A-ZÄÖÜÉ][\p{L}'’-]+(\s+[A-ZÄÖÜÉ][\p{L}'’-]+){1,2}$/u.test(x))
          || '';
      }
      return {
        title: line(api.title),
        company: line(api.company_name || ''),
        location: line(api.place || (Array.isArray(api.locations) && api.locations[0] && api.locations[0].city) || ''),
        workload: hi ? (lo === hi ? `${hi} %` : `${lo}-${hi} %`) : '',
        description,
        contactName,
        contactPhone: line((person && person.phone) || ''),
        contactEmail: line(api.application_email || (person && person.email) || ''),
        url: (link && link.href) || cleanHref(),
        sourceKey,
        logoUrl: jsonLogo(api),
        via: 'api',
      };
    }

    // Fallback: read the detail pane that is actually shown.
    const root = first(['[data-cy^="vacancy-layout"]', '[data-cy="vacancy-detail"]']);
    if (!root) return { listPage: true, sourceKey };
    const info = root.querySelector('[data-cy="vacancy-info"]');
    const locItem = info ? [...info.querySelectorAll('li')].find((li) => !li.hasAttribute('data-cy')) : null;
    const workloadText = pickText(['[data-cy="info-workload"]'], root)
      || findLabeled(['Arbeitspensum', 'Pensum', "Taux d'activité", 'Taux d’activité', 'Workload'], root);
    // the job's own detail link, not the search URL it is shown in
    const detailLink = id ? document.querySelector(`a[href*="/detail/${id}"]`) : null;
    return {
      title: pickText(['[data-cy="vacancy-title"]', 'h1', 'h2'], root),
      company: pickText(['[data-cy="company-link"]', '[data-cy="vacancy-company"] h2', '[data-cy="vacancy-company"] h3'], root),
      location: line(textOf(locItem)) || findLabeled(['Arbeitsort', 'Lieu de travail', 'Place of work'], root),
      workload: detectWorkload(workloadText) || workloadText,
      description: richText(root.querySelector('[data-cy="vacancy-description"]'),
        (n) => /jobfit|salary|login/.test(n.getAttribute('data-cy') || ''))
        .replace(/^(über den job|à propos du poste|à propos de l[’']emploi|about the job|informazioni sul lavoro)\s*\n+/i, ''),
      url: detailLink ? new URL(detailLink.getAttribute('href'), location.href).href.split('?')[0] : cleanHref(),
      sourceKey,
      via: 'dom',
    };
  };

  // ---------- LinkedIn ----------
  const ABOUT_JOB_WORDS = '(?:about the job|about this job|details zum jobangebot|info zum job|über den job|über die stelle|stellenbeschreibung|jobbeschreibung|à propos de l[’\']offre d[’\']emploi|à propos de cet emploi|détails de l[’\']offre|informazioni sull[’\']offerta di lavoro|acerca del empleo|over de vacature)';
  const ABOUT_JOB = new RegExp(`^${ABOUT_JOB_WORDS}$`, 'i');
  const ABOUT_JOB_START = new RegExp(`^${ABOUT_JOB_WORDS}\\s*\\n+`, 'i');
  const isVisible = (el) => Boolean(el && el.getClientRects && el.getClientRects().length);

  // 1) The JSON LinkedIn's own job page loads. Needs the user's normal LinkedIn session.
  const VOYAGER_LANG = { de: 'de_DE', fr: 'fr_FR', it: 'it_IT', en: 'en_US', es: 'es_ES', nl: 'nl_NL', pt: 'pt_BR', pl: 'pl_PL', sv: 'sv_SE' };
  const voyagerText = (desc) => {
    const text = (desc && desc.text) || '';
    const inserts = [];
    for (const a of (desc && desc.attributes) || []) {
      const kind = Object.keys(a.attributeKindUnion || a.type || {})[0] || '';
      if (!Number.isFinite(a.start)) continue;
      if (/listitem$/i.test(kind)) {
        inserts.push([a.start, '\n• ']);
        if (a.length) inserts.push([a.start + a.length, '\n']);
      } else if (/(linebreak|paragraph)$/i.test(kind) && text[a.start] !== '\n') {
        inserts.push([a.start, '\n']);
      }
    }
    let s = text;
    // stable: later positions first, so earlier offsets stay valid
    inserts.sort((x, y) => y[0] - x[0]).forEach(([pos, str]) => { s = s.slice(0, pos) + str + s.slice(pos); });
    return clean(s).replace(/•\s*\n+\s*/g, '• ').replace(/\n{2,}(?=• )/g, '\n');
  };
  const findNames = (node, depth = 0, out = []) => {
    if (!node || typeof node !== 'object' || depth > 6 || out.length > 2) return out;
    if (typeof node.firstName === 'string' && typeof node.lastName === 'string') {
      out.push(line(`${node.firstName} ${node.lastName}`));
      return out;
    }
    Object.values(node).forEach((v) => findNames(v, depth + 1, out));
    return out;
  };
  const linkedinVoyager = async (jobId) => {
    const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1];
    if (!csrf) return null;
    const lang = VOYAGER_LANG[(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase()] || 'en_US';
    const j = JSON.parse(await fetchText(
      `${location.origin}/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`,
      { headers: { 'csrf-token': csrf, accept: 'application/json', 'x-restli-protocol-version': '2.0.0', 'x-li-lang': lang } },
    ));
    if (!j || !j.title) return null;
    const company = Object.values(j.companyDetails || {})[0] || {};
    const types = [].concat(j.workplaceTypes || []).map((u) => String(u).split(':').pop());
    const workModel = types.includes('3') ? 'hybrid' : types.includes('2') ? 'remote' : types.includes('1') ? 'onsite' : '';
    const status = String(j.employmentStatus || '').split(':').pop();
    return {
      title: line(j.title),
      company: line((company.companyResolutionResult && company.companyResolutionResult.name) || company.companyName || ''),
      location: line(j.formattedLocation || ''),
      description: voyagerText(j.description),
      workModel,
      employment: status === 'FULL_TIME' ? labels.fullTime : status === 'PART_TIME' ? labels.partTime : '',
      contactName: findNames(j.allJobHiringTeamMembersInjectionResult)[0] || '',
      logoUrl: vectorImageUrl(j.companyDetails),
    };
  };

  // 2) The public job view (works logged out too).
  const linkedinGuest = (html) => {
    const doc = parseHtml(html);
    if (doc) {
      const q = (sel) => line((doc.querySelector(sel) || {}).textContent || '');
      const bullets = [...doc.querySelectorAll('.topcard__flavor--bullet')].map((e) => line(e.textContent));
      const criteria = [...doc.querySelectorAll('.description__job-criteria-item')].map((li) => [
        line((li.querySelector('h3') || {}).textContent || ''),
        line((li.querySelector('.description__job-criteria-text, span') || {}).textContent || ''),
      ]);
      const markup = doc.querySelector('.show-more-less-html__markup') || doc.querySelector('.description__text');
      if (markup) markup.querySelectorAll('button').forEach((b) => b.remove());
      return {
        title: q('.top-card-layout__title, .topcard__title'),
        company: q('.topcard__org-name-link, .top-card-layout__second-subline .topcard__flavor a'),
        location: bullets.find((b) => b && !timeish.test(b)) || '',
        description: markup ? htmlToText(markup.innerHTML) : '',
        employment: detectEmployment((criteria.find(([k]) => /beschäftigung|employment|type d['’]emploi|tipo di impiego|contrat/i.test(k)) || [])[1] || ''),
        contactName: q('.message-the-recruiter .base-main-card__title'),
        logoUrl: (() => {
          const img = doc.querySelector('.top-card-layout__card img[data-delayed-url], .topcard img[data-delayed-url], img.artdeco-entity-image[data-delayed-url]');
          const u = img ? img.getAttribute('data-delayed-url') : '';
          return /company-logo/.test(u || '') ? absUrl(u) : '';
        })(),
      };
    }
    // DOMParser blocked: read the few fields straight from the markup
    const m = (re) => { const r = html.match(re); return r ? stripTags(r[1]) : ''; };
    const descHtml = (html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<button|<\/section|<\/div)/) || [])[1] || '';
    const criteria = [...html.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)]
      .map((x) => [stripTags(x[1]), stripTags(x[2])]);
    const bullets = [...html.matchAll(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/g)].map((x) => stripTags(x[1]));
    return {
      title: m(/<h[12][^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h[12]>/),
      company: m(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/),
      location: bullets.find((b) => b && !timeish.test(b)) || '',
      description: descHtml ? htmlToTextPlain(descHtml) : '',
      employment: detectEmployment((criteria.find(([k]) => /beschäftigung|employment|type d['’]emploi|tipo di impiego|contrat/i.test(k)) || [])[1] || ''),
      contactName: '',
      logoUrl: absUrl(((html.match(/data-delayed-url="([^"]*company-logo[^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&')),
    };
  };

  // 3) What is on screen: the detail pane of the selected job.
  const linkedinDom = () => {
    const root = first([
      '.jobs-search__job-details--wrapper', '.jobs-search__job-details', '.job-view-layout',
      '.jobs-details', '.scaffold-layout__detail', '[class*="jobs-search__job-details"]', '.top-card-layout',
    ]);
    // The "About the job" heading is the most stable landmark in every LinkedIn layout.
    const heading = [...(root || document).querySelectorAll('h1, h2, h3, span, strong, div, p')]
      .find((el) => el.childElementCount === 0 && ABOUT_JOB.test(line(el.textContent)));
    let descBox = null;
    if (heading) {
      // climb until the box holds real text besides the heading itself
      const headLen = line(heading.textContent).length;
      descBox = heading.parentElement;
      while (descBox && descBox !== document.body && line(descBox.textContent).length - headLen < 60) descBox = descBox.parentElement;
      if (descBox === document.body) descBox = null;
    }
    if (!descBox) {
      const known = ['#job-details', '.jobs-description__content .jobs-box__html-content', '.jobs-description-content__text',
        '.jobs-box__html-content', '.show-more-less-html__markup', '.description__text'];
      descBox = (root && pick(known, root)) || pick(known, document);
    }
    let description = richText(descBox).replace(ABOUT_JOB_START, '');
    description = description.replace(/\n?(…\s*)?(mehr anzeigen|see more|show more|weniger anzeigen|see less|afficher plus|voir plus)\s*$/i, '');
    const scope = root || (descBox && descBox.parentElement) || document;
    const title = pickText([
      '.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title', 'h1.top-card-layout__title', 'h1',
    ], scope);
    const company = pickText([
      '.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name', '.topcard__org-name-link', 'a[href*="/company/"]',
    ], scope);
    // "Zürich, Schweiz · Erneut veröffentlicht: vor 1 Monat · 87 Bewerber" -> "Zürich, Schweiz"
    const partOf = (s) => s.split(/\s*·\s*/).map((x) => x.trim())
      .find((x) => x && x.length < 80 && !timeish.test(x) && !(title && x.includes(title)) && !(company && x === company)) || '';
    let location = '';
    const known = scope.querySelector('.job-details-jobs-unified-top-card__tertiary-description-container, .job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__primary-description');
    if (known) {
      const firstSpan = known.querySelector('.tvm__text');
      location = partOf(line(firstSpan ? firstSpan.textContent : textOf(known)));
    }
    if (!location) {
      location = [...scope.querySelectorAll('.topcard__flavor--bullet, .job-details-jobs-unified-top-card__bullet')]
        .map((e) => line(e.textContent)).find((x) => x && !timeish.test(x)) || '';
    }
    if (!location) {
      // the shortest visible element holding "a · b" is the line itself, not a wrapper
      let bestLen = Infinity;
      for (const el of scope.querySelectorAll('div, span, p, li')) {
        if (el.childElementCount > 8 || !isVisible(el)) continue;
        const s = line(el.innerText || el.textContent);
        if (s.length > 200 || s.length >= bestLen || !/ · /.test(s)) continue;
        const part = partOf(s);
        if (part) { location = part; bestLen = s.length; }
      }
    }
    // Pills like "Hybrid" "Full-time" sit next to each other without spaces,
    // so read the top of the pane leaf by leaf.
    const header = root ? leafText(root).slice(0, 900) : '';
    return {
      title, company, location, description,
      workModel: detectWorkModel(header, 'header'),
      employment: detectEmployment(header),
      contactName: pickText(['.hirer-card__hirer-information .jobs-poster__name strong', '.hirer-card__hirer-information strong', '.jobs-poster__name'], scope).split(/\s*[·•]\s*/)[0],
    };
  };

  const linkedin = async () => {
    const params = new URLSearchParams(location.search);
    const m = location.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/);
    let jobId = params.get('currentJobId') || (m && m[1]) || '';
    if (!jobId) {
      const active = document.querySelector('.jobs-search-results-list__list-item--active [data-job-id], .job-card-container--active[data-job-id], [aria-current="page"][data-job-id]');
      jobId = (active && active.getAttribute('data-job-id')) || '';
    }
    const dom = linkedinDom();
    let api = {};
    let guest = {};
    if (jobId && !options.offline) {
      const [a, g] = await Promise.all([
        linkedinVoyager(jobId).catch(() => null),
        fetchText(`${location.origin}/jobs-guest/jobs/api/jobPosting/${jobId}`).then(linkedinGuest).catch(() => null),
      ]);
      if (a && a.title) api = a;
      if (g && g.title) guest = g;
    }
    const pickFirst = (...vals) => vals.find((v) => v && String(v).trim()) || '';
    const title = pickFirst(api.title, guest.title, dom.title);
    const headerDocs = docTitleParts();
    return {
      title: title || headerDocs[0] || '',
      company: pickFirst(api.company, guest.company, dom.company, headerDocs[1]),
      location: pickFirst(dom.location, guest.location, api.location),
      // the public view keeps the posting's own formatting; the pane is what you see
      description: pickFirst(guest.description, dom.description, api.description),
      workModel: pickFirst(api.workModel, dom.workModel),
      workload: detectWorkload(title) || pickFirst(api.employment, guest.employment, dom.employment),
      contactName: pickFirst(dom.contactName, api.contactName, guest.contactName),
      url: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : cleanHref(),
      sourceKey: jobId ? `linkedin:${jobId}` : '',
      logoUrl: pickFirst(api.logoUrl, guest.logoUrl),
      listPage: !jobId && !title,
      via: api.title ? 'api' : guest.title ? 'guest' : 'dom',
    };
  };

  // ---------- Indeed ----------
  const cityFromAddress = (addr) => {
    const s = line(addr);
    if (!s) return '';
    const zip = s.match(/(?:^|,\s*)\d{4,5}\s+([^,]+)/);
    if (zip) return zip[1].trim();
    const parts = s.split(/\s*,\s*/);
    if (parts.length > 1 && /^[A-Z]{2}$/.test(parts[parts.length - 1])) return parts[parts.length - 2];
    return s;
  };
  const indeed = () => {
    const params = new URLSearchParams(location.search);
    const root = first([
      '.jobsearch-RightPane', '#jobsearch-ViewjobPaneWrapper', '[data-testid="viewjob-main-content"]',
      '.jobsearch-ViewJobLayout-jobDisplay', '#viewJobSSRRoot',
    ]) || document;
    let jk = params.get('vjk') || params.get('jk') || '';
    if (!jk) {
      const link = root.querySelector('a[href*="fromjk="]');
      jk = link ? (new URL(link.href, location.href).searchParams.get('fromjk') || '') : '';
    }
    const title = pickText([
      '[data-testid="vj-job-title"]', '[data-testid="jobsearch-JobInfoHeader-title"]', '.jobsearch-JobInfoHeader-title', 'h1',
    ], root).replace(/\s*[-–]\s*(job post|stellenanzeige|jobanzeige|offre d['’]emploi|annonce)\s*$/i, '');
    const meta = root.querySelector('[data-testid="company-info-metadata"]');
    const company = pickText([
      '[data-testid="inlineHeader-companyName"]', '[data-testid="company-info-metadata"] a', '[data-company-name="true"]',
      '[data-testid="jobsearch-CompanyInfoContainer"] a', '.jobsearch-CompanyInfoContainer a',
    ], root).replace(/\s*\d[.,]\d\s*(out of|von|sur|de)\b.*$/i, '');
    let rawLoc = pickText([
      '[data-testid="inlineHeader-companyLocation"]', '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
      '[data-testid="job-location"]', '#jobLocationText',
    ], root);
    if (!rawLoc && meta) {
      rawLoc = textOf(meta).split('\n').map((x) => line(x))
        .filter((x) => x && x !== company && x !== '·' && !/^\d([.,]\d)?$/.test(x)).pop() || '';
    }
    if (!rawLoc) {
      const mapLink = root.querySelector('[data-testid="structured-job-summary"] [aria-label][role="link"]');
      rawLoc = mapLink ? line(mapLink.textContent) : '';
    }
    let loc = rawLoc;
    let workModel = '';
    const wm = loc.match(/^(hybrid(?:es arbeiten| work| remote)?|hybride|télétravail(?: hybride| partiel)?|remote|homeoffice|home office)\s*(?:in|à|en)?\s*/i);
    if (wm) {
      workModel = /hybrid|partiel/i.test(wm[1]) ? 'hybrid' : 'remote';
      loc = loc.slice(wm[0].length).trim();
    }
    const summary = pickText(['[data-testid="structured-job-summary"]', '#salaryInfoAndJobType',
      '[data-testid="jobsearch-OtherJobDetailsContainer"]', '#jobDetailsSection'], root);
    let descEl = pick(['.simple-job-description-html', '#jobDescriptionText', '.jobsearch-jobDescriptionText',
      '[data-testid="jobsearch-JobComponent-description"]'], root);
    if (!descEl) {
      const h = root.querySelector('[data-testid="vj-job-description-heading"]');
      descEl = h ? h.nextElementSibling : null;
    }
    return {
      title, company,
      location: cityFromAddress(loc),
      description: richText(descEl),
      workModel: workModel || detectWorkModel(`${summary}\n${rawLoc}`, 'header'),
      workload: detectWorkload(title) || detectLabeledWorkload(summary) || detectWorkload(summary) || detectEmployment(summary),
      url: jk ? `${location.origin}/viewjob?jk=${encodeURIComponent(jk)}` : cleanHref(),
      sourceKey: jk ? `indeed:${jk}` : '',
      listPage: !title,
      via: 'dom',
    };
  };

  // ---------- StepStone ----------
  const stepstone = () => {
    const title = pickText(['[data-at="header-job-title"]']);
    const workType = pickText(['[data-at="metadata-work-type"]']);
    const id = (location.pathname.match(/--(\d{5,})(?:-inline)?\.html/) || [])[1] || '';
    return {
      title,
      company: pickText(['[data-at="metadata-company-name"]', '[data-at="header-company-name"]']),
      location: pickText(['[data-at="metadata-location"]']),
      description: richText(document.querySelector('[data-at="job-ad-content"]'),
        (n) => /apply|salary|gehalt|company-card|company-logo|recommender|result-list|divider|badge/i.test(n.getAttribute('data-at') || '')),
      workModel: detectWorkModel(workType, 'header'),
      workload: detectWorkload(title) || detectEmployment(workType),
      url: cleanHref().split('?')[0],
      sourceKey: id ? `stepstone:${id}` : '',
      listPage: !title,
      via: 'dom',
    };
  };

  // ---------- Workday (*.myworkdayjobs.com) ----------
  // Values come as "label\nvalue" (a screen reader label first): keep the value.
  const WD_LABEL = /^(locations?|standorte?|time type|arbeitszeittyp|arbeitszeit|remote type|posted on|job requisition id|lieu|lieux|type de poste)$/i;
  const wdValue = (name) => {
    const el = document.querySelector(`[data-automation-id="${name}"]`);
    if (!el) return '';
    const parts = textOf(el).split('\n').map((x) => line(x)).filter(Boolean);
    if (parts.length > 1 && WD_LABEL.test(parts[0])) parts.shift();
    return parts.join(', ');
  };
  const workday = () => {
    const title = pickText(['[data-automation-id="jobPostingHeader"]']);
    const tenant = location.hostname.split('.')[0];
    const ogSite = metaContent('og:site_name');
    const req = (location.pathname.match(/_([A-Z]{0,6}-?\d[\w-]*)\/?$/i) || [])[1] || '';
    const rawLoc = wdValue('locations');
    return {
      title,
      company: (ogSite && !/workday/i.test(ogSite) ? ogSite : '') || (tenant ? tenant[0].toUpperCase() + tenant.slice(1) : ''),
      location: rawLoc.replace(/\s*\((?:office|on-?site|hybrid|remote)\)/gi, ''),
      description: richText(document.querySelector('[data-automation-id="jobPostingDescription"]')),
      workModel: detectWorkModel(`${wdValue('remoteType')}\n${rawLoc}`, 'header'),
      workload: detectWorkload(title) || detectEmployment(wdValue('time')),
      url: cleanHref(),
      sourceKey: req ? `workday:${tenant}:${req.toLowerCase()}` : '',
      listPage: !title,
      via: 'dom',
    };
  };

  // ---------- Greenhouse ----------
  const greenhouse = () => {
    const title = pickText(['.job__title h1', 'h1.section-header', '.app-title', 'main h1', 'h1']);
    const fromTitle = line(document.title).match(/^Job Application for (.+?) at (.+)$/i);
    const slug = location.pathname.split('/').filter(Boolean)[0] || '';
    const loc = pickText(['.job__location', '.location']);
    const id = (location.pathname.match(/\/jobs\/(\d+)/) || [])[1] || new URLSearchParams(location.search).get('gh_jid') || '';
    return {
      title,
      company: pickText(['.company-name']).replace(/^at\s+/i, '') || (fromTitle ? fromTitle[2] : '') || (slug ? slug[0].toUpperCase() + slug.slice(1) : ''),
      location: loc,
      description: richText(first(['.job__description', '#content .job-post-content', '#content'])),
      workModel: detectWorkModel(loc, 'header'),
      workload: detectWorkload(title),
      url: cleanHref(),
      sourceKey: id ? `greenhouse:${id}` : '',
      listPage: !title,
      via: 'dom',
    };
  };

  // ---------- Lever ----------
  const lever = () => {
    const title = pickText(['.posting-headline h2', '.posting-headline h1']);
    const category = (cls) => pickText([`.posting-categories .${cls}`, `.posting-category.${cls}`]).replace(/\s*\/\s*$/, '');
    const id = (location.pathname.match(UUID) || [''])[0];
    const sections = [...document.querySelectorAll('.section-wrapper .section.page-centered, [data-qa="job-description"], [data-qa="closing-description"]')]
      .filter((el) => !el.querySelector('.postings-btn, form, .posting-headline'));
    return {
      title,
      company: (line(document.title).match(/^(.+?)\s+-\s+/) || [])[1] || '',
      location: category('location'),
      description: sections.map((el) => richText(el)).filter(Boolean).join('\n\n'),
      workModel: detectWorkModel(category('workplaceTypes'), 'header'),
      workload: detectWorkload(title) || detectEmployment(category('commitment')),
      url: cleanHref().replace(/\/apply\/?$/, ''),
      sourceKey: id ? `lever:${id.toLowerCase()}` : '',
      listPage: !title,
      via: 'dom',
    };
  };

  // ---------- any other site ----------
  // Readability-style: score blocks of real text, prefer few links and no chrome.
  const mainContent = () => {
    const NEG = /comment|footer|foot|nav|menu|sidebar|cookie|consent|banner|related|share|social|header|promo|teaser|newsletter|breadcrumb|pagination|modal|popup|login|signup|recommend|similar/i;
    const scores = new Map();
    const add = (el, n) => { if (el && el !== document.body && el !== document.documentElement) scores.set(el, (scores.get(el) || 0) + n); };
    for (const p of document.querySelectorAll('p, li, h2, h3, h4, td, pre, blockquote')) {
      if (p.closest('nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
      const s = line(p.textContent);
      if (s.length < 25) continue;
      const score = 1 + Math.min(3, Math.floor(s.length / 100)) + (s.split(/[,;]/).length - 1) * 0.5;
      add(p.parentElement, score);
      add(p.parentElement && p.parentElement.parentElement, score / 2);
      add(p.parentElement && p.parentElement.parentElement && p.parentElement.parentElement.parentElement, score / 4);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, raw] of scores) {
      const id = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
      const text = line(el.textContent);
      if (text.length < 200) continue;
      const linkText = [...el.querySelectorAll('a')].reduce((n, a) => n + line(a.textContent).length, 0);
      const density = linkText / Math.max(1, text.length);
      let score = raw * (1 - Math.min(0.9, density));
      if (NEG.test(id)) score *= 0.3;
      if (/description|content|job|stelle|posting|vacancy|article|main|detail/i.test(id)) score *= 1.25;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  };
  const generic = () => {
    const parts = docTitleParts();
    const ogTitle = metaContent('og:title', 'twitter:title');
    const h1 = pickText(['main h1', 'article h1', 'h1']);
    const title = h1 || ogTitle || parts[0] || '';
    let siteName = metaContent('og:site_name', 'application-name');
    if (PORTALS.test(siteName)) siteName = '';
    const workloadLabel = findLabeled(['Pensum', 'Arbeitspensum', 'Beschäftigungsgrad', 'Workload', "Taux d'activité", 'Anstellungsart']);
    const box = pick(['[itemprop="description"]', '#job-description', '#jobDescription', '[class*="job-description" i]',
      '[class*="jobdescription" i]', '[data-testid*="description" i]']);
    return {
      title,
      // "Job title - Company" / "Page | Company": the site name is usually last
      company: siteName || (parts.length > 1 && !PORTALS.test(parts[parts.length - 1]) ? parts[parts.length - 1] : ''),
      location: findLabeled(['Arbeitsort', 'Einsatzort', 'Standort', 'Location', 'Lieu de travail', 'Ort']),
      description: richText(box && textOf(box).length >= 150 ? box : mainContent()).slice(0, 30000),
      workload: detectWorkload(title) || detectWorkload(workloadLabel) || detectEmployment(workloadLabel),
    };
  };

  // ---------- combine ----------
  const host = location.hostname.replace(/^www\./, '');
  let site = 'generic';
  let siteName = '';
  if (/(^|\.)linkedin\.com$/.test(host)) { site = 'linkedin'; siteName = 'LinkedIn'; }
  else if (/(^|\.)jobs\.ch$/.test(host)) { site = 'jobcloud'; siteName = 'jobs.ch'; }
  else if (/(^|\.)jobup\.ch$/.test(host)) { site = 'jobcloud'; siteName = 'jobup.ch'; }
  else if (/(^|\.)indeed\.[a-z.]+$/.test(host)) { site = 'indeed'; siteName = 'Indeed'; }
  else if (/(^|\.)stepstone\.[a-z.]+$/.test(host)) { site = 'stepstone'; siteName = 'StepStone'; }
  else if (/\.myworkday(jobs|site)\.com$/.test(host)) { site = 'workday'; siteName = 'Workday'; }
  else if (/(^|\.)greenhouse\.io$/.test(host)) { site = 'greenhouse'; siteName = 'Greenhouse'; }
  else if (/(^|\.)lever\.co$/.test(host)) { site = 'lever'; siteName = 'Lever'; }
  // Portals whose own pages are the only source we trust. A generic "main content"
  // guess would pull in the job list next to the posting.
  const strictSite = ['linkedin', 'jobcloud', 'indeed'].includes(site);

  const safe = async (fn) => { try { return (await fn()) || {}; } catch (e) { return { error: String((e && e.message) || e) }; } };
  const readers = { linkedin, indeed, jobcloud, stepstone, workday, greenhouse, lever };
  const postingList = site === 'linkedin' || site === 'jobcloud' ? [] : await safe(() => findJobPostings());
  // A list page can carry dozens of JobPostings. Only trust it if there is exactly one,
  // and only if it describes what is on screen (single page apps keep stale ones around).
  const comparable = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  let jsonLd = Array.isArray(postingList) && postingList.length === 1 ? await safe(() => fromJsonLd(postingList[0])) : {};
  if (jsonLd.title) {
    const want = comparable(jsonLd.title).slice(0, 24);
    if (want && !comparable(document.body ? document.body.innerText : '').includes(want)) jsonLd = {};
  }
  const manyPostings = !strictSite && Array.isArray(postingList) && postingList.length > 1;
  const siteData = readers[site] ? await safe(readers[site]) : {};
  const gen = !strictSite && (!siteData.title || !siteData.description) ? await safe(generic) : {};
  const sources = [siteData, jsonLd, gen];
  const take = (key) => {
    for (const src of sources) {
      const v = src && src[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  // ---------- company logo ----------
  // Only look inside the posting itself on portals: their lists show many logos.
  const LOGO_SKIP = /ghost|placeholder|spacer|blank\.|pixel|1x1|avatar|profile-(display|framed)photo|emoji|flag-|sprite|static\.licdn\.com\/aero/i;
  const attrsOf = (el) => (el && el.getAttribute
    ? ['alt', 'class', 'id', 'data-testid', 'data-at', 'data-cy', 'data-automation-id', 'aria-label', 'title'].map((a) => el.getAttribute(a) || '').join(' ')
    : '');
  const imgUrl = (img) => {
    const u = img.getAttribute('data-delayed-url') || img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (/^data:image\/(png|jpe?g|webp|gif|svg)/i.test(u)) return u.length > 300 ? u : '';
    return absUrl(u);
  };
  const companyText = take('company');
  const hostWords = comparable(location.hostname.replace(/^(www|jobs?|careers?|karriere|stellen|apply)\./i, ''));
  const firstWord = comparable(companyText.split(/[\s+&,/-]+/)[0] || '');
  const companySite = site === 'generic' && firstWord.length >= 3 && hostWords.includes(firstWord);
  const logoElement = (scope) => {
    if (!scope) return null;
    const want = comparable(companyText).slice(0, 10);
    let best = null;
    let bestScore = 0;
    [...scope.querySelectorAll('img')].slice(0, 250).forEach((img, i) => {
      const url = imgUrl(img);
      if (!url) return;
      const hay = `${attrsOf(img)} ${attrsOf(img.parentElement)} ${attrsOf(img.parentElement && img.parentElement.parentElement)} ${url}`;
      if (LOGO_SKIP.test(hay)) return;
      const r = img.getBoundingClientRect();
      const w = r.width || img.naturalWidth || 0;
      const h = r.height || img.naturalHeight || 0;
      if (w && h && (w < 14 || h < 14)) return;
      const named = want.length >= 3 && comparable(img.getAttribute('alt')).includes(want);
      let score = 0;
      if (/logo/i.test(hay)) score += 3;
      if (named) score += 3;
      if (/company|organi[sz]ation|employer|firma|unternehmen|entreprise/i.test(hay)) score += 1;
      if (w && h) {
        if (w / h >= 0.6 && w / h <= 1.7) score += 1;
        if (w > 420 || h > 300) score -= 4;
      }
      // a logo in the header of an unknown job site is that site's logo, not the employer's
      if (site === 'generic' && !companySite && !named) return;
      score -= i * 0.001;
      if (score >= 3 && score > bestScore) { best = { el: img, url }; bestScore = score; }
    });
    return best;
  };
  const siteIcon = () => {
    if (!companySite) return '';
    const links = [...document.querySelectorAll('link[rel~="icon" i], link[rel="apple-touch-icon" i], link[rel="apple-touch-icon-precomposed" i]')];
    const size = (l) => Math.max(0, ...String(l.getAttribute('sizes') || '').split(/\s+/).map((x) => parseInt(x, 10) || 0));
    links.sort((a, b) => (/apple/i.test(b.rel) - /apple/i.test(a.rel)) || size(b) - size(a));
    return (links.length && absUrl(links[0].getAttribute('href'))) || `${location.origin}/favicon.ico`;
  };
  const LOGO_SCOPES = {
    linkedin: ['.jobs-search__job-details--wrapper', '.jobs-search__job-details', '.job-view-layout', '.jobs-details',
      '.scaffold-layout__detail', '.top-card-layout'],
    jobcloud: ['[data-cy^="vacancy-layout"]', '[data-cy="vacancy-detail"]'],
    indeed: ['.jobsearch-RightPane', '#jobsearch-ViewjobPaneWrapper', '[data-testid="viewjob-main-content"]',
      '.jobsearch-ViewJobLayout-jobDisplay', '#viewJobSSRRoot'],
  };
  const logoScope = LOGO_SCOPES[site] ? first(LOGO_SCOPES[site]) : document.body;
  const logoEl = await safe(() => logoElement(logoScope));
  const logoRect = (() => {
    const el = logoEl && logoEl.el;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.height < 14 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  })();
  const logoCandidates = [...new Set([siteData.logoUrl, logoEl && logoEl.url, jsonLd.logoUrl, siteIcon()].filter(Boolean))].slice(0, 4);

  const job = {
    title: take('title'),
    company: take('company'),
    location: take('location'),
    description: take('description'),
    workModel: take('workModel'),
    workload: take('workload'),
    contactName: take('contactName'),
    contactEmail: take('contactEmail'),
    contactPhone: take('contactPhone'),
    url: siteData.url || cleanHref(),
    source: siteName || host,
    sourceKey: siteData.sourceKey || '',
    logoCandidates,
    logoRect,
  };

  const labeledWorkload = detectLabeledWorkload(job.description);
  if (labeledWorkload && (!job.workload || job.workload === labels.fullTime || job.workload === labels.partTime)) job.workload = labeledWorkload;
  if (!job.workload) job.workload = detectWorkload(job.description, false);
  if (!job.workModel) job.workModel = detectWorkModel(job.description, 'text');
  const contact = detectContact(job.description);
  if (!job.contactName) job.contactName = contact.name;
  if (!job.contactEmail) job.contactEmail = contact.email;
  if (!job.contactPhone) job.contactPhone = contact.phone;
  if (job.description.length > 30000) job.description = `${job.description.slice(0, 30000)} …`;

  let selection = '';
  try { selection = clean(String(window.getSelection ? window.getSelection() : '')); } catch { /* ignore */ }

  return {
    ok: true,
    site: siteName,
    host,
    via: siteData.via || (jsonLd.title ? 'jsonld' : 'generic'),
    detected: Boolean(job.title && job.company) && !manyPostings,
    listPage: (Boolean(siteData.listPage) && !job.title) || manyPostings,
    job,
    selection: selection.slice(0, 30000),
  };
}

// Runs in the job page (chrome.scripting.executeScript) after reading: loads the
// logo with the page's own access and shrinks it to a 64 px image. Self-contained.
export async function logoInPage(urls) {
  const SIZE = 64;
  const draw = (src) => {
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    if (!w || !h) return '';
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const k = Math.min(SIZE / w, SIZE / h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (SIZE - w * k) / 2, (SIZE - h * k) / 2, w * k, h * k);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let opaque = 0;
    let lo = 765;
    let hi = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 16) continue;
      opaque += 1;
      const v = px[i] + px[i + 1] + px[i + 2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // empty, or one flat colour from edge to edge: not a logo
    if (opaque < 40 || (opaque === SIZE * SIZE && hi - lo < 24)) return '';
    return canvas.toDataURL('image/png');
  };
  const decode = async (blob) => {
    try { return await createImageBitmap(blob); } catch { /* SVG */ }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  };
  for (const url of (urls || []).slice(0, 4)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size < 40 || blob.size > 5000000) continue;
      const data = draw(await decode(blob));
      if (data) return data;
    } catch { /* blocked or not an image: try the next one */ } finally {
      clearTimeout(timer);
    }
  }
  return '';
}
