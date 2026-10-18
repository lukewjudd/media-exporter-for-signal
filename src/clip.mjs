#!/usr/bin/env node
// Compute a CLIP embedding for every archived photo/video thumbnail (run viewer.mjs
// first so thumbnails exist), then score each one as screenshot vs photo.
// Embeddings power search (serve.mjs); scores power the viewer's Screenshots tab.
//
// Usage: node src/clip.mjs [archiveDir]
// Writes archive/.clip/{index.json, embeddings.f32, full-index.json, full.f32, labels.json}. Incremental.
// Each image is embedded twice (see VIEWS in clip-lib.mjs); an image counts as a
// screenshot when either view scores high: the crop catches wide screenshots,
// the full frame catches tall phone screenshots whose bars the crop cuts off.
//
// CLIP still misses cropped screenshots (a tweet, a review) and ones dominated by
// a photo (a Marketplace listing), so images it isn't sure about also get cheap
// "made on a screen" checks (screenSignals below): a clock in the status bar,
// lots of text on a flat background, or an exact phone-screen width with text.

import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { existsSync as exists, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { join, resolve } from 'node:path';
import { DATA, ROOT, loadManifest } from './lib.mjs';
import { CLIP_DIM, CLIP_MODEL, VIEWS, loadClip, loadIndex, textEmbeddings } from './clip-lib.mjs';

const archiveDir = resolve(process.argv[2] ?? join(DATA, 'archive'));
const clipDir = join(archiveDir, '.clip');
const BATCH = 16;

// Zero-shot prompts: an image is a screenshot when the screenshot prompts win
// most of the probability against a broad set of ordinary photo subjects.
const SCREENSHOT = [
  'a screenshot of a phone', 'a screenshot of a mobile app', 'a screenshot of a text message conversation',
  'a screenshot of a social media post', 'a screenshot of a website', 'a screenshot of a map',
  'a screenshot of a computer screen', 'a screenshot of a document or spreadsheet',
];
const PHOTO = [
  'a photo of people', 'a photo of a person', 'a selfie', 'a photo of a baby', 'a photo of a child',
  'a photo of food', 'a photo of a pet', 'a photo of an animal', 'a photo of a landscape', 'a photo of a beach',
  'a photo of a city street', 'a photo of a building', 'a photo of a room', 'a photo of an object',
  'a photo of a car', 'a photo of clothes', 'a photo of a computer screen taken with a camera',
  'a photo of a printed document', 'a photo of a receipt', 'a photo of a sign',
];
// Checked by eye: above 0.8 is almost all screenshots and memes; 0.5-0.8 still has real photos
const SCREENSHOT_THRESHOLD = 0.8;

// Phone screen widths in pixels (portrait): a cropped screenshot keeps the full width
const PHONE_WIDTHS = new Set([640, 720, 750, 828, 1080, 1125, 1170, 1179, 1206, 1242, 1284, 1290, 1320, 1440]);
// Checked against samples: catches ~86% of clear screenshots, ~1 in 150 clear photos (a photographed book page)
const looksMadeOnScreen = s => s.clock
  || (s.chars >= 100 && s.flat >= 0.15)
  || (PHONE_WIDTHS.has(s.width) && s.chars >= 40 && s.flat >= 0.15);

// Share of 4x4 blocks (on a 256px greyscale copy) with almost no variation: interface, not camera grain
async function flatness(file) {
  const { data, info } = await sharp(file).resize(256, 256, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let flat = 0, blocks = 0;
  for (let y = 0; y + 4 <= info.height; y += 4) {
    for (let x = 0; x + 4 <= info.width; x += 4) {
      let sum = 0, sq = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const v = data[(y + j) * info.width + x + i]; sum += v; sq += v * v; }
      blocks++;
      if (Math.sqrt(Math.max(0, sq / 16 - (sum / 16) ** 2)) < 1) flat++;
    }
  }
  return blocks ? flat / blocks : 0;
}

// The Swift helper reads text with Apple's Vision framework; built on first use
async function screenTextTool() {
  const src = join(ROOT, 'tools', 'statusbar.swift'), bin = join(ROOT, 'tools', 'statusbar');
  if (!exists(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    console.log('Building tools/statusbar (Swift)…');
    await promisify(execFile)('swiftc', ['-O', src, '-o', bin]);
  }
  return bin;
}

// Text in the top strip, text coverage and character count for each file, using a few helper processes
async function readScreenText(files, workers = 3) {
  const bin = await screenTextTool();
  const results = new Map();
  let done = 0;
  const chunks = Array.from({ length: workers }, (_, w) => files.filter((_, i) => i % workers === w));
  await Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
    if (!chunk.length) return resolve();
    const p = spawn(bin);
    let buf = '';
    p.stdout.on('data', c => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const j = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        results.set(j.path, j);
        if (++done % 200 === 0 || done === files.length) process.stdout.write(`\r  read text in ${done}/${files.length} images   `);
      }
    });
    p.on('error', reject);
    p.on('close', resolve);
    p.stdin.end(chunk.join('\n') + '\n');
  })));
  if (files.length) process.stdout.write('\n');
  return results;
}

