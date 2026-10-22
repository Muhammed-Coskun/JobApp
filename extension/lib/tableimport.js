// Import jobs from a spreadsheet: .xlsx (Excel), .csv or .tsv.
//
// No library: an .xlsx file is a zip of XML files. The browser's
// DecompressionStream unpacks the zip entries, DOMParser reads the XML.
// Only the first worksheet is read.

import { createJob, normalizeUrl, today } from './store.js';
import { t } from './i18n.js';

// ---------- reading files ----------

export async function readTableFile(file) {
  const name = (file.name || '').toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  if (isZip || name.endsWith('.xlsx')) return readXlsx(await file.arrayBuffer());
  if (name.endsWith('.xls')) throw new Error('xls');
  return readCsv(await decodeText(await file.arrayBuffer()));
}

async function decodeText(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  // Excel on Windows often saves CSV as Windows-1252; UTF-8 decoding then shows U+FFFD.
  if (utf8.includes('�')) return new TextDecoder('windows-1252').decode(buffer);
  return utf8.replace(/^﻿/, '');
}

export function readCsv(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delimiter = [';', '\t', ','].map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return toTable(rows);
}

// --- xlsx ---

async function unzip(buffer) {
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  const names = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const fileName = names.decode(new Uint8Array(buffer, p + 46, nameLen));
    files.set(fileName, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (fileName) => {
    const f = files.get(fileName);
    if (!f) return null;
    const start = f.local + 30 + view.getUint16(f.local + 26, true) + view.getUint16(f.local + 28, true);
    const bytes = new Uint8Array(buffer, start, f.size);
    if (f.method === 0) return new TextDecoder().decode(bytes);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const byTag = (node, tag) => [...node.getElementsByTagName(tag)];

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/i) || ['A'])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(buffer) {
  const read = await unzip(buffer);
  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new Error('xlsx');
  const firstSheet = byTag(xml(workbook), 'sheet')[0];
  const relId = firstSheet && (firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = await read('xl/_rels/workbook.xml.rels');
  if (rels && relId) {
    const rel = byTag(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === relId);
    const target = rel && rel.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const shared = [];
  const sst = await read('xl/sharedStrings.xml');
  if (sst) {
    for (const si of byTag(xml(sst), 'si')) shared.push(byTag(si, 't').map((t) => t.textContent).join(''));
  }
  // which style indexes are dates or percentages, so the raw numbers can be shown as such
  const dateStyles = new Set();
  const percentStyles = new Set();
  const styles = await read('xl/styles.xml');
  if (styles) {
    const doc = xml(styles);
    const custom = new Map(byTag(doc, 'numFmt').map((f) => [f.getAttribute('numFmtId'), f.getAttribute('formatCode') || '']));
    const cellXfs = byTag(doc, 'cellXfs')[0];
    if (cellXfs) {
      byTag(cellXfs, 'xf').forEach((xf, i) => {
        const id = xf.getAttribute('numFmtId');
        const n = Number(id);
        const code = (custom.get(id) || '').replace(/"[^"]*"/g, '');
        if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47) || /[dmy]{2}/i.test(code)) dateStyles.add(String(i));
        else if (n === 9 || n === 10 || code.includes('%')) percentStyles.add(String(i));
      });
    }
  }
  const sheet = await read(sheetPath);
  if (!sheet) throw new Error('xlsx');
  const rows = [];
  for (const r of byTag(xml(sheet), 'row')) {
    const row = [];
    for (const c of byTag(r, 'c')) {
      const idx = colIndex(c.getAttribute('r') || '');
      const type = c.getAttribute('t');
      const v = byTag(c, 'v')[0];
      let value = '';
      if (type === 's') value = shared[Number(v && v.textContent)] ?? '';
      else if (type === 'inlineStr') value = byTag(c, 't').map((t) => t.textContent).join('');
      else if (type === 'b') value = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
      else value = v ? v.textContent : '';
      const style = c.getAttribute('s') || '';
      if (value && (!type || type === 'n') && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(value)) {
        if (dateStyles.has(style)) value = excelSerialToIso(Number(value));
        else if (percentStyles.has(style)) value = `${Math.round(Number(value) * 100)} %`;
      }
      row[idx] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return toTable(rows);
}

function excelSerialToIso(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  return d.toISOString().slice(0, 10);
}

function toTable(rawRows) {
  const rows = rawRows.map((r) => r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()));
  const headerIndex = rows.findIndex((r) => r.filter(Boolean).length >= 2);
  if (headerIndex < 0) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] || '');
  const headers = pad(rows[headerIndex]).map((h, i) => h || `#${i + 1}`);
  const body = rows.slice(headerIndex + 1).map(pad).filter((r) => r.some(Boolean));
  // Templates often have empty spare columns or formatting far to the right.
  const keep = headers.map((_, i) => body.some((r) => r[i]));
  return {
    headers: headers.filter((_, i) => keep[i]),
    rows: body.map((r) => r.filter((_, i) => keep[i])),
  };
}

