#!/usr/bin/env node
// One-time setup: checks this Mac has what the pipeline needs, downloads the face
// models and builds the Swift helper. Safe to re-run. (CLIP downloads itself the
// first time `npm run clip` runs.)
//
// Usage: node src/setup.mjs

import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { ROOT } from './lib.mjs';

const run = promisify(execFile);
const FACE_MODELS_URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';
const FACE_MODELS = ['det_10g.onnx', 'w600k_r50.onnx']; // detector + recogniser; the pack's other models aren't used
const modelDir = join(ROOT, '.models', 'insightface', 'buffalo_l');

const ok = msg => console.log(`  ✓ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);

console.log('Checking this Mac…');
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) throw new Error(`Node ${process.versions.node} is too old: install Node 22 or newer`);
ok(`Node ${process.versions.node}`);
if (process.platform !== 'darwin') warn('Not macOS: extracting works, but face detection speed-ups, screenshot text checks and Send to Photos are macOS-only');
else ok('macOS');

try {
  await run('xcrun', ['--find', 'swiftc']);
  ok('Swift compiler (for the screenshot text checks)');
  const bin = join(ROOT, 'tools', 'statusbar');
  await run('swiftc', ['-O', join(ROOT, 'tools', 'statusbar.swift'), '-o', bin]);
  ok('Built tools/statusbar');
} catch {
  warn('No Swift compiler: run `xcode-select --install`, then `npm run setup` again (needed for `npm run clip`)');
}

console.log('Face models (InsightFace buffalo_l)…');
if (FACE_MODELS.every(f => existsSync(join(modelDir, f)))) ok('Already downloaded');
else {
  console.log('  Downloading ~280 MB from github.com/deepinsight/insightface…');
  const tmp = await mkdtemp(join(tmpdir(), 'face-models-'));
  try {
    const zip = join(tmp, 'buffalo_l.zip');
    const res = await fetch(FACE_MODELS_URL);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    await mkdir(modelDir, { recursive: true });
    await run('unzip', ['-o', '-j', zip, ...FACE_MODELS, '-d', modelDir]);
    ok(`Saved to ${modelDir}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
console.log('  Note: InsightFace\'s pretrained models are for non-commercial use only.');

if (!existsSync(join(ROOT, '.env'))) warn('No .env yet: copy .env.example to .env and add your recovery key (or type it when asked)');
console.log('\nSetup done. Next: put your backup in backup/ and run `npm run sync`.');
