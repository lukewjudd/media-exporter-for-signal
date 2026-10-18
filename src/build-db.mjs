#!/usr/bin/env node
// Load the decrypted backup's chats, messages and attachments into DuckDB,
// so you can see what's taking up space.
//
// Usage: node src/build-db.mjs [backupDir] [dbPath] [archiveDir]
//   defaults: ./backup, ./signal.duckdb, ./archive
//
// Run extract.mjs first: media deleted from the phone is still included, via the
// archive's manifest, with on_phone = false.
//
// Sizes are each attachment's original (plaintext) size as recorded in the backup,
// which is roughly what it occupies on the phone.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DATA, SELF_NAME, decryptAttachment, loadManifest, mediaNameFor, mediaPath, openBackup, planArchive, recipientName } from './lib.mjs';

const backupDir = resolve(process.argv[2] ?? join(DATA, 'backup'));
const dbPath = resolve(process.argv[3] ?? join(DATA, 'signal.duckdb'));
const archiveDir = resolve(process.argv[4] ?? join(DATA, 'archive'));

const category = ct =>
  ct.startsWith('image/') ? (ct === 'image/gif' ? 'gif' : 'image')
  : ct.startsWith('video/') ? 'video'
  : ct.startsWith('audio/') ? 'audio'
  : 'file';

const kindOf = r => (!r ? 'unknown' : r.self ? 'self' : r.group ? 'group' : r.contact ? 'direct' : 'other');

