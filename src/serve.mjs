#!/usr/bin/env node
// Serve viewer.html with search (CLIP), people (faces.mjs + people.mjs) and
// keep/skip picks saved to archive/picks.json. Local only (127.0.0.1); serves
// viewer.html and the archive folder, nothing else from the project.
//
// Usage: node src/serve.mjs [port]   (or npm run view; search needs npm run clip)

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { DATA, ROOT } from './lib.mjs';
import { CLIP_DIM, loadIndex, textEmbeddings } from './clip-lib.mjs';
import { buildPeopleIndex, loadPeopleFile, savePeopleFile } from './people.mjs';
import { DuckDBInstance } from '@duckdb/node-api';

const PORT = Number(process.argv[2] ?? 8777);
const archiveDir = join(DATA, 'archive');
const RESULTS = 300;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

// Search needs CLIP embeddings (npm run clip); everything else works without them
const { hashes, vectors } = await loadIndex(join(archiveDir, '.clip'));
const rowHash = [...hashes.keys()];
// The full-frame view (if indexed) also counts: an image matches by whichever view scores higher
const full = await loadIndex(join(archiveDir, '.clip'), 'full');
const fullRow = rowHash.map(h => full.hashes.get(h) ?? -1);
if (hashes.size) {
  await textEmbeddings(['warm up']); // load the text model before the first search
  console.log(`Search ready: ${hashes.size} images`);
} else console.log('Search is off until you run `npm run clip`.');

async function search(q) {
  const prompt = /^(a|an|the) /i.test(q) ? q : `a photo of ${q}`;
  const t = await textEmbeddings([prompt]);
  const scores = new Float32Array(rowHash.length);
  for (let r = 0; r < rowHash.length; r++) {
    let dot = 0;
    const o = r * CLIP_DIM;
    for (let d = 0; d < CLIP_DIM; d++) dot += vectors[o + d] * t[d];
    const f = fullRow[r];
    if (f >= 0) {
      let dotFull = 0;
      const of = f * CLIP_DIM;
      for (let d = 0; d < CLIP_DIM; d++) dotFull += full.vectors[of + d] * t[d];
      if (dotFull > dot) dot = dotFull;
    }
    scores[r] = dot;
  }
  const top = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, RESULTS);
  return { q, hashes: top.map(r => rowHash[r]), scores: top.map(r => Math.round(scores[r] * 1000) / 1000) };
}

// ---------- chats: windows of messages from signal.duckdb ----------

const dbPath = join(DATA, 'signal.duckdb');
const dimsPath = join(archiveDir, '.thumbs', 'm', 'dims.json');
let db = null, dims = {};
// Reopen when `npm run sync` rebuilds the database (or thumbnails), no restart needed
async function conn() {
  if (!existsSync(dbPath)) throw new Error('No database yet: run `npm run db`');
  const mtime = statSync(dbPath).mtimeMs;
  if (!db || db.mtime !== mtime) {
    db?.con.closeSync(); db?.inst.closeSync();
    const inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
    db = { inst, con: await inst.connect(), mtime };
  }
  if (existsSync(dimsPath) && dims.mtime !== statSync(dimsPath).mtimeMs) {
    dims = { mtime: statSync(dimsPath).mtimeMs, map: JSON.parse(await readFile(dimsPath, 'utf8')) };
  }
  return db.con;
}
const rows = async (sql, params = []) => (await (await conn()).runAndReadAll(sql, params)).getRowObjectsJson();

async function chatList() {
  const list = await rows(`SELECT c.chat_id, c.name, c.kind, count(*) AS n, max(m.sent_ms) AS last
    FROM chats c JOIN messages m USING (chat_id) GROUP BY ALL ORDER BY last DESC`);
  return list.map(r => ({ id: Number(r.chat_id), name: r.name, kind: r.kind, n: Number(r.n), last: Number(r.last) }));
}

// The message a media file belongs to, preferring the chat it was opened from
async function contextFor(hash, chatName) {
  const [r] = await rows(`SELECT m.chat_id, m.message_id FROM attachments a JOIN messages m USING (message_id) JOIN chats c ON c.chat_id = m.chat_id
    WHERE a.plaintext_hash = $1 ORDER BY (c.name = $2) DESC, m.sent_ms LIMIT 1`, [hash, chatName ?? '']);
  return r ? { chat: Number(r.chat_id), message: Number(r.message_id) } : null;
}

