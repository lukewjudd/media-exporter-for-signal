#!/usr/bin/env node
// Build a demo archive from made-up chats, so you can try the app or take
// screenshots without using anyone's real photos. Writes an encrypted Signal
// backup in the real format, then runs the whole pipeline on it.
//
// Photos come from Lorem Picsum (Unsplash photos, free to use); screenshots,
// videos and a voice note are generated. Nothing here touches your own archive.
//
// Usage: npm run demo:build   then   npm run demo

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { createAccount } from '../test/fake-backup.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEMO = join(ROOT, 'demo');
const CACHE = join(DEMO, 'cache');   // downloaded photos, kept between builds
const DATA = join(DEMO, 'data');     // the demo's backup/, archive/ and database
mkdirSync(CACHE, { recursive: true });

// A fixed seed, so every build makes the same demo
let seed = 20240607;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = list => list[Math.floor(rnd() * list.length)];

// ---------- media ----------

async function picsum(id, w, h, extra = '') {
  const file = join(CACHE, `${id}-${w}x${h}${extra.replace(/\W/g, '')}.jpg`);
  if (!existsSync(file)) {
    const res = await fetch(`https://picsum.photos/id/${id}/${w}/${h}${extra}`);
    if (!res.ok) throw new Error(`Couldn't download photo ${id}: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(file);
}

// Picsum photos with no faces, for everyday pictures (checked once with the face detector)
const SCENES = [
  10, 27, 43, 59, 76, 93, 111, 127, 144, 162, 178, 195, 213, 231, 249, 266, 282, 301, 318, 336,
  354, 371, 388, 407, 425, 443, 460, 479, 496, 512, 528, 545, 562, 579, 602, 618, 638, 656, 672, 689,
  715, 733, 765, 783, 802, 819, 836, 857, 873, 889, 908, 926, 943, 960, 979, 995, 1014, 1032, 1050, 1066,
];
// Three portraits; several crops of each give the face grouping someone to group
const PORTRAITS = { Maya: 996, Isla: 978, Nina: 64 };
const PORTRAIT_CROPS = [[1600, 1200, ''], [1200, 1600, ''], [1500, 1500, ''], [1600, 1100, '?grayscale'], [1300, 1600, '']];

// A phone screenshot drawn as SVG: status bar, then whatever the body draws
const FONT = 'font-family="-apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"';
function phone(body, { w = 1179, h = 2556, bg = '#ffffff', ink = '#000000', bar = true } = {}) {
  const status = bar ? `<text x="96" y="110" ${FONT} font-size="50" font-weight="600" fill="${ink}">9:41</text>
    <rect x="${w - 190}" y="78" width="88" height="42" rx="12" fill="none" stroke="${ink}" stroke-width="4"/><rect x="${w - 184}" y="84" width="68" height="30" rx="7" fill="${ink}"/>` : '';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${status}${body}</svg>`)).png().toBuffer();
}
const lines = (x, y, size, texts, fill = '#000', gap = 1.35) => texts.map((t, i) => `<text x="${x}" y="${y + i * size * gap}" ${FONT} font-size="${size}" fill="${fill}">${t}</text>`).join('');

