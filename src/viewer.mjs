#!/usr/bin/env node
// Build viewer.html: browse each chat's photos and videos as a grid, or one at a
// time with the arrow keys. Reads archive/manifest.json (no recovery key needed)
// and makes thumbnails in archive/.thumbs, skipping any that already exist.
//
// Usage: node src/viewer.mjs [archiveDir] [outPath]

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { DATA, ROOT, loadManifest } from './lib.mjs';

const run = promisify(execFile);
const archiveDir = resolve(process.argv[2] ?? join(DATA, 'archive'));
const outPath = resolve(process.argv[3] ?? join(DATA, 'viewer.html'));
const thumbDir = join(archiveDir, '.thumbs');
const THUMB = 360;      // square grid tiles, sized for 2x screens
const DISPLAY = 2560;   // longest side for formats browsers can't show
const MEDIUM = 640;     // chat bubbles: real aspect ratio, longest side
const CONCURRENCY = 8;

sharp.concurrency(1); // parallelism comes from running several files at once

// Browsers show these directly; anything else image-like gets a JPEG display copy
const WEB_IMAGE = /^image\/(jpe?g|png|gif|webp|avif)$/i;
const kindOf = ct => (ct.startsWith('video/') ? 'v' : ct === 'image/gif' ? 'g' : ct.startsWith('image/') ? 'i' : null);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Decode anything sharp can't read (e.g. Sony .arw RAW) via macOS sips
async function decodeWithSips(src) {
  const tmp = join(tmpdir(), `viewer-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await run('sips', ['-s', 'format', 'jpeg', src, '--out', tmp]);
    return await readFile(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function videoFrame(src) {
  for (const at of ['1', '0']) {
    try {
      const { stdout } = await run(ffmpegPath, ['-v', 'error', '-ss', at, '-i', src, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      if (stdout.length) return stdout;
    } catch { /* try the first frame instead */ }
  }
  throw new Error('no video frame');
}

async function makeThumbs(item, dims) {
  const thumb = join(thumbDir, `${item.hash}.webp`);
  const medium = join(thumbDir, 'm', `${item.hash}.webp`);
  const needsDisplay = item.kind === 'i' && !WEB_IMAGE.test(item.contentType);
  const display = join(thumbDir, 'display', `${item.hash}.jpg`);
  if (existsSync(thumb) && existsSync(medium) && dims[item.hash] && (!needsDisplay || existsSync(display))) return 'skipped';

  const src = join(archiveDir, item.path);
  let input;
  if (item.kind === 'v') input = await videoFrame(src);
  else {
    try {
      await sharp(src).metadata();
      input = src;
    } catch {
      input = await decodeWithSips(src);
    }
  }
  if (!existsSync(thumb)) {
    await sharp(input, { animated: false }).rotate().resize(THUMB, THUMB, { fit: 'cover', position: 'attention' })
      .webp({ quality: 72 }).toFile(thumb);
  }
  if (!existsSync(medium) || !dims[item.hash]) {
    const out = existsSync(medium)
      ? await sharp(medium).metadata()
      : await sharp(input, { animated: false }).rotate().resize(MEDIUM, MEDIUM, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(medium);
    dims[item.hash] = [out.width, out.height];
  }
  if (needsDisplay && !existsSync(display)) {
    await mkdir(dirname(display), { recursive: true });
    await sharp(input).rotate().resize(DISPLAY, DISPLAY, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(display);
  }
  return 'made';
}

async function main() {
  const manifest = await loadManifest(archiveDir);
  await mkdir(join(thumbDir, 'm'), { recursive: true });
  // Real width/height of each medium thumbnail, so chat bubbles reserve the right space
  const dimsPath = join(thumbDir, 'm', 'dims.json');
  const dims = existsSync(dimsPath) ? JSON.parse(await readFile(dimsPath, 'utf8')) : {};

  // One list of photos/videos per chat folder, oldest first
  const chats = new Map();
  for (const m of Object.values(manifest.messages)) {
    for (const f of m.files) {
      const kind = kindOf(f.contentType ?? '');
      if (!kind || !existsSync(join(archiveDir, f.path))) continue;
      const folder = f.path.split('/')[0];
      if (!chats.has(folder)) chats.set(folder, []);
      chats.get(folder).push({ ...f, kind, sender: m.sender, sentAt: m.sentAt });
    }
  }
  const items = [...chats.values()].flat();
  // Same file can appear in several chats: thumbnail it once
  const unique = [...new Map(items.map(i => [i.hash, i])).values()];
  console.log(`${items.length} photos and videos in ${chats.size} chats`);

  let done = 0, made = 0;
  const failed = new Set();
  await pool(unique, CONCURRENCY, async item => {
    try {
      if ((await makeThumbs(item, dims)) === 'made') made++;
    } catch (e) {
      failed.add(item.hash);
      item.error = e.message.split('\n')[0];
    } finally {
      if (++done % 200 === 0 || done === unique.length) process.stdout.write(`\r  thumbnails ${done}/${unique.length} (${made} new)`);
    }
  });
  process.stdout.write('\n');
  await writeFile(dimsPath, JSON.stringify(dims));
  if (failed.size) {
    console.log(`${failed.size} thumbnails failed:`);
    for (const i of unique.filter(i => failed.has(i.hash)).slice(0, 10)) console.log(`  ${i.path}: ${i.error}`);
  }

  // Screenshot scores from clip.mjs, if it has been run
  const labelsPath = join(archiveDir, '.clip', 'labels.json');
  const labels = existsSync(labelsPath) ? JSON.parse(await readFile(labelsPath, 'utf8')) : null;
  const isShot = hash => (labels?.labels[hash]?.screenshot ?? 0) >= (labels?.threshold ?? 1);

  // Compact data: per chat, senders listed once and items as small arrays
  const rel = p => relative(dirname(outPath), join(archiveDir, p)).split('/').map(encodeURIComponent).join('/');
  const thumbBase = rel('.thumbs');
  const data = {
    thumbBase,
    archiveBase: rel(''),
    hasLabels: !!labels,
    chats: [...chats].map(([name, list]) => {
      list.sort((a, b) => a.sentAt - b.sentAt);
      const senders = [...new Set(list.map(i => i.sender))];
      return {
        name,
        base: rel(name),
        senders,
        // [path within chat folder, thumb hash or '', kind, sender index, sentAt, display copy?, screenshot?]
        items: list.map(i => [
          i.path.split('/').slice(1).map(encodeURIComponent).join('/'),
          failed.has(i.hash) ? '' : i.hash,
          i.kind,
          senders.indexOf(i.sender),
          i.sentAt,
          i.kind === 'i' && !WEB_IMAGE.test(i.contentType) && !failed.has(i.hash) ? 1 : 0,
          i.kind !== 'v' && isShot(i.hash) ? 1 : 0,
        ]),
      };
    }).sort((a, b) => b.items.length - a.items.length),
  };

  const template = await readFile(join(ROOT, 'web', 'viewer.template.html'), 'utf8');
  await writeFile(outPath, template.replace('/*DATA*/null', () => JSON.stringify(data).replace(/</g, '\\u003c')));
  console.log(`Wrote ${outPath}`);
}

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