const MSG_COLS = `message_id, sent_ms, sender, outgoing, body, attachment_count`;
async function messagesWindow(chatId, { around, before, after, limit }) {
  limit = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const older = (ms, id, n, inclusive = false) => rows(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = $1
    AND (sent_ms < $2 OR (sent_ms = $2 AND message_id ${inclusive ? '<=' : '<'} $3)) ORDER BY sent_ms DESC, message_id DESC LIMIT $4`, [chatId, ms, id, n + 1]);
  const newer = (ms, id, n, inclusive = false) => rows(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = $1
    AND (sent_ms > $2 OR (sent_ms = $2 AND message_id ${inclusive ? '>=' : '>'} $3)) ORDER BY sent_ms, message_id LIMIT $4`, [chatId, ms, id, n + 1]);
  const cursor = c => { const [ms, id] = String(c).split(':').map(Number); return [ms, id]; };

  let list, hasOlder = false, hasNewer = false;
  if (around) {
    const [a] = await rows(`SELECT sent_ms, message_id FROM messages WHERE message_id = $1 AND chat_id = $2`, [Number(around), chatId]);
    if (!a) throw new Error('Message not found');
    const half = Math.floor(limit / 2);
    const up = await older(Number(a.sent_ms), Number(a.message_id), half);
    const down = await newer(Number(a.sent_ms), Number(a.message_id), limit - half, true);
    hasOlder = up.length > half; hasNewer = down.length > limit - half;
    list = [...up.slice(0, half).reverse(), ...down.slice(0, limit - half)];
  } else if (before) {
    const r = await older(...cursor(before), limit);
    hasOlder = r.length > limit; list = r.slice(0, limit).reverse();
  } else if (after) {
    const r = await newer(...cursor(after), limit);
    hasNewer = r.length > limit; list = r.slice(0, limit);
  } else { // latest
    const r = await older(Number.MAX_SAFE_INTEGER, 0, limit);
    hasOlder = r.length > limit; list = r.slice(0, limit).reverse();
  }

  const ids = list.filter(m => Number(m.attachment_count) > 0).map(m => Number(m.message_id));
  const atts = ids.length ? await rows(`SELECT message_id, plaintext_hash, content_type, archive_path, in_archive, on_phone, caption, file_name, size_bytes
    FROM attachments WHERE message_id IN (${ids.join(',')}) ORDER BY message_id, position`) : [];
  const byMsg = new Map();
  for (const a of atts) {
    const k = Number(a.message_id);
    if (!byMsg.has(k)) byMsg.set(k, []);
    byMsg.get(k).push({
      h: a.plaintext_hash, ct: a.content_type, p: a.in_archive ? a.archive_path : null, cap: a.caption, name: a.file_name,
      size: Number(a.size_bytes), dims: dims.map?.[a.plaintext_hash] ?? null,
    });
  }
  return {
    hasOlder, hasNewer,
    messages: list.map(m => ({
      id: Number(m.message_id), ms: Number(m.sent_ms), sender: m.sender, out: m.outgoing === true || m.outgoing === 'true',
      body: m.body, att: byMsg.get(Number(m.message_id)) ?? [],
    })),
  };
}

// ---------- picks: keep / skip ----------

const picksPath = join(archiveDir, 'picks.json');
const picks = existsSync(picksPath) ? JSON.parse(await readFile(picksPath, 'utf8')) : { version: 1, picks: {} };
async function savePicks() {
  await writeFile(`${picksPath}.tmp`, JSON.stringify(picks));
  await rename(`${picksPath}.tmp`, picksPath);
}

// ---------- people ----------

let people = null; // { people: [{ key, name, photos, faces, cover }] }
async function getPeople() {
  if (people) return people;
  const indexPath = join(archiveDir, '.faces', 'people-index.json');
  if (existsSync(indexPath)) people = JSON.parse(await readFile(indexPath, 'utf8'));
  else if (existsSync(join(archiveDir, '.faces', 'index.json'))) people = (await buildPeopleIndex(archiveDir)).index;
  else people = { people: [] };
  return people;
}
async function savePeopleIndex() {
  await writeFile(join(archiveDir, '.faces', 'people-index.json'), JSON.stringify(people));
}