async function screenshots() {
  const bubble = (y, text, out) => {
    const w = Math.min(820, 60 + text.length * 26);
    const x = out ? 1179 - 60 - w : 60;
    return `<rect x="${x}" y="${y}" width="${w}" height="110" rx="55" fill="${out ? '#2c6bed' : '#e9e9eb'}"/>` +
      `<text x="${x + 40}" y="${y + 70}" ${FONT} font-size="44" fill="${out ? '#fff' : '#000'}">${text}</text>`;
  };
  return {
    chat: await phone(lines(380, 250, 52, ['Weekend Away'], '#000') +
      ['Are we still on for Saturday?', 'Yes! Leaving at 8', 'I\'ll bring the snacks', 'Can someone grab ice?', 'On it 🙌', 'See you all soon']
        .map((t, i) => bubble(380 + i * 170, t, i % 2 === 1)).join('')),
    post: await phone(`<circle cx="150" cy="330" r="60" fill="#c7d2fe"/>` + lines(240, 320, 46, ['Coastal Walks', '@coastalwalks'], '#111') +
      lines(90, 520, 54, ['Sunrise from the headland this', 'morning. Worth the 5am alarm.'], '#111') +
      `<rect x="90" y="700" width="1000" height="760" rx="30" fill="#93c5fd"/><circle cx="820" cy="900" r="110" fill="#fde68a"/>` +
      `<path d="M90 1300 L420 1000 L700 1250 L900 1080 L1090 1300 L1090 1460 L90 1460 Z" fill="#1e3a8a"/>` +
      lines(90, 1560, 40, ['8:12 AM · 12 May', '412 Reposts   38 Quotes   5,180 Likes'], '#6b7280')),
    map: await phone(`<rect y="160" width="1179" height="2396" fill="#e5f0e8"/>` +
      [300, 700, 1200, 1700].map(y => `<rect x="0" y="${y}" width="1179" height="46" fill="#fff"/>`).join('') +
      [250, 640, 980].map(x => `<rect x="${x}" y="160" width="40" height="2396" fill="#fff"/>`).join('') +
      `<circle cx="600" cy="1100" r="46" fill="#ef4444"/><rect x="0" y="2050" width="1179" height="506" rx="40" fill="#fff"/>` +
      lines(80, 2160, 50, ['Harbour Café', '12 min walk · Open until 4 pm'], '#111')),
    receipt: await phone(lines(90, 300, 60, ['Order confirmed'], '#111') + lines(90, 420, 44, ['Thanks! Your order is on its way.', '', 'Camping chairs ×2          $89.00', 'Lantern                          $24.50', 'Delivery                          Free', '', 'Total                             $113.50'], '#333')),
    recipe: await phone(lines(90, 300, 62, ['Lemon olive oil cake'], '#111') + lines(90, 430, 42, ['3 eggs', '200 g sugar', '2 lemons, zest and juice', '120 ml olive oil', '200 g flour', '2 tsp baking powder', '', 'Bake 40 min at 170°C.'], '#333'), { bg: '#fffbeb' }),
    ticket: await phone(`<rect x="70" y="260" width="1040" height="1500" rx="40" fill="#0f172a"/>` + lines(140, 400, 56, ['SYD → MEL', 'Flight QF 401', 'Seat 14C · Boarding 7:10'], '#e2e8f0') +
      [...Array(30)].map((_, i) => `<rect x="${160 + i * 29}" y="1300" width="${i % 3 ? 14 : 8}" height="260" fill="#e2e8f0"/>`).join(''), { bg: '#1e293b', ink: '#fff' }),
    // A screenshot cropped to just the post: no status bar, but still clearly from a screen
    cropped: await phone(lines(90, 150, 46, ['Book Club Reads'], '#e5e7eb') + lines(90, 280, 52, ['Next month: The Remains of the Day.', 'Bring a snack and an opinion.'], '#f9fafb') +
      lines(90, 500, 38, ['10:24 · 3 Mar'], '#9ca3af'), { w: 1179, h: 580, bg: '#111827', bar: false }),
  };
}