async function main() {
  const backup = await openBackup(backupDir);
  const { entries, chatFolder } = planArchive(backup, await loadManifest(archiveDir));

  const recipients = [...backup.recipients.values()].map(r => ({
    recipient_id: r.id, name: recipientName(r, SELF_NAME), kind: kindOf(r),
  }));
  const chats = [...backup.chats.values()].map(c => ({
    chat_id: c.id, name: chatFolder.get(c.id), kind: kindOf(backup.recipients.get(c.recipientId)),
    recipient_id: c.recipientId, archived: !!c.archived,
  }));

  const messages = [];
  const attachments = [];
  const seen = new Set();
  let messageId = 0;
  for (const e of entries) {
    // Long messages keep their full text in an attached file
    if (e.longText) {
      const loc = e.longText.locatorInfo;
      try { e.text = decryptAttachment(await readFile(mediaPath(backupDir, mediaNameFor(loc))), loc.localKey, loc.plaintextHash, loc.size).toString('utf8'); }
      catch { /* keep the short version */ }
    }
    const id = ++messageId;
    const it = e.item;
    messages.push({
      message_id: id, chat_id: e.chatId, author_id: it?.authorId ?? null, sender: e.sender,
      sent_at: e.date.toISOString(), sent_ms: e.date.getTime(), outgoing: it ? !!it.outgoing : e.sender === SELF_NAME, body: e.text,
      attachment_count: e.files.length, on_phone: !e.goneFromPhone,
    });
    for (const [position, f] of e.files.entries()) {
      // The phone stores identical files once, so only the first copy counts toward storage
      const hash = f.hash;
      const duplicate = hash != null && seen.has(hash);
      if (hash) seen.add(hash);
      attachments.push({
        attachment_id: attachments.length + 1, message_id: id, position, chat_id: e.chatId, sender: e.sender,
        sent_at: e.date.toISOString(), content_type: f.contentType, category: category(f.contentType),
        size_bytes: f.size, file_name: f.fileName, caption: f.caption, width: f.width, height: f.height,
        duration_s: f.duration, plaintext_hash: hash, duplicate,
        on_phone: !f.missing && !f.archivedOnly,
        archive_path: f.path ? join('archive', f.path) : null,
        in_archive: f.path ? existsSync(join(archiveDir, f.path)) : false,
      });
    }
  }

  // Stage as NDJSON, then load with explicit schemas
  const tmp = await mkdtemp(join(tmpdir(), 'signal-db-'));
  try {
    const stage = async (name, rows) => {
      const p = join(tmp, `${name}.ndjson`);
      await writeFile(p, rows.map(r => JSON.stringify(r)).join('\n'));
      return p;
    };
    const files = {
      recipients: await stage('recipients', recipients),
      chats: await stage('chats', chats),
      messages: await stage('messages', messages),
      attachments: await stage('attachments', attachments),
    };

    if (existsSync(dbPath)) await rm(dbPath);
    const db = await DuckDBInstance.create(dbPath);
    const con = await db.connect();
    // Rows are stored sorted (by chat, then time for messages), so the chat viewer's
    // "messages around X" lookups only touch a few row groups
    const load = (table, path, columns, orderBy = '') =>
      con.run(`CREATE TABLE ${table} AS SELECT * FROM read_json('${path}', format = 'newline_delimited', columns = ${columns}) ${orderBy}`);

    await load('recipients', files.recipients, `{recipient_id: 'BIGINT', name: 'VARCHAR', kind: 'VARCHAR'}`);
    await load('chats', files.chats, `{chat_id: 'BIGINT', name: 'VARCHAR', kind: 'VARCHAR', recipient_id: 'BIGINT', archived: 'BOOLEAN'}`);
    await load('messages', files.messages, `{message_id: 'BIGINT', chat_id: 'BIGINT', author_id: 'BIGINT', sender: 'VARCHAR',
      sent_at: 'TIMESTAMPTZ', sent_ms: 'BIGINT', outgoing: 'BOOLEAN', body: 'VARCHAR', attachment_count: 'INTEGER', on_phone: 'BOOLEAN'}`,
      'ORDER BY chat_id, sent_ms, message_id');
    await load('attachments', files.attachments, `{attachment_id: 'BIGINT', message_id: 'BIGINT', position: 'INTEGER', chat_id: 'BIGINT', sender: 'VARCHAR',
      sent_at: 'TIMESTAMPTZ', content_type: 'VARCHAR', category: 'VARCHAR', size_bytes: 'BIGINT', file_name: 'VARCHAR',
      caption: 'VARCHAR', width: 'INTEGER', height: 'INTEGER', duration_s: 'DOUBLE', plaintext_hash: 'VARCHAR',
      duplicate: 'BOOLEAN', on_phone: 'BOOLEAN', archive_path: 'VARCHAR', in_archive: 'BOOLEAN'}`,
      'ORDER BY message_id, position');

    // Convenience view: one row per chat with its storage footprint
    await con.run(`
      CREATE VIEW chat_storage AS
      SELECT c.chat_id, c.name, c.kind,
             count(DISTINCT m.message_id) AS messages,
             count(a.attachment_id) FILTER (WHERE NOT a.duplicate) AS files,
             coalesce(sum(a.size_bytes) FILTER (WHERE NOT a.duplicate), 0) AS bytes,
             coalesce(sum(a.size_bytes) FILTER (WHERE NOT a.duplicate AND a.on_phone), 0) AS phone_bytes,
             coalesce(sum(a.size_bytes) FILTER (WHERE NOT a.duplicate AND a.category = 'video'), 0) AS video_bytes,
             coalesce(sum(a.size_bytes) FILTER (WHERE NOT a.duplicate AND a.category IN ('image', 'gif')), 0) AS image_bytes,
             min(m.sent_at) AS first_message, max(m.sent_at) AS last_message
      FROM chats c
      LEFT JOIN messages m USING (chat_id)
      LEFT JOIN attachments a USING (message_id)
      GROUP BY ALL
      ORDER BY bytes DESC`);

    const r = await con.runAndReadAll(`SELECT
      (SELECT count(*) FROM messages) messages,
      (SELECT count(*) FROM attachments) attachments,
      (SELECT round(sum(size_bytes) FILTER (WHERE NOT duplicate) / 1e9, 2) FROM attachments) gb,
      (SELECT round(sum(size_bytes) FILTER (WHERE NOT duplicate AND on_phone) / 1e9, 2) FROM attachments) phone_gb`);
    const [s] = r.getRowObjectsJson();
    console.log(`Wrote ${dbPath}: ${s.messages} messages, ${s.attachments} attachments, ${s.gb} GB of media (${s.phone_gb} GB still on the phone)`);
    con.closeSync();
    db.closeSync();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
