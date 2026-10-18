#!/usr/bin/env node
// Find faces in every archived photo and fingerprint them, ready for grouping
// into people (people.mjs). Uses InsightFace's SCRFD detector and ArcFace
// recogniser (buffalo_l pack in .models/insightface; non-commercial licence).
// Videos are sampled (up to 12 frames spread across each) and each person is
// kept once per video, from their clearest frame. Screenshots are skipped. Incremental.
//
// Usage: node src/faces.mjs [archiveDir]
// Writes archive/.faces/{index.json, embeddings.f32, crops/<face id>.webp}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { DATA, ROOT, isMain, loadManifest } from './lib.mjs';

const archiveDir = resolve(process.argv[2] ?? join(DATA, 'archive'));
const faceDir = join(archiveDir, '.faces');
const MODELS = join(ROOT, '.models', 'insightface', 'buffalo_l');
const DET_SIZE = 640;      // detector input (letterboxed square)
const DECODE_MAX = 1280;   // working resolution for alignment crops
const MIN_SCORE = 0.6;
const MIN_FACE = 28;       // pixels at working resolution
const EMB_DIM = 512;
const CONCURRENCY = 3;
const VIDEO_FRAMES = 12;
const SAME_PERSON = 0.5;   // faces in one video this similar are the same person
const run = promisify(execFile);

sharp.concurrency(1);

// ArcFace's reference landmark positions in its 112x112 input
const ARCFACE_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

// ---------- detection (SCRFD) ----------

export async function detect(det, rgb, w, h) {
  const scale = DET_SIZE / Math.max(w, h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const small = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(nw, nh).raw().toBuffer();
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane).fill(-127.5 / 128); // zero padding, normalised
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const s = (y * nw + x) * 3, d = y * DET_SIZE + x;
      input[d] = (small[s] - 127.5) / 128;
      input[plane + d] = (small[s + 1] - 127.5) / 128;
      input[2 * plane + d] = (small[s + 2] - 127.5) / 128;
    }
  }
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) });
  const o = det.outputNames.map(n => out[n].data);

  // Outputs: scores, boxes, landmarks for strides 8/16/32, two anchors per cell
  const found = [];
  [8, 16, 32].forEach((stride, i) => {
    const scores = o[i], boxes = o[i + 3], kps = o[i + 6];
    const gridW = DET_SIZE / stride;
    for (let a = 0; a < scores.length; a++) {
      if (scores[a] < MIN_SCORE) continue;
      const cell = Math.floor(a / 2);
      const cx = (cell % gridW) * stride, cy = Math.floor(cell / gridW) * stride;
      const b = boxes.subarray(a * 4, a * 4 + 4), k = kps.subarray(a * 10, a * 10 + 10);
      found.push({
        score: scores[a],
        box: [(cx - b[0] * stride) / scale, (cy - b[1] * stride) / scale, (cx + b[2] * stride) / scale, (cy + b[3] * stride) / scale],
        kps: Array.from({ length: 5 }, (_, j) => [(cx + k[j * 2] * stride) / scale, (cy + k[j * 2 + 1] * stride) / scale]),
      });
    }
  });
  return nms(found, 0.4);
}

function nms(list, iouMax) {
  list.sort((a, b) => b.score - a.score);
  const keep = [];
  const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  for (const f of list) {
    const ok = keep.every(k => {
      const ix = Math.max(0, Math.min(f.box[2], k.box[2]) - Math.max(f.box[0], k.box[0]));
      const iy = Math.max(0, Math.min(f.box[3], k.box[3]) - Math.max(f.box[1], k.box[1]));
      const inter = ix * iy;
      return inter / (area(f.box) + area(k.box) - inter) <= iouMax;
    });
    if (ok) keep.push(f);
  }
  return keep;
}

// ---------- alignment + recognition (ArcFace) ----------

// Least-squares similarity transform (rotation, uniform scale, shift) taking src points to dst
function similarity(src, dst) {
  const n = src.length;
  const ms = [0, 0], md = [0, 0];
  for (let i = 0; i < n; i++) { ms[0] += src[i][0] / n; ms[1] += src[i][1] / n; md[0] += dst[i][0] / n; md[1] += dst[i][1] / n; }
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - ms[0], sy = src[i][1] - ms[1], dx = dst[i][0] - md[0], dy = dst[i][1] - md[1];
    num1 += sx * dx + sy * dy; num2 += sx * dy - sy * dx; den += sx * sx + sy * sy;
  }
  const a = num1 / den, b = num2 / den;
  return { a, b, tx: md[0] - (a * ms[0] - b * ms[1]), ty: md[1] - (b * ms[0] + a * ms[1]) };
}

