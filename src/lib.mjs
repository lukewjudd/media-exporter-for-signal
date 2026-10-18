// Shared by extract.mjs and build-db.mjs: open and decrypt a Signal local backup
// (iOS 8.30+ / Desktop "SignalBackups" format) and plan where each attachment
// lives in the archive.

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import readline from 'node:readline';
import protobuf from 'protobufjs';
import { AccountEntropyPool } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import { MessageBackupKey } from '@signalapp/libsignal-client/dist/MessageBackup.js';

// The project folder (this file lives in src/): .env, backup/, archive/ and the database live here
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where your data lives: backup/, archive/, the database and the generated pages.
// The project folder unless SIGNAL_ARCHIVE_DATA points elsewhere (the demo uses this).
export const DATA = process.env.SIGNAL_ARCHIVE_DATA ? resolve(process.env.SIGNAL_ARCHIVE_DATA) : ROOT;

// True when the given module is the script being run (works with spaces in paths)
export const isMain = url => process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]);
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
export const SELF_NAME = process.env.SIGNAL_SELF_NAME || 'Me';

// ---------- recovery key ----------

function promptHidden(question) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo the prompt but not what's typed
    rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(question); };
    rl.question(question, answer => {
      rl.close();
      process.stdout.write('\n');
      res(answer);
    });
  });
}

