#!/usr/bin/env node
// Group faces (from faces.mjs) into people. Named people in archive/people.json
// claim matching faces first, so names survive new syncs; the rest are grouped
// automatically into unnamed people for you to name in the viewer.
//
// people.json: { people: [{ id, name, faces, rejected?, manual? }], hidden: [face ids], removed: [face ids] }
//   manual   photos tagged by hand (hashes), for faces the detector missed
//   rejected faces taken off a named person; they may join someone else
//   hidden   faces of groups you hid; removed: single faces taken off unnamed groups
//
// Usage: node src/people.mjs [archiveDir]
// Writes archive/.faces/people-index.json

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DATA, isMain } from './lib.mjs';

const DIM = 512;
// Cosine similarity thresholds for ArcFace embeddings
const JOIN_NAMED = 0.42;   // face joins a named person
const JOIN_GROUP = 0.45;   // face joins an automatic group
const MERGE_GROUPS = 0.55; // two automatic groups are the same person
const SMALL_FACE = 40;     // smaller faces only join existing groups, never start one
const MIN_PHOTOS = 3;      // automatic groups smaller than this aren't shown

const dot = (a, b) => { let s = 0; for (let d = 0; d < DIM; d++) s += a[d] * b[d]; return s; };
const unit = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };

export async function loadPeopleFile(archiveDir) {
  const p = join(archiveDir, 'people.json');
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : { version: 1, people: [], hidden: [] };
}

export async function savePeopleFile(archiveDir, data) {
  const p = join(archiveDir, 'people.json');
  await writeFile(`${p}.tmp`, JSON.stringify(data, null, 1));
  await rename(`${p}.tmp`, p);
}

export async function loadFaces(archiveDir) {
  const faceDir = join(archiveDir, '.faces');
  if (!existsSync(join(faceDir, 'index.json'))) throw new Error('No faces yet: run `npm run faces` first');
  const index = JSON.parse(await readFile(join(faceDir, 'index.json'), 'utf8'));
  const buf = await readFile(join(faceDir, 'embeddings.f32'));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return index.faces.map((f, i) => ({ ...f, v: all.subarray(i * DIM, (i + 1) * DIM) }));
}

class Group {
  constructor(key, name = null) { this.key = key; this.name = name; this.sum = new Float32Array(DIM); this.faces = []; this.centroid = null; }
  add(f) { for (let d = 0; d < DIM; d++) this.sum[d] += f.v[d]; this.faces.push(f); this.centroid = null; }
  c() { return (this.centroid ??= Float32Array.from(unit(Array.from(this.sum)))); }
}

export function groupFaces(allFaces, peopleFile) {
  const removed = new Set(peopleFile.removed ?? []);
  const faces = allFaces.filter(f => !removed.has(f.id));
  const byId = new Map(faces.map(f => [f.id, f]));
  const taken = new Set();

  // 1. Named people: their confirmed faces, then any face that clearly matches them
  const named = peopleFile.people.map(p => {
    const g = new Group(p.id, p.name);
    g.rejected = new Set(p.rejected ?? []);
    g.manual = p.manual ?? [];
    for (const id of p.faces) { const f = byId.get(id); if (f && !taken.has(id)) { g.add(f); taken.add(id); } }
    return g;
  }).filter(g => g.faces.length || g.manual.length);
  const best = (f, groups, skip) => {
    let top = null, score = -1;
    for (const g of groups) {
      if (skip?.(g) || !g.faces.length) continue; // hand-tagged-only people have no faces to compare
      const s = dot(f.v, g.c());
      if (s > score) { score = s; top = g; }
    }
    return [top, score];
  };
  // Centroids stay fixed during this pass, so results don't depend on face order
  for (const f of faces) {
    if (taken.has(f.id)) continue;
    const [g, s] = best(f, named, g => g.rejected.has(f.id));
    if (g && s >= JOIN_NAMED) { g.faces.push(f); taken.add(f.id); }
  }

  // 2. Everyone else: largest faces first, join the closest group or start a new one
  const groups = [];
  const rest = faces.filter(f => !taken.has(f.id)).sort((a, b) => b.size - a.size);
  for (const f of rest) {
    if (f.size < SMALL_FACE) continue;
    const [g, s] = best(f, groups);
    if (g && s >= JOIN_GROUP) g.add(f);
    else { const n = new Group(`auto:${f.id}`); n.add(f); groups.push(n); }
    taken.add(f.id);
  }
  // Merge groups that are clearly the same person
  for (let changed = true; changed;) {
    changed = false;
    groups.sort((a, b) => b.faces.length - a.faces.length);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (dot(groups[i].c(), groups[j].c()) >= MERGE_GROUPS) {
          for (const f of groups[j].faces) groups[i].add(f);
          groups.splice(j--, 1); changed = true;
        }
      }
    }
  }
  // Small faces join an existing group only when they match well
  for (const f of rest) {
    if (taken.has(f.id)) continue;
    const [g, s] = best(f, [...named, ...groups], g => g.rejected?.has(f.id));
    if (g && s >= JOIN_GROUP + 0.05) { g.faces.push(f); taken.add(f.id); }
  }

  // Hidden people are remembered by their faces, since group keys can change between runs
  const hidden = new Set(peopleFile.hidden ?? []);
  const isHidden = g => g.faces.filter(f => hidden.has(f.id)).length * 2 >= g.faces.length;
  const describe = g => {
    const photos = new Set([...g.faces.map(f => f.hash), ...(g.manual ?? [])]);
    const cover = g.faces.length ? g.faces.reduce((a, b) => (b.size * b.score > a.size * a.score ? b : a)).id : null;
    return { key: g.key, name: g.name, photos: [...photos], faces: g.faces.map(f => f.id), manual: g.manual ?? [], cover };
  };
  const people = [
    ...named.map(describe).sort((a, b) => b.photos.length - a.photos.length),
    ...groups.map(describe).filter((p, i) => p.photos.length >= MIN_PHOTOS && !isHidden(groups.find(g => g.key === p.key))).sort((a, b) => b.photos.length - a.photos.length),
  ];
  return { generated: new Date().toISOString(), people };
}

export async function buildPeopleIndex(archiveDir) {
  const faces = await loadFaces(archiveDir);
  const index = groupFaces(faces, await loadPeopleFile(archiveDir));
  await writeFile(join(archiveDir, '.faces', 'people-index.json'), JSON.stringify(index));
  return { index, faces: faces.length };
}

if (isMain(import.meta.url)) {
  const archiveDir = resolve(process.argv[2] ?? join(DATA, 'archive'));
  const t = Date.now();
  buildPeopleIndex(archiveDir).then(({ index, faces }) => {
    const named = index.people.filter(p => p.name).length;
    console.log(`${faces} faces grouped into ${index.people.length} people (${named} named) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }).catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
}