// Give a person a name. Using a name that already exists merges the two.
async function namePerson(key, name) {
  const idx = await getPeople();
  const file = await loadPeopleFile(archiveDir);
  const group = idx.people.find(p => p.key === key);
  if (!group) throw new Error('Unknown person');
  name = name.trim().slice(0, 80);
  const same = idx.people.find(p => p.key !== key && p.name && p.name.toLowerCase() === name.toLowerCase());
  if (same) {
    // Merge into the existing person
    const target = file.people.find(p => p.id === same.key);
    target.faces = [...new Set([...target.faces, ...group.faces])];
    const source = file.people.find(p => p.id === key);
    if (source?.manual?.length) target.manual = [...new Set([...(target.manual ?? []), ...source.manual])];
    same.manual = [...new Set([...(same.manual ?? []), ...(group.manual ?? [])])];
    if (source) file.people.splice(file.people.indexOf(source), 1);
    same.faces = [...new Set([...same.faces, ...group.faces])];
    same.photos = [...new Set([...same.photos, ...group.photos])];
    idx.people.splice(idx.people.indexOf(group), 1);
  } else if (group.name) {
    file.people.find(p => p.id === key).name = name;
    group.name = name;
  } else {
    const id = 'p' + randomBytes(6).toString('hex');
    file.people.push({ id, name, faces: group.faces });
    Object.assign(group, { key: id, name });
  }
  await savePeopleFile(archiveDir, file);
  await savePeopleIndex();
  return { merged: !!same, key: same ? same.key : group.key };
}

// Tag a photo with a person by hand (for faces the detector missed). A new name creates the person.
async function tagPhoto(hash, name) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Bad photo');
  name = name.trim().slice(0, 80);
  if (!name) throw new Error('Name needed');
  const idx = await getPeople();
  const file = await loadPeopleFile(archiveDir);
  let entry = idx.people.find(p => p.name && p.name.toLowerCase() === name.toLowerCase());
  if (!entry) {
    const id = 'p' + randomBytes(6).toString('hex');
    file.people.push({ id, name, faces: [], manual: [] });
    entry = { key: id, name, photos: [], faces: [], manual: [], cover: null };
    idx.people.push(entry);
  }
  const person = file.people.find(p => p.id === entry.key);
  person.manual = [...new Set([...(person.manual ?? []), hash])];
  entry.manual = [...new Set([...(entry.manual ?? []), hash])];
  if (!entry.photos.includes(hash)) entry.photos.push(hash);
  await savePeopleFile(archiveDir, file);
  await savePeopleIndex();
  return { key: entry.key, name: entry.name };
}

// Take a person off a photo: a hand tag is deleted; a detected face is marked as not them
async function untagPhoto(hash, key, faceId) {
  const idx = await getPeople();
  const file = await loadPeopleFile(archiveDir);
  const entry = idx.people.find(p => p.key === key);
  if (!entry) throw new Error('Unknown person');
  const person = file.people.find(p => p.id === key); // only named people are in the file
  if (faceId) {
    // Every face of this person in this photo or video goes, not just the one shown on the tag
    await tags(); // makes sure faceIndex is loaded
    const here = entry.faces.filter(id => id === faceId || faceIndex.byId.get(id)?.hash === hash);
    entry.faces = entry.faces.filter(id => !here.includes(id));
    if (person) {
      person.faces = person.faces.filter(id => !here.includes(id));
      person.rejected = [...new Set([...(person.rejected ?? []), ...here])];
    } else file.removed = [...new Set([...(file.removed ?? []), ...here])];
  } else {
    entry.manual = (entry.manual ?? []).filter(h => h !== hash);
    if (person) person.manual = (person.manual ?? []).filter(h => h !== hash);
  }
  // Still in the photo through another face or a hand tag?
  await tags(); // makes sure faceIndex is loaded
  const stillThere = entry.faces.some(id => faceIndex.byId.get(id)?.hash === hash) || (entry.manual ?? []).includes(hash);
  if (!stillThere) entry.photos = entry.photos.filter(h => h !== hash);
  await savePeopleFile(archiveDir, file);
  await savePeopleIndex();
  return { ok: true };
}