// 112x112 RGB face crop, sampled bilinearly through the inverse transform
function alignFace(rgb, w, h, kps) {
  const { a, b, tx, ty } = similarity(kps, ARCFACE_DST);
  const det = a * a + b * b;
  const out = Buffer.alloc(112 * 112 * 3);
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const px = u - tx, py = v - ty;
      const x = (a * px + b * py) / det, y = (-b * px + a * py) / det;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : rgb[(yy * w + xx) * 3 + c]);
        const val = (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
        out[(v * 112 + u) * 3 + c] = Math.round(val);
      }
    }
  }
  return out;
}

// One face per run: CoreML recompiles (~5s) whenever the batch size changes
async function embed(rec, crops) {
  const plane = 112 * 112;
  const vecs = [];
  for (const crop of crops) {
    const input = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
      input[p] = (crop[p * 3] - 127.5) / 127.5;
      input[plane + p] = (crop[p * 3 + 1] - 127.5) / 127.5;
      input[2 * plane + p] = (crop[p * 3 + 2] - 127.5) / 127.5;
    }
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
    const v = out[rec.outputNames[0]].data.slice(0, EMB_DIM);
    const len = Math.hypot(...v);
    vecs.push(v.map(x => x / len));
  }
  return vecs;
}

// Faces in one decoded image, aligned and fingerprinted
async function facesIn(det, rec, rgb, w, h) {
  const faces = (await detect(det, rgb, w, h)).filter(f => Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]) >= MIN_FACE);
  if (!faces.length) return [];
  const crops = faces.map(f => alignFace(rgb, w, h, f.kps));
  const vecs = await embed(rec, crops);
  return faces.map((f, n) => ({ ...f, crop: crops[n], v: vecs[n], w, h }));
}

// Up to VIDEO_FRAMES frames spread evenly across the video, as JPEG files in a temp folder
async function videoFrames(src, dir) {
  const probe = await run(ffmpegPath, ['-hide_banner', '-i', src]).catch(e => e); // exits non-zero without an output; we only want stderr
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr ?? '');
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  const fps = duration > 0 ? Math.min(2, VIDEO_FRAMES / duration) : 1;
  await run(ffmpegPath, ['-v', 'error', '-i', src, '-vf', `fps=${fps},scale='min(${DECODE_MAX},iw)':-2`, '-frames:v', String(VIDEO_FRAMES), join(dir, '%02d.jpg')]);
  const files = (await readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
  return files.map((f, k) => ({ file: join(dir, f), t: Math.round(((k + 0.5) / fps) * 10) / 10 }));
}

const dotp = (a, b) => { let s = 0; for (let d = 0; d < EMB_DIM; d++) s += a[d] * b[d]; return s; };