// A few seconds of gentle zoom over a photo, and a short tone for a voice note
function video(photo, name) {
  const src = join(CACHE, `${name}.jpg`), out = join(CACHE, `${name}.mp4`);
  if (!existsSync(out)) {
    writeFileSync(src, photo);
    execFileSync(ffmpegPath, ['-v', 'error', '-y', '-loop', '1', '-i', src, '-vf', "scale=1600:-2,zoompan=z='min(zoom+0.0015,1.25)':d=90:s=1280x720:fps=30", '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out]);
  }
  return readFileSync(out);
}
function voiceNote() {
  const out = join(CACHE, 'voice.m4a');
  if (!existsSync(out)) execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', '-b:a', '64k', out]);
  return readFileSync(out);
}

// ---------- chats ----------

const SELF = 1;
const PEOPLE = { Mum: 2, Dad: 3, Maya: 4, Isla: 5, Nina: 6, Sam: 7, Priya: 8 };
const CHATS = [
  { id: 101, name: 'Family', group: true, members: ['Mum', 'Dad', 'Maya'] },
  { id: 102, name: 'Weekend Away 🏕️', group: true, members: ['Isla', 'Nina', 'Sam'] },
  { id: 103, name: 'Book Club', group: true, members: ['Isla', 'Priya'] },
  { id: 104, name: 'Maya', with: 'Maya' },
  { id: 105, name: 'Nina', with: 'Nina' },
  { id: 106, name: 'Sam', with: 'Sam' },
  { id: 107, name: 'Note to Self', self: true },
];
// Short scripted exchanges, replayed at different times so chats read naturally.
// 'me' is you, '*' is anyone else in the chat.
const CONVOS = {
  Family: [
    [['Mum', 'Dinner on Sunday?'], ['me', 'Yes! What time?'], ['Mum', '6 if that works'], ['Dad', 'I\'ll do the roast'], ['Maya', 'I\'ll bring dessert 🍰']],
    [['Dad', 'The dog found a stick bigger than him'], ['Maya', 'Haha classic'], ['me', 'He\'s so proud of himself']],
    [['Maya', 'Running 10 min late, sorry!'], ['Mum', 'No rush, drive safe']],
    [['Mum', 'Made the lemon cake again'], ['me', 'Save me a slice!'], ['Mum', 'Already did ❤️']],
    [['me', 'Happy birthday Dad!! 🎂'], ['Maya', 'Happy birthday!!'], ['Dad', 'Thanks both, lovely day']],
  ],
  'Weekend Away 🏕️': [
    [['Isla', 'Campsite is booked!'], ['Sam', 'Legend'], ['me', 'Who has the big tent?'], ['Nina', 'Me, I\'ll bring it']],
    [['Sam', 'Leaving Friday at 4?'], ['Isla', 'Works for me'], ['me', 'Same, I\'ll grab snacks on the way']],
    [['Nina', 'The view from the top 😍'], ['Isla', 'Unreal'], ['me', 'Worth the climb']],
    [['Isla', 'Bring warm layers, it gets cold at night'], ['Sam', 'Noted 🧥']],
    [['me', 'Best trip yet'], ['Nina', 'Same time next year?'], ['Sam', 'Already in the calendar']],
  ],
  'Book Club': [
    [['Priya', 'Finished it last night'], ['Isla', 'That ending though'], ['me', 'No spoilers, I\'m on chapter 12!']],
    [['Isla', 'Next pick?'], ['me', 'Something short this time 😅'], ['Priya', 'Agreed']],
    [['Priya', 'Can we do Thursday instead?'], ['Isla', 'Thursday works'], ['me', 'I\'ll host']],
  ],
  Maya: [
    [['Maya', 'Coffee tomorrow?'], ['me', 'Yes please, 10?'], ['Maya', 'Perfect, see you there']],
    [['Maya', 'Look where I am'], ['me', 'So jealous'], ['Maya', 'Wish you were here']],
    [['me', 'That was so fun'], ['Maya', 'Sending you the photos now']],
  ],
  Nina: [
    [['Nina', 'Beach day?'], ['me', 'Always'], ['Nina', 'Pick you up at 9']],
    [['Nina', 'New café near work'], ['me', 'Let\'s try it Friday'], ['Nina', 'Deal']],
    [['me', 'Did you see this?'], ['Nina', 'Can\'t stop laughing 😂']],
  ],
  Sam: [
    [['Sam', 'Game tonight?'], ['me', 'Got the tickets'], ['Sam', 'Legend 🙌']],
    [['me', 'Wanna grab lunch?'], ['Sam', 'Yes, usual place?'], ['me', 'See you at 12:30']],
    [['Sam', 'Running late, sorry'], ['me', 'All good']],
  ],
  'Note to Self': [[['me', 'Remember: renew passport']], [['me', 'Gift ideas: book, candle, plant']], [['me', 'Things to pack: charger, rain jacket']]],
};

function frames(media, assets) {
  const out = [{ recipient: { id: SELF, self: {} } }];
  const aci = n => Buffer.from(String(n).padStart(16, '0'));
  for (const [name, id] of Object.entries(PEOPLE)) out.push({ recipient: { id, contact: { aci: aci(id), profileGivenName: name } } });
  for (const c of CHATS) {
    if (c.group) out.push({ recipient: { id: c.id + 1000, group: { masterKey: Buffer.alloc(32, c.id % 256), snapshot: { title: { title: c.name } } } } });
  }
  for (const c of CHATS) out.push({ chat: { id: c.id, recipientId: c.self ? SELF : c.group ? c.id + 1000 : PEOPLE[c.with] } });

  // Spread messages over four years, with some on today's date in earlier years for "On this day"
  const start = Date.parse('2022-02-01T09:00:00'), end = Date.now() - 86400e3;
  const today = new Date();
  const onThisDay = [1, 2, 3].map(y => new Date(today.getFullYear() - y, today.getMonth(), today.getDate(), 11 + y, 20).getTime());
  // Most activity is recent, like a real phone: dates lean towards the last year
  const when = () => Math.round(end - rnd() ** 2.4 * (end - start));
  const att = (label, contentType, bytes, extra = {}) => ({ pointer: { contentType, locatorInfo: media(label, bytes), ...extra } });

  // Media handed out to chats: [chat, kind, asset, caption?]
  const plan = [
    ...assets.scenes.slice(0, 18).map((a, i) => ['Family', a, i % 5 === 0 ? 'Look at this!' : null]),
    ...assets.scenes.slice(18, 38).map((a, i) => ['Weekend Away 🏕️', a, i % 6 === 0 ? 'From today' : null]),
    ...assets.scenes.slice(38, 46).map(a => ['Maya', a]), ...assets.scenes.slice(46, 54).map(a => ['Nina', a]), ...assets.scenes.slice(54).map(a => ['Sam', a]),
    ...assets.portraits.Maya.map(a => [pick(['Family', 'Maya']), a]),
    ...assets.portraits.Isla.map(a => [pick(['Weekend Away 🏕️', 'Book Club']), a]),
    ...assets.portraits.Nina.map(a => [pick(['Weekend Away 🏕️', 'Nina']), a]),
    ['Weekend Away 🏕️', assets.shots.chat], ['Nina', assets.shots.post], ['Maya', assets.shots.map], ['Weekend Away 🏕️', assets.shots.receipt],
    ['Family', assets.shots.recipe], ['Sam', assets.shots.ticket], ['Book Club', assets.shots.cropped],
    ['Weekend Away 🏕️', assets.videos[0], 'Sunrise 🌅'], ['Family', assets.videos[1]], ['Maya', assets.voice],
  ];
  const items = [];
  for (const c of CHATS) {
    const others = c.self ? [] : c.group ? c.members : [c.with];
    // Each exchange happens a couple of times, at least half a day from any other in this chat
    const bursts = CONVOS[c.name].length * (c.self ? 1 : 3);
    const used = [];
    for (let k = 0; k < bursts; k++) {
      let ms = when();
      for (let tries = 0; used.some(t => Math.abs(t - ms) < 12 * 3600e3) && tries < 50; tries++) ms = when();
      used.push(ms);
      for (const [who, text] of CONVOS[c.name][k % CONVOS[c.name].length]) {
        const name = who === '*' ? pick(others) : who;
        items.push({ c, ms, author: name === 'me' ? SELF : PEOPLE[name], text });
        ms += Math.round((1 + rnd() * 6) * 60e3); // replies a few minutes apart
      }
    }
  }
  plan.forEach(([chatName, a, caption], i) => {
    const c = CHATS.find(x => x.name === chatName);
    const talkers = c.group ? c.members : [c.with];
    const ms = i < onThisDay.length * 3 && i % 3 === 0 ? onThisDay[i / 3] : when();
    items.push({ c, ms, author: rnd() < 0.35 ? SELF : PEOPLE[pick(talkers)], text: caption ?? '', attachments: [att(a.label, a.type, a.bytes, a.dims ? { width: a.dims[0], height: a.dims[1] } : {})] });
  });
  items.sort((a, b) => a.ms - b.ms);
  for (const it of items) {
    const out1 = it.author === SELF;
    out.push({ chatItem: {
      chatId: it.c.id, authorId: it.author, dateSent: it.ms,
      ...(out1 ? { outgoing: {} } : { incoming: { dateReceived: it.ms + 2000 } }),
      standardMessage: { ...(it.text ? { text: { body: it.text } } : {}), attachments: it.attachments ?? [] },
    } });
  }
  return { frames: out, messages: items.length };
}

// ---------- build ----------

const run = (script, args = []) => execFileSync('node', [join(ROOT, 'src', script), ...args], {
  stdio: 'inherit', env: { ...process.env, SIGNAL_ARCHIVE_DATA: DATA, SIGNAL_RECOVERY_KEY: key, SIGNAL_SELF_NAME: 'Me', NO_OPEN: '1' },
});
let key;

async function main() {
  console.log('Fetching demo photos (cached after the first build)…');
  const scenes = [];
  for (const [i, id] of SCENES.entries()) {
    const [w, h] = i % 4 === 3 ? [1200, 1600] : [1600, 1200];
    scenes.push({ label: `scene-${id}`, type: 'image/jpeg', bytes: await picsum(id, w, h), dims: [w, h] });
  }
  const portraits = {};
  for (const [name, id] of Object.entries(PORTRAITS)) {
    portraits[name] = [];
    for (const [w, h, extra] of PORTRAIT_CROPS) portraits[name].push({ label: `${name}-${w}x${h}${extra}`, type: 'image/jpeg', bytes: await picsum(id, w, h, extra), dims: [w, h] });
  }
  console.log('Drawing screenshots, videos and a voice note…');
  const shots = Object.fromEntries(Object.entries(await screenshots()).map(([k, b]) => [k, { label: `shot-${k}`, type: 'image/png', bytes: b }]));
  const videos = [video(scenes[20].bytes, 'video-a'), video(scenes[3].bytes, 'video-b')].map((b, i) => ({ label: `video-${i}`, type: 'video/mp4', bytes: b }));
  const voice = { label: 'voice', type: 'audio/mp4', bytes: voiceNote() };

  const account = createAccount();
  key = account.recoveryKey;
  const { frames: f, messages } = frames(account.media, { scenes, portraits, shots, videos, voice });
  account.writeBackup(join(DATA, 'backup'), f, { appVersion: 'demo' });
  console.log(`Wrote a demo backup: ${CHATS.length} chats, ${messages} messages.\n`);

  // Start from a clean archive each time
  execFileSync('rm', ['-rf', join(DATA, 'archive'), join(DATA, 'signal.duckdb')]);
  for (const step of ['extract.mjs', 'build-db.mjs', 'dashboard.mjs', 'viewer.mjs', 'clip.mjs', 'faces.mjs', 'people.mjs']) run(step);

  // Name the three people and mark a few keepers, so every screen has something on it
  const archive = join(DATA, 'archive');
  const index = JSON.parse(readFileSync(join(archive, '.faces', 'people-index.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(archive, 'manifest.json'), 'utf8'));
  const labelOf = {};
  for (const m of Object.values(manifest.messages)) for (const file of m.files) labelOf[file.hash] = file.path;
  const hashOf = label => account.media(label).plaintextHash.toString('hex');
  const people = Object.entries(portraits).map(([name, list], i) => {
    const mine = new Set(list.map(a => hashOf(a.label)));
    const group = index.people.find(p => p.photos.some(h => mine.has(h)));
    return group && { id: `demo${i}`, name, faces: group.faces };
  }).filter(Boolean);
  writeFileSync(join(archive, 'people.json'), JSON.stringify({ version: 1, people, hidden: [] }, null, 1));
  const keep = scenes.filter((_, i) => i % 5 === 0).map(a => hashOf(a.label));
  const skip = [shots.receipt, shots.ticket, scenes[7], scenes[13]].map(a => hashOf(a.label));
  writeFileSync(join(archive, 'picks.json'), JSON.stringify({ version: 1, picks: Object.fromEntries([...keep.map(h => [h, 'keep']), ...skip.map(h => [h, 'skip'])]) }));
  run('people.mjs');
  run('viewer.mjs');
  console.log(`\nDemo ready: ${people.length} people named, ${keep.length} photos kept. Run \`npm run demo\` to open it.`);
}

main().catch(e => { console.error(`\nError: ${e.message}`); process.exit(1); });
