#!/usr/bin/env node
// Import everything marked "keep" in the viewer into Apple Photos, in an album
// (default "From Signal"), dated to when it was sent in Signal. Signal strips
// photo metadata, so without this every import would be dated today.
// Remembers what it has sent in archive/exported.json, so re-running only sends new keeps.
//
// Usage: node src/export-photos.mjs [--album "From Signal"] [--dry-run]
// The first run asks macOS for permission to control Photos.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { DATA, loadManifest } from './lib.mjs';

const run = promisify(execFile);
const archiveDir = join(DATA, 'archive');
const picksPath = join(archiveDir, 'picks.json');
const exportedPath = join(archiveDir, 'exported.json');
const args = process.argv.slice(2);
const album = args.includes('--album') ? args[args.indexOf('--album') + 1] : 'From Signal';
const dryRun = args.includes('--dry-run');
const BATCH = 25;

// JavaScript for Automation, run by osascript. Imports a batch, then sets each
// item's date by matching file names (import order isn't guaranteed).
const JXA = `
function run(argv) {
  const job = JSON.parse(argv[0]);
  const Photos = Application('Photos');
  Photos.activate();
  let album = Photos.albums.whose({ name: job.album })[0];
  try { album.name(); } catch (e) { album = Photos.make({ new: 'album', named: job.album }); }
  const files = job.items.map(i => Path(i.file));
  const imported = Photos.import(files, { into: album, skipCheckDuplicates: true }) || [];
  const byName = {};
  for (const i of job.items) byName[i.name] = i.date;
  let dated = 0;
  for (const item of imported) {
    const when = byName[item.filename()];
    if (when) { item.date = new Date(when); dated++; }
  }
  return JSON.stringify({ imported: imported.length, dated });
}`;

async function main() {
  // picks.json belongs to the viewer's server; this script only reads it
  const picks = existsSync(picksPath) ? JSON.parse(await readFile(picksPath, 'utf8')) : { picks: {} };
  const exported = existsSync(exportedPath) ? JSON.parse(await readFile(exportedPath, 'utf8')) : { version: 1, exported: {} };
  const manifest = await loadManifest(archiveDir);

  // Each kept file once, with the date of its earliest message
  const files = new Map();
  for (const m of Object.values(manifest.messages)) {
    for (const f of m.files) {
      if (picks.picks[f.hash] !== 'keep' || exported.exported[f.hash]) continue;
      const prior = files.get(f.hash);
      if (!prior || m.sentAt < prior.sentAt) files.set(f.hash, { hash: f.hash, file: join(archiveDir, f.path), sentAt: m.sentAt });
    }
  }
  const todo = [...files.values()].filter(f => existsSync(f.file)).sort((a, b) => a.sentAt - b.sentAt);
  const kept = Object.values(picks.picks).filter(v => v === 'keep').length;
  console.log(`${kept} kept, ${Object.keys(exported.exported).length} already in Photos, ${todo.length} to import into album "${album}"`);
  if (dryRun || !todo.length) return;

  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const job = { album, items: batch.map(f => ({ file: f.file, name: basename(f.file), date: f.sentAt })) };
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', JXA, JSON.stringify(job)], { maxBuffer: 1e7 });
    const result = JSON.parse(stdout.trim());
    if (result.imported < batch.length) console.warn(`\n  Photos imported ${result.imported} of ${batch.length} in this batch`);
    // Record progress after every batch, so an interrupted run resumes where it stopped
    const now = new Date().toISOString();
    for (const f of batch) exported.exported[f.hash] = { at: now, album };
    await writeFile(`${exportedPath}.tmp`, JSON.stringify(exported));
    await rename(`${exportedPath}.tmp`, exportedPath);
    done += batch.length;
    process.stdout.write(`\r  imported ${done}/${todo.length}`);
  }
  process.stdout.write('\n');
  console.log(`Done. They're in the "${album}" album in Photos, dated to when they were sent.`);
}

main().catch(e => {
  const msg = e.stderr || e.message;
  console.error(`\nError: ${msg}`);
  if (/not allowed|-1743|authoriz/i.test(msg)) {
    console.error('macOS blocked access to Photos. Allow it in System Settings → Privacy & Security → Automation, then run again.');
  }
  process.exit(1);
});
