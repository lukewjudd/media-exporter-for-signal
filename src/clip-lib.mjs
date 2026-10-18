// CLIP helpers shared by clip.mjs (indexing) and serve.mjs (search).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage, env } from '@huggingface/transformers';
import { ROOT } from './lib.mjs';

export const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
export const CLIP_DIM = 512;
env.cacheDir = join(ROOT, '.models'); // downloaded once from Hugging Face, then offline

const loaded = {};
export async function loadClip({ vision = false, text = false } = {}) {
  if (vision && !loaded.vision) {
    loaded.processor = await AutoProcessor.from_pretrained(CLIP_MODEL);
    loaded.vision = await CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'fp32' });
  }
  if (text && !loaded.text) {
    loaded.tokenizer = await AutoTokenizer.from_pretrained(CLIP_MODEL);
    loaded.text = await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'fp32' });
  }
  return { ...loaded, RawImage };
}

// Unit-length text embeddings, flattened: prompt p occupies [p * CLIP_DIM, (p + 1) * CLIP_DIM)
export async function textEmbeddings(prompts) {
  const { tokenizer, text } = await loadClip({ text: true });
  const { text_embeds } = await text(tokenizer(prompts, { padding: true, truncation: true }));
  return text_embeds.normalize(2, -1).data;
}

// Two views per image: 'crop' is the square grid thumbnail (centre crop), 'full' is
// the whole image shrunk into a padded square, which keeps a tall screenshot's
// status and navigation bars in view.
export const VIEWS = { crop: ['index.json', 'embeddings.f32'], full: ['full-index.json', 'full.f32'] };

// hashes: Map(hash -> row), vectors: Float32Array of unit-length rows
export async function loadIndex(clipDir, view = 'crop') {
  const [indexFile, dataFile] = VIEWS[view];
  const indexPath = join(clipDir, indexFile);
  if (!existsSync(indexPath)) return { hashes: new Map(), vectors: new Float32Array(0) };
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  if (index.model !== CLIP_MODEL) throw new Error(`Embeddings were made with ${index.model}; delete ${clipDir} to rebuild`);
  const buf = await readFile(join(clipDir, dataFile));
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { hashes: new Map(index.hashes.map((h, i) => [h, i])), vectors };
}
