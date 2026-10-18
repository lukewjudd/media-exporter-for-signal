#!/usr/bin/env node
// Build dashboard.html from signal.duckdb: where Signal's media storage goes,
// by chat, month and file. Self-contained; open it straight from disk.
//
// Usage: node src/dashboard.mjs [dbPath] [outPath]

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DATA } from './lib.mjs';

const dbPath = resolve(process.argv[2] ?? join(DATA, 'signal.duckdb'));
const outPath = resolve(process.argv[3] ?? join(DATA, 'dashboard.html'));

const db = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
const con = await db.connect();
const rows = async sql => (await con.runAndReadAll(sql)).getRowObjectsJson();
const SERIES = `CASE WHEN category IN ('image', 'gif') THEN 'photo' WHEN category = 'video' THEN 'video' ELSE 'other' END`;

const data = {
  generated: new Date().toISOString(),
  backupDate: (await rows(`SELECT max(sent_at)::VARCHAR d FROM messages`))[0].d,
  chats: await rows(`SELECT chat_id, name, kind, messages, files, bytes, phone_bytes FROM chat_storage WHERE bytes > 0 OR messages > 0`),
  // chat × month × series, counting each stored file once
  cells: await rows(`
    SELECT chat_id, strftime(sent_at, '%Y-%m') ym, ${SERIES} s, on_phone p,
           sum(size_bytes) b, count(*) n, sum(size_bytes) FILTER (WHERE in_archive) ab
    FROM attachments WHERE NOT duplicate GROUP BY ALL`),
  big: await rows(`
    SELECT chat_id, size_bytes b, ${SERIES} s, content_type ct, sender, strftime(sent_at, '%Y-%m-%d') d,
           strftime(sent_at, '%Y-%m') ym, archive_path p, in_archive a, on_phone ph, file_name f, plaintext_hash h
    FROM attachments WHERE NOT duplicate ORDER BY size_bytes DESC LIMIT 2000`),
  buckets: await rows(`
    SELECT CASE WHEN size_bytes >= 10e6 THEN 3 WHEN size_bytes >= 1e6 THEN 2 WHEN size_bytes >= 100e3 THEN 1 ELSE 0 END k,
           count(*) n, sum(size_bytes) b
    FROM attachments WHERE NOT duplicate GROUP BY 1 ORDER BY 1`),
};
con.closeSync();
db.closeSync();

// Numbers come back from DuckDB as strings; make them numbers once here
for (const c of data.chats) for (const k of ['chat_id', 'messages', 'files', 'bytes', 'phone_bytes']) c[k] = Number(c[k]);
for (const c of data.cells) { for (const k of ['chat_id', 'b', 'n', 'ab']) c[k] = Number(c[k] ?? 0); c.p = c.p === true || c.p === 'true'; }
for (const f of data.big) { f.chat_id = Number(f.chat_id); f.b = Number(f.b); f.ph = f.ph === true || f.ph === 'true'; f.a = f.a === true || f.a === 'true'; }
for (const b of data.buckets) { b.k = Number(b.k); b.n = Number(b.n); b.b = Number(b.b); }

// ---------------------------------------------------------------------------
const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signal Storage</title>
<style>
:root{color-scheme:light;
  --page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
  --photo:#2a78d6;--video:#eb6834;--other:#1baf7a;--accent:#2a78d6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
  --photo:#3987e5;--video:#d95926;--other:#199e70;--accent:#3987e5}}
:root[data-theme="dark"]{color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
  --photo:#3987e5;--video:#d95926;--other:#199e70;--accent:#3987e5}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:0 0 2px}
.sub{color:var(--ink-2);margin:0 0 20px}.note{color:var(--muted);font-size:12px;margin:2px 0 12px}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:16px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-2)}
select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:6px 10px;min-width:180px}
button.clear{font:inherit;font-size:12px;color:var(--accent);background:none;border:0;padding:8px 4px;cursor:pointer}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:16px;min-width:0}
.tile .k{font-size:12px;color:var(--ink-2)}.tile .v{font-size:28px;font-weight:600;margin:2px 0}.tile .d{font-size:12px;color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:12px}
@media(min-width:900px){.grid2{grid-template-columns:5fr 6fr}}
.legend{display:flex;gap:14px;font-size:12px;color:var(--ink-2);margin:4px 0 8px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
svg{display:block;width:100%;overflow:visible}
svg text{fill:var(--ink-2);font-size:11px}svg .val{fill:var(--ink-2);font-variant-numeric:tabular-nums}
svg .tick{fill:var(--muted);font-variant-numeric:tabular-nums}
.bar-row{cursor:pointer}.bar-row:hover .hit{fill:var(--ring)}.bar-row.sel text.lbl{fill:var(--ink);font-weight:600}
.dim{opacity:.28}
#tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--ring);border-radius:8px;
  padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);display:none;z-index:9;min-width:150px}