// Every face across a video's frames, keeping each person once (their clearest face)
async function videoFaces(det, rec, src) {
  const dir = await mkdtemp(join(tmpdir(), 'faces-video-'));
  try {
    const all = [];
    for (const frame of await videoFrames(src, dir)) {
      const { data, info } = await sharp(frame.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const f of await facesIn(det, rec, data, info.width, info.height)) all.push({ ...f, t: frame.t });
    }
    all.sort((a, b) => b.score * Math.min(b.box[2] - b.box[0], b.box[3] - b.box[1]) - a.score * Math.min(a.box[2] - a.box[0], a.box[3] - a.box[1]));
    const kept = [];
    for (const f of all) if (!kept.some(k => dotp(k.v, f.v) >= SAME_PERSON)) kept.push(f);
    return kept;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- main ----------

async function loadState() {
  const p = join(faceDir, 'index.json');
  if (!existsSync(p)) return { processed: new Set(), faces: [], vectors: [] };
  const index = JSON.parse(await readFile(p, 'utf8'));
  const buf = await readFile(join(faceDir, 'embeddings.f32'));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return {
    processed: new Set(index.processed), faces: index.faces,
    vectors: index.faces.map((_, i) => all.slice(i * EMB_DIM, (i + 1) * EMB_DIM)),
  };
}

async function save(state) {
  const all = new Float32Array(state.faces.length * EMB_DIM);
  state.vectors.forEach((v, i) => all.set(v, i * EMB_DIM));
  await writeFile(join(faceDir, 'embeddings.f32'), Buffer.from(all.buffer));
  await writeFile(join(faceDir, 'index.json'), JSON.stringify({ version: 1, dim: EMB_DIM, processed: [...state.processed], faces: state.faces }));
}

async function main() {
  const manifest = await loadManifest(archiveDir);
  const labelsPath = join(archiveDir, '.clip', 'labels.json');
  const labels = existsSync(labelsPath) ? JSON.parse(await readFile(labelsPath, 'utf8')) : null;
  const isShot = h => (labels?.labels[h]?.screenshot ?? 0) >= (labels?.threshold ?? 1);
  if (!labels) console.log('No screenshot labels yet (run clip.mjs first); scanning everything.');

  // One entry per unique photo
  const photos = new Map();
  for (const m of Object.values(manifest.messages)) {
    for (const f of m.files) {
      const ct = f.contentType ?? '';
      if (!existsSync(join(archiveDir, f.path))) continue;
      if (ct.startsWith('image/') && ct !== 'image/gif' && !isShot(f.hash)) photos.set(f.hash, { path: f.path, video: false });
      else if (ct.startsWith('video/') && process.env.FACES_VIDEOS !== '0') photos.set(f.hash, { path: f.path, video: true });
    }
  }
  const state = await loadState();
  const limit = Number(process.env.FACES_LIMIT) || Infinity; // for quick trial runs
  const todo = [...photos].filter(([h]) => !state.processed.has(h)).slice(0, limit);
  const videos = todo.filter(([, x]) => x.video).length;
  console.log(`${photos.size} photos and videos to scan (screenshots skipped), ${state.processed.size} already done, ${todo.length} to do (${videos} videos)`);

  if (!existsSync(join(MODELS, 'det_10g.onnx')) || !existsSync(join(MODELS, 'w600k_r50.onnx'))) {
    throw new Error('Face models not found: run `npm run setup` first');
  }
  await mkdir(join(faceDir, 'crops'), { recursive: true });
  // CoreML (GPU / Neural Engine) is ~5x faster than CPU here; unsupported layers fall back to CPU
  ort.env.logLevel = 'error';
  const opts = { executionProviders: ['coreml', 'cpu'], intraOpNumThreads: 2 };
  const det = await ort.InferenceSession.create(join(MODELS, 'det_10g.onnx'), opts);
  const rec = await ort.InferenceSession.create(join(MODELS, 'w600k_r50.onnx'), opts);

  let i = 0, done = 0, found = 0, failed = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const [hash, { path, video }] = todo[i++];
      try {
        let faces;
        if (video) faces = await videoFaces(det, rec, join(archiveDir, path));
        else {
          const { data: rgb, info } = await sharp(join(archiveDir, path)).rotate()
            .resize(DECODE_MAX, DECODE_MAX, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          faces = await facesIn(det, rec, rgb, info.width, info.height);
        }
        for (let n = 0; n < faces.length; n++) {
          const f = faces[n];
          const id = `${hash.slice(0, 16)}-${video ? 'v' : ''}${n}`;
          const [x1, y1, x2, y2] = f.box;
          state.faces.push({
            id, hash, score: Math.round(f.score * 100) / 100,
            // box as fractions of the image (or video frame), so it applies at any size
            box: [x1 / f.w, y1 / f.h, (x2 - x1) / f.w, (y2 - y1) / f.h].map(v => Math.round(v * 1e4) / 1e4),
            size: Math.round(Math.min(x2 - x1, y2 - y1)),
            ...(video ? { t: f.t } : {}), // seconds into the video
          });
          state.vectors.push(f.v);
          await sharp(f.crop, { raw: { width: 112, height: 112, channels: 3 } }).webp({ quality: 80 }).toFile(join(faceDir, 'crops', `${id}.webp`));
        }
        found += faces.length;
        state.processed.add(hash);
      } catch {
        failed++;
        state.processed.add(hash); // unreadable file; don't retry every run
      }
      if (++done % 100 === 0 || done === todo.length) {
        const eta = ((Date.now() - started) / done) * (todo.length - done) / 60000;
        process.stdout.write(`\r  scanned ${done}/${todo.length}, ${found} faces (about ${eta.toFixed(0)} min left)   `);
      }
      if (done % 2000 === 0) await save(state); // checkpoint
    }
  }));
  if (todo.length) process.stdout.write('\n');
  await save(state);
  await det.release(); await rec.release(); // avoids an onnxruntime crash at exit
  console.log(`${state.faces.length} faces in ${state.processed.size} photos and videos${failed ? `, ${failed} unreadable` : ''}.`);
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}
