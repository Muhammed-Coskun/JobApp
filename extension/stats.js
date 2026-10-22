// Statistics tab: where your applications ended up (Sankey), key numbers,
// applications per week and per source. Everything is computed locally.
import { t, plural } from './lib/i18n.js';
import {
  parseIso, isoDate, today, downloadFile, formatDate, interviewDepth, roundLabel,
} from './lib/store.js';
import { escapeHtml } from './lib/form.js';

const RANGES = [
  { id: 'all', days: Infinity, key: 'rangeAll' },
  { id: '30', days: 30, key: 'range30' },
  { id: '90', days: 90, key: 'range90' },
  { id: '365', days: 365, key: 'range365' },
];
let range = 'all';
let lastState = null;
let lastFunnel = null;

// ---------- data ----------

const MAX_ROUNDS = 4;

function kindOf(columns, id) {
  const c = columns.find((x) => x.id === id);
  return c ? c.kind : '';
}

// Date the application was sent: the explicit date, else the first move out of the wishlist.
// Estimated steps (imported rows without a date) have no real date and are left out.
function appliedDate(job, columns) {
  if (job.appliedAt) return job.appliedAt;
  const h = (job.history || []).find((e) => !e.estimated && kindOf(columns, e.status) && kindOf(columns, e.status) !== 'wishlist');
  return h ? isoDate(new Date(h.at)) : '';
}

function isApplied(job, columns) {
  if (job.appliedAt) return true;
  const visited = new Set([job.status, ...(job.history || []).map((h) => h.status)]);
  return [...visited].some((s) => {
    const k = kindOf(columns, s);
    return k && k !== 'wishlist';
  });
}

// When the job reached its current column, if that is known.
function outcomeDate(job) {
  const h = [...(job.history || [])].reverse().find((e) => e.status === job.status);
  return h && !h.estimated ? isoDate(new Date(h.at)) : '';
}

export function computeFunnel(allJobs, columns, days = Infinity) {
  const cutoff = Number.isFinite(days) ? isoDate(new Date(Date.now() - days * 86400000)) : '';
  const jobs = allJobs.filter((j) => isApplied(j, columns) && (!cutoff || appliedDate(j, columns) >= cutoff));
  const offerName = (columns.find((c) => c.kind === 'offer') || {}).name || t('kind_offer');
  const rejectedName = (columns.find((c) => c.kind === 'rejected') || {}).name || t('kind_rejected');

  const nodes = new Map();
  const node = (id, label, kind, tip) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind, tip: tip || label });
    return id;
  };
  const links = new Map();
  const link = (a, b) => {
    const k = `${a}>${b}`;
    links.set(k, { source: a, target: b, value: (links.get(k)?.value || 0) + 1 });
  };
  // Every outcome sits right after the last step a job reached ("rejected after
  // interview 1" is its own node), so no band has to cross a column.
  const after = (depth) => (depth ? t('sankeyAfterRound', roundLabel(depth)) : t('sankeyAfterApplication'));

  const root = node('applied', t('sankeyApplied'), 'root');
  let responded = 0;
  let interviewed = 0;
  let offers = 0;
  const responseDays = [];
  const details = [];

  for (const job of jobs) {
    const realDepth = interviewDepth(job, columns);
    const depth = Math.min(realDepth, MAX_ROUNDS);
    const visited = new Set([job.status, ...(job.history || []).map((h) => h.status)]);
    const reachedOffer = [...visited].some((s) => kindOf(columns, s) === 'offer');
    const cur = kindOf(columns, job.status);

    const path = [root];
    for (let i = 1; i <= depth; i += 1) {
      const label = i === MAX_ROUNDS && realDepth > MAX_ROUNDS ? `${roundLabel(i)}+` : roundLabel(i);
      path.push(node(`round:${i}`, label, 'stage'));
    }
    let terminal;
    let outcome;
    if (cur === 'offer') {
      outcome = 'offer';
      terminal = node(`offer@${depth}`, offerName, 'offer', `${offerName} ${after(depth)}`);
    } else if (cur === 'rejected') {
      outcome = 'rejected';
      terminal = node(`rejected@${depth}`, rejectedName, 'rejected', `${rejectedName} ${after(depth)}`);
    } else if (cur === 'other') {
      const col = columns.find((c) => c.id === job.status);
      outcome = `other:${col.id}`;
      terminal = node(`other:${col.id}@${depth}`, col.name, 'other', `${col.name} ${after(depth)}`);
    } else if (depth > 0 || cur === 'interview' || reachedOffer) {
      outcome = 'active';
      terminal = node(`active@${depth}`, t('sankeyActive'), 'active', `${t('sankeyActive')} ${after(depth)}`);
    } else {
      outcome = 'noReply';
      terminal = node('noReply', t('sankeyNoReply'), 'noReply');
    }
    if (reachedOffer && cur !== 'offer') path.push(node(`offer@${depth}`, offerName, 'offer', `${offerName} ${after(depth)}`));
    path.push(terminal);
    for (let i = 0; i < path.length - 1; i += 1) link(path[i], path[i + 1]);

    const gotResponse = depth > 0 || reachedOffer || cur === 'rejected';
    if (gotResponse) responded += 1;
    if (depth > 0 || reachedOffer) interviewed += 1;
    if (reachedOffer) offers += 1;
    const start = parseIso(appliedDate(job, columns));
    if (gotResponse && start) {
      const firstMove = (job.history || []).find((h) => ['interview', 'offer', 'rejected'].includes(kindOf(columns, h.status)));
      // imported jobs only know their current state, not when the reply came
      if (firstMove && !firstMove.estimated) {
        const d = Math.round((parseIso(isoDate(new Date(firstMove.at))) - start) / 86400000);
        if (d >= 0 && d < 400) responseDays.push(d);
      }
    }
    details.push({ job, depth: realDepth, outcome, outcomeName: nodes.get(terminal).label, outcomeAt: outcome === 'active' || outcome === 'noReply' ? '' : outcomeDate(job), appliedAt: appliedDate(job, columns) });
  }

  return {
    jobs,
    details,
    total: jobs.length,
    nodes: [...nodes.values()],
    links: [...links.values()],
    kpis: {
      applications: jobs.length,
      responseRate: jobs.length ? responded / jobs.length : null,
      interviewRate: jobs.length ? interviewed / jobs.length : null,
      offers,
      avgDays: responseDays.length ? Math.round(responseDays.reduce((a, b) => a + b, 0) / responseDays.length) : null,
    },
  };
}