#tip b{display:block;margin-bottom:4px}#tip .r{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
#tip i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:6px 8px;border-bottom:1px solid var(--grid)}
td{padding:6px 8px;border-bottom:1px solid var(--grid);vertical-align:middle}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto}
.thumb{width:40px;height:40px;object-fit:cover;border-radius:6px;display:block;background:var(--grid)}
.chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--ring);color:var(--ink-2);white-space:nowrap}
.chip i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.meter{height:8px;border-radius:4px;background:var(--grid);overflow:hidden;display:flex;margin-top:8px}
.meter span{display:block;height:100%}
</style></head>
<body><main>
<h1>Signal storage</h1>
<p class="sub" id="sub"></p>

<div class="filters">
  <label>Show<select id="fScope"><option value="phone">Still on phone</option><option value="all">Including deleted from phone</option></select></label>
  <label>Chat<select id="fChat"></select></label>
  <label>Age<select id="fAge">
    <option value="0">All media</option><option value="3">Older than 3 months</option><option value="6">Older than 6 months</option>
    <option value="12">Older than 1 year</option><option value="24">Older than 2 years</option><option value="36">Older than 3 years</option>
  </select></label>
  <button class="clear" id="clear" hidden>Clear filters</button>
</div>

<div class="tiles" id="tiles"></div>

<div class="grid2">
  <section class="card"><h2>Storage by chat</h2><p class="note" id="chatNote">Top 15 chats. Click a bar to filter.</p>
    <div class="legend" id="legend1"></div><div id="chatChart"></div></section>
  <section class="card"><h2 id="monthTitle">Storage by month</h2><p class="note" id="monthNote"></p>
    <div class="legend" id="legend2"></div><div id="monthChart"></div></section>
</div>

<section class="card" style="margin-bottom:12px"><h2>Largest files</h2><p class="note" id="bigNote"></p>
  <div class="scroll"><table id="bigTable"></table></div></section>

<section class="card"><h2>All chats</h2><p class="note">Every chat with media, largest first. Click a row to filter.</p>
  <div class="scroll"><table id="chatTable"></table></div></section>
</main>
<div id="tip" role="tooltip"></div>
<script>
const D = /*DATA*/null;
const S = [{k:'photo',label:'Photos'},{k:'video',label:'Videos'},{k:'other',label:'Audio & files'}];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = b => b >= 1e9 ? (b/1e9).toFixed(b >= 10e9 ? 1 : 2) + ' GB' : b >= 1e6 ? (b/1e6).toFixed(b >= 100e6 ? 0 : 1) + ' MB' : Math.round(b/1e3) + ' KB';
const num = n => n.toLocaleString();
const chatNames = new Map(D.chats.map(c => [c.chat_id, c.name]));
const chatName = { get: id => chatNames.get(id) ?? 'Chat no longer on phone' };
const NS = 'http://www.w3.org/2000/svg';