// Hide a group (strangers, bad detections); remembered by its faces
async function hidePerson(key) {
  const idx = await getPeople();
  const file = await loadPeopleFile(archiveDir);
  const group = idx.people.find(p => p.key === key);
  if (!group) throw new Error('Unknown person');
  file.hidden = [...new Set([...(file.hidden ?? []), ...group.faces])];
  const named = file.people.find(p => p.id === key);
  if (named) file.people.splice(file.people.indexOf(named), 1);
  idx.people.splice(idx.people.indexOf(group), 1);
  await savePeopleFile(archiveDir, file);
  await savePeopleIndex();
  return { hidden: key };
}

// Who is in each photo: hash -> [[person index, face id, box]] from the people groups
let faceIndex = null;
async function tags() {
  const idx = await getPeople();
  const facesPath = join(archiveDir, '.faces', 'index.json');
  if (!existsSync(facesPath)) return { people: [], tags: {} };
  if (!faceIndex || faceIndex.mtime !== statSync(facesPath).mtimeMs) {
    const f = JSON.parse(await readFile(facesPath, 'utf8'));
    faceIndex = { mtime: statSync(facesPath).mtimeMs, byId: new Map(f.faces.map(x => [x.id, x])) };
  }
  const out = {};
  const people = idx.people.map((p, i) => {
    for (const id of p.faces) {
      const face = faceIndex.byId.get(id);
      if (!face) continue;
      // One tag per person per photo: a video can catch the same person from several angles
      if ((out[face.hash] ?? []).some(t => t[0] === i)) continue;
      (out[face.hash] ??= []).push([i, id, face.t == null ? face.box : null]); // video faces have no fixed box
    }
    for (const hash of p.manual ?? []) {
      if (!(out[hash] ?? []).some(t => t[0] === i)) (out[hash] ??= []).push([i, null, null]); // tagged by hand
    }
    return { key: p.key, name: p.name, cover: p.cover };
  });
  return { people, tags: out };
}

// Home page: totals, triage progress, and photos from this day in earlier years
async function home() {
  const [t] = await rows(`SELECT
      (SELECT count(*) FROM messages) AS messages,
      (SELECT count(*) FROM chats c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.chat_id)) AS chats,
      (SELECT count(*) FILTER (WHERE category IN ('image', 'gif')) FROM attachments WHERE NOT duplicate AND in_archive) AS photos,
      (SELECT count(*) FILTER (WHERE category = 'video') FROM attachments WHERE NOT duplicate AND in_archive) AS videos,
      (SELECT max(sent_ms) FROM messages) AS latest`);
  const today = new Date();
  const onThisDay = await rows(`SELECT a.plaintext_hash AS h, a.category, c.name AS chat, a.sender, m.sent_ms
    FROM attachments a JOIN messages m USING (message_id) JOIN chats c ON c.chat_id = m.chat_id
    WHERE a.in_archive AND NOT a.duplicate AND a.category IN ('image', 'video')
      AND month(a.sent_at) = $1 AND day(a.sent_at) = $2 AND year(a.sent_at) < $3
    ORDER BY m.sent_ms DESC`, [today.getMonth() + 1, today.getDate(), today.getFullYear()]);
  const labelsPath = join(archiveDir, '.clip', 'labels.json');
  const labels = existsSync(labelsPath) ? JSON.parse(await readFile(labelsPath, 'utf8')) : null;
  const shots = labels ? Object.values(labels.labels).filter(l => l.screenshot >= labels.threshold).length : 0;
  const exportedPath = join(archiveDir, 'exported.json');
  const exported = existsSync(exportedPath) ? Object.keys(JSON.parse(await readFile(exportedPath, 'utf8')).exported).length : 0;
  const idx = await getPeople();
  const values = Object.values(picks.picks);
  // Skip screenshots in "on this day"; they're rarely what you want to see again
  const isShot = h => labels && (labels.labels[h]?.screenshot ?? 0) >= labels.threshold;
  return {
    messages: Number(t.messages), chats: Number(t.chats), photos: Number(t.photos), videos: Number(t.videos), latest: Number(t.latest),
    screenshots: shots, people: idx.people.length, named: idx.people.filter(p => p.name).length,
    kept: values.filter(v => v === 'keep').length, skipped: values.filter(v => v === 'skip').length, exported,
    onThisDay: onThisDay.filter(r => !isShot(r.h)).slice(0, 24).map(r => ({ h: r.h, video: r.category === 'video', chat: r.chat, sender: r.sender, ms: Number(r.sent_ms) })),
  };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('Too large'); }
  return JSON.parse(body || '{}');
}