// ---------- text measuring (labels must never be cut off) ----------

let measureCtx = null;
function textWidth(text, size, weight, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${size}px ${font}`;
  return measureCtx.measureText(String(text)).width;
}

// ---------- Sankey layout ----------

// top to bottom inside a column; the next interview round goes last, so the
// flow that continues runs along the bottom edge
const ORDER = { root: 0, noReply: 1, active: 2, offer: 3, other: 4, rejected: 5, stage: 6 };
const LABEL_H = 36;

function layoutSankey(funnel, width, height, { nodeW = 14, pad = 14, left = 120, right = 170 } = {}) {
  const nodes = funnel.nodes.map((n) => ({ ...n, in: [], out: [] }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = funnel.links.map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) }));
  links.forEach((l) => { l.s.out.push(l); l.t.in.push(l); });
  nodes.forEach((n) => {
    n.value = Math.max(n.in.reduce((a, l) => a + l.value, 0), n.out.reduce((a, l) => a + l.value, 0));
  });
  const depth = new Map();
  const visit = (n, d) => {
    if ((depth.get(n.id) ?? -1) >= d) return;
    depth.set(n.id, d);
    n.out.forEach((l) => visit(l.t, d + 1));
  };
  nodes.filter((n) => !n.in.length).forEach((n) => visit(n, 0));
  const maxDepth = Math.max(0, ...depth.values());
  nodes.forEach((n) => { n.depth = depth.get(n.id) || 0; });

  const layers = [];
  nodes.forEach((n) => { (layers[n.depth] = layers[n.depth] || []).push(n); });
  layers.forEach((layer) => layer.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || b.value - a.value));
  const innerW = Math.max(40, width - left - right - nodeW);
  const ky = Math.min(...layers.filter(Boolean).map((layer) => (height - (layer.length - 1) * pad) / layer.reduce((a, n) => a + n.value, 0)));
  const slot = (n) => Math.max(n.h, LABEL_H);
  layers.forEach((layer) => {
    if (!layer) return;
    layer.forEach((n) => { n.h = Math.max(3, n.value * ky); });
    const total = layer.reduce((a, n) => a + n.h, 0) + (layer.length - 1) * pad;
    let y = (height - total) / 2;
    layer.forEach((n) => {
      n.x = left + (maxDepth ? (n.depth / maxDepth) * innerW : 0);
      n.y = y;
      y += n.h + pad;
    });
  });
  const offsets = () => {
    nodes.forEach((n) => {
      let sy = n.y;
      n.out.sort((a, b) => a.t.y - b.t.y).forEach((l) => { l.sy = sy; l.w = l.value * ky; sy += l.w; });
      let ty = n.y;
      n.in.sort((a, b) => a.s.y - b.s.y).forEach((l) => { l.ty = ty; ty += l.value * ky; });
    });
  };
  offsets();
  // Columns after the first: put each node where its bands arrive, so they run
  // straight, then push nodes apart until every label has room.
  for (let pass = 0; pass < 4; pass += 1) {
    for (let d = 1; d <= maxDepth; d += 1) {
      const layer = layers[d];
      if (!layer) continue;
      layer.forEach((n) => {
        const w = n.in.reduce((a, l) => a + l.w, 0);
        if (w) n.y = n.in.reduce((a, l) => a + l.sy * l.w, 0) / w;
      });
      layer.sort((a, b) => a.y - b.y);
      let floor = 0;
      layer.forEach((n) => {
        const top = n.y + n.h / 2 - slot(n) / 2;
        if (top < floor) n.y += floor - top;
        floor = n.y + n.h / 2 + slot(n) / 2 + 4;
      });
      let ceiling = height;
      for (let i = layer.length - 1; i >= 0; i -= 1) {
        const n = layer[i];
        const bottom = n.y + n.h / 2 + slot(n) / 2;
        if (bottom > ceiling) n.y -= bottom - ceiling;
        ceiling = n.y + n.h / 2 - slot(n) / 2 - 4;
      }
      layer.forEach((n) => { n.y = Math.max(0, Math.min(height - n.h, n.y)); });
    }
    offsets();
  }
  return { nodes, links, nodeW, maxDepth };
}

function bandPath(l, nodeW) {
  const x0 = l.s.x + nodeW;
  const x1 = l.t.x;
  const xm = (x0 + x1) / 2;
  const w = Math.max(1, l.w);
  return `M${x0},${l.sy} C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty} L${x1},${l.ty + w} C${xm},${l.ty + w} ${xm},${l.sy + w} ${x0},${l.sy + w} Z`;
}

function sankeySvg(funnel, width, height, colors, { forExport = false, title = '', footer = '' } = {}) {
  const top = forExport ? 70 : 10;
  const bottom = forExport ? 46 : 10;
  const total = funnel.total || 1;
  const pct = (v) => `${Math.round((v / total) * 100)} %`;
  const font = colors.font;
  const sub = (n) => (n.kind === 'root' ? String(n.value) : `${n.value} (${pct(n.value)})`);
  const labelW = (n) => Math.max(textWidth(n.label, 13, 700, font), textWidth(sub(n), 12, 400, font));
  // margins from the real label widths, so nothing is cut off at the edges
  const sum = (list) => list.reduce((a, l) => a + l.value, 0);
  const valueOf = (id) => Math.max(sum(funnel.links.filter((l) => l.target === id)), sum(funnel.links.filter((l) => l.source === id)));
  const rootNode = funnel.nodes.find((n) => n.kind === 'root');
  const terminals = funnel.nodes.filter((n) => !funnel.links.some((l) => l.source === n.id));
  const left = Math.ceil(labelW({ ...rootNode, value: total }) + 24);
  const right = Math.ceil(Math.max(90, ...terminals.map((n) => labelW({ ...n, value: valueOf(n.id) }))) + 26);
  const lay = layoutSankey(funnel, width, height - top - bottom, { left, right });
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(t('sankeyTitle'))}">`);
  if (forExport) {
    parts.push(`<rect width="${width}" height="${height}" fill="${colors.surface}"/>`);
    parts.push(`<text x="${width / 2}" y="44" text-anchor="middle" font-family="${font}" font-size="26" font-weight="700" fill="${colors.ink}">${escapeHtml(title)}</text>`);
    parts.push(`<text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-family="${font}" font-size="12" fill="${colors.muted}">${escapeHtml(footer)}</text>`);
  }
  parts.push(`<g transform="translate(0 ${top})">`);
  for (const l of lay.links) {
    parts.push(`<path class="sk-link" data-tip="${escapeHtml(`${l.s.tip} → ${l.t.tip}: ${l.value}`)}" d="${bandPath(l, lay.nodeW)}" fill="${colors[l.t.kind]}" fill-opacity="${colors.linkOpacity}"/>`);
  }
  for (const n of lay.nodes) {
    parts.push(`<rect class="sk-node" data-tip="${escapeHtml(`${n.tip}: ${n.value} (${pct(n.value)})`)}" x="${n.x}" y="${n.y}" width="${lay.nodeW}" height="${n.h}" rx="2" fill="${colors[n.kind]}"/>`);
  }
  for (const n of lay.nodes) {
    const isRoot = n.kind === 'root';
    const passes = n.out.length > 0 && !isRoot;
    // root and interview rounds: label on the left; outcomes: on the right
    const toLeft = isRoot || passes;
    const anchor = toLeft ? 'end' : 'start';
    const x = toLeft ? n.x - 8 : n.x + lay.nodeW + 8;
    const cy = n.y + n.h / 2;
    const w = labelW(n);
    if (!isRoot) {
      // labels can sit on top of bands: give them a backing plate
      const px = toLeft ? x - w - 5 : x - 5;
      parts.push(`<rect x="${px}" y="${cy - 18}" width="${w + 10}" height="36" rx="5" fill="${colors.surface}" fill-opacity="0.9"/>`);
    }
    parts.push(`<text x="${x}" y="${cy - 3}" text-anchor="${anchor}" font-family="${font}" font-size="13" font-weight="700" fill="${colors.ink}">${escapeHtml(n.label)}</text>`);
    parts.push(`<text x="${x}" y="${cy + 13}" text-anchor="${anchor}" font-family="${font}" font-size="12" fill="${colors.muted}" font-variant-numeric="tabular-nums">${escapeHtml(sub(n))}</text>`);
  }
  parts.push('</g></svg>');
  return parts.join('');
}