async function getAccountEntropyPool() {
  const raw = process.env.SIGNAL_RECOVERY_KEY || await promptHidden('Signal recovery key (64 characters, spaces OK): ');
  // The iOS app displays "0" as "=" and "O" as "#" to avoid look-alikes
  // (Signal-iOS DisplayableAccountEntropyPool.swift); undo that.
  const aep = raw.replace(/[\s-]/g, '').replace(/=/g, '0').replace(/#/g, 'O').toLowerCase();
  if (!AccountEntropyPool.isValid(aep)) {
    const stray = [...aep].flatMap((c, i) => (/[a-z0-9]/.test(c) ? [] : [`${JSON.stringify(c)} at position ${i + 1}`]));
    throw new Error(
      `That doesn't look like a valid recovery key. Expected 64 letters and digits, got ${aep.length} characters` +
      (stray.length ? `, including ${stray.join(', ')}.` : '.')
    );
  }
  return aep;
}

// ---------- backup files ----------

async function findLatestSnapshot(dir) {
  const names = (await readdir(dir)).filter(n => /^signal-backup-\d{4}(-\d{2}){5}$/.test(n)).sort();
  if (!names.length) throw new Error(`No signal-backup-* folder found in ${dir}`);
  return join(dir, names.at(-1));
}

function decryptBackupId(metadataBytes, metadataKey, LocalMetadata) {
  const meta = LocalMetadata.decode(metadataBytes);
  if (meta.version !== 1) throw new Error(`Unsupported local backup version ${meta.version}`);
  const { iv, encryptedId } = meta.backupId;
  const counter = Buffer.concat([Buffer.from(iv), Buffer.alloc(4)]);
  const d = createDecipheriv('aes-256-ctr', Buffer.from(metadataKey), counter);
  return Buffer.concat([d.update(encryptedId), d.final()]);
}

function decryptMain(data, aesKey, macKey) {
  const body = data.subarray(0, data.length - 32);
  const theirMac = data.subarray(data.length - 32);
  const ourMac = createHmac('sha256', Buffer.from(macKey)).update(body).digest();
  if (!timingSafeEqual(ourMac, theirMac)) {
    throw new Error('Backup MAC check failed: the recovery key is wrong, or the backup is incomplete.');
  }
  const d = createDecipheriv('aes-256-cbc', Buffer.from(aesKey), body.subarray(0, 16));
  return gunzipSync(Buffer.concat([d.update(body.subarray(16)), d.final()]));
}

function* readDelimited(buf) {
  const reader = protobuf.Reader.create(buf);
  while (reader.pos < reader.len) {
    const len = reader.uint32();
    yield buf.subarray(reader.pos, reader.pos + len);
    reader.pos += len;
  }
}

// Attachment files: IV(16) | AES-256-CBC ciphertext | HMAC-SHA256(32)
export function decryptAttachment(data, localKey, plaintextHash, size) {
  const tryKeys = (aesKey, macKey) => {
    const body = data.subarray(0, data.length - 32);
    const mac = createHmac('sha256', macKey).update(body).digest();
    if (!timingSafeEqual(mac, data.subarray(data.length - 32))) return null;
    const d = createDecipheriv('aes-256-cbc', aesKey, body.subarray(0, 16));
    let plain = Buffer.concat([d.update(body.subarray(16)), d.final()]);
    if (size && plain.length > size) plain = plain.subarray(0, size);
    return plain;
  };
  const k = Buffer.from(localKey);
  const plain = tryKeys(k.subarray(0, 32), k.subarray(32, 64)) ?? tryKeys(k.subarray(32, 64), k.subarray(0, 32));
  if (!plain) throw new Error('MAC mismatch');
  if (plaintextHash && !createHash('sha256').update(plain).digest().equals(Buffer.from(plaintextHash))) {
    throw new Error('plaintext hash mismatch');
  }
  return plain;
}

export const mediaNameFor = loc =>
  createHash('sha256').update(Buffer.concat([Buffer.from(loc.plaintextHash ?? []), Buffer.from(loc.localKey)])).digest('hex');

export const mediaPath = (backupDir, name) => join(backupDir, 'files', name.slice(0, 2), name);

// Decrypt the backup and return its recipients, chats and chat items.
export async function openBackup(backupDir) {
  const root = await protobuf.load([join(ROOT, 'protos/Backups.proto'), join(ROOT, 'protos/LocalBackup.proto')]);
  const BackupInfo = root.lookupType('signalbackups.BackupInfo');
  const Frame = root.lookupType('signalbackups.Frame');
  const LocalMetadata = root.lookupType('signal.backup.local.Metadata');
  const toObj = (T, bytes) => T.toObject(T.decode(bytes), { longs: Number, defaults: false });

  const snapshot = await findLatestSnapshot(backupDir);
  console.log(`Backup snapshot: ${relative(process.cwd(), snapshot) || snapshot}`);

  const aep = await getAccountEntropyPool();
  const backupKey = AccountEntropyPool.deriveBackupKey(aep);
  const backupId = decryptBackupId(await readFile(join(snapshot, 'metadata')), backupKey.deriveLocalBackupMetadataKey(), LocalMetadata);
  const { aesKey, hmacKey } = new MessageBackupKey({ backupKey, backupId });

  process.stdout.write('Decrypting message archive... ');
  const plain = decryptMain(await readFile(join(snapshot, 'main')), aesKey, hmacKey);
  console.log(`ok (${(plain.length / 1e6).toFixed(1)} MB)`);

  const frames = readDelimited(plain);
  const info = toObj(BackupInfo, frames.next().value);
  console.log(`Backup made ${new Date(info.backupTimeMs).toLocaleString()} by Signal ${info.currentAppVersion ?? '?'}`);

  const recipients = new Map();
  const chats = new Map();
  const items = [];
  for (const bytes of frames) {
    const f = toObj(Frame, bytes);
    if (f.recipient) recipients.set(f.recipient.id, f.recipient);
    else if (f.chat) chats.set(f.chat.id, f.chat);
    else if (f.chatItem) items.push(f.chatItem);
  }
  items.sort((a, b) => a.dateSent - b.dateSent);
  return { info, recipients, chats, items };
}

// ---------- naming ----------

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'video/3gpp': '3gp', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'text/x-signal-plain': 'txt', 'text/plain': 'txt',
};