// Changes must come from the viewer itself: a custom header can't be sent
// cross-site without a CORS preflight, which this server never approves.
const fromViewer = req => req.headers['x-signal-viewer'] === '1' &&
  (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${PORT}` || req.headers.origin === `http://localhost:${PORT}`);

const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

async function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/search') {
    if (!hashes.size) return json(res, { error: 'Search needs `npm run clip` first' }, 503);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    return json(res, q ? await search(q) : { q, hashes: [], scores: [] });
  }
  if (req.method === 'GET' && path === '/api/picks') return json(res, picks);
  if (req.method === 'GET' && path === '/api/tags') return json(res, await tags());
  if (req.method === 'GET' && path === '/api/home') return json(res, await home());
  if (req.method === 'GET' && path === '/api/chats') return json(res, { chats: await chatList() });
  if (req.method === 'GET' && path === '/api/context') return json(res, await contextFor(url.searchParams.get('hash'), url.searchParams.get('chat')));
  if (req.method === 'GET' && path === '/api/messages') {
    const q = Object.fromEntries(url.searchParams);
    return json(res, await messagesWindow(Number(q.chat), q));
  }
  if (req.method === 'GET' && path === '/api/people') {
    const idx = await getPeople();
    // Named people first, then the largest groups still to name
    const sorted = [...idx.people].sort((x, y) => (!!y.name - !!x.name) || (y.photos.length - x.photos.length));
    return json(res, { people: sorted.map(({ key, name, photos, cover }) => ({ key, name, photos, cover })) });
  }
  if (req.method !== 'POST') return json(res, { error: 'Not found' }, 404);
  if (!fromViewer(req)) return json(res, { error: 'Forbidden' }, 403);
  const body = await readJson(req);
  if (path === '/api/picks') {
    for (const [hash, value] of Object.entries(body.picks ?? {})) {
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      if (value === 'keep' || value === 'skip') picks.picks[hash] = value;
      else delete picks.picks[hash];
    }
    await savePicks();
    return json(res, { ok: true });
  }
  if (path === '/api/people/name') return json(res, await namePerson(String(body.key), String(body.name ?? '')));
  if (path === '/api/people/hide') return json(res, await hidePerson(String(body.key)));
  if (path === '/api/people/tag') return json(res, await tagPhoto(String(body.hash), String(body.name ?? '')));
  if (path === '/api/people/untag') return json(res, await untagPhoto(String(body.hash), String(body.key), body.faceId ? String(body.faceId) : null));
  if (path === '/api/export') {
    // Runs export-photos.mjs; picks are flushed by the viewer before it asks
    const out = await new Promise(done => execFile('node', [join(ROOT, 'src', 'export-photos.mjs')], { cwd: ROOT, maxBuffer: 1e7 },
      (err, stdout, stderr) => done({ ok: !err, output: (stdout + stderr).replace(/\r[^\n]*/g, '').trim() })));
    return json(res, out, out.ok ? 200 : 500);
  }
  return json(res, { error: 'Not found' }, 404);
}

// Only viewer.html and files under archive/ are reachable
function resolveStatic(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, '');
  if (rel === '' || rel === '.' || rel === 'home.html') return join(ROOT, 'web', 'home.html');
  if (rel === 'chat.html') return join(ROOT, 'web', 'chat.html');
  if (rel === 'viewer.html' || rel === 'dashboard.html') return join(DATA, rel); // generated pages
  const full = join(DATA, rel);
  if (!full.startsWith(archiveDir + sep)) return null;
  return full;
}

function sendFile(req, res, file) {
  const { size } = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) { // videos need byte ranges to seek
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'max-age=3600' });
    createReadStream(file).pipe(res);
  }
}

// Only answer requests addressed to this machine by name. Blocks DNS rebinding, where a
// website points its own domain at 127.0.0.1 to read your archive through your browser.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

createServer(async (req, res) => {
  if (!LOCAL_HOSTS.has(req.headers.host ?? '')) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = resolveStatic(url.pathname);
    if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    sendFile(req, res, file);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Media Exporter for Signal: ${url}  (Ctrl+C to stop)`);
  if (!process.env.NO_OPEN) execFile('open', [url]);
});