function themeColors(root) {
  const cs = getComputedStyle(root);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    root: v('--sk-root'), stage: v('--sk-stage'), active: v('--sk-active'), offer: v('--sk-offer'),
    rejected: v('--sk-rejected'), noReply: v('--sk-noreply'), other: v('--sk-other'),
    linkOpacity: v('--sk-link-opacity') || '0.35',
    series: [1, 2, 3, 4, 5].map((i) => v(`--series-${i}`)), seriesOther: v('--series-other'),
    surface: v('--surface'), ink: v('--ink'), muted: v('--muted'),
    font: cs.fontFamily.replace(/"/g, "'"),
  };
}

// ---------- pie chart ----------

function statusSlices(funnel, colors) {
  const order = ['noReply', 'active', 'offer', 'rejected'];
  const counts = new Map();
  for (const d of funnel.details) {
    const key = d.outcome.startsWith('other:') ? d.outcome : d.outcome;
    const e = counts.get(key) || { key, name: d.outcomeName, count: 0 };
    e.count += 1;
    counts.set(key, e);
  }
  const kindColor = (key) => (key.startsWith('other:') ? colors.other : colors[key]);
  return [...counts.values()]
    .sort((a, b) => ((order.indexOf(a.key) + 1 || 9) - (order.indexOf(b.key) + 1 || 9)) || b.count - a.count)
    .map((e) => ({ ...e, color: kindColor(e.key) }));
}