const clean = s => (s ?? '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function extFor(ptr) {
  const fromName = ptr.fileName && extname(ptr.fileName).slice(1);
  if (fromName) return fromName.toLowerCase();
  const ct = (ptr.contentType ?? '').toLowerCase();
  return EXT[ct] ?? (ct.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin');
}

export function recipientName(r, selfLabel) {
  if (r.self) return selfLabel;
  if (r.group) return r.group.snapshot?.title?.title || 'Unnamed group';
  if (r.releaseNotes) return 'Signal Release Notes';
  const c = r.contact;
  if (!c) return `recipient-${r.id}`;
  const join2 = (a, b) => [a, b].filter(Boolean).join(' ');
  return (
    join2(c.nickname?.given, c.nickname?.family) ||
    join2(c.systemGivenName, c.systemFamilyName) || c.systemNickname ||
    join2(c.profileGivenName, c.profileFamilyName) ||
    c.username || (c.e164 ? `+${c.e164}` : '') || `contact-${r.id}`
  );
}

// ---------- manifest ----------
// archive/manifest.json remembers which archived file belongs to which message,
// so media deleted from the phone stays linked after later syncs. Keys are
// stable across backups (Signal's own chat/recipient ids are not).

export const MANIFEST_FILE = 'manifest.json';

export async function loadManifest(archiveDir) {
  const p = join(archiveDir, MANIFEST_FILE);
  if (!existsSync(p)) return { version: 1, messages: {} };
  const m = JSON.parse(await readFile(p, 'utf8'));
  if (m.version !== 1) throw new Error(`Unsupported manifest version ${m.version}`);
  return m;
}

export async function saveManifest(archiveDir, manifest) {
  const p = join(archiveDir, MANIFEST_FILE);
  await writeFile(`${p}.tmp`, JSON.stringify(manifest));
  await rename(`${p}.tmp`, p);
}

const hex = b => Buffer.from(b).toString('hex');

// A recipient's identity that survives between backups
export function stableKey(r) {
  if (!r) return 'unknown';
  if (r.self) return 'self';
  if (r.releaseNotes) return 'release-notes';
  if (r.group?.masterKey) return `group:${createHash('sha256').update(Buffer.from(r.group.masterKey)).digest('hex').slice(0, 32)}`;
  const c = r.contact;
  if (c?.aci) return `aci:${hex(c.aci)}`;
  if (c?.pni) return `pni:${hex(c.pni)}`;
  if (c?.e164) return `e164:${c.e164}`;
  if (c?.username) return `user:${c.username}`;
  return `recipient:${r.id}`;
}

// Walk every message and decide its chat folder and each attachment's archive path
// (relative to the archive folder). Paths already in the manifest are reused, and
// archived files the phone no longer has come back as `archivedOnly`.
// Returns one entry per message that has text or attachments, in date order.
export function planArchive({ recipients, chats, items }, manifest = { messages: {} }) {
  const chatFolder = new Map();
  const chatKey = new Map();
  const usedFolder = new Set();
  for (const [id, chat] of chats) {
    const r = recipients.get(chat.recipientId);
    let name = clean(r ? recipientName(r, 'Note to Self') : `chat-${id}`) || `chat-${id}`;
    if (usedFolder.has(name.toLowerCase())) name = `${name} (${id})`;
    usedFolder.add(name.toLowerCase());
    chatFolder.set(id, name);
    chatKey.set(id, stableKey(r));
  }
  const chatIdByKey = new Map([...chatKey].map(([id, k]) => [k, id]));
  const senderName = id => {
    const r = recipients.get(id);
    return r ? recipientName(r, SELF_NAME) : 'Unknown';
  };
  const archivedOnly = f => ({ ...f, archivedOnly: true });

  const entries = [];
  const seen = new Set();
  const usedDest = new Set();
  for (const m of Object.values(manifest.messages)) for (const f of m.files) usedDest.add(f.path.toLowerCase());

  for (const it of items) {
    const msg = it.standardMessage ?? (it.viewOnceMessage && { attachments: [it.viewOnceMessage.attachment] });
    if (!msg || !chatFolder.has(it.chatId)) continue;
    const folder = chatFolder.get(it.chatId);
    const date = new Date(it.dateSent);
    const sender = senderName(it.authorId);
    const key = `${chatKey.get(it.chatId)}|${stableKey(recipients.get(it.authorId))}|${it.dateSent}`;
    seen.add(key);
    const prior = new Map((manifest.messages[key]?.files ?? []).map(f => [f.hash, f]));
    const entry = { key, chatKey: chatKey.get(it.chatId), item: it, chatId: it.chatId, folder, date, sender, text: msg.text?.body ?? '', files: [] };
    if (msg.longText?.locatorInfo?.localKey) entry.longText = msg.longText;

    const unmatchedMissing = [];
    (msg.attachments ?? []).forEach((att, i) => {
      const ptr = att?.pointer;
      if (!ptr) return;
      const loc = ptr.locatorInfo ?? {};
      const hash = loc.plaintextHash ? hex(loc.plaintextHash) : null;
      const meta = {
        hash, contentType: ptr.contentType ?? '', size: loc.size ?? 0, caption: ptr.caption ?? null, fileName: ptr.fileName ?? null,
        width: ptr.width ?? null, height: ptr.height ?? null, duration: ptr.audioDurationSeconds ?? null,
      };
      const known = hash && prior.get(hash);
      if (known) prior.delete(hash);
      if (!loc.localKey || !loc.plaintextHash) {
        if (known) entry.files.push(archivedOnly({ ...known, ...meta, hash }));
        else { const f = { ...meta, missing: true }; entry.files.push(f); unmatchedMissing.push(f); }
        return;
      }
      let path = known?.path;
      if (!path) {
        const base = ptr.fileName
          ? `${stamp(date)}_${clean(sender)}_${clean(ptr.fileName.replace(/\.[^.]+$/, ''))}`
          : `${stamp(date)}_${clean(sender)}${msg.attachments.length > 1 ? `_${i + 1}` : ''}`;
        path = join(folder, String(date.getFullYear()), `${base}.${extFor(ptr)}`);
        for (let n = 2; usedDest.has(path.toLowerCase()); n++) {
          path = join(folder, String(date.getFullYear()), `${base}_${n}.${extFor(ptr)}`);
        }
        usedDest.add(path.toLowerCase());
      }
      entry.files.push({ ...meta, path, loc, mediaName: mediaNameFor(loc) });
    });
    // Archived files the phone has dropped; they replace "not in backup" placeholders one for one
    for (const f of prior.values()) {
      const placeholder = unmatchedMissing.shift();
      if (placeholder) entry.files.splice(entry.files.indexOf(placeholder), 1);
      entry.files.push(archivedOnly(f));
    }

    if (entry.text || entry.files.length || entry.longText) entries.push(entry);
  }

  // Messages with archived media that are no longer in the backup at all
  for (const [key, m] of Object.entries(manifest.messages)) {
    if (seen.has(key)) continue;
    const chatId = chatIdByKey.get(m.chatKey) ?? null;
    entries.push({
      key, chatKey: m.chatKey, item: null, chatId, folder: chatId != null ? chatFolder.get(chatId) : m.folder,
      date: new Date(m.sentAt), sender: m.sender, text: m.text ?? '', files: m.files.map(archivedOnly), goneFromPhone: true,
    });
  }
  entries.sort((a, b) => a.date - b.date);
  return { entries, chatFolder, senderName };
}

// Manifest record for one message: only files that actually exist in the archive
export function manifestRecord(entry, archiveDir) {
  const files = entry.files
    .filter(f => f.path && f.hash && existsSync(join(archiveDir, f.path)))
    .map(({ hash, path, contentType, size, caption, fileName, width, height, duration }) =>
      ({ hash, path, contentType, size, caption, fileName, width, height, duration }));
  if (!files.length) return null;
  return { chatKey: entry.chatKey, folder: entry.folder, sender: entry.sender, sentAt: entry.date.getTime(), text: entry.text, files };
}