// ---------- understanding the columns ----------

export const IMPORT_FIELDS = ['', 'company', 'title', 'location', 'status', 'interview', 'appliedAt', 'savedAt', 'url',
  'workload', 'workModel', 'source', 'contactName', 'contactEmail', 'contactPhone', 'notes', 'description'];

const HEADER_WORDS = {
  company: /^(firma|unternehmen|arbeitgeber|company|employer|organi[sz]ation|entreprise|employeur|azienda|firmenname|company name)$/i,
  title: /^(stelle|position|jobtitel|job ?titel|titel|job|rolle|role|job title|title|stellenbezeichnung|bezeichnung|poste|ruolo)$/i,
  location: /^(ort|standort|arbeitsort|location|city|stadt|lieu|ville|luogo|einsatzort)$/i,
  status: /^(status|stand|stage|phase|state|ergebnis|antwort|r[uü]ckmeldung|result|statut)$/i,
  interview: /^(interviews?( ?(stage|stufe|date|datum|termin|runde|round))?|vorstellungsgespr[aä]ch|gespr[aä]ch(e|stermin)?|einladung|entretien)$/i,
  appliedAt: /^(beworben( am)?|bewerbungsdatum|datum( der)? bewerbung|datum|date|applied( on| at| date)?|date applied|application date|gesendet( am)?|eingereicht( am)?|date de candidature)$/i,
  savedAt: /^(gespeichert( am)?|saved( on)?|erstellt( am)?|created|hinzugef[uü]gt)$/i,
  url: /^(link|url|inserat|stelleninserat|posting|job ?(link|url)|job ?posting( ?(link|url))?|posting ?(link|url)|stellen ?link|inserat ?link|link zu[mr]? (stelle|inserat|anzeige)|anzeige|website|webseite|lien)$/i,
  workload: /^(pensum|arbeitspensum|workload|besch[aä]ftigungsgrad|anstellungsgrad|taux|taux d'activit[eé]|%|prozent)$/i,
  workModel: /^(arbeitsmodell|work ?model|remote|homeoffice|home office|arbeitsort-typ|mode de travail)$/i,
  source: /^(quelle|plattform|portal|source|jobb[oö]rse|kanal|channel|gefunden( auf| über)?|via)$/i,
  contactName: /^(kontakt|kontaktperson|ansprechpartner(in)?|ansprechperson|contact|contact person|recruiter(in)?|hr|interviewer(in)?|hiring manager)$/i,
  contactEmail: /^(e-?mail|mail|kontakt ?e-?mail|contact email)$/i,
  contactPhone: /^(telefon|tel\.?|phone|telefonnummer|nummer)$/i,
  notes: /^(notizen?|bemerkung(en)?|kommentar(e)?|notes?|comments?|anmerkung(en)?|info)$/i,
  description: /^(beschreibung|description|stellenbeschreibung|details)$/i,
};

export function guessMapping(headers, rows) {
  const used = new Set();
  const mapping = headers.map((h) => {
    const name = h.replace(/[:*]+$/, '').trim();
    const field = Object.keys(HEADER_WORDS).find((f) => !used.has(f) && HEADER_WORDS[f].test(name)) || '';
    if (field) used.add(field);
    return field;
  });
  // A "link" column without links is usually where the posting was found.
  const urlCol = mapping.indexOf('url');
  if (urlCol >= 0) {
    const values = rows.map((r) => r[urlCol]).filter(Boolean);
    const links = values.filter((v) => /^(https?:\/\/|www\.)/i.test(v)).length;
    if (values.length && links / values.length < 0.4) {
      used.delete('url');
      mapping[urlCol] = used.has('source') ? 'notes' : 'source';
      if (mapping[urlCol] === 'notes' && used.has('notes')) mapping[urlCol] = '';
      if (mapping[urlCol]) used.add(mapping[urlCol]);
    }
  }
  // No header for a field? Look at the values.
  headers.forEach((_, i) => {
    if (mapping[i]) return;
    const all = rows.map((r) => r[i]).filter(Boolean);
    // one stray value (a meeting link in a spare column) says nothing about the column
    if (!all.length || (all.length < 3 && all.length < rows.length)) return;
    const values = all.slice(0, 20);
    const share = (re) => values.filter((v) => re.test(v)).length / values.length;
    if (!used.has('url') && share(/^https?:\/\//i) > 0.6) { mapping[i] = 'url'; used.add('url'); }
    else if (!used.has('appliedAt') && share(/^(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})$/) > 0.6) { mapping[i] = 'appliedAt'; used.add('appliedAt'); }
    else if (!used.has('contactEmail') && share(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i) > 0.6) { mapping[i] = 'contactEmail'; used.add('contactEmail'); }
  });
  return mapping;
}

// Which board column a status text belongs to, by the column's meaning.
const STATUS_WORDS = [
  ['offer', /angebot|zusage|offer|accepted|angenommen|vertrag|contrat|unterschrieben/i],
  ['rejected', /absage|abgelehnt|ablehnung|rejected|declined|refus|abgesagt|nicht erfolgreich|no thanks|kein interesse|negativ|^nein$|^no$|zur[uü]ckgezogen|withdrawn|dropped|abgebrochen|cancel+ed|storniert|closed|geschlossen/i],
  ['interview', /interview|gespr[aä]ch|vorstellung|einladung|call|assessment|entretien|telefon|zweit|runde|round|case|probetag|schnupper|screen/i],
  ['applied', /beworben|applied|gesendet|sent|eingereicht|offen|pending|warte|keine (antwort|r[uü]ckmeldung)|no (reply|response|answer)|ghost|unbeantwortet|best[aä]tigt|eingang/i],
  ['wishlist', /gespeichert|merkliste|wishlist|saved|interessant|todo|to do|geplant|noch nicht|idee/i],
];

export function guessStatusKind(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const hit = STATUS_WORDS.find(([, re]) => re.test(s));
  return hit ? hit[0] : '';
}

export function columnForKind(columns, kind) {
  return (columns.find((c) => c.kind === kind) || {}).id || '';
}

// ---------- values ----------

const MONTHS = {
  jan: 1, januar: 1, january: 1, janvier: 1, feb: 2, februar: 2, february: 2, février: 2, fevrier: 2, mär: 3, mar: 3, märz: 3, maerz: 3, march: 3, mars: 3,
  apr: 4, april: 4, avril: 4, mai: 5, may: 5, jun: 6, juni: 6, june: 6, juin: 6, jul: 7, juli: 7, july: 7, juillet: 7,
  aug: 8, august: 8, août: 8, aout: 8, sep: 9, sept: 9, september: 9, septembre: 9, okt: 10, oct: 10, oktober: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11, dez: 12, dec: 12, dezember: 12, december: 12, décembre: 12, decembre: 12,
};

export function parseDateLoose(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const ok = (y, m, d) => y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m && ok(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    // European order unless that is impossible
    if (b > 12 && a <= 12) [a, b] = [b, a];
    if (ok(y, b, a)) return `${y}-${pad(b)}-${pad(a)}`;
  }
  m = s.match(/^(\d{1,2})\.?\s+([a-zäéû]+)\.?\s+(\d{4})$/i);
  if (m && MONTHS[m[2].toLowerCase()] && ok(+m[3], MONTHS[m[2].toLowerCase()], +m[1])) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  m = s.match(/^([a-zäéû]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m && MONTHS[m[1].toLowerCase()] && ok(+m[3], MONTHS[m[1].toLowerCase()], +m[2])) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const iso = excelSerialToIso(Number(s));
    if (iso > '1990' && iso < '2100') return iso;
  }
  return '';
}

function workModelFrom(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return '';
  if (/hybrid/.test(s)) return 'hybrid';
  if (/remote|home ?office|télétravail|fern/.test(s)) return 'remote';
  if (/vor ort|on-?site|präsenz|office|büro|sur site/.test(s)) return 'onsite';
  return '';
}

function workloadFrom(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/^0?\.\d+$/.test(s)) return `${Math.round(Number(s) * 100)} %`; // Excel percent cell
  const r = s.match(/(\d{1,3})\s*%?\s*(?:-|–|bis|to)\s*(\d{1,3})\s*%?/);
  if (r) return `${r[1]}-${r[2]} %`;
  const one = s.match(/^(\d{1,3})\s*%?$/);
  if (one && +one[1] <= 100) return `${one[1]} %`;
  return s;
}

const PORTALS = [
  [/linked ?in/i, 'LinkedIn'], [/jobs\.ch/i, 'jobs.ch'], [/jobup/i, 'jobup.ch'], [/indeed/i, 'Indeed'],
  [/stepstone/i, 'StepStone'], [/xing/i, 'XING'], [/glassdoor/i, 'Glassdoor'], [/jobscout ?24/i, 'JobScout24'],
  [/monster/i, 'Monster'], [/jobwinner/i, 'jobwinner.ch'], [/arbeitsagentur/i, 'Arbeitsagentur'],
  [/wellfound|angel ?list/i, 'Wellfound'], [/greenhouse/i, 'Greenhouse'], [/lever\.co/i, 'Lever'],
];
const COMPANY_SITE = /^(offiziell|official|direkt|direct|website|webseite|homepage|karriere(seite|portal|website)?|career(s)?( ?(site|page|portal))?|eigene ?(web)?seite|firmen ?(web)?seite|unternehmens ?(web)?seite|company ?(site|website|page)|site de l'entreprise)$/i;

// "Northwind linkedin" -> "LinkedIn", "eigene Webseite" or the company's own name -> "Company website".
export function canonicalSource(value, company) {
  const s = String(value || '').trim();
  if (!s) return '';
  const portal = PORTALS.find(([re]) => re.test(s));
  if (portal) return portal[1];
  const bare = comparable(s.replace(/\.(com|ch|de|net|org|io|eu|fr|at)$/i, ''));
  const firm = comparable(company);
  if (COMPANY_SITE.test(s) || (bare.length >= 4 && firm && (firm.includes(bare) || bare.includes(firm)))) return t('sourceCompanySite');
  return s;
}

const comparable = (s) => String(s || '').toLowerCase().replace(/\b(ag|gmbh|sa|sàrl|ltd|llc|inc)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

// Rows that name a job. Template rows that only carry a default status are not jobs.
export function namedRows(rows, mapping) {
  const cols = ['company', 'title'].map((f) => mapping.indexOf(f)).filter((i) => i >= 0);
  if (!cols.length) return rows;
  return rows.filter((r) => cols.some((i) => String(r[i] || '').trim()));
}

const ROUND_WORDS = [
  [/\b(first|erste[rsn]?|premier|première)\b/i, 1], [/\b(second|zweite[rsn]?|deuxième)\b/i, 2],
  [/\b(third|dritte[rsn]?|troisième)\b/i, 3], [/\b(fourth|vierte[rsn]?|quatrième)\b/i, 4], [/\b(fifth|fünfte[rsn]?)\b/i, 5],
];
function roundCount(text) {
  const s = String(text || '');
  if (parseDateLoose(s)) return 1;
  const digit = s.match(/(?:^|\D)([1-6])\s*\.?\s*(?:runde|round|interview|gespr|tour|$)/i);
  if (digit) return Number(digit[1]);
  const word = ROUND_WORDS.find(([re]) => re.test(s));
  return word ? word[1] : 1;
}

const MEETING = /teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com/i;
const noon = (iso) => new Date(`${iso}T12:00:00`).toISOString();

// rows + mapping -> new jobs (duplicates of existing ones and within the file are skipped)
export function buildImport({ rows, mapping, statusMap, columns, existing, sourceLabel }) {
  const seen = new Set(existing.flatMap((j) => [normalizeUrl(j.url), `${comparable(j.company)}|${comparable(j.title)}`]).filter(Boolean));
  const firstId = columns[0].id;
  const appliedId = columnForKind(columns, 'applied') || (columns[1] || columns[0]).id;
  const interviewId = columnForKind(columns, 'interview');
  const kindOf = (id) => (columns.find((c) => c.id === id) || {}).kind || '';
  const importedAt = new Date().toISOString();
  const jobs = [];
  let duplicates = 0;
  let empty = 0;
  for (const row of rows) {
    const get = (field) => {
      const i = mapping.indexOf(field);
      return i >= 0 ? String(row[i] || '').trim() : '';
    };
    const company = get('company');
    const title = get('title');
    if (!company && !title) {
      // only count rows that hold something besides a status, so template rows stay quiet
      if (mapping.some((f, i) => f && f !== 'status' && String(row[i] || '').trim())) empty += 1;
      continue;
    }
    const appliedAt = parseDateLoose(get('appliedAt'));
    const savedAt = parseDateLoose(get('savedAt')) || appliedAt || today();
    const statusText = get('status');
    let status = statusText && statusMap[statusText] ? statusMap[statusText] : '';
    if (!status) status = appliedAt ? appliedId : firstId;
    if (!columns.some((c) => c.id === status)) status = firstId;
    const kind = kindOf(status);

    const interviewText = get('interview');
    const interviewAt = parseDateLoose(interviewText);
    const rawUrl = get('url');
    // meeting links are not the posting
    const isUrl = /^(https?:\/\/|www\.)/i.test(rawUrl) && !MEETING.test(rawUrl);

    const draft = {
      company, title,
      location: get('location'),
      url: isUrl ? rawUrl.replace(/^www\./i, 'https://www.') : '',
      workload: workloadFrom(get('workload')),
      workModel: workModelFrom(get('workModel')),
      contactName: get('contactName'),
      contactEmail: get('contactEmail'),
      contactPhone: get('contactPhone'),
      notes: [get('notes'), rawUrl && !isUrl ? rawUrl : ''].filter(Boolean).join('\n'),
      description: get('description'),
      source: canonicalSource(get('source'), company) || sourceLabel,
      status,
      savedAt,
      // no date in the file: leave it empty instead of pretending it was sent today
      appliedAt,
    };
    const keyA = normalizeUrl(draft.url);
    const keyB = `${comparable(company)}|${comparable(title)}`;
    if ((keyA && seen.has(keyA)) || seen.has(keyB)) { duplicates += 1; continue; }
    if (keyA) seen.add(keyA);
    seen.add(keyB);

    const job = createJob(draft, columns);
    job.appliedAt = appliedAt;
    // History for the statistics. Steps whose date the file does not give are marked
    // as estimated, so they count in the Sankey but not in timing figures.
    const start = appliedAt ? noon(appliedAt) : importedAt;
    const undated = !appliedAt;
    if (status === firstId) {
      job.history = [{ status, at: noon(savedAt) }];
    } else {
      const history = [{ status: appliedId, at: start, ...(undated ? { estimated: true } : {}) }];
      let last = start;
      const hadInterview = interviewText && interviewId && ['interview', 'offer', 'rejected', 'other'].includes(kind);
      if (hadInterview) {
        const at = interviewAt ? noon(interviewAt) : start;
        const step = kind === 'interview' ? status : interviewId;
        history.push({ status: step, at, ...(interviewAt ? {} : { estimated: true }) });
        if (at > last) last = at;
      }
      if (status !== appliedId && !(hadInterview && kind === 'interview')) {
        history.push({ status, at: last, estimated: true });
      }
      job.history = history;
    }
    // "Second Round" -> two rounds; the last one carries the date or the text
    if (interviewText) {
      const n = roundCount(interviewText);
      job.interviews = Array.from({ length: n }, (_, i) => ({
        id: `${job.id}-r${i + 1}`,
        date: i === n - 1 ? interviewAt : '',
        time: '',
        kind: '',
        note: i === n - 1 && !interviewAt ? interviewText : '',
      }));
    }
    job.createdAt = Date.parse(appliedAt ? start : noon(savedAt)) || job.createdAt;
    job.imported = true;
    jobs.push(job);
  }
  return { jobs, duplicates, empty };
}
