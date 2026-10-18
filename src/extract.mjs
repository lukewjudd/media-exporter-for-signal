#!/usr/bin/env node
// Decrypt a Signal local backup folder (iOS 8.30+ / Desktop "SignalBackups" format)
// and write every attachment out as normal files, grouped by chat and year,
// plus a browsable index.html per chat. archive/manifest.json remembers every
// archived file, so media later deleted from the phone stays linked.
//
// Usage: node src/extract.mjs [backupDir] [outDir]
//   backupDir defaults to ./backup  (the folder containing signal-backup-* and files/)
//   outDir    defaults to ./archive
//
// The recovery key comes from SIGNAL_RECOVERY_KEY in .env, or a hidden prompt if unset.

import { existsSync } from 'node:fs';
import { link, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DATA, decryptAttachment, loadManifest, manifestRecord, mediaNameFor, mediaPath, openBackup, planArchive, saveManifest } from './lib.mjs';

const backupDir = resolve(process.argv[2] ?? join(DATA, 'backup'));
const outDir = resolve(process.argv[3] ?? join(DATA, 'archive'));
const CONCURRENCY = 8;

// Encode each path segment, so names containing # or ? still link correctly
const href = p => p.split('/').map(encodeURIComponent).join('/');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  const backup = await openBackup(backupDir);
  const manifest = await loadManifest(outDir);
  const { entries } = planArchive(backup, manifest);

  const stats = { messages: 0, attachments: 0, notInBackup: 0, written: 0, skipped: 0, failed: 0, missingFile: 0, archivedOnly: 0 };
  stats.messages = entries.length;
  const jobs = [];
  const transcripts = new Map();
  for (const entry of entries) {
    for (const f of entry.files) {
      stats.attachments++;
      if (f.missing) { stats.notInBackup++; continue; }
      if (f.archivedOnly) { stats.archivedOnly++; continue; }
      f.job = { src: mediaPath(backupDir, f.mediaName), dest: join(outDir, f.path), loc: f.loc, date: entry.date };
      jobs.push(f.job);
    }
    if (!transcripts.has(entry.folder)) transcripts.set(entry.folder, []);
    transcripts.get(entry.folder).push(entry);
  }
  const chats = backup.chats;

  console.log(`${chats.size} chats, ${stats.messages} messages, ${stats.attachments} attachments (${stats.notInBackup} not in this backup, ${stats.archivedOnly} archived but no longer on the phone)`);
  console.log(`Writing to ${outDir}`);

  // Same media can appear in several messages: decrypt once, hard-link the rest
  const firstDest = new Map();
  let done = 0;
  const failures = [];
  await pool(jobs, CONCURRENCY, async job => {
    try {
      if (existsSync(job.dest)) { stats.skipped++; return; }
      await mkdir(dirname(job.dest), { recursive: true });
      const prior = firstDest.get(job.src);
      if (prior && existsSync(prior)) {
        await link(prior, job.dest);
      } else {
        if (!existsSync(job.src)) { stats.missingFile++; throw new Error('file missing from backup folder'); }
        const plainBytes = decryptAttachment(await readFile(job.src), job.loc.localKey, job.loc.plaintextHash, job.loc.size);
        await writeFile(job.dest, plainBytes);
        firstDest.set(job.src, job.dest);
      }
      await utimes(job.dest, job.date, job.date);
      stats.written++;
    } catch (e) {
      stats.failed++;
      job.failed = e.message;
      failures.push(`${relative(outDir, job.dest)}\t${e.message}`);
    } finally {
      if (++done % 250 === 0 || done === jobs.length) process.stdout.write(`\r  ${done}/${jobs.length} files`);
    }
  });
  process.stdout.write('\n');

  // Long messages are stored as a text attachment; inline them in the transcript
  for (const entries of transcripts.values()) {
    for (const e of entries) {
      if (!e.longText) continue;
      const loc = e.longText.locatorInfo;
      try {
        e.text = decryptAttachment(await readFile(mediaPath(backupDir, mediaNameFor(loc))), loc.localKey, loc.plaintextHash, loc.size).toString('utf8');
      } catch { /* keep the short body */ }
    }
  }

  const messages = {};
  for (const e of entries) {
    const rec = manifestRecord(e, outDir);
    if (rec) messages[e.key] = rec;
  }
  await saveManifest(outDir, { version: 1, messages });

  await writeTranscripts(transcripts);
  await writeFile(join(outDir, 'failures.tsv'), failures.join('\n') + (failures.length ? '\n' : ''));

  console.log(`Done. ${stats.written} written, ${stats.skipped} already existed, ${stats.failed - stats.missingFile} failed to decrypt.`);
  console.log(`${stats.notInBackup + stats.missingFile} attachments aren't in this backup (${stats.notInBackup} never saved on the phone, ${stats.missingFile} referenced but their file wasn't written).`);
  if (failures.length) console.log(`Details: ${join(outDir, 'failures.tsv')}`);
}

async function writeTranscripts(transcripts) {
  const fmt = d => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const links = [];
  for (const [folder, entries] of [...transcripts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = entries.map(e => {
      const media = e.files.map(f => {
        if (f.missing) return `<div class="missing">[${esc(f.fileName || f.contentType || 'attachment')} not in backup]</div>`;
        if (f.job?.failed) return `<div class="missing">[${esc(f.path)}: ${esc(f.job.failed)}]</div>`;
        const src = `../${href(f.path)}`;
        const cap = (f.caption ? `<div class="cap">${esc(f.caption)}</div>` : '') + (f.archivedOnly ? '<div class="cap">Archived only, no longer on phone</div>' : '');
        if (f.contentType.startsWith('image/')) return `<a href="${src}"><img loading="lazy" src="${src}"></a>${cap}`;
        if (f.contentType.startsWith('video/')) return `<video controls preload="none" src="${src}"></video>${cap}`;
        if (f.contentType.startsWith('audio/')) return `<audio controls preload="none" src="${src}"></audio>${cap}`;
        return `<a href="${src}">${esc(f.path.split('/').pop())}</a>${cap}`;
      }).join('');
      return `<div class="m"><div class="h"><b>${esc(e.sender)}</b> · ${esc(fmt(e.date))}</div>${e.text ? `<div class="t">${esc(e.text)}</div>` : ''}${media}</div>`;
    }).join('\n');
    await mkdir(join(outDir, folder), { recursive: true });
    await writeFile(join(outDir, folder, 'index.html'), page(folder, rows, '<a href="../index.html">← All chats</a>'));
    const n = entries.reduce((s, e) => s + e.files.length, 0);
    links.push(`<li><a href="${href(folder)}/index.html">${esc(folder)}</a> <span>${entries.length} messages · ${n} attachments</span></li>`);
  }
  await writeFile(join(outDir, 'index.html'), page('Signal archive', `<ul>${links.join('\n')}</ul>`, ''));
}

const page = (title, body, nav) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style>
body{font:15px/1.45 -apple-system,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#1c1c1e;background:#fff}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}.m{border-color:#333}span,.h{color:#999}}
.m{border-bottom:1px solid #e5e5ea;padding:10px 0}.h{color:#666;font-size:13px}.t{white-space:pre-wrap;margin:4px 0}
img,video{max-width:100%;max-height:420px;border-radius:8px;margin:4px 0;display:block}.cap{font-size:13px;color:#888}
.missing{color:#a66;font-size:13px}li{margin:6px 0}span{color:#666;font-size:13px}a{color:#0a84ff}
</style>${nav}<h1>${esc(title)}</h1>${body}`;

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
