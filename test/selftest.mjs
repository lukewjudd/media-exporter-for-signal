#!/usr/bin/env node
// End-to-end check with a throwaway key: build a fake backup, sync it, then
// "delete media on the phone" in a second backup and sync again. Archived files
// must stay on disk, stay linked from the chat pages, and be flagged in the DB.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { createAccount } from './fake-backup.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { recoveryKey: aep, media, writeBackup } = createAccount();

const img = label => ({ pointer: { contentType: 'image/jpeg', locatorInfo: media(label) } });

const people = [
  { recipient: { id: 1, self: {} } },
  { recipient: { id: 2, contact: { aci: Buffer.alloc(16, 2), profileGivenName: 'Sam' } } },
  { recipient: { id: 3, group: { masterKey: Buffer.alloc(32, 3), snapshot: { title: { title: 'Family #1' } } } } },
  { chat: { id: 10, recipientId: 2 } }, { chat: { id: 11, recipientId: 3 } },
];
const t = s => Date.parse(s);
const msg1 = (atts) => ({ chatItem: { chatId: 10, authorId: 2, dateSent: t('2021-03-14T18:32:00'), incoming: {}, standardMessage: { text: { body: 'beach day' }, attachments: atts } } });
const msg2 = (att) => ({ chatItem: { chatId: 11, authorId: 1, dateSent: t('2023-07-01T09:00:00'), outgoing: {}, standardMessage: { text: { body: 'party' }, attachments: [att] } } });
const msg3 = { chatItem: { chatId: 11, authorId: 2, dateSent: t('2024-01-02T10:00:00'), incoming: {}, standardMessage: { attachments: [img('c')] } } };
const msg4 = { chatItem: { chatId: 10, authorId: 1, dateSent: t('2025-05-05T05:05:05'), outgoing: {}, standardMessage: { attachments: [img('d')] } } };

const work = mkdtempSync(join(tmpdir(), 'signal-selftest-'));
const backup = join(work, 'backup'), archive = join(work, 'archive'), db = join(work, 'signal.duckdb');
const env = { ...process.env, SIGNAL_RECOVERY_KEY: aep, SIGNAL_SELF_NAME: 'Me' };
const run = (script, ...args) => execFileSync('node', [join(ROOT, 'src', script), ...args], { env, cwd: work, stdio: 'pipe' }).toString();
const sync = () => { run('extract.mjs', backup, archive); run('build-db.mjs', backup, db, archive); };
const query = async sql => {
  const inst = await DuckDBInstance.create(db, { access_mode: 'READ_ONLY' });
  const con = await inst.connect();
  const r = (await con.runAndReadAll(sql)).getRowObjectsJson();
  con.closeSync(); inst.closeSync();
  return r;
};

try {
  // 1. Everything on the phone
  writeBackup(backup, [...people, msg1([img('a1'), img('a2')]), msg2(img('b')), msg3, msg4]);
  sync();
  const manifest1 = JSON.parse(readFileSync(join(archive, 'manifest.json'), 'utf8'));
  const paths = Object.values(manifest1.messages).flatMap(m => m.files.map(f => f.path)).sort();
  assert.equal(paths.length, 5, 'five archived files in manifest');
  for (const p of paths) assert.ok(existsSync(join(archive, p)), `${p} exists`);
  assert.deepEqual(await query(`SELECT count(*) FILTER (WHERE on_phone)::INT n FROM attachments`), [{ n: 5 }]);

  // 2. Delete media on the phone: a2 removed from msg1, msg2's pointer loses its local file,
  //    msg3 (media only) disappears entirely, msg4 untouched
  const b = img('b');
  writeBackup(backup, [...people, msg1([img('a1')]),
    msg2({ pointer: { contentType: 'image/jpeg', locatorInfo: { plaintextHash: b.pointer.locatorInfo.plaintextHash, size: b.pointer.locatorInfo.size } } }), msg4]);
  sync();
  const manifest2 = JSON.parse(readFileSync(join(archive, 'manifest.json'), 'utf8'));
  const paths2 = Object.values(manifest2.messages).flatMap(m => m.files.map(f => f.path)).sort();
  assert.deepEqual(paths2, paths, 'manifest keeps every file at the same path');
  for (const p of paths) assert.ok(existsSync(join(archive, p)), `${p} still exists`);

  const rows = await query(`SELECT on_phone, count(*)::INT n FROM attachments GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(rows, [{ on_phone: false, n: 3 }, { on_phone: true, n: 2 }], 'three files flagged as archived only');
  assert.deepEqual(await query(`SELECT count(*)::INT n FROM attachments WHERE NOT in_archive`), [{ n: 0 }]);

  // Chat pages still link every file, and say which are archived only
  const fam = readFileSync(join(archive, 'Family #1', 'index.html'), 'utf8');
  const sam = readFileSync(join(archive, 'Sam', 'index.html'), 'utf8');
  for (const p of paths) {
    const link = `../${p.split('/').map(encodeURIComponent).join('/')}`;
    assert.ok(fam.includes(link) || sam.includes(link), `${p} linked from a chat page`);
  }
  assert.equal((fam + sam).match(/Archived only/g)?.length, 3);
  assert.ok(!(fam + sam).includes('not in backup'), 'no "not in backup" placeholders for archived files');

  // Dashboard builds and counts the cleared bytes
  run('dashboard.mjs', db, join(work, 'dashboard.html'));
  assert.ok(existsSync(join(work, 'dashboard.html')));

  console.log('selftest passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