// ----- state -----
const state = { chat: null, age: 0, scope: 'phone' };
const inScope = x => state.scope === 'all' || x.p;
const backup = new Date(D.backupDate);
const cutoff = () => {
  if (!state.age) return null;
  const d = new Date(backup.getFullYear(), backup.getMonth() - state.age, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const inAge = ym => { const c = cutoff(); return !c || ym < c; };

// ----- tooltip -----
const tip = $('tip');
function showTip(e, title, rows) {
  tip.innerHTML = '<b>' + esc(title) + '</b>' + rows.map(r =>
    '<div class="r"><span>' + (r.k ? '<i style="background:var(--' + r.k + ')"></i>' : '') + esc(r.label) + '</span><span>' + esc(r.value) + '</span></div>').join('');
  tip.style.display = 'block';
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
const hideTip = () => tip.style.display = 'none';

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
// Bar with only the data end rounded (4px), anchored square to the baseline
function barPath(x, y, w, h, horizontal, roundEnd) {
  const r = roundEnd ? Math.min(4, horizontal ? w : h, horizontal ? h / 2 : w / 2) : 0;
  if (horizontal) return 'M' + x + ',' + y + 'h' + (w - r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'v' + (h - 2*r) + 'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r + 'h' + (r - w) + 'z';
  return 'M' + x + ',' + (y + h) + 'v' + (r - h) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) + 'h' + (w - 2*r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'v' + (h - r) + 'z';
}
const niceMax = v => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; };

// ----- aggregates -----
function agg() {
  const byChat = new Map(), byMonth = new Map();
  let total = 0, files = 0, archived = 0, cleared = 0; const bySeries = { photo: 0, video: 0, other: 0 };
  for (const c of D.cells) {
    if (!inAge(c.ym)) continue;
    if (!c.p && (state.chat == null || c.chat_id === state.chat)) cleared += c.ab; // archived, gone from phone
    if (!inScope(c)) continue;
    let r = byChat.get(c.chat_id); if (!r) byChat.set(c.chat_id, r = { photo: 0, video: 0, other: 0, total: 0, n: 0 });
    r[c.s] += c.b; r.total += c.b; r.n += c.n;
    if (state.chat != null && c.chat_id !== state.chat) continue;
    total += c.b; files += c.n; archived += c.ab; bySeries[c.s] += c.b;
  }
  for (const c of D.cells) {
    if (state.chat != null && c.chat_id !== state.chat) continue;
    if (!inScope(c)) continue;
    let m = byMonth.get(c.ym); if (!m) byMonth.set(c.ym, m = { photo: 0, video: 0, other: 0, total: 0, n: 0 });
    m[c.s] += c.b; m.total += c.b; m.n += c.n;
  }
  return { byChat, byMonth, total, files, archived, cleared, bySeries };
}

// ----- tiles -----
function renderTiles(a) {
  const grand = D.cells.filter(inScope).reduce((s, c) => s + c.b, 0);
  const sel = state.chat != null || state.age;
  const where = state.scope === 'phone' ? 'on phone' : 'archived';
  const ranked = [...a.byChat.values()].map(r => r.total).sort((x, y) => y - x);
  const allAge = ranked.reduce((s, v) => s + v, 0);
  const top5 = ranked.slice(0, 5).reduce((s, v) => s + v, 0);
  const meter = S.map(s => '<span style="width:' + (a.total ? 100 * a.bySeries[s.k] / a.total : 0) + '%;background:var(--' + s.k + ')"></span>').join('');
  const tiles = [
    { k: (sel ? 'Selected media ' : 'Media ') + where, v: fmt(a.total), d: num(a.files) + ' files' + (sel ? ' · ' + (grand ? Math.round(100 * a.total / grand) : 0) + '% of all media ' + where : '') },
    { k: 'Photos · Videos', v: (a.total ? Math.round(100 * a.bySeries.photo / a.total) : 0) + '% · ' + (a.total ? Math.round(100 * a.bySeries.video / a.total) : 0) + '%',
      d: fmt(a.bySeries.photo) + ' photos · ' + fmt(a.bySeries.video) + ' videos · ' + fmt(a.bySeries.other) + ' other', meter },
    state.scope === 'phone'
      ? { k: 'Already archived on this Mac', v: (a.total ? Math.round(100 * a.archived / a.total) : 0) + '%', d: fmt(a.archived) + ' safe to delete from the phone' }
      : { k: 'Archived on this Mac', v: (a.total ? Math.round(100 * a.archived / a.total) : 0) + '%', d: fmt(a.archived) + ' of ' + fmt(a.total) },
    { k: 'Cleared from phone', v: fmt(a.cleared), d: a.cleared ? 'archived only, no longer on the phone' : 'nothing deleted from the phone yet' },
    state.chat == null
      ? { k: 'Top 5 chats', v: (allAge ? Math.round(100 * top5 / allAge) : 0) + '%', d: 'of ' + (state.age ? 'this' : 'all') + ' media, ' + fmt(top5) }
      : { k: 'Rank', v: '#' + (ranked.indexOf((a.byChat.get(state.chat) || {}).total) + 1), d: 'of ' + ranked.length + ' chats with media' },
  ];
  $('tiles').innerHTML = tiles.map(t => '<div class="card tile"><div class="k">' + t.k + '</div><div class="v">' + t.v + '</div><div class="d">' + t.d + '</div>' +
    (t.meter ? '<div class="meter" aria-hidden="true">' + t.meter + '</div>' : '') + '</div>').join('');
}

// ----- chart 1: horizontal stacked bars by chat -----
function renderChatChart(a) {
  const box = $('chatChart'); box.innerHTML = '';
  const all = [...a.byChat.entries()].map(([id, r]) => ({ id, ...r })).filter(r => r.total > 0).sort((x, y) => y.total - x.total);
  const top = all.slice(0, 15);
  const rest = all.slice(15);
  if (rest.length) top.push(rest.reduce((o, r) => { for (const s of S) o[s.k] += r[s.k]; o.total += r.total; o.n += r.n; return o; },
    { id: null, other_: rest.length, photo: 0, video: 0, other: 0, total: 0, n: 0 }));
  const W = box.clientWidth || 480, labelW = Math.min(170, W * 0.36), valW = 64, rowH = 24, barH = 14;
  const H = top.length * rowH + 22;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Storage by chat' }, box);
  const max = niceMax(top[0]?.total || 1), plotW = W - labelW - valW, x = v => labelW + plotW * v / max;
  for (let i = 0; i <= 4; i++) {
    const gx = x(max * i / 4);
    el('line', { x1: gx, x2: gx, y1: 0, y2: H - 18, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    el('text', { x: gx, y: H - 4, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = fmt(max * i / 4).replace(' ', '');
  }
  top.forEach((r, i) => {
    const y = i * rowH;
    const g = el('g', { class: 'bar-row' + (r.id != null && r.id === state.chat ? ' sel' : '') + (state.chat != null && r.id !== state.chat ? ' dim' : ''), tabindex: 0 }, svg);
    el('rect', { class: 'hit', x: 0, y, width: W, height: rowH, fill: 'transparent', rx: 4 }, g);
    const name = r.id == null ? r.other_ + ' other chats' : chatName.get(r.id);
    const t = el('text', { x: labelW - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'lbl' }, g);
    t.textContent = name.length > 24 ? name.slice(0, 23) + '…' : name;
    let cx = labelW; const segs = S.filter(s => r[s.k] > 0);
    segs.forEach((s, j) => {
      const w = plotW * r[s.k] / max, last = j === segs.length - 1;
      const gap = last ? 0 : 2; // 2px surface gap between stacked segments
      if (w - gap > 0.5) el('path', { d: barPath(cx, y + (rowH - barH) / 2, Math.max(w - gap, 0.5), barH, true, last), fill: 'var(--' + s.k + ')' }, g);
      cx += w;
    });
    el('text', { x: cx + 6, y: y + rowH / 2 + 4, class: 'val' }, g).textContent = fmt(r.total);
    const rows = [...S.map(s => ({ k: s.k, label: s.label, value: fmt(r[s.k]) })), { label: 'Files', value: num(r.n) }];
    g.addEventListener('pointermove', e => showTip(e, name, rows));
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', e => { const b = g.getBoundingClientRect(); showTip({ clientX: b.left + labelW, clientY: b.bottom }, name, rows); });
    g.addEventListener('blur', hideTip);
    const pick = () => { if (r.id != null) { state.chat = state.chat === r.id ? null : r.id; hideTip(); render(); } };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  $('chatNote').textContent = (rest.length ? 'Top 15 chats, the rest grouped. ' : '') + (state.age ? 'Only media ' + $('fAge').selectedOptions[0].text.toLowerCase() + '. ' : '') + 'Click a bar to filter.';
}

// ----- chart 2: monthly stacked columns -----
function renderMonthChart(a) {
  const box = $('monthChart'); box.innerHTML = '';
  const yms = [...a.byMonth.keys()].sort();
  if (!yms.length) { box.textContent = 'No media.'; return; }
  // continuous months from first to backup date
  const months = []; let [y, m] = yms[0].split('-').map(Number);
  const end = backup.getFullYear() * 12 + backup.getMonth();
  while (y * 12 + m - 1 <= end) { months.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  const W = box.clientWidth || 560, H = 300, padL = 52, padB = 24, padT = 8, plotW = W - padL, plotH = H - padB - padT;
  const max = niceMax(Math.max(...months.map(k => a.byMonth.get(k)?.total || 0)));
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Storage by month' }, box);
  const yv = v => padT + plotH - plotH * v / max;
  for (let i = 0; i <= 4; i++) {
    const gy = yv(max * i / 4);
    el('line', { x1: padL, x2: W, y1: gy, y2: gy, stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    el('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = fmt(max * i / 4).replace(' ', '');
  }
  const step = plotW / months.length, bw = Math.max(1, step - 2); // 2px gap between adjacent bars
  months.forEach((k, i) => {
    const r = a.byMonth.get(k) || { photo: 0, video: 0, other: 0, total: 0, n: 0 };
    const g = el('g', { class: inAge(k) ? '' : 'dim' }, svg);
    let base = 0; const segs = S.filter(s => r[s.k] > 0);
    segs.forEach((s, j) => {
      const h = plotH * r[s.k] / max, last = j === segs.length - 1, gap = last || h < 3 ? 0 : 2;
      if (h > 0.3) el('path', { d: barPath(padL + i * step + 1, yv(base + r[s.k]) + gap, bw, Math.max(h - gap, 0.3), false, last), fill: 'var(--' + s.k + ')' }, g);
      base += r[s.k];
    });
    el('rect', { x: padL + i * step, y: padT, width: step, height: plotH, fill: 'transparent' }, g)
      .addEventListener('pointermove', e => showTip(e, new Date(k + '-01T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        [...S.map(s => ({ k: s.k, label: s.label, value: fmt(r[s.k]) })), { label: 'Total', value: fmt(r.total) }, { label: 'Files', value: num(r.n) }]));
    g.lastChild.addEventListener('pointerleave', hideTip);
    if (k.endsWith('-01')) el('text', { x: padL + i * step, y: H - 6, class: 'tick' }, svg).textContent = k.slice(0, 4);
  });
  $('monthTitle').textContent = 'Storage by month' + (state.chat != null ? ': ' + chatName.get(state.chat) : '');
  $('monthNote').textContent = state.age ? 'Faded months are newer than the age filter, so they aren\'t counted in the totals above.' : 'Media received each month. Hover for detail.';
}

// ----- tables -----
function renderBig() {
  const c = cutoff();
  const list = D.big.filter(f => (state.chat == null || f.chat_id === state.chat) && (!c || f.ym < c) && (state.scope === 'all' || f.ph)).slice(0, 50);
  const head = '<tr><th></th><th class="num">Size</th><th>Type</th><th>Chat</th><th>From</th><th>Date</th><th></th></tr>';
  $('bigTable').innerHTML = head + list.map(f => {
    const href = f.p ? f.p.split('/').map(encodeURIComponent).join('/') : null;
    const thumb = f.a && href && /\.(jpe?g|png|gif|webp|heic)$/i.test(f.p) ? '<img class="thumb" loading="lazy" src="' + href + '" alt="">' : '';
    const kind = S.find(s => s.k === f.s);
    return '<tr><td>' + thumb + '</td><td class="num">' + fmt(f.b) + '</td><td><span class="chip"><i style="background:var(--' + f.s + ')"></i>' + kind.label.replace('Audio & files', (f.ct.split('/')[0] || 'file')) + '</span></td>' +
      '<td>' + esc(chatName.get(f.chat_id)) + '</td><td>' + esc(f.sender) + '</td><td class="num">' + f.d + '</td>' +
      '<td>' + (f.a && href ? '<a href="viewer.html?hash=' + f.h + '&chat=' + encodeURIComponent(chatName.get(f.chat_id)) + '">Open</a>' : '<span class="chip">not archived</span>') + (f.ph ? '' : ' <span class="chip">not on phone</span>') + '</td></tr>';
  }).join('');
  $('bigNote').textContent = list.length ? 'The 50 biggest files' + (state.chat != null ? ' in ' + chatName.get(state.chat) : '') + (c ? ', ' + $('fAge').selectedOptions[0].text.toLowerCase() : '') + '. "Open" shows it in the photo viewer.' : 'No files match these filters.';
}

function renderChatTable(a) {
  const rows = [...a.byChat.entries()].map(([id, r]) => ({ id, ...r })).filter(r => r.total > 0).sort((x, y) => y.total - x.total);
  const tot = rows.reduce((s, r) => s + r.total, 0);
  $('chatTable').innerHTML = '<tr><th>Chat</th><th class="num">Total</th><th class="num">Share</th><th class="num">Photos</th><th class="num">Videos</th><th class="num">Audio & files</th><th class="num">Files</th></tr>' +
    rows.map(r => '<tr data-id="' + r.id + '" style="cursor:pointer' + (r.id === state.chat ? ';font-weight:600' : '') + '"><td>' + esc(chatName.get(r.id)) + '</td><td class="num">' + fmt(r.total) + '</td><td class="num">' +
      (100 * r.total / tot).toFixed(1) + '%</td><td class="num">' + fmt(r.photo) + '</td><td class="num">' + fmt(r.video) + '</td><td class="num">' + fmt(r.other) + '</td><td class="num">' + num(r.n) + '</td></tr>').join('');
}
$('chatTable').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) { const id = Number(tr.dataset.id); state.chat = state.chat === id ? null : id; render(); scrollTo({ top: 0, behavior: 'smooth' }); } });

// ----- wiring -----
const legend = S.map(s => '<span><i style="background:var(--' + s.k + ')"></i>' + s.label + '</span>').join('');
$('legend1').innerHTML = legend; $('legend2').innerHTML = legend;
const opts = [...D.chats].filter(c => c.bytes > 0).sort((x, y) => x.name.localeCompare(y.name));
$('fChat').innerHTML = '<option value="">All chats</option>' + opts.map(c => '<option value="' + c.chat_id + '">' + esc(c.name) + ' (' + fmt(c.bytes) + ')</option>').join('');
$('fChat').onchange = () => { state.chat = $('fChat').value ? Number($('fChat').value) : null; render(); };
$('fAge').onchange = () => { state.age = Number($('fAge').value); render(); };
$('fScope').onchange = () => { state.scope = $('fScope').value; render(); };
$('clear').onclick = () => { state.chat = null; state.age = 0; state.scope = 'phone'; render(); };
const sum = (f, k) => D.cells.filter(f).reduce((s, c) => s + c[k], 0);
$('sub').textContent = 'Signal backup of ' + backup.toLocaleDateString(undefined, { dateStyle: 'medium' }) + ': ' + fmt(sum(c => c.p, 'b')) + ' of media still on the phone (' +
  num(sum(c => c.p, 'n')) + ' files), ' + fmt(sum(() => true, 'ab')) + ' archived on this Mac. Sizes are original file sizes, roughly what each takes on the phone.';

function render() {
  $('fChat').value = state.chat ?? ''; $('fAge').value = state.age; $('fScope').value = state.scope;
  $('clear').hidden = state.chat == null && !state.age && state.scope === 'phone';
  const a = agg();
  renderTiles(a); renderChatChart(a); renderMonthChart(a); renderBig(); renderChatTable(a);
}
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
render();
</script></body></html>`;

const json = JSON.stringify(data).replace(/</g, '\\u003c');
await writeFile(outPath, PAGE.replace('/*DATA*/null', () => json));
console.log(`Wrote ${outPath}`);
