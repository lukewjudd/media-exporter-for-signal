// Writes Signal local backups the way the iPhone app does (same folder layout and
// encryption), from made-up chats and media. Used by the self-test and the demo.

import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { AccountEntropyPool } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import { MessageBackupKey } from '@signalapp/libsignal-client/dist/MessageBackup.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const protos = await protobuf.load([join(ROOT, 'protos/Backups.proto'), join(ROOT, 'protos/LocalBackup.proto')]);
const T = n => protos.lookupType(n);

// One account: a recovery key, plus media keyed by label so later backups reuse
// the same file keys, as the phone does
export function createAccount() {
  const recoveryKey = AccountEntropyPool.generate();
  const backupKey = AccountEntropyPool.deriveBackupKey(recoveryKey);
  const backupId = randomBytes(16);
  const files = new Map(); // label -> { plain, loc }

  // A locatorInfo for the given bytes, encrypted with its own local key
  function media(label, plain) {
    if (!files.has(label)) {
      plain ??= randomBytes(2000 + files.size * 100);
      files.set(label, { plain, loc: { localKey: randomBytes(64), plaintextHash: createHash('sha256').update(plain).digest(), size: plain.length } });
    }
    return files.get(label).loc;
  }

  // Write a backup folder: <dir>/signal-backup-…/{metadata,main,files} and <dir>/files/xx/<name>
  function writeBackup(dir, frames, { snapshot = 'signal-backup-2026-10-17-22-39-33', appVersion = 'fake' } = {}) {
    rmSync(dir, { recursive: true, force: true });
    const snap = join(dir, snapshot);
    mkdirSync(snap, { recursive: true });
    const iv12 = randomBytes(12);
    const c = createCipheriv('aes-256-ctr', Buffer.from(backupKey.deriveLocalBackupMetadataKey()), Buffer.concat([iv12, Buffer.alloc(4)]));
    writeFileSync(join(snap, 'metadata'), T('signal.backup.local.Metadata').encode({ version: 1, backupId: { iv: iv12, encryptedId: Buffer.concat([c.update(backupId), c.final()]) } }).finish());

    const parts = [T('signalbackups.BackupInfo').encode({ version: 1, backupTimeMs: Date.now(), currentAppVersion: appVersion }).finish(),
      ...frames.map(f => T('signalbackups.Frame').encode(T('signalbackups.Frame').fromObject(f)).finish())];
    const delim = Buffer.concat(parts.map(p => { const w = protobuf.Writer.create(); w.uint32(p.length); return Buffer.concat([w.finish(), p]); }));
    const mk = new MessageBackupKey({ backupKey, backupId });
    const iv = randomBytes(16);
    const ci = createCipheriv('aes-256-cbc', Buffer.from(mk.aesKey), iv);
    const body = Buffer.concat([iv, ci.update(gzipSync(delim)), ci.final()]);
    writeFileSync(join(snap, 'main'), Buffer.concat([body, createHmac('sha256', Buffer.from(mk.hmacKey)).update(body).digest()]));

    // Only write media files that this backup's messages reference
    const byLoc = new Map([...files.values()].map(v => [v.loc, v.plain]));
    for (const f of frames) {
      for (const a of f.chatItem?.standardMessage?.attachments ?? []) {
        const loc = a.pointer.locatorInfo;
        if (!loc?.localKey) continue;
        const ivf = randomBytes(16);
        const cf = createCipheriv('aes-256-cbc', loc.localKey.subarray(0, 32), ivf);
        const enc = Buffer.concat([ivf, cf.update(byLoc.get(loc)), cf.final()]);
        const name = createHash('sha256').update(Buffer.concat([loc.plaintextHash, loc.localKey])).digest('hex');
        mkdirSync(join(dir, 'files', name.slice(0, 2)), { recursive: true });
        writeFileSync(join(dir, 'files', name.slice(0, 2), name), Buffer.concat([enc, createHmac('sha256', loc.localKey.subarray(32)).update(enc).digest()]));
      }
    }
  }

  return { recoveryKey, media, writeBackup };
}