function sourceSlices(funnel, colors) {
  return sourcesData(funnel, lastState.columns).map((s, i, all) => ({
    key: s.name,
    name: s.name,
    count: s.count,
    // fixed order, the folded rest is neutral
    color: s.other ? colors.seriesOther : colors.series[i] || colors.seriesOther,
  }));
}

function donutSvg(slices, size, colors) {
  const total = slices.reduce((a, s) => a + s.count, 0);
  const c = size / 2;
  const R = size / 2 - 2;
  const r = R * 0.62;
  const parts = [`<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(t('pieTitle'))}">`];
  if (!total) return '';
  const point = (a, rad) => [c + rad * Math.sin(a), c - rad * Math.cos(a)];
  let a0 = 0;
  for (const s of slices) {
    const share = s.count / total;
    const a1 = a0 + share * Math.PI * 2;
    const tip = `${s.name}: ${s.count} (${Math.round(share * 100)} %)`;
    if (share >= 0.9999) {
      parts.push(`<circle class="pie-slice" data-tip="${escapeHtml(tip)}" cx="${c}" cy="${c}" r="${(R + r) / 2}" fill="none" stroke="${s.color}" stroke-width="${R - r}"/>`);
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = point(a0, R);
      const [x1, y1] = point(a1, R);
      const [x2, y2] = point(a1, r);
      const [x3, y3] = point(a0, r);
      // a 2px gap in the surface colour between slices
      parts.push(`<path class="pie-slice" data-tip="${escapeHtml(tip)}" d="M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z" fill="${s.color}" stroke="${colors.surface}" stroke-width="2" stroke-linejoin="round"/>`);
    }
    a0 = a1;
  }
  parts.push(`<text x="${c}" y="${c + 2}" text-anchor="middle" font-family="${colors.font}" font-size="26" font-weight="700" fill="${colors.ink}">${total}</text>`);
  parts.push(`<text x="${c}" y="${c + 20}" text-anchor="middle" font-family="${colors.font}" font-size="12" fill="${colors.muted}">${escapeHtml(t('sankeyApplied'))}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

let pieMode = 'status';

function renderPie(container, funnel, colors) {
  const box = container.querySelector('#pie');
  const slices = pieMode === 'status' ? statusSlices(funnel, colors) : sourceSlices(funnel, colors);
  const total = slices.reduce((a, s) => a + s.count, 0);
  if (!total) {
    box.innerHTML = `<p class="viz-empty">${escapeHtml(t('statsEmptyShort'))}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="pie-chart">${donutSvg(slices, 188, colors)}</div>
    <ul class="pie-legend">${slices.map((s) => `
      <li data-tip="${escapeHtml(`${s.name}: ${s.count} (${Math.round((s.count / total) * 100)} %)`)}">
        <span class="swatch" style="background:${escapeHtml(s.color)}"></span>
        <span class="pie-name">${escapeHtml(s.name)}</span>
        <span class="pie-val"><strong>${s.count}</strong> ${Math.round((s.count / total) * 100)} %</span>
      </li>`).join('')}</ul>`;
}

// ---------- interviews in detail ----------

function interviewRows(funnel) {
  const fmt = (iso) => (iso ? formatDate(iso) : t('historyNoDate'));
  const rows = funnel.details.filter((d) => d.depth > 0)
    .map((d) => {
      const rounds = (d.job.interviews || []).slice();
      while (rounds.length < d.depth) rounds.push({ date: '' });
      const last = [d.outcomeAt, ...rounds.map((r) => r.date), d.appliedAt].filter(Boolean).sort().pop() || '';
      return { ...d, rounds, last };
    })
    .sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  if (!rows.length) return `<p class="viz-empty">${escapeHtml(t('ivEmpty'))}</p>`;
  return `<ul class="iv-list">${rows.map((d) => {
    const steps = [
      `<li class="iv-step applied"><span>${escapeHtml(t('ivApplied'))}</span><time>${escapeHtml(fmt(d.appliedAt))}</time></li>`,
      ...d.rounds.map((r, i) => {
        const planned = r.date && r.date > today();
        return `<li class="iv-step round${planned ? ' planned' : ''}"${planned ? ` title="${escapeHtml(t('roundPlanned', roundLabel(i + 1), formatDate(r.date)))}"` : ''}><span>${escapeHtml(roundLabel(i + 1))}</span><time>${escapeHtml(fmt(r.date))}${planned && r.time ? ` ${escapeHtml(r.time)}` : ''}</time></li>`;
      }),
    ];
    const kind = d.outcome.startsWith('other:') ? 'other' : d.outcome;
    const spanDays = d.outcomeAt && d.appliedAt ? Math.round((parseIso(d.outcomeAt) - parseIso(d.appliedAt)) / 86400000) : null;
    steps.push(`<li class="iv-step ${escapeHtml(kind)}"><span>${escapeHtml(d.outcomeName)}</span>${kind === 'active' ? '' : `<time>${escapeHtml(fmt(d.outcomeAt))}</time>`}</li>`);
    return `<li class="iv-row">
      <a class="iv-head" href="#job=${encodeURIComponent(d.job.id)}">
        <strong>${escapeHtml(d.job.company || t('unknownCompany'))}</strong>
        <span>${escapeHtml(d.job.title || '')}</span>
        ${spanDays != null && spanDays >= 0 ? `<em>${escapeHtml(plural(spanDays, 'daysOne', 'daysMany'))}</em>` : ''}
      </a>
      <ol class="iv-steps">${steps.join('')}</ol>
    </li>`;
  }).join('')}</ul>`;
}

// ---------- weekly bars ----------

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - yearStart) / 86400000 + 1) / 7);
}

function weeklyData(funnel, columns, days) {
  const dates = funnel.jobs.map((j) => parseIso(appliedDate(j, columns))).filter(Boolean);
  const now = mondayOf(new Date());
  let weeks = Number.isFinite(days) ? Math.ceil(days / 7) : 12;
  if (!Number.isFinite(days) && dates.length) {
    const first = mondayOf(new Date(Math.min(...dates)));
    weeks = Math.round((now - first) / (7 * 86400000)) + 1;
  }
  weeks = Math.max(4, Math.min(52, weeks));
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = new Date(now);
    start.setDate(start.getDate() - i * 7);
    buckets.push({ start, week: isoWeek(start), count: 0 });
  }
  for (const d of dates) {
    const m = mondayOf(d).getTime();
    const b = buckets.find((x) => x.start.getTime() === m);
    if (b) b.count += 1;
  }
  return buckets;
}

function weeklySvg(buckets, width, height) {
  const padL = 30;
  const padB = 24;
  const padT = 14;
  const innerW = width - padL - 6;
  const innerH = height - padB - padT;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const slot = innerW / buckets.length;
  const bw = Math.min(24, slot * 0.68);
  const fmt = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { day: '2-digit', month: '2-digit' });
  const parts = [`<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(t('weeklyTitle'))}">`];
  for (let v = 0; v <= top; v += step) {
    const y = padT + innerH - (v / top) * innerH;
    parts.push(`<line x1="${padL}" x2="${width - 4}" y1="${y}" y2="${y}" class="grid"/>`);
    parts.push(`<text x="${padL - 6}" y="${y + 4}" text-anchor="end" class="tick">${v}</text>`);
  }
  const labelEvery = Math.ceil(buckets.length / 8);
  buckets.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const h = (b.count / top) * innerH;
    const y = padT + innerH - h;
    const tip = t('weeklyTip', t('weekLabel', String(b.week)), fmt.format(b.start), String(b.count));
    // hit area is the whole slot, bigger than the bar
    parts.push(`<rect class="hit" data-tip="${escapeHtml(tip)}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${innerH}" fill="transparent"/>`);
    if (b.count) {
      const r = Math.min(4, bw / 2, h);
      parts.push(`<path class="bar" d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z"/>`);
    }
    if (i % labelEvery === 0 || i === buckets.length - 1) {
      parts.push(`<text x="${padL + i * slot + slot / 2}" y="${height - 6}" text-anchor="middle" class="tick">${escapeHtml(t('weekLabel', String(b.week)))}</text>`);
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

// ---------- sources ----------

function sourcesData(funnel, columns) {
  const map = new Map();
  for (const j of funnel.jobs) {
    const key = j.source || t('sourceManual');
    const e = map.get(key) || { name: key, count: 0, interviews: 0 };
    e.count += 1;
    const visited = new Set([j.status, ...(j.history || []).map((h) => h.status)]);
    if (interviewDepth(j, columns) > 0 || [...visited].some((s) => kindOf(columns, s) === 'offer')) e.interviews += 1;
    map.set(key, e);
  }
  const list = [...map.values()].sort((a, b) => b.count - a.count);
  if (list.length > 6) {
    const rest = list.splice(5);
    list.push(rest.reduce((a, e) => ({ ...a, count: a.count + e.count, interviews: a.interviews + e.interviews }), { name: t('otherSources'), count: 0, interviews: 0, other: true }));
  }
  return list;
}

// ---------- render ----------

const pctText = (v) => (v == null ? '–' : `${Math.round(v * 100)} %`);

export function renderStats(container, state) {
  lastState = state;
  const r = RANGES.find((x) => x.id === range) || RANGES[0];
  const funnel = computeFunnel(state.jobs, state.columns, r.days);
  lastFunnel = funnel;
  const k = funnel.kpis;
  const rangeButtons = RANGES.map((x) => `<button type="button" role="radio" aria-checked="${x.id === range}" data-range="${x.id}">${escapeHtml(t(x.key))}</button>`).join('');

  container.innerHTML = `
    <div class="stats-inner">
      <div class="stats-toolbar">
        <div class="range" role="radiogroup" aria-label="${escapeHtml(t('statsRange'))}">${rangeButtons}</div>
        <div class="stats-actions">
          <button type="button" class="btn" id="copySankey" ${funnel.total ? '' : 'disabled'}>${escapeHtml(t('copySankeymatic'))}</button>
          <button type="button" class="btn" id="exportPng" ${funnel.total ? '' : 'disabled'}>${escapeHtml(t('exportPng'))}</button>
        </div>
      </div>
      <div class="kpis">
        ${tile(t('kpiApplications'), String(k.applications))}
        ${tile(t('kpiResponseRate'), pctText(k.responseRate))}
        ${tile(t('kpiInterviewRate'), pctText(k.interviewRate))}
        ${tile(t('kpiOffers'), String(k.offers))}
        ${tile(t('kpiAvgDays'), k.avgDays == null ? '–' : plural(k.avgDays, 'daysOne', 'daysMany'))}
      </div>
      <section class="panel sankey-panel">
        <header><h2>${escapeHtml(t('sankeyTitle'))}</h2><p>${escapeHtml(t('sankeySubtitle'))}</p></header>
        <div class="sankey" id="sankey"></div>
        <details class="table-view">
          <summary>${escapeHtml(t('showTable'))}</summary>
          <table><thead><tr><th>${escapeHtml(t('tableFrom'))}</th><th>${escapeHtml(t('tableTo'))}</th><th class="num">${escapeHtml(t('tableCount'))}</th></tr></thead>
          <tbody>${funnel.links.map((l) => {
            const a = funnel.nodes.find((n) => n.id === l.source);
            const b = funnel.nodes.find((n) => n.id === l.target);
            return `<tr><td>${escapeHtml(a.tip)}</td><td>${escapeHtml(b.tip)}</td><td class="num">${l.value}</td></tr>`;
          }).join('')}</tbody></table>
        </details>
      </section>
      <div class="stats-grid stats-grid-2">
        <section class="panel">
          <header class="panel-head-row">
            <div><h2>${escapeHtml(t('pieTitle'))}</h2><p>${escapeHtml(t(pieMode === 'status' ? 'pieSubtitleStatus' : 'pieSubtitleSource'))}</p></div>
            <div class="range small" role="radiogroup" aria-label="${escapeHtml(t('pieTitle'))}">
              <button type="button" role="radio" aria-checked="${pieMode === 'status'}" data-pie="status">${escapeHtml(t('pieByStatus'))}</button>
              <button type="button" role="radio" aria-checked="${pieMode === 'source'}" data-pie="source">${escapeHtml(t('pieBySource'))}</button>
            </div>
          </header>
          <div class="pie" id="pie"></div>
        </section>
        <section class="panel">
          <header><h2>${escapeHtml(t('ivTitle'))}</h2><p>${escapeHtml(t('ivSubtitle'))}</p></header>
          <div class="iv" id="interviews">${interviewRows(funnel)}</div>
        </section>
      </div>
      <div class="stats-grid">
        <section class="panel">
          <header><h2>${escapeHtml(t('weeklyTitle'))}</h2><p>${escapeHtml(t('weeklySubtitle'))}</p></header>
          <div class="weekly" id="weekly"></div>
        </section>
        <section class="panel">
          <header><h2>${escapeHtml(t('sourcesTitle'))}</h2><p>${escapeHtml(t('sourcesSubtitle'))}</p></header>
          <div class="sources" id="sources"></div>
        </section>
      </div>
      <div class="viz-tip" id="vizTip" role="tooltip" hidden></div>
    </div>`;

  container.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range;
    renderStats(container, lastState);
  }));
  container.querySelectorAll('[data-pie]').forEach((b) => b.addEventListener('click', () => {
    pieMode = b.dataset.pie;
    renderStats(container, lastState);
  }));
  container.querySelector('#exportPng').addEventListener('click', () => exportPng(container));
  container.querySelector('#copySankey').addEventListener('click', (e) => copySankeymatic(e.currentTarget));

  const sankeyBox = container.querySelector('#sankey');
  if (!funnel.total) {
    sankeyBox.innerHTML = `<p class="viz-empty">${escapeHtml(t('statsEmpty'))}</p>`;
  } else {
    const w = Math.max(560, sankeyBox.clientWidth || 900);
    sankeyBox.innerHTML = sankeySvg(funnel, w, sankeyHeight(funnel, 300, 520), themeColors(container));
  }
  renderPie(container, funnel, themeColors(container));

  const weeklyBox = container.querySelector('#weekly');
  weeklyBox.innerHTML = weeklySvg(weeklyData(funnel, state.columns, r.days), Math.max(320, weeklyBox.clientWidth || 480), 220);

  const sources = sourcesData(funnel, state.columns);
  const smax = Math.max(1, ...sources.map((s) => s.count));
  container.querySelector('#sources').innerHTML = sources.length
    ? `<ul>${sources.map((s) => `
        <li data-tip="${escapeHtml(t('sourceTip', s.name, String(s.count), String(s.interviews)))}">
          <span class="src-name">${escapeHtml(s.name)}</span>
          <span class="src-track"><span class="src-bar" style="width:${(s.count / smax) * 100}%"></span></span>
          <span class="src-val"><strong>${s.count}</strong> ${escapeHtml(plural(s.interviews, 'interviewsOne', 'interviewsMany'))}</span>
        </li>`).join('')}</ul>`
    : `<p class="viz-empty">${escapeHtml(t('statsEmptyShort'))}</p>`;

  bindTooltips(container);
}