async function main() {
  const manifest = await loadManifest(archiveDir);
  await mkdir(clipDir, { recursive: true });

  const hashes = new Set();
  for (const m of Object.values(manifest.messages)) {
    for (const f of m.files) {
      const ct = f.contentType ?? '';
      if ((ct.startsWith('image/') || ct.startsWith('video/')) && existsSync(join(archiveDir, '.thumbs', `${f.hash}.webp`))) hashes.add(f.hash);
    }
  }

  const { processor, vision, RawImage } = await loadClip({ vision: true });
  const thumb = h => join(archiveDir, '.thumbs', `${h}.webp`);
  const medium = h => join(archiveDir, '.thumbs', 'm', `${h}.webp`);
  const readers = {
    crop: h => RawImage.read(thumb(h)),
    full: async h => {
      const src = existsSync(medium(h)) ? medium(h) : thumb(h);
      const { data } = await sharp(src).resize(224, 224, { fit: 'contain', background: '#000' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return new RawImage(new Uint8ClampedArray(data), 224, 224, 3);
    },
  };

  const views = {};
  for (const view of Object.keys(VIEWS)) {
    const { hashes: known, vectors } = await loadIndex(clipDir, view);
    const todo = [...hashes].filter(h => !known.has(h));
    console.log(`${view}: ${hashes.size} images, ${known.size} already embedded, ${todo.length} to do`);
    const added = new Float32Array(todo.length * CLIP_DIM);
    const started = Date.now();
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const images = await Promise.all(batch.map(readers[view]));
      const { image_embeds } = await vision(await processor(images));
      added.set(image_embeds.normalize(2, -1).data, i * CLIP_DIM);
      const done = Math.min(i + BATCH, todo.length);
      if (done % 320 < BATCH || done === todo.length) {
        const eta = ((Date.now() - started) / done) * (todo.length - done) / 60000;
        process.stdout.write(`\r  embedded ${done}/${todo.length} (about ${eta.toFixed(0)} min left)   `);
      }
    }
    if (todo.length) process.stdout.write('\n');
    const allHashes = [...known.keys(), ...todo];
    const all = new Float32Array(allHashes.length * CLIP_DIM);
    all.set(vectors);
    all.set(added, vectors.length);
    const [indexFile, dataFile] = VIEWS[view];
    await writeFile(join(clipDir, dataFile), Buffer.from(all.buffer));
    await writeFile(join(clipDir, indexFile), JSON.stringify({ model: CLIP_MODEL, dim: CLIP_DIM, hashes: allHashes }));
    views[view] = { rows: new Map(allHashes.map((h, n) => [h, n])), all };
  }

  // Score every image: softmax over all prompts (CLIP's logit scale is 100)
  const prompts = [...SCREENSHOT, ...PHOTO];
  const text = await textEmbeddings(prompts);
  const score = v => {
    const logits = prompts.map((_, p) => {
      let dot = 0;
      for (let d = 0; d < CLIP_DIM; d++) dot += v[d] * text[p * CLIP_DIM + d];
      return 100 * dot;
    });
    const max = Math.max(...logits);
    const exp = logits.map(l => Math.exp(l - max));
    return exp.slice(0, SCREENSHOT.length).reduce((s, x) => s + x, 0) / exp.reduce((s, x) => s + x, 0);
  };
  const clipScore = {};
  for (const h of hashes) {
    clipScore[h] = Math.max(...Object.values(views).map(({ rows, all }) => {
      const n = rows.get(h);
      return n == null ? 0 : score(all.subarray(n * CLIP_DIM, (n + 1) * CLIP_DIM));
    }));
  }

  // Screen signals for photos CLIP didn't already flag (cached in signals.json)
  const signalsPath = join(clipDir, 'signals.json');
  const signals = exists(signalsPath) ? JSON.parse(await readFile(signalsPath, 'utf8')) : {};
  const fileOf = {};
  for (const m of Object.values(manifest.messages)) for (const f of m.files) fileOf[f.hash] ??= f;
  const check = [...hashes].filter(h => !signals[h] && clipScore[h] < SCREENSHOT_THRESHOLD &&
    /^image\//.test(fileOf[h]?.contentType ?? '') && fileOf[h].contentType !== 'image/gif');
  if (check.length) {
    console.log(`Checking ${check.length} images for signs they were made on a screen…`);
    const paths = check.map(h => join(archiveDir, fileOf[h].path));
    const text = await readScreenText(paths);
    for (const [k, h] of check.entries()) {
      const t = text.get(paths[k]) ?? {};
      const src = exists(medium(h)) ? medium(h) : paths[k];
      let width = 0, flat = 0;
      try { width = (await sharp(paths[k]).metadata()).width ?? 0; flat = await flatness(src); } catch { /* unreadable */ }
      signals[h] = { clock: /(^|\s)\d{1,2}[:.]\d{2}(\s|$)/.test(t.top ?? ''), chars: t.chars ?? 0, flat: Math.round(flat * 100) / 100, width };
    }
    await writeFile(signalsPath, JSON.stringify(signals));
  }

  const labels = {};
  let shots = 0, bySignal = 0;
  for (const h of hashes) {
    const byClip = clipScore[h] >= SCREENSHOT_THRESHOLD;
    const byScreen = !byClip && signals[h] && looksMadeOnScreen(signals[h]);
    // screenshot: the decision score viewers compare with the threshold (1 when a screen signal decided it)
    labels[h] = { screenshot: byScreen ? 1 : Math.round(clipScore[h] * 1000) / 1000, clip: Math.round(clipScore[h] * 1000) / 1000, ...(byScreen ? { screen: true } : {}) };
    if (byClip || byScreen) shots++;
    if (byScreen) bySignal++;
  }
  await writeFile(join(clipDir, 'labels.json'), JSON.stringify({ threshold: SCREENSHOT_THRESHOLD, labels }));
  console.log(`Scored ${hashes.size} images: ${shots} look like screenshots (${shots - bySignal} by CLIP, ${bySignal} more by screen signals).`);
}

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