// tall enough that the busiest column has room for all its labels
function sankeyHeight(funnel, min, max) {
  const depth = new Map([['applied', 0]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const l of funnel.links) {
      const d = (depth.get(l.source) ?? 0) + 1;
      if ((depth.get(l.target) ?? -1) < d) { depth.set(l.target, d); changed = true; }
    }
  }
  const perDepth = new Map();
  depth.forEach((d) => perDepth.set(d, (perDepth.get(d) || 0) + 1));
  const busiest = Math.max(1, ...perDepth.values());
  return Math.max(min, Math.min(max, 120 + busiest * 70));
}

function tile(label, value) {
  return `<div class="kpi"><p class="kpi-label">${escapeHtml(label)}</p><p class="kpi-value">${escapeHtml(value)}</p></div>`;
}

function bindTooltips(container) {
  const tip = container.querySelector('#vizTip');
  const inner = container.querySelector('.stats-inner');
  container.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      const box = inner.getBoundingClientRect();
      let x = e.clientX - box.left + 14;
      const y = e.clientY - box.top + 14;
      if (x + tip.offsetWidth > box.width) x = e.clientX - box.left - tip.offsetWidth - 14;
      tip.style.transform = `translate(${x}px, ${y}px)`;
      el.classList.add('hover');
    });
    el.addEventListener('pointerleave', () => { tip.hidden = true; el.classList.remove('hover'); });
  });
}

// ---------- exports ----------

function sankeymaticText(funnel) {
  // SankeyMATIC joins nodes with the same name, so use the unique long names
  const label = (id) => funnel.nodes.find((n) => n.id === id).tip;
  return funnel.links.map((l) => `${label(l.source)} [${l.value}] ${label(l.target)}`).join('\n');
}

async function copySankeymatic(button) {
  if (!lastFunnel || !lastFunnel.total) return;
  try {
    await navigator.clipboard.writeText(sankeymaticText(lastFunnel));
    const old = button.textContent;
    button.textContent = t('copied');
    setTimeout(() => { button.textContent = old; }, 1600);
  } catch (err) {
    console.error(err);
  }
}

async function exportPng(container) {
  if (!lastFunnel || !lastFunnel.total) return;
  const width = 1200;
  const height = sankeyHeight(lastFunnel, 560, 820) + 116;
  const svg = sankeySvg(lastFunnel, width, height, themeColors(container), {
    forExport: true,
    title: t('pngTitle'),
    footer: t('pngFooter', String(lastFunnel.total), today()),
  });
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    downloadFile(`bewerbungen-sankey-${today()}.png`, blob, 'image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
