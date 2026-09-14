const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webPush = require('web-push');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 15 * 1024 * 1024,
  perMessageDeflate: { threshold: 4096 },
});

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '15mb' }));

const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const INDEX_HTML_RAW = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const BUILD_ID = Date.now().toString(36);
function renderIndexHtml() {
  const cfg = { occupatusPassword: process.env.OCCUPATUS_PASSWORD || '' };
  return INDEX_HTML_RAW
    .replace('/*__APP_CFG__*/{}', JSON.stringify(cfg))
    .replace(/(<(?:script|link)[^>]*(?:src|href)=")(\/[^"?#]+\.(?:js|css))"/gi, `$1$2?v=${BUILD_ID}"`);
}
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderIndexHtml());
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.includes(path.sep + 'stickers' + path.sep)) {
      const base = path.basename(filePath).toLowerCase();
      if (base === 'index.json' || base === 'manifest.json') {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }
    const base = path.basename(filePath).toLowerCase();
    if (base === 'sw.js' || base === 'index.html' || base === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    if (/\.(js|css|svg|png|jpe?g|webp|gif|ico|woff2?|mp4|webm)$/i.test(base)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    }
  },
}));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:chat.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const HUB_USER = 'occupatus';
const LEGACY_PEER = 'mutatio';

const SERVER_OPTIONS = {
  'chat00': { url: 'https://test-chat-ewz1.onrender.com', display: 'bit.ly/chat00' },
  'test-doang': { url: 'https://test-doang.onrender.com', display: 'bit.ly/test-doang' },
};
const DEFAULT_ACTIVE_SERVER = 'chat00';
const ACTIVE_SERVER_KV = 'active_server';
const SERVER_KEY = SERVER_OPTIONS[process.env.SERVER_KEY]
  ? process.env.SERVER_KEY
  : DEFAULT_ACTIVE_SERVER;

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      text TEXT,
      image TEXT,
      video TEXT,
      audio TEXT,
      time TEXT NOT NULL,
      reply_to_id INTEGER,
      peer TEXT
    )
  `);
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN video TEXT`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN audio TEXT`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN peer TEXT`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN auto_sayang INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {}
  await db.execute({
    sql: `UPDATE messages SET peer = CASE WHEN username = ? THEN ? ELSE username END WHERE peer IS NULL`,
    args: [HUB_USER, LEGACY_PEER],
  });
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_peer_id ON messages (peer, id)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      subscription TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT PRIMARY KEY,
      notif_enabled INTEGER NOT NULL DEFAULT 1
    )
  `);
  const usCols = await db.execute(`PRAGMA table_info(user_settings)`);
  const usColNames = new Set(usCols.rows.map((r) => String(r.name)));
  if (!usColNames.has('theme')) {
    await db.execute(`ALTER TABLE user_settings ADD COLUMN theme TEXT`);
  }
  if (!usColNames.has('pet')) {
    await db.execute(`ALTER TABLE user_settings ADD COLUMN pet TEXT`);
  }
  if (!usColNames.has('pet_active_anim')) {
    await db.execute(`ALTER TABLE user_settings ADD COLUMN pet_active_anim TEXT`);
  }
  if (!usColNames.has('presence_visible')) {
    await db.execute(`ALTER TABLE user_settings ADD COLUMN presence_visible INTEGER NOT NULL DEFAULT 1`);
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS read_state (
      username TEXT NOT NULL,
      peer TEXT NOT NULL,
      last_read_id INTEGER NOT NULL,
      PRIMARY KEY (username, peer)
    )
  `);
  const rsCols = await db.execute(`PRAGMA table_info(read_state)`);
  const hasPeerCol = rsCols.rows.some((r) => String(r.name) === 'peer');
  if (!hasPeerCol) {
    await db.execute(`
      CREATE TABLE read_state_v2 (
        username TEXT NOT NULL,
        peer TEXT NOT NULL,
        last_read_id INTEGER NOT NULL,
        PRIMARY KEY (username, peer)
      )
    `);
    await db.execute({
      sql: `INSERT OR IGNORE INTO read_state_v2 (username, peer, last_read_id)
            SELECT username, CASE WHEN username = ? THEN ? ELSE username END, last_read_id
            FROM read_state`,
      args: [HUB_USER, LEGACY_PEER],
    });
    await db.execute(`DROP TABLE read_state`);
    await db.execute(`ALTER TABLE read_state_v2 RENAME TO read_state`);
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS presence (
      username TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      username TEXT PRIMARY KEY,
      avatar TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS game_scores (
      username TEXT NOT NULL,
      game TEXT NOT NULL,
      score INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (username, game)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      peer TEXT NOT NULL,
      time TEXT NOT NULL,
      PRIMARY KEY (message_id, username, emoji)
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions (message_id)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_journal_peer_id ON journal_entries (peer, id)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS presence_peer (
      username TEXT NOT NULL,
      peer TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (username, peer)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS peer_server (
      username TEXT PRIMARY KEY,
      server_key TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);
  const ppExisting = await db.execute('SELECT COUNT(*) AS c FROM presence_peer');
  if (Number(ppExisting.rows[0].c) === 0) {
    const global = await db.execute('SELECT username, last_seen FROM presence');
    for (const row of global.rows) {
      const u = String(row.username);
      const iso = String(row.last_seen);
      for (const other of users) {
        if (other === u) continue;
        await db.execute({
          sql: `INSERT OR IGNORE INTO presence_peer (username, peer, last_seen) VALUES (?, ?, ?)`,
          args: [u, other, iso],
        });
      }
    }
  }
}

async function getAppKv(key) {
  const r = await db.execute({ sql: 'SELECT value FROM app_kv WHERE key = ?', args: [key] });
  return r.rows.length ? String(r.rows[0].value) : null;
}
async function setAppKv(key, value) {
  await db.execute({
    sql: `INSERT INTO app_kv (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, String(value)],
  });
}

async function loadAllReadState() {
  const result = await db.execute('SELECT username, peer, last_read_id FROM read_state');
  for (const row of result.rows) {
    setLastRead(String(row.username), String(row.peer), Number(row.last_read_id));
  }
}

function setLastRead(username, peer, id) {
  let inner = lastRead.get(username);
  if (!inner) {
    inner = new Map();
    lastRead.set(username, inner);
  }
  inner.set(peer, id);
}

function getLastRead(username, peer) {
  const inner = lastRead.get(username);
  if (!inner) return 0;
  return inner.get(peer) || 0;
}

const presenceHidden = new Set();

async function loadAllPresenceVisibility() {
  const result = await db.execute('SELECT username, presence_visible FROM user_settings');
  for (const row of result.rows) {
    const v = row.presence_visible;
    if (v !== null && v !== undefined && Number(v) === 0) {
      presenceHidden.add(String(row.username));
    }
  }
}

function isPresenceHidden(username) {
  return presenceHidden.has(username);
}

async function setPresenceVisible(username, visible) {
  await db.execute({
    sql: `INSERT INTO user_settings (username, presence_visible) VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET presence_visible = excluded.presence_visible`,
    args: [username, visible ? 1 : 0],
  });
  if (visible) presenceHidden.delete(username);
  else presenceHidden.add(username);
}

const avatars = new Map();

async function loadAllAvatars() {
  const result = await db.execute('SELECT username, avatar FROM user_profiles');
  for (const row of result.rows) {
    if (row.avatar) avatars.set(String(row.username), String(row.avatar));
  }
}

async function persistAvatar(username, avatar) {
  const now = new Date().toISOString();
  if (avatar) {
    await db.execute({
      sql: `INSERT INTO user_profiles (username, avatar, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET avatar = excluded.avatar, updated_at = excluded.updated_at`,
      args: [username, avatar, now],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO user_profiles (username, avatar, updated_at) VALUES (?, NULL, ?)
            ON CONFLICT(username) DO UPDATE SET avatar = NULL, updated_at = excluded.updated_at`,
      args: [username, now],
    });
  }
}

function avatarsSnapshot() {
  const snap = {};
  for (const u of users) {
    snap[u] = avatars.get(u) || null;
  }
  return snap;
}

async function persistReadState(username, peer, id) {
  await db.execute({
    sql: `INSERT INTO read_state (username, peer, last_read_id) VALUES (?, ?, ?)
          ON CONFLICT(username, peer) DO UPDATE SET last_read_id = excluded.last_read_id`,
    args: [username, peer, id],
  });
}

async function getNotifEnabled(username) {
  const result = await db.execute({
    sql: 'SELECT notif_enabled FROM user_settings WHERE username = ?',
    args: [username],
  });
  if (!result.rows.length) return true;
  return Number(result.rows[0].notif_enabled) !== 0;
}

async function setNotifEnabled(username, enabled) {
  await db.execute({
    sql: `INSERT INTO user_settings (username, notif_enabled) VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET notif_enabled = excluded.notif_enabled`,
    args: [username, enabled ? 1 : 0],
  });
}

const VALID_THEMES = new Set(['light', 'dark', 'ocean', 'forest', 'sunset', 'merdeka']);

async function getUserTheme(username) {
  const result = await db.execute({
    sql: 'SELECT theme FROM user_settings WHERE username = ?',
    args: [username],
  });
  if (!result.rows.length) return null;
  const theme = result.rows[0].theme;
  return VALID_THEMES.has(theme) ? theme : null;
}

async function setUserTheme(username, theme) {
  await db.execute({
    sql: `INSERT INTO user_settings (username, theme) VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET theme = excluded.theme`,
    args: [username, theme],
  });
}

const VALID_PETS = new Set([
  'cat', 'tiger', 'dog', 'fox', 'panda', 'lion', 'bear', 'monkey',
  'frog', 'pig', 'rabbit', 'penguin', 'unicorn', 'dragon', 'octopus',
  'ghost', 'robot', 'doraemon',
]);
const VALID_PET_ANIMS = new Set(['breathe', 'shake', 'jump', 'roll']);

async function getUserPet(username) {
  const result = await db.execute({
    sql: 'SELECT pet, pet_active_anim FROM user_settings WHERE username = ?',
    args: [username],
  });
  if (!result.rows.length) return { pet: null, active: null };
  const row = result.rows[0];
  const pet = VALID_PETS.has(row.pet) ? row.pet : null;
  const active = VALID_PET_ANIMS.has(row.pet_active_anim) ? row.pet_active_anim : null;
  return { pet, active };
}

async function setUserPet(username, patch) {
  const cols = [];
  const args = [username];
  if (patch.pet !== undefined) { cols.push('pet'); args.push(patch.pet); }
  if (patch.active !== undefined) { cols.push('pet_active_anim'); args.push(patch.active); }
  if (!cols.length) return;
  const insertCols = ['username', ...cols].join(', ');
  const placeholders = args.map(() => '?').join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  await db.execute({
    sql: `INSERT INTO user_settings (${insertCols}) VALUES (${placeholders})
          ON CONFLICT(username) DO UPDATE SET ${updates}`,
    args,
  });
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
const r2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL);

const r2Client = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const botEnabled = !!GEMINI_API_KEY;

const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const ALLOWED_VIDEO_MIME = new Set(['video/webm', 'video/mp4', 'video/quicktime']);
const R2_PUBLIC_VIDEO_PREFIX = r2Enabled ? `${R2_PUBLIC_URL}/videos/` : '';

const STICKER_PATH_PREFIX = '/stickers/';
const STICKER_MANIFEST = (() => {
  try {
    const raw = require('fs').readFileSync(path.join(__dirname, 'public', 'stickers', 'index.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed.stickers || []).filter((s) => s && typeof s.name === 'string' && typeof s.file === 'string');
  } catch (e) {
    console.warn('sticker manifest missing:', e.message);
    return [];
  }
})();
const ALLOWED_STICKERS = new Map(
  STICKER_MANIFEST.map((s) => [s.name, {
    file: s.file,
    users: Array.isArray(s.users) && s.users.length ? new Set(s.users) : null,
  }])
);
function stickerVisibleTo(name, username) {
  const entry = ALLOWED_STICKERS.get(name);
  if (!entry) return false;
  if (!entry.users) return true;
  return entry.users.has(username);
}
function stickersManifestFor(username) {
  return STICKER_MANIFEST
    .filter((s) => !Array.isArray(s.users) || s.users.includes(username))
    .map(({ users, ...rest }) => rest);
}

async function saveSubscription(username, sub) {
  await db.execute({
    sql: `INSERT INTO push_subscriptions (endpoint, username, subscription, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET username=excluded.username, subscription=excluded.subscription`,
    args: [sub.endpoint, username, JSON.stringify(sub), new Date().toISOString()],
  });
}

async function deleteSubscription(endpoint) {
  await db.execute({
    sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?',
    args: [endpoint],
  });
}

async function getSubscriptionsFor(username) {
  const result = await db.execute({
    sql: 'SELECT subscription FROM push_subscriptions WHERE username = ?',
    args: [username],
  });
  return result.rows.map((r) => {
    try { return JSON.parse(r.subscription); } catch { return null; }
  }).filter(Boolean);
}

async function sendPushToRecipient(recipient, payload) {
  if (!pushEnabled) return;
  if (!recipient) return;
  const subs = await getSubscriptionsFor(recipient);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await deleteSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error('push error:', err.statusCode, err.body);
      }
    }
  }));
}

function resolvePeer(sender, requested) {
  if (sender === HUB_USER) {
    if (typeof requested !== 'string') return null;
    if (!users.has(requested)) return null;
    if (requested === HUB_USER) return null;
    return requested;
  }
  return sender;
}

function userRoom(u) {
  return 'user:' + u;
}

function recipientOf(sender, peer) {
  return sender === HUB_USER ? peer : HUB_USER;
}

function emitToThread(peer, event, payload) {
  io.to(userRoom(HUB_USER)).to(userRoom(peer)).emit(event, payload);
}

function defaultPeerFor(username) {
  if (username !== HUB_USER) return username;
  return LEGACY_PEER;
}

function peersList() {
  return [...users].filter((u) => u !== HUB_USER);
}

function readStateSnapshot(username) {
  if (username === HUB_USER) {
    const out = {};
    for (const [u, inner] of lastRead) {
      out[u] = Object.fromEntries(inner);
    }
    return out;
  }
  const meId = getLastRead(username, username);
  const hubId = getLastRead(HUB_USER, username);
  return {
    [username]: { [username]: meId },
    [HUB_USER]: { [username]: hubId },
  };
}

function applyUserTextTransforms(username, text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (username === 'occupatus') {
    out = out.replace(/\bayang(?!nya\b)/gi, (m) => (m[0] === 'A' ? 'Sayang' : 'sayang'));
  }
  out = out.replace(/\b(hati-hati|hatihati|ati-ati|atiati|heart-heart|heartheart)\b/gi, (m) => (m.includes('-') ? '❤️-❤️' : '❤️❤️'));
  return out;
}

async function saveMessage(msg) {
  const result = await db.execute({
    sql: 'INSERT INTO messages (username, text, image, video, audio, time, reply_to_id, peer, auto_sayang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [msg.username, msg.text || null, msg.image || null, msg.video || null, msg.audio || null, msg.time, msg.replyToId || null, msg.peer, msg.autoSayang ? 1 : 0],
  });
  return Number(result.lastInsertRowid);
}

function isStickerRef(val) {
  return typeof val === 'string' && val.startsWith(STICKER_PATH_PREFIX);
}

function mapRow(r) {
  const sticker = isStickerRef(r.image) ? r.image : null;
  const out = {
    id: Number(r.id),
    username: r.username,
    text: r.text,
    image: sticker ? null : r.image,
    sticker,
    video: r.video,
    audio: r.audio,
    time: r.time,
    peer: r.peer,
    unsent: !!Number(r.unsent || 0),
  };
  if (Number(r.auto_sayang || 0)) out.autoSayang = true;
  if (r.reply_to_id) {
    const replySticker = isStickerRef(r.reply_image);
    out.replyTo = {
      id: Number(r.reply_to_id),
      username: r.reply_username,
      text: r.reply_text,
      hasImage: !replySticker && !!r.reply_image,
      hasSticker: replySticker,
      hasVideo: !!r.reply_video,
      hasAudio: !!r.reply_audio,
      unsent: !!Number(r.reply_unsent || 0),
    };
  }
  return out;
}

async function getReactionsForIds(ids) {
  const map = {};
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.execute({
    sql: `SELECT message_id, username, emoji FROM message_reactions WHERE message_id IN (${placeholders})`,
    args: ids,
  });
  for (const r of result.rows) {
    const mid = Number(r.message_id);
    if (!map[mid]) map[mid] = [];
    map[mid].push({ username: String(r.username), emoji: String(r.emoji) });
  }
  return map;
}

async function attachReactions(messages) {
  const ids = messages.filter((m) => m && m.id).map((m) => m.id);
  if (!ids.length) return messages;
  const map = await getReactionsForIds(ids);
  for (const m of messages) {
    m.reactions = map[m.id] || [];
  }
  return messages;
}

async function getMessageById(id) {
  const result = await db.execute({
    sql: `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent, m.auto_sayang,
                 p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
          FROM messages m
          LEFT JOIN messages p ON m.reply_to_id = p.id
          WHERE m.id = ?`,
    args: [id],
  });
  if (!result.rows.length) return null;
  const msg = mapRow(result.rows[0]);
  await attachReactions([msg]);
  return msg;
}

async function getHistory(peer, limit = 50, beforeId = null) {
  const sql = beforeId
    ? `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent, m.auto_sayang,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       WHERE m.peer = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    : `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent, m.auto_sayang,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       WHERE m.peer = ?
       ORDER BY m.id DESC LIMIT ?`;
  const args = beforeId ? [peer, beforeId, limit] : [peer, limit];
  const result = await db.execute({ sql, args });
  const messages = result.rows.reverse().map(mapRow);
  await attachReactions(messages);
  return messages;
}

const users = new Set(
  (process.env.ALLOWED_USERS || 'occupatus,mutatio,A,B')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean)
);

function parseUserPasswords(raw) {
  const map = {};
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const user = entry.slice(0, idx).trim();
    const pass = entry.slice(idx + 1);
    if (user && pass) map[user] = pass;
  }
  return map;
}

const PASSWORD_SEED = parseUserPasswords(process.env.USER_PASSWORDS);

const passwordCache = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makePasswordEntry(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashPassword(password, salt)}`;
}

async function loadPasswordCache() {
  const result = await db.execute('SELECT username, password_hash FROM user_credentials');
  passwordCache.clear();
  for (const row of result.rows) {
    passwordCache.set(String(row.username), String(row.password_hash));
  }
}

async function seedPasswords() {
  for (const [username, password] of Object.entries(PASSWORD_SEED)) {
    const current = passwordCache.get(username);
    if (current) {
      const [salt, hash] = current.split(':');
      if (salt && hash && hashPassword(password, salt) === hash) continue;
    }
    const entry = makePasswordEntry(password);
    await db.execute({
      sql: `INSERT INTO user_credentials (username, password_hash) VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
      args: [username, entry],
    });
    passwordCache.set(username, entry);
  }
}

function checkPassword(username, password) {
  const stored = passwordCache.get(username);
  if (!stored) return true;
  if (typeof password !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const provided = hashPassword(password, salt);
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createToken(username) {
  const payload = b64url(JSON.stringify({ u: username, iat: Date.now() }));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (!data.u || !users.has(data.u)) return null;
    if (Date.now() - data.iat > SESSION_MAX_AGE_MS) return null;
    return data.u;
  } catch {
    return null;
  }
}

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username) {
    return res.status(400).json({ ok: false, error: 'Username is required' });
  }
  if (!users.has(username)) {
    return res.status(401).json({ ok: false, error: 'Invalid username' });
  }
  if (!checkPassword(username, password)) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  const token = createToken(username);
  res.json({ ok: true, token, username });
});

app.get('/me', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const username = token && verifyToken(token);
  if (!username) return res.status(401).json({ ok: false });
  res.json({ ok: true, username });
});

function authFromReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token && verifyToken(token);
}

const AVATAR_PRESET_GROUPS = [
  { id: 'faces', label: 'Wajah', items: ['😀','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😋','😜','🤪','🤗','🤔','😐','😶','🙄','😌','😴','🤤','😪','🤒','🥵','🥶','🥴','😵','🤯','🥳','😎','🤓','😕','🙁','😮','😳','🥺','😨','😰','😢','😭','😱','😞','🥱','😤','😡','🤬','🤡','👻','😺'] },
  { id: 'animals', label: 'Hewan', items: ['🦊','🐶','🐱','🐻','🐼','🐰','🐨','🐯','🦁','🐸','🐷','🐮','🐵','🐧','🦄','🦉','🦔','🐢','🐿️','🐺'] },
  { id: 'sea', label: 'Laut', items: ['🐙','🐳','🐬','🦈','🐠','🐡','🦑','🦞','🦀','🐚','🐟','🐋','🪸','🦭'] },
  { id: 'nature', label: 'Alam', items: ['🦋','🐝','🐞','🌸','🌺','🌻','🌷','🌈','⭐','🌙','☀️','🌵','🍀','🌊','🍄','🌟','🔥','❄️','🌴','🍁'] },
  { id: 'food', label: 'Makanan', items: ['🍕','🍩','🍓','🍔','🍜','🍦','🍪','🍰','🍎','🍉','🍌','🥑','🌮','🍿','🍣','🥐','🍫','🍭','🥭','🧁'] },
  { id: 'objects', label: 'Objek', items: ['🎈','🎨','🎧','🎮','🎯','🎸','📷','🎤','🚀','🎁','🏆','💎','🔮','🎪','⚽','🏀','🎲','🧩','🎳','🛼'] },
];
const AVATAR_PRESET_SET = new Set(AVATAR_PRESET_GROUPS.flatMap((g) => g.items));

app.get('/avatars', (_req, res) => {
  const username = authFromReq(_req);
  if (!username) return res.status(401).json({ ok: false });
  res.json({ ok: true, avatars: avatarsSnapshot(), presetGroups: AVATAR_PRESET_GROUPS });
});

app.post('/avatar', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const { preset } = req.body || {};
  if (typeof preset !== 'string' || !AVATAR_PRESET_SET.has(preset)) {
    return res.status(400).json({ ok: false, error: 'Invalid avatar' });
  }
  try {
    await persistAvatar(username, preset);
    avatars.set(username, preset);
    io.emit('avatar:update', { username, avatar: preset });
    res.json({ ok: true });
  } catch (err) {
    console.error('avatar save error:', err.message);
    res.status(500).json({ ok: false, error: 'Save failed' });
  }
});

app.delete('/avatar', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  try {
    await persistAvatar(username, null);
    avatars.delete(username);
    io.emit('avatar:update', { username, avatar: null });
    res.json({ ok: true });
  } catch (err) {
    console.error('avatar delete error:', err.message);
    res.status(500).json({ ok: false, error: 'Delete failed' });
  }
});

app.get('/stickers/manifest', (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  res.json({ ok: true, stickers: stickersManifestFor(username) });
});

app.get('/vapid-public', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ ok: false, error: 'Push not configured' });
  res.json({ ok: true, key: VAPID_PUBLIC_KEY });
});

app.post('/push-subscribe', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  try {
    await saveSubscription(username, sub);
    res.json({ ok: true });
  } catch (err) {
    console.error('subscribe error:', err.message);
    res.status(500).json({ ok: false });
  }
});

const METERED_APP_NAME = process.env.METERED_APP_NAME || '';
const METERED_API_KEY = process.env.METERED_API_KEY || '';
const TURN_URLS = process.env.TURN_URLS || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

const STATIC_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let iceCache = { servers: null, expiresAt: 0 };
const ICE_CACHE_MS = 60 * 60 * 1000;

async function fetchMeteredCredentials() {
  const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Metered API ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('Metered API: unexpected response');
  return data;
}

async function getIceServers() {
  const now = Date.now();
  if (iceCache.servers && iceCache.expiresAt > now) return iceCache.servers;
  let servers = [...STATIC_STUN];
  if (METERED_APP_NAME && METERED_API_KEY) {
    try {
      const metered = await fetchMeteredCredentials();
      servers = metered;
    } catch (err) {
      console.error('Metered TURN fetch failed:', err.message);
    }
  } else if (TURN_URLS) {
    const urls = TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean);
    servers.push({ urls, username: TURN_USERNAME, credential: TURN_PASSWORD });
  }
  iceCache = { servers, expiresAt: now + ICE_CACHE_MS };
  return servers;
}

app.get('/ice-servers', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  try {
    const iceServers = await getIceServers();
    res.json({ ok: true, iceServers });
  } catch (err) {
    console.error('ice-servers error:', err.message);
    res.status(500).json({ ok: false, iceServers: STATIC_STUN });
  }
});

app.get('/r2-status', (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  res.json({ ok: true, enabled: r2Enabled });
});

app.post('/r2-presign-video', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (!r2Enabled) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const { contentType, size } = req.body || {};
  if (typeof contentType !== 'string' || !ALLOWED_VIDEO_MIME.has(contentType)) {
    return res.status(400).json({ ok: false, error: 'Invalid content type' });
  }
  const sz = Number(size);
  if (!Number.isFinite(sz) || sz <= 0 || sz > VIDEO_MAX_BYTES) {
    return res.status(400).json({ ok: false, error: 'Invalid size' });
  }
  try {
    var ext = 'webm';
    if (contentType === 'video/mp4') ext = 'mp4';
    else if (contentType === 'video/quicktime') ext = 'mov';
    const date = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomBytes(16).toString('hex');
    const key = `videos/${date}/${rand}.${ext}`;
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: sz,
    });
    const uploadUrl = await getSignedUrl(r2Client, cmd, { expiresIn: 1800 });
    const publicUrl = `${R2_PUBLIC_URL}/${key}`;
    res.json({ ok: true, uploadUrl, publicUrl, key, contentType });
  } catch (err) {
    console.error('presign error:', err.message);
    res.status(500).json({ ok: false, error: 'Presign failed' });
  }
});

const GALLERY_PAGE_DEFAULT = 12;
const GALLERY_PAGE_MAX = 1000;

app.get('/gallery', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });

  const peer = resolvePeer(username, req.query.peer);
  if (!peer) return res.status(400).json({ ok: false, error: 'Invalid peer' });

  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(
    GALLERY_PAGE_MAX,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : GALLERY_PAGE_DEFAULT)
  );

  const parsedPage = parseInt(req.query.page, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const offset = (page - 1) * limit;

  const unsentFilter = username === HUB_USER ? '' : ' AND unsent = 0';
  const mediaFilter = "((image IS NOT NULL AND image NOT LIKE '/stickers/%') OR video IS NOT NULL)";
  try {
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) AS cnt FROM messages WHERE peer = ? AND ${mediaFilter}${unsentFilter}`,
      args: [peer],
    });
    const totalItems = Number(countResult.rows[0].cnt);
    const totalPages = Math.ceil(totalItems / limit);

    const result = await db.execute({
      sql: `SELECT id, username, image, video, time, unsent
             FROM messages
            WHERE peer = ? AND ${mediaFilter}${unsentFilter}
            ORDER BY id DESC
            LIMIT ? OFFSET ?`,
      args: [peer, limit, offset],
    });

    const items = result.rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      time: r.time,
      type: r.image ? 'image' : 'video',
      src: r.image || r.video,
      unsent: !!Number(r.unsent || 0),
    }));

    res.json({ ok: true, items, totalItems, totalPages, page, peer });
  } catch (err) {
    console.error('gallery error:', err.message);
    res.status(500).json({ ok: false });
  }
});

async function deleteGalleryMessage(id) {
  const msg = await getMessageById(id);
  if (!msg) return { ok: false, reason: 'not-found' };
  if (!msg.image && !msg.video) return { ok: false, reason: 'no-media' };

  if (msg.video && r2Enabled && typeof msg.video === 'string' && msg.video.startsWith(R2_PUBLIC_URL + '/')) {
    const key = msg.video.slice(R2_PUBLIC_URL.length + 1);
    try {
      await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    } catch (e) {
      console.error('r2 delete failed:', e.message);
    }
  }

  await db.execute({ sql: 'DELETE FROM messages WHERE id = ?', args: [id] });
  emitToThread(msg.peer, 'delete-message', { id, peer: msg.peer });
  return { ok: true, peer: msg.peer };
}

app.delete('/gallery/:id', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });

  try {
    const result = await deleteGalleryMessage(id);
    if (!result.ok) {
      const status = result.reason === 'not-found' ? 404 : 400;
      const error = result.reason === 'no-media' ? 'No media on this message' : 'Not found';
      return res.status(status).json({ ok: false, error });
    }
    res.json({ ok: true, id, peer: result.peer });
  } catch (err) {
    console.error('gallery delete error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/gallery/bulk-delete', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const ids = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  if (!ids.length) return res.status(400).json({ ok: false, error: 'No valid ids' });
  if (ids.length > 500) return res.status(400).json({ ok: false, error: 'Too many ids (max 500)' });

  const deleted = [];
  const failed = [];
  for (const id of ids) {
    try {
      const result = await deleteGalleryMessage(id);
      if (result.ok) deleted.push({ id, peer: result.peer });
      else failed.push({ id, reason: result.reason });
    } catch (err) {
      console.error('gallery bulk delete failed for id', id, ':', err.message);
      failed.push({ id, reason: 'error' });
    }
  }
  res.json({ ok: true, deleted, failed });
});

app.delete('/history/:peer', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const peer = String(req.params.peer || '').trim();
  if (!peer || peer === HUB_USER || !users.has(peer)) {
    return res.status(400).json({ ok: false, error: 'Invalid peer' });
  }

  try {
    const rows = (await db.execute({
      sql: `SELECT id, video FROM messages
            WHERE peer = ? AND video IS NOT NULL AND video != ''`,
      args: [peer],
    })).rows;

    let r2Deleted = 0;
    let r2Failed = 0;
    if (r2Enabled) {
      for (const r of rows) {
        const v = r.video;
        if (typeof v !== 'string' || !v.startsWith(R2_PUBLIC_URL + '/')) continue;
        const key = v.slice(R2_PUBLIC_URL.length + 1);
        try {
          await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
          r2Deleted++;
        } catch (e) {
          r2Failed++;
          console.error('r2 delete failed for', key, ':', e.message);
        }
      }
    }

    await db.execute({
      sql: `DELETE FROM message_reactions
            WHERE message_id IN (SELECT id FROM messages WHERE peer = ?)`,
      args: [peer],
    });
    const del = await db.execute({
      sql: 'DELETE FROM messages WHERE peer = ?',
      args: [peer],
    });
    await db.execute({
      sql: `DELETE FROM read_state
            WHERE (username = ? AND peer = ?) OR (username = ? AND peer = ?)`,
      args: [HUB_USER, peer, peer, HUB_USER],
    });

    // Sync in-memory read cache.
    const hubInner = lastRead.get(HUB_USER);
    if (hubInner) hubInner.delete(peer);
    const peerInner = lastRead.get(peer);
    if (peerInner) peerInner.delete(HUB_USER);

    emitToThread(peer, 'clear-history', { peer, actor: HUB_USER });

    res.json({
      ok: true,
      peer,
      messagesDeleted: Number(del.rowsAffected || 0),
      r2Deleted,
      r2Failed,
    });
  } catch (err) {
    console.error('clear history error:', err.message);
    res.status(500).json({ ok: false });
  }
});

const JOURNAL_BODY_MAX = 4000;
const JOURNAL_PAGE_DEFAULT = 30;
const JOURNAL_PAGE_MAX = 100;

function resolveJournalPeer(username, requested) {
  const p = typeof requested === 'string' ? requested.trim() : '';
  if (!p || p === HUB_USER || !users.has(p)) return null;
  if (username !== HUB_USER && username !== p) return null;
  return p;
}

function journalRow(r) {
  return {
    id: Number(r.id),
    peer: String(r.peer),
    author: String(r.author),
    body: String(r.body || ''),
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

app.get('/journal/:peer', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const peer = resolveJournalPeer(username, req.params.peer);
  if (!peer) return res.status(400).json({ ok: false, error: 'Invalid peer' });
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(
    JOURNAL_PAGE_MAX,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : JOURNAL_PAGE_DEFAULT)
  );
  const before = parseInt(req.query.before, 10);
  try {
    const args = [peer, username];
    let where = 'peer = ? AND author = ?';
    if (Number.isFinite(before) && before > 0) {
      where += ' AND id < ?';
      args.push(before);
    }
    args.push(limit);
    const result = await db.execute({
      sql: `SELECT id, peer, author, body, created_at, updated_at
              FROM journal_entries
             WHERE ${where}
          ORDER BY id DESC
             LIMIT ?`,
      args,
    });
    const items = result.rows.map(journalRow);
    res.json({ ok: true, peer, items, hasMore: items.length === limit });
  } catch (err) {
    console.error('journal list error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/journal/:peer', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const peer = resolveJournalPeer(username, req.params.peer);
  if (!peer) return res.status(400).json({ ok: false, error: 'Invalid peer' });
  const raw = req.body && typeof req.body.body === 'string' ? req.body.body : '';
  const body = raw.trim();
  if (!body) return res.status(400).json({ ok: false, error: 'Body required' });
  if (body.length > JOURNAL_BODY_MAX) {
    return res.status(400).json({ ok: false, error: 'Too long' });
  }
  try {
    const now = new Date().toISOString();
    const result = await db.execute({
      sql: `INSERT INTO journal_entries (peer, author, body, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [peer, username, body, now],
    });
    const entry = {
      id: Number(result.lastInsertRowid),
      peer,
      author: username,
      body,
      createdAt: now,
      updatedAt: null,
    };
    io.to(userRoom(username)).emit('journal:new', entry);
    res.json({ ok: true, entry });
  } catch (err) {
    console.error('journal create error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.patch('/journal/:peer/:id', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const peer = resolveJournalPeer(username, req.params.peer);
  if (!peer) return res.status(400).json({ ok: false, error: 'Invalid peer' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });
  const raw = req.body && typeof req.body.body === 'string' ? req.body.body : '';
  const body = raw.trim();
  if (!body) return res.status(400).json({ ok: false, error: 'Body required' });
  if (body.length > JOURNAL_BODY_MAX) {
    return res.status(400).json({ ok: false, error: 'Too long' });
  }
  try {
    const cur = await db.execute({
      sql: `SELECT id, peer, author FROM journal_entries WHERE id = ? AND peer = ?`,
      args: [id, peer],
    });
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    if (String(cur.rows[0].author) !== username) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE journal_entries SET body = ?, updated_at = ? WHERE id = ?`,
      args: [body, now, id],
    });
    const entry = {
      id,
      peer,
      author: username,
      body,
      updatedAt: now,
    };
    io.to(userRoom(username)).emit('journal:update', entry);
    res.json({ ok: true, entry });
  } catch (err) {
    console.error('journal update error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.delete('/journal/:peer/:id', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const peer = resolveJournalPeer(username, req.params.peer);
  if (!peer) return res.status(400).json({ ok: false, error: 'Invalid peer' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });
  try {
    const cur = await db.execute({
      sql: `SELECT id, peer, author FROM journal_entries WHERE id = ? AND peer = ?`,
      args: [id, peer],
    });
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    if (String(cur.rows[0].author) !== username) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    await db.execute({ sql: `DELETE FROM journal_entries WHERE id = ?`, args: [id] });
    io.to(userRoom(username)).emit('journal:delete', { id, peer });
    res.json({ ok: true, id, peer });
  } catch (err) {
    console.error('journal delete error:', err.message);
    res.status(500).json({ ok: false });
  }
});

function serverOptionsPayload() {
  return Object.entries(SERVER_OPTIONS).map(([key, v]) => ({ key, display: v.display }));
}

async function getActiveServerKey() {
  const stored = await getAppKv(ACTIVE_SERVER_KV);
  return SERVER_OPTIONS[stored] ? stored : DEFAULT_ACTIVE_SERVER;
}

app.get('/active-server', async (req, res) => {
  const username = authFromReq(req);
  const activeKey = await getActiveServerKey();
  res.json({
    ok: true,
    activeKey,
    activeDisplay: SERVER_OPTIONS[activeKey].display,
    serverKey: SERVER_KEY,
    serverDisplay: SERVER_OPTIONS[SERVER_KEY].display,
    match: SERVER_KEY === activeKey,
    canEdit: username === HUB_USER,
    options: serverOptionsPayload(),
  });
});

app.post('/active-server', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const key = req.body && typeof req.body.key === 'string' ? req.body.key : '';
  if (!SERVER_OPTIONS[key]) return res.status(400).json({ ok: false, error: 'Invalid key' });
  await setAppKv(ACTIVE_SERVER_KV, key);
  res.json({ ok: true, activeKey: key, activeDisplay: SERVER_OPTIONS[key].display });
});

app.get('/peer-server-status', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const activeKey = await getActiveServerKey();
    const result = await db.execute(
      'SELECT username, server_key, last_seen FROM peer_server ORDER BY last_seen DESC'
    );
    const peers = result.rows.map((r) => {
      const key = String(r.server_key);
      return {
        username: String(r.username),
        serverKey: key,
        serverDisplay: (SERVER_OPTIONS[key] || {}).display || key,
        lastSeen: String(r.last_seen),
        match: key === activeKey,
      };
    });
    res.json({ ok: true, activeKey, peers });
  } catch (err) {
    console.error('peer-server-status error:', err.message);
    res.status(500).json({ ok: false });
  }
});

const SAYANG_COUNTER_KEY = 'sayang_counter_start';

async function getSayangCounterStart() {
  let iso = await getAppKv(SAYANG_COUNTER_KEY);
  if (!iso || isNaN(new Date(iso).getTime())) {
    iso = new Date().toISOString();
    await setAppKv(SAYANG_COUNTER_KEY, iso);
  }
  return iso;
}

app.get('/sayang-stats', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  if (username !== HUB_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const target = 'turki';
  try {
    const counterStart = await getSayangCounterStart();

    const totals = (await db.execute({
      sql: `SELECT
              SUM(CASE WHEN text IS NOT NULL AND text != '' THEN 1 ELSE 0 END) AS total_text,
              SUM(CASE WHEN auto_sayang = 1 THEN 1 ELSE 0 END) AS auto_count,
              SUM(CASE WHEN auto_sayang = 0 AND text IS NOT NULL AND lower(text) LIKE '%sayang%' THEN 1 ELSE 0 END) AS manual_count,
              SUM(CASE WHEN auto_sayang = 0 AND text IS NOT NULL
                       THEN (length(lower(text)) - length(replace(lower(text), 'sayang', ''))) / 6
                       ELSE 0 END) AS manual_occurrences,
              MIN(CASE WHEN auto_sayang = 0 AND text IS NOT NULL AND lower(text) LIKE '%sayang%' THEN time END) AS first_manual_at,
              MAX(CASE WHEN auto_sayang = 0 AND text IS NOT NULL AND lower(text) LIKE '%sayang%' THEN time END) AS last_manual_at
            FROM messages
            WHERE username = ? AND (unsent IS NULL OR unsent = 0) AND time >= ?`,
      args: [target, counterStart],
    })).rows[0] || {};

    const recentRows = (await db.execute({
      sql: `SELECT id, text, time, peer
            FROM messages
            WHERE username = ?
              AND (unsent IS NULL OR unsent = 0)
              AND auto_sayang = 0
              AND text IS NOT NULL
              AND lower(text) LIKE '%sayang%'
              AND time >= ?
            ORDER BY id DESC
            LIMIT 20`,
      args: [target, counterStart],
    })).rows;

    const dailyRows = (await db.execute({
      sql: `SELECT substr(time, 1, 10) AS day, COUNT(*) AS n
            FROM messages
            WHERE username = ?
              AND (unsent IS NULL OR unsent = 0)
              AND auto_sayang = 0
              AND text IS NOT NULL
              AND lower(text) LIKE '%sayang%'
              AND time >= ?
            GROUP BY day
            ORDER BY day ASC`,
      args: [target, counterStart],
    })).rows;

    res.json({
      ok: true,
      target,
      totals: {
        totalTextMessages: Number(totals.total_text || 0),
        manual: Number(totals.manual_count || 0),
        auto: Number(totals.auto_count || 0),
        manualOccurrences: Number(totals.manual_occurrences || 0),
        counterStart,
        firstManualAt: totals.first_manual_at || null,
        lastManualAt: totals.last_manual_at || null,
      },
      daily: dailyRows.map((r) => ({ day: r.day, count: Number(r.n || 0) })),
      recent: recentRows.map((r) => ({
        id: Number(r.id),
        text: r.text,
        time: r.time,
        peer: r.peer,
      })),
    });
  } catch (err) {
    console.error('sayang-stats error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/user-settings', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  try {
    const notifEnabled = await getNotifEnabled(username);
    const theme = await getUserTheme(username);
    const petData = await getUserPet(username);
    const presenceVisible = !isPresenceHidden(username);
    res.json({ ok: true, notifEnabled, theme, pet: petData.pet, petActiveAnim: petData.active, presenceVisible });
  } catch (err) {
    console.error('settings get error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/user-settings', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const { notifEnabled, theme, pet, petActiveAnim, presenceVisible } = req.body || {};
  if (notifEnabled !== undefined && typeof notifEnabled !== 'boolean') {
    return res.status(400).json({ ok: false });
  }
  if (theme !== undefined && !VALID_THEMES.has(theme)) {
    return res.status(400).json({ ok: false });
  }
  if (pet !== undefined && !VALID_PETS.has(pet)) {
    return res.status(400).json({ ok: false });
  }
  if (petActiveAnim !== undefined && !VALID_PET_ANIMS.has(petActiveAnim)) {
    return res.status(400).json({ ok: false });
  }
  if (presenceVisible !== undefined && typeof presenceVisible !== 'boolean') {
    return res.status(400).json({ ok: false });
  }
  if (
    notifEnabled === undefined && theme === undefined && pet === undefined &&
    petActiveAnim === undefined && presenceVisible === undefined
  ) {
    return res.status(400).json({ ok: false });
  }
  try {
    if (typeof notifEnabled === 'boolean') await setNotifEnabled(username, notifEnabled);
    if (theme !== undefined) await setUserTheme(username, theme);
    if (pet !== undefined || petActiveAnim !== undefined) {
      await setUserPet(username, { pet, active: petActiveAnim });
    }
    if (typeof presenceVisible === 'boolean') {
      const wasHidden = isPresenceHidden(username);
      await setPresenceVisible(username, presenceVisible);
      const nowHidden = !presenceVisible;
      if (wasHidden !== nowHidden) {
        for (const other of users) {
          if (other === username) continue;
          const payload = nowHidden
            ? { username, online: false, lastSeen: null }
            : {
                username,
                online: getPeerOnline(username, other),
                lastSeen: getPeerLastSeen(username, other),
              };
          io.to(userRoom(other)).emit('presence:update', payload);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('settings set error:', err.message);
    res.status(500).json({ ok: false });
  }
});

const LEADERBOARD_GAMES = new Set(['2048', 'snake', 'dino', 'racing']);

async function getGameScores(username) {
  const out = { '2048': 0, 'snake': 0, 'dino': 0, 'racing': 0 };
  try {
    const rs = await db.execute({
      sql: 'SELECT game, score FROM game_scores WHERE username = ?',
      args: [username],
    });
    for (const row of rs.rows) {
      const g = String(row.game);
      if (out.hasOwnProperty(g)) out[g] = Number(row.score) || 0;
    }
  } catch (err) {
    console.error('getGameScores error:', err.message);
  }
  return out;
}

app.post('/game-score', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const { game, score } = req.body || {};
  if (!LEADERBOARD_GAMES.has(game)) return res.status(400).json({ ok: false, error: 'Invalid game' });
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0 || s > 1e9) return res.status(400).json({ ok: false, error: 'Invalid score' });
  try {
    const existing = await db.execute({
      sql: 'SELECT score FROM game_scores WHERE username = ? AND game = ?',
      args: [username, game],
    });
    const current = existing.rows.length ? Number(existing.rows[0].score) : 0;
    if (s > current) {
      await db.execute({
        sql: `INSERT INTO game_scores (username, game, score, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(username, game) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
        args: [username, game, s, Date.now()],
      });
      return res.json({ ok: true, best: s, updated: true });
    }
    return res.json({ ok: true, best: current, updated: false });
  } catch (err) {
    console.error('game-score error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/leaderboard', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  let peer;
  if (username === HUB_USER) {
    peer = String(req.query.peer || '').trim();
    if (!peer || peer === HUB_USER) return res.status(400).json({ ok: false, error: 'Peer required' });
  } else {
    peer = username;
  }
  try {
    const [hubScores, peerScores] = await Promise.all([
      getGameScores(HUB_USER),
      getGameScores(peer),
    ]);
    res.json({ ok: true, hub: HUB_USER, peer, scores: { [HUB_USER]: hubScores, [peer]: peerScores } });
  } catch (err) {
    console.error('leaderboard error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/push-unsubscribe', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ ok: false });
  try {
    await deleteSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

const TRUTH_DARE_MARKER = '\u2063\u200C\u2063\u200C';

function encodeTruthDarePayload(payload) {
  return TRUTH_DARE_MARKER + JSON.stringify(payload);
}

function parseTruthDarePayload(text) {
  if (typeof text !== 'string' || !text.startsWith(TRUTH_DARE_MARKER)) return null;
  try {
    return JSON.parse(text.slice(TRUTH_DARE_MARKER.length));
  } catch (_) {
    return null;
  }
}

const TRUTH_CATEGORIES = [
  'kenangan masa kecil atau masa sekolah yang bikin ngakak atau memalukan',
  'kebiasaan aneh, guilty pleasure, atau hal random yang cuma kamu yang tau',
  'opini kontroversial soal makanan, film, musik, atau tren',
  'momen paling awkward atau embarrassing yang pernah dialami',
  'crush pertama, mantan, atau pengalaman cinta monyet',
  'ketakutan terbesar, insecurity, atau hal yang bikin overthinking',
  'mimpi teraneh atau khayalan liar yang pernah kepikiran',
  'kebohongan terbesar yang pernah dilontarkan ke orangtua atau teman',
  'hal random tentang tubuh, penampilan, atau kebiasaan personal',
  'fantasi romantis atau tipe ideal yang bikin baper',
  'pengalaman first kiss, pdkt, atau momen deg-degan sama seseorang',
  'topik dewasa: pengalaman intim, ketertarikan fisik, atau hal spicy pribadi',
  'topik dewasa: fantasi nakal, kink ringan, atau preferensi seksual',
  'topik dewasa: pengalaman pertama kali (kissing, dating, atau lebih)',
  'pendapat jujur tentang lawan main (peer) — apa yang paling menarik atau bikin penasaran',
  'kalau ketemu peer di dunia nyata besok, hal pertama yang mau dilakukan',
  'ide gila, mimpi besar, atau bucket list yang belum kesampaian',
  'hal paling memalukan yang pernah di-search di internet atau di history',
  'rahasia kecil yang belum pernah diceritain ke siapa-siapa',
  'pengalaman mabuk, nyoba hal baru, atau momen out of character',
];

const DARE_CATEGORIES = [
  'kirim voice note dengan gaya tertentu (whisper mode, suara kartun, logat daerah, atau baca puisi)',
  'kirim foto sekitar sekarang: sudut kamar teraneh, isi kulkas, wajah tanpa filter, atau outfit sekarang',
  'ketik pesan dengan cara nyeleneh (semua huruf kapital, alay 4l4y, bahasa jawa halus, atau tanpa vokal)',
  'tiru suara atau bikin ASMR singkat (makan kerupuk, ngetok meja, hujan pakai mulut)',
  'nyanyi 1 bait lagu apapun via voice note dengan penuh penghayatan',
  'kirim screenshot random: foto ke-7 di galeri, chat terakhir dengan mama, atau app yang paling sering dibuka',
  'gombalin peer pakai gombalan paling cringe yang bisa kamu bikin sekarang juga',
  'ceritain plot film/anime terakhir yang ditonton pakai emoji doang, minimal 8 emoji',
  'kirim voice note ngomong hal random selama 15 detik pakai gaya reporter berita',
  'buka kamera depan, screenshot ekspresi paling jelek yang bisa kamu bikin, terus kirim',
  'topik dewasa: kirim foto bagian tubuh non-vital yang menurutmu paling menarik (tangan, leher, pundak, tulang selangka)',
  'topik dewasa: voice note bilang sesuatu yang seductive atau menggoda ke peer',
  'topik dewasa: ceritain fantasi terpendam kamu dalam 2 kalimat',
  'topik dewasa: kirim outfit pose paling percaya diri kamu (boleh mirror selfie)',
  'topik dewasa: ketik apa yang bakal kamu lakuin ke peer kalau ada di sebelah kamu sekarang',
  'roleplay singkat: mulai chat berikutnya sebagai karakter tertentu (dokter, guru galak, alien) sampai peer nebak',
  'bikin haiku atau pantun dadakan tentang peer, kirim sekarang',
  'kirim rekomendasi lagu yang paling mewakili perasaan kamu ke peer sekarang',
  'bikin kuis 1 pertanyaan random tentang diri kamu, peer harus jawab bener sebelum lanjut',
  'ceritain aib kecil kamu hari ini dalam 1 pesan (jujur, no filter)',
];

async function fetchGeminiTruthOrDare(choice) {
  if (!botEnabled) return null;
  const isTruth = choice === 'truth';
  const pool = isTruth ? TRUTH_CATEGORIES : DARE_CATEGORIES;
  const allowSpicyCategory = Math.random() < 0.15;
  const filteredPool = allowSpicyCategory
    ? pool
    : pool.filter((c) => !c.startsWith('topik dewasa'));
  const category = filteredPool[Math.floor(Math.random() * filteredPool.length)];
  const spiceLevel = Math.random();
  const spiceHint = spiceLevel < 0.75
    ? 'Level: santai, umum, dan lucu — hindari topik seksual atau terlalu intim.'
    : spiceLevel < 0.92
      ? 'Level: agak menggoda atau bikin deg-degan, tapi tetap sopan dan tidak vulgar.'
      : 'Level: boleh sedikit spicy atau dewasa, tetap consensual dan playful, jangan vulgar berlebihan.';
  const systemPrompt = isTruth
    ? 'Kamu adalah pembuat pertanyaan Truth untuk game Truth or Dare antara dua orang dewasa yang sudah dekat (bisa pasangan, gebetan, atau sahabat) via chat pribadi. ' +
      'Tulis SATU pertanyaan personal dalam Bahasa Indonesia informal (gaya obrolan santai, boleh pakai "lo/gue" atau "kamu/aku"). ' +
      'Wajib eksplorasi topik yang bervariasi setiap kali — jangan generik, jangan mainstream, jangan mirip pertanyaan sebelumnya. ' +
      'DEFAULT-nya pertanyaan umum: kebiasaan, opini, kenangan, hobi, cerita lucu, mimpi, ketakutan, dsb. Jangan sering-sering topik seksual atau terlalu intim — cukup sesekali saja kalau memang diminta level spicy. ' +
      'Hindari SARA, hal yang benar-benar menyakitkan/traumatis, atau melibatkan minor. ' +
      'Maks 25 kata. Balas hanya satu pertanyaan diakhiri tanda tanya, tanpa quote marks, tanpa emoji, tanpa nomor, tanpa prefix "Truth:".'
    : 'Kamu adalah pembuat tantangan Dare untuk game Truth or Dare antara dua orang dewasa yang sudah dekat via chat pribadi. ' +
      'Tulis SATU tantangan dalam Bahasa Indonesia informal yang bisa dilakukan lewat chat (voice note, foto, screenshot, ketik gaya tertentu, roleplay, dsb.). ' +
      'Wajib variatif — jangan itu-itu aja. DEFAULT-nya tantangan umum yang lucu, kreatif, manis, atau random. Jangan sering-sering ke arah seksual/dewasa — cukup sesekali kalau diminta level spicy. ' +
      'Hindari melibatkan orang lain di dunia nyata, hal berbahaya secara fisik, konten ilegal, atau melibatkan minor. ' +
      'Maks 25 kata. Balas hanya satu tantangan sebagai kalimat perintah, tanpa quote marks, tanpa emoji, tanpa nomor, tanpa prefix "Dare:".';
  const userPrompt = isTruth
    ? `Buat satu pertanyaan Truth sekarang. Kategori kali ini: ${category}. ${spiceHint} Jangan sebut kategori atau level di jawaban.`
    : `Buat satu tantangan Dare sekarang. Kategori kali ini: ${category}. ${spiceHint} Jangan sebut kategori atau level di jawaban.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 1.3, topP: 0.98, maxOutputTokens: 120 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error('Gemini truth-or-dare error:', resp.status, errBody.slice(0, 200));
    return null;
  }
  const data = await resp.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((p) => p.text || '').join('').trim().replace(/^["']+|["']+$/g, '');
  return text ? text.slice(0, 280) : null;
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const username = token && verifyToken(token);
  if (!username) return next(new Error('Unauthorized'));
  socket.data.username = username;
  next();
});

const onlineUsers = new Set();
const socketCounts = new Map();
const lastRead = new Map();
const peerLastSeen = new Map(); // user → Map(other → iso)
const peerActiveSockets = new Map(); // user → Map(other → Set(socket.id))
const activeCalls = new Map();
const lastPingAt = new Map();
const tttSessions = new Map();
const snlSessions = new Map();

const SNL_LADDERS = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };
const SNL_SNAKES = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };

function snlNewSession(peer, inviter, opponent) {
  return {
    peer,
    status: 'pending',
    inviter,
    opponent,
    positions: { [inviter]: 0, [opponent]: 0 },
    turn: inviter,
    lastRoll: null,
    winner: null,
    startedAt: new Date().toISOString(),
    resigned: null,
  };
}

function snlPublicState(session) {
  if (!session) return null;
  return {
    peer: session.peer,
    status: session.status,
    inviter: session.inviter,
    opponent: session.opponent,
    positions: Object.assign({}, session.positions),
    turn: session.turn,
    lastRoll: session.lastRoll ? Object.assign({}, session.lastRoll) : null,
    winner: session.winner,
    startedAt: session.startedAt,
    resigned: session.resigned || null,
    ladders: SNL_LADDERS,
    snakes: SNL_SNAKES,
  };
}

const TTT_WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function tttEvaluate(board) {
  for (const [a, b, c] of TTT_WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { symbol: board[a], line: [a, b, c] };
    }
  }
  if (board.every((c) => c)) return { symbol: null, line: null, draw: true };
  return null;
}

function tttPublicState(session) {
  if (!session) return null;
  return {
    peer: session.peer,
    status: session.status,
    inviter: session.inviter,
    opponent: session.opponent,
    symbols: session.symbols,
    turn: session.turn,
    board: session.board.slice(),
    winner: session.winner,
    winnerSymbol: session.winnerSymbol,
    winLine: session.winLine,
    startedAt: session.startedAt,
  };
}

function ensureInnerMap(map, key) {
  let inner = map.get(key);
  if (!inner) { inner = new Map(); map.set(key, inner); }
  return inner;
}

function getPeerLastSeen(user, other) {
  const inner = peerLastSeen.get(user);
  return inner ? (inner.get(other) || null) : null;
}

function setPeerLastSeenInMemory(user, other, iso) {
  ensureInnerMap(peerLastSeen, user).set(other, iso);
}

async function persistPeerLastSeen(user, other, iso) {
  await db.execute({
    sql: `INSERT INTO presence_peer (username, peer, last_seen) VALUES (?, ?, ?)
          ON CONFLICT(username, peer) DO UPDATE SET last_seen = excluded.last_seen`,
    args: [user, other, iso],
  });
}

function touchPeerLastSeen(user, other, iso) {
  setPeerLastSeenInMemory(user, other, iso);
  persistPeerLastSeen(user, other, iso).catch((e) => console.error('persist peer last seen:', e.message));
}

function getPeerOnline(user, other) {
  const inner = peerActiveSockets.get(user);
  if (!inner) return false;
  const s = inner.get(other);
  return !!(s && s.size > 0);
}

function attachPeerSocket(user, other, socketId) {
  const inner = ensureInnerMap(peerActiveSockets, user);
  let s = inner.get(other);
  if (!s) { s = new Set(); inner.set(other, s); }
  s.add(socketId);
  return s.size;
}

function detachPeerSocket(user, other, socketId) {
  const inner = peerActiveSockets.get(user);
  if (!inner) return 0;
  const s = inner.get(other);
  if (!s) return 0;
  s.delete(socketId);
  const remaining = s.size;
  if (remaining === 0) inner.delete(other);
  if (inner.size === 0) peerActiveSockets.delete(user);
  return remaining;
}

async function loadAllPeerPresence() {
  const result = await db.execute('SELECT username, peer, last_seen FROM presence_peer');
  for (const row of result.rows) {
    setPeerLastSeenInMemory(String(row.username), String(row.peer), String(row.last_seen));
  }
}

function presenceSnapshot(viewer) {
  const snap = {};
  for (const u of users) {
    if (u === viewer) {
      snap[u] = {
        online: (socketCounts.get(u) || 0) > 0,
        lastSeen: null,
        avatar: avatars.get(u) || null,
      };
      continue;
    }
    const hidden = isPresenceHidden(u);
    snap[u] = {
      online: hidden ? false : getPeerOnline(u, viewer),
      lastSeen: hidden ? null : getPeerLastSeen(u, viewer),
      avatar: avatars.get(u) || null,
    };
  }
  return snap;
}

function presencePayloadFor(subject, viewer) {
  const hidden = isPresenceHidden(subject);
  return {
    username: subject,
    online: hidden ? false : getPeerOnline(subject, viewer),
    lastSeen: hidden ? null : getPeerLastSeen(subject, viewer),
  };
}

function emitPresenceTo(viewer, subject) {
  io.to(userRoom(viewer)).emit('presence:update', presencePayloadFor(subject, viewer));
}

io.on('connection', async (socket) => {
  const username = socket.data.username;
  socket.join(userRoom(username));
  const prev = socketCounts.get(username) || 0;
  socketCounts.set(username, prev + 1);
  const wasOffline = prev === 0;
  if (wasOffline) {
    onlineUsers.add(username);
  }
  try {
    const seenAt = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO peer_server (username, server_key, last_seen)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              server_key = excluded.server_key,
              last_seen = excluded.last_seen`,
      args: [username, SERVER_KEY, seenAt],
    });
    io.to(userRoom(HUB_USER)).emit('peer-server:update', {
      username,
      serverKey: SERVER_KEY,
      serverDisplay: SERVER_OPTIONS[SERVER_KEY].display,
      lastSeen: seenAt,
    });
  } catch (err) {
    console.error('peer_server upsert error:', err.message);
  }

  const initialPeer = defaultPeerFor(username);
  socket.data.activePeer = initialPeer;
  const initialOther = recipientOf(username, initialPeer);
  const initialSize = attachPeerSocket(username, initialOther, socket.id);
  const nowIso = new Date().toISOString();
  touchPeerLastSeen(username, initialOther, nowIso);
  const cameOnlineWithInitial = initialSize === 1;

  async function emitHistoryFor(peer) {
    try {
      const list = await getHistory(peer, 50);
      socket.emit('history', { peer, messages: list, hasMore: list.length === 50 });
    } catch (err) {
      console.error('history error:', err.message);
      socket.emit('history', { peer, messages: [], hasMore: false });
    }
  }

  socket.emit('readState', readStateSnapshot(username));
  await emitHistoryFor(initialPeer);
  socket.emit('presence:init', presenceSnapshot(username));
  if (username === HUB_USER) socket.emit('peers', peersList());
  if (cameOnlineWithInitial && !isPresenceHidden(username)) {
    emitPresenceTo(initialOther, username);
  }

  socket.on('selectPeer', async (payload, ack) => {
    const requested = payload && typeof payload.peer === 'string' ? payload.peer : null;
    let newPeer;
    if (username !== HUB_USER) {
      newPeer = username;
    } else {
      if (!requested || !users.has(requested) || requested === HUB_USER) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Invalid peer' });
        return;
      }
      newPeer = requested;
    }
    const oldPeer = socket.data.activePeer;
    const oldOther = recipientOf(username, oldPeer);
    const newOther = recipientOf(username, newPeer);
    if (oldOther !== newOther) {
      const remaining = detachPeerSocket(username, oldOther, socket.id);
      const iso = new Date().toISOString();
      touchPeerLastSeen(username, oldOther, iso);
      if (remaining === 0 && !isPresenceHidden(username)) {
        emitPresenceTo(oldOther, username);
      }
      const size = attachPeerSocket(username, newOther, socket.id);
      touchPeerLastSeen(username, newOther, iso);
      if (size === 1 && !isPresenceHidden(username)) {
        emitPresenceTo(newOther, username);
      }
    } else {
      touchPeerLastSeen(username, newOther, new Date().toISOString());
    }
    socket.data.activePeer = newPeer;
    if (username === HUB_USER) await emitHistoryFor(newPeer);
    if (typeof ack === 'function') ack({ ok: true, peer: newPeer });
  });

  async function handleOutgoing(payload, ack, build) {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const built = build(peer);
    if (built && built.error) {
      if (typeof ack === 'function') ack({ error: built.error });
      return;
    }
    const { msg, pushBody, broadcastExtras } = built;
    const clientId = payload && payload.clientId;
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      if (broadcastExtras) Object.assign(broadcast, broadcastExtras);
      emitToThread(peer, 'message', broadcast);
      touchPeerLastSeen(username, recipientOf(username, peer), msg.time);
      sendPushToRecipient(recipientOf(username, peer), {
        title: 'Berita terkini',
        body: 'Simak update dan artikel pilihan hari ini',
        url: '/',
      }).catch(() => {});
      if (typeof ack === 'function') ack({ id, peer });
    } catch (e) {
      console.error('save error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  }

  socket.on('message', async (payload, ack) => {
    let text;
    let replyToId = null;
    let autoSayang = false;
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object') {
      text = payload.text;
      replyToId = Number(payload.replyToId) || null;
      autoSayang = !!payload.autoSayang && username === 'turki';
    }
    if (typeof text !== 'string' || !text.trim()) {
      if (typeof ack === 'function') ack({ error: 'No text' });
      return;
    }
    await handleOutgoing(payload && typeof payload === 'object' ? payload : {}, ack, (peer) => {
      const safe = applyUserTextTransforms(username, text.slice(0, 1000));
      return {
        msg: { username, text: safe, time: new Date().toISOString(), replyToId, peer, autoSayang },
        pushBody: safe,
      };
    });
  });

  socket.on('image', async (payload, ack) => {
    if (!payload || typeof payload.dataUrl !== 'string') {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { dataUrl, caption, replyToId } = payload;
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      if (typeof ack === 'function') ack({ error: 'Invalid image' });
      return;
    }
    if (dataUrl.length > 15 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ error: 'Too large' });
      return;
    }
    await handleOutgoing(payload, ack, (peer) => {
      const safe = applyUserTextTransforms(username, typeof caption === 'string' ? caption.slice(0, 500) : '');
      return {
        msg: {
          username,
          image: dataUrl,
          text: safe,
          time: new Date().toISOString(),
          replyToId: Number(replyToId) || null,
          peer,
        },
        pushBody: safe || '📷 Sent a photo',
      };
    });
  });

  socket.on('video', async (payload, ack) => {
    if (!payload) {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { url, dataUrl, caption, replyToId } = payload;
    let videoVal = null;
    if (typeof url === 'string' && url) {
      if (!r2Enabled || !url.startsWith(R2_PUBLIC_VIDEO_PREFIX)) {
        if (typeof ack === 'function') ack({ error: 'Invalid video URL' });
        return;
      }
      if (url.length > 500) {
        if (typeof ack === 'function') ack({ error: 'URL too long' });
        return;
      }
      videoVal = url;
    } else if (typeof dataUrl === 'string') {
      const m = /^data:(video\/(webm|mp4));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) {
        if (typeof ack === 'function') ack({ error: 'Invalid video' });
        return;
      }
      if (dataUrl.length > 15 * 1024 * 1024) {
        if (typeof ack === 'function') ack({ error: 'Too large' });
        return;
      }
      videoVal = dataUrl;
    } else {
      if (typeof ack === 'function') ack({ error: 'No video' });
      return;
    }
    await handleOutgoing(payload, ack, (peer) => {
      const safe = applyUserTextTransforms(username, typeof caption === 'string' ? caption.slice(0, 500) : '');
      return {
        msg: {
          username,
          video: videoVal,
          text: safe,
          time: new Date().toISOString(),
          replyToId: Number(replyToId) || null,
          peer,
        },
        pushBody: safe || '🎬 Sent a video',
      };
    });
  });

  socket.on('audio', async (payload, ack) => {
    if (!payload || typeof payload.dataUrl !== 'string') {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { dataUrl, caption, replyToId } = payload;
    const m = /^data:(audio\/(webm|mp4|ogg|mpeg|wav))(;codecs=[A-Za-z0-9.,-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      if (typeof ack === 'function') ack({ error: 'Invalid audio' });
      return;
    }
    if (dataUrl.length > 3 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ error: 'Too large' });
      return;
    }
    await handleOutgoing(payload, ack, (peer) => {
      const safe = applyUserTextTransforms(username, typeof caption === 'string' ? caption.slice(0, 500) : '');
      return {
        msg: {
          username,
          audio: dataUrl,
          text: safe || null,
          time: new Date().toISOString(),
          replyToId: Number(replyToId) || null,
          peer,
        },
        pushBody: '🎤 Sent a voice note',
      };
    });
  });

  socket.on('sticker', async (payload, ack) => {
    if (!payload || typeof payload.name !== 'string') {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const entry = ALLOWED_STICKERS.get(payload.name);
    if (!entry) {
      if (typeof ack === 'function') ack({ error: 'Unknown sticker' });
      return;
    }
    if (!stickerVisibleTo(payload.name, username)) {
      if (typeof ack === 'function') ack({ error: 'Sticker not available' });
      return;
    }
    const stickerUrl = STICKER_PATH_PREFIX + entry.file;
    const { replyToId } = payload;
    await handleOutgoing(payload, ack, (peer) => ({
      msg: {
        username,
        image: stickerUrl,
        time: new Date().toISOString(),
        replyToId: Number(replyToId) || null,
        peer,
      },
      pushBody: `${payload.name} sticker`,
    }));
  });

  socket.on('forward', async (payload, ack) => {
    if (username !== HUB_USER) {
      if (typeof ack === 'function') ack({ error: 'Not allowed' });
      return;
    }
    const sourceId = Number(payload && payload.sourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      if (typeof ack === 'function') ack({ error: 'Invalid source' });
      return;
    }
    const source = await getMessageById(sourceId);
    if (!source || source.unsent) {
      if (typeof ack === 'function') ack({ error: 'Source unavailable' });
      return;
    }
    await handleOutgoing(payload, ack, (peer) => {
      const stickerVal = source.sticker && isStickerRef(source.sticker) ? source.sticker : null;
      const imageVal = stickerVal ? stickerVal : (source.image || null);
      const msg = {
        username,
        text: source.text || null,
        image: imageVal,
        video: source.video || null,
        audio: source.audio || null,
        time: new Date().toISOString(),
        replyToId: null,
        peer,
      };
      let pushBody = source.text || '';
      if (!pushBody) {
        if (stickerVal) pushBody = 'sticker';
        else if (source.image) pushBody = '📷 Sent a photo';
        else if (source.video) pushBody = '🎬 Sent a video';
        else if (source.audio) pushBody = '🎤 Sent a voice note';
      }
      return { msg, pushBody };
    });
  });

  socket.on('loadMore', async (payload, ack) => {
    const beforeId = Number(payload && payload.beforeId);
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer || !Number.isFinite(beforeId) || beforeId <= 0) {
      if (typeof ack === 'function') ack({ messages: [], hasMore: false });
      return;
    }
    try {
      const list = await getHistory(peer, 50, beforeId);
      const hasMore = list.length === 50;
      if (typeof ack === 'function') ack({ peer, messages: list, hasMore });
    } catch (e) {
      console.error('loadMore error:', e.message);
      if (typeof ack === 'function') ack({ messages: [], hasMore: false });
    }
  });

  socket.on('read', (payload) => {
    let id, requestedPeer;
    if (payload && typeof payload === 'object') {
      id = Number(payload.msgId);
      requestedPeer = payload.peer;
    } else {
      id = Number(payload);
    }
    if (!Number.isFinite(id) || id <= 0) return;
    const peer = resolvePeer(username, requestedPeer);
    if (!peer) return;
    const prev = getLastRead(username, peer);
    if (id <= prev) return;
    setLastRead(username, peer, id);
    persistReadState(username, peer, id).catch((e) => console.error('persist read state:', e.message));
    emitToThread(peer, 'read', { username, peer, lastReadId: id });
  });

  socket.on('unsend', async (payload, ack) => {
    const id = Number(payload && payload.id);
    if (!Number.isFinite(id) || id <= 0) {
      if (typeof ack === 'function') ack({ error: 'Invalid id' });
      return;
    }
    try {
      const msg = await getMessageById(id);
      if (!msg) {
        if (typeof ack === 'function') ack({ error: 'Not found' });
        return;
      }
      if (msg.username !== username) {
        if (typeof ack === 'function') ack({ error: 'Forbidden' });
        return;
      }
      if (!msg.unsent) {
        await db.execute({
          sql: 'UPDATE messages SET unsent = 1 WHERE id = ?',
          args: [id],
        });
      }
      emitToThread(msg.peer, 'unsend', { id, peer: msg.peer });
      if (typeof ack === 'function') ack({ ok: true, id, peer: msg.peer });
    } catch (e) {
      console.error('unsend error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('resend', async (payload, ack) => {
    const id = Number(payload && payload.id);
    if (!Number.isFinite(id) || id <= 0) {
      if (typeof ack === 'function') ack({ error: 'Invalid id' });
      return;
    }
    try {
      const msg = await getMessageById(id);
      if (!msg) {
        if (typeof ack === 'function') ack({ error: 'Not found' });
        return;
      }
      if (msg.username !== username) {
        if (typeof ack === 'function') ack({ error: 'Forbidden' });
        return;
      }
      if (msg.unsent) {
        await db.execute({
          sql: 'UPDATE messages SET unsent = 0 WHERE id = ?',
          args: [id],
        });
        msg.unsent = false;
      }
      emitToThread(msg.peer, 'resend', { id, peer: msg.peer, message: msg });
      if (typeof ack === 'function') ack({ ok: true, id, peer: msg.peer });
    } catch (e) {
      console.error('resend error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('truth-dare:challenge', async (payload, ack) => {
    if (!botEnabled) {
      if (typeof ack === 'function') ack({ error: 'AI belum aktif' });
      return;
    }
    await handleOutgoing(payload && typeof payload === 'object' ? payload : {}, ack, (peer) => {
      return {
        msg: {
          username,
          text: encodeTruthDarePayload({ state: 'pending', challenger: username }),
          time: new Date().toISOString(),
          replyToId: null,
          peer,
        },
        pushBody: '🎲 Truth or Dare?',
      };
    });
  });

  socket.on('truth-dare:pick', async (payload, ack) => {
    const id = Number(payload && payload.id);
    const choice = payload && payload.choice;
    if (!Number.isFinite(id) || id <= 0 || (choice !== 'truth' && choice !== 'dare')) {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    try {
      const msg = await getMessageById(id);
      if (!msg || msg.unsent) {
        if (typeof ack === 'function') ack({ error: 'Not found' });
        return;
      }
      const parsed = parseTruthDarePayload(msg.text);
      if (!parsed) {
        if (typeof ack === 'function') ack({ error: 'Bukan kartu T/D' });
        return;
      }
      if (parsed.state !== 'pending') {
        if (typeof ack === 'function') ack({ error: 'Sudah dijawab' });
        return;
      }
      if (username === parsed.challenger) {
        if (typeof ack === 'function') ack({ error: 'Tunggu peer memilih' });
        return;
      }
      const prompt = await fetchGeminiTruthOrDare(choice);
      if (!prompt) {
        if (typeof ack === 'function') ack({ error: 'Gagal generate' });
        return;
      }
      const nextPayload = {
        state: 'answered',
        challenger: parsed.challenger,
        picker: username,
        choice,
        prompt,
      };
      const nextText = encodeTruthDarePayload(nextPayload);
      await db.execute({
        sql: 'UPDATE messages SET text = ? WHERE id = ?',
        args: [nextText, id],
      });
      emitToThread(msg.peer, 'truth-dare:update', {
        id,
        peer: msg.peer,
        payload: nextPayload,
      });
      if (typeof ack === 'function') ack({ ok: true, id, peer: msg.peer });
    } catch (e) {
      console.error('truth-dare:pick error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('tictactoe:sync', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = tttSessions.get(peer) || null;
    if (typeof ack === 'function') ack({ ok: true, session: tttPublicState(session) });
  });

  socket.on('tictactoe:invite', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const existing = tttSessions.get(peer);
    if (existing && existing.status !== 'done') {
      if (typeof ack === 'function') ack({ error: 'Sesi masih aktif' });
      return;
    }
    const opponent = recipientOf(username, peer);
    const session = {
      peer,
      status: 'pending',
      inviter: username,
      opponent,
      symbols: { [username]: 'X', [opponent]: 'O' },
      turn: 'X',
      board: Array(9).fill(null),
      winner: null,
      winnerSymbol: null,
      winLine: null,
      startedAt: new Date().toISOString(),
    };
    tttSessions.set(peer, session);
    emitToThread(peer, 'tictactoe:state', { peer, session: tttPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: tttPublicState(session) });
  });

  socket.on('tictactoe:accept', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = tttSessions.get(peer);
    if (!session || session.status !== 'pending') {
      if (typeof ack === 'function') ack({ error: 'Tidak ada undangan' });
      return;
    }
    if (username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan penerima undangan' });
      return;
    }
    session.status = 'active';
    session.startedAt = new Date().toISOString();
    emitToThread(peer, 'tictactoe:state', { peer, session: tttPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: tttPublicState(session) });
  });

  socket.on('tictactoe:decline', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = tttSessions.get(peer);
    if (!session || session.status !== 'pending') {
      if (typeof ack === 'function') ack({ error: 'Tidak ada undangan' });
      return;
    }
    if (username !== session.opponent && username !== session.inviter) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    tttSessions.delete(peer);
    emitToThread(peer, 'tictactoe:state', { peer, session: null, reason: 'declined', by: username });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('tictactoe:move', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const index = Number(payload && payload.index);
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      if (typeof ack === 'function') ack({ error: 'Kotak tidak valid' });
      return;
    }
    const session = tttSessions.get(peer);
    if (!session || session.status !== 'active') {
      if (typeof ack === 'function') ack({ error: 'Game belum dimulai' });
      return;
    }
    const mySymbol = session.symbols[username];
    if (!mySymbol) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    if (session.turn !== mySymbol) {
      if (typeof ack === 'function') ack({ error: 'Belum giliran kamu' });
      return;
    }
    if (session.board[index]) {
      if (typeof ack === 'function') ack({ error: 'Kotak sudah terisi' });
      return;
    }
    session.board[index] = mySymbol;
    const result = tttEvaluate(session.board);
    if (result) {
      session.status = 'done';
      if (result.symbol) {
        session.winnerSymbol = result.symbol;
        session.winner = Object.keys(session.symbols).find((u) => session.symbols[u] === result.symbol) || null;
        session.winLine = result.line;
      } else {
        session.winner = 'draw';
      }
    } else {
      session.turn = mySymbol === 'X' ? 'O' : 'X';
    }
    emitToThread(peer, 'tictactoe:state', { peer, session: tttPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: tttPublicState(session) });
  });

  socket.on('tictactoe:rematch', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = tttSessions.get(peer);
    if (!session || session.status !== 'done') {
      if (typeof ack === 'function') ack({ error: 'Belum ada sesi selesai' });
      return;
    }
    if (username !== session.inviter && username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    const newInviter = username;
    const newOpponent = newInviter === session.inviter ? session.opponent : session.inviter;
    const next = {
      peer,
      status: 'active',
      inviter: newInviter,
      opponent: newOpponent,
      symbols: { [newInviter]: 'X', [newOpponent]: 'O' },
      turn: 'X',
      board: Array(9).fill(null),
      winner: null,
      winnerSymbol: null,
      winLine: null,
      startedAt: new Date().toISOString(),
    };
    tttSessions.set(peer, next);
    emitToThread(peer, 'tictactoe:state', { peer, session: tttPublicState(next) });
    if (typeof ack === 'function') ack({ ok: true, session: tttPublicState(next) });
  });

  socket.on('tictactoe:leave', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = tttSessions.get(peer);
    if (!session) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    if (username !== session.inviter && username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    if (session.status === 'active') {
      session.status = 'done';
      const otherSymbol = session.symbols[username] === 'X' ? 'O' : 'X';
      session.winnerSymbol = otherSymbol;
      session.winner = Object.keys(session.symbols).find((u) => session.symbols[u] === otherSymbol) || null;
      session.winLine = null;
      session.resigned = username;
      emitToThread(peer, 'tictactoe:state', { peer, session: tttPublicState(session), reason: 'resigned', by: username });
    } else {
      tttSessions.delete(peer);
      emitToThread(peer, 'tictactoe:state', { peer, session: null, reason: 'left', by: username });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('snakeladder:sync', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer) || null;
    if (typeof ack === 'function') ack({ ok: true, session: snlPublicState(session) });
  });

  socket.on('snakeladder:invite', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const existing = snlSessions.get(peer);
    if (existing && existing.status !== 'done') {
      if (typeof ack === 'function') ack({ error: 'Sesi masih aktif' });
      return;
    }
    const opponent = recipientOf(username, peer);
    const session = snlNewSession(peer, username, opponent);
    snlSessions.set(peer, session);
    emitToThread(peer, 'snakeladder:state', { peer, session: snlPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: snlPublicState(session) });
  });

  socket.on('snakeladder:accept', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer);
    if (!session || session.status !== 'pending') {
      if (typeof ack === 'function') ack({ error: 'Tidak ada undangan' });
      return;
    }
    if (username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan penerima undangan' });
      return;
    }
    session.status = 'active';
    session.startedAt = new Date().toISOString();
    emitToThread(peer, 'snakeladder:state', { peer, session: snlPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: snlPublicState(session) });
  });

  socket.on('snakeladder:decline', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer);
    if (!session || session.status !== 'pending') {
      if (typeof ack === 'function') ack({ error: 'Tidak ada undangan' });
      return;
    }
    if (username !== session.opponent && username !== session.inviter) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    snlSessions.delete(peer);
    emitToThread(peer, 'snakeladder:state', { peer, session: null, reason: 'declined', by: username });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('snakeladder:roll', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer);
    if (!session || session.status !== 'active') {
      if (typeof ack === 'function') ack({ error: 'Game belum dimulai' });
      return;
    }
    if (username !== session.inviter && username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    if (session.turn !== username) {
      if (typeof ack === 'function') ack({ error: 'Belum giliran kamu' });
      return;
    }
    const dice = 1 + Math.floor(Math.random() * 6);
    const from = session.positions[username] || 0;
    let landed = from + dice;
    let jumped = null;
    if (landed > 100) {
      landed = from;
    } else if (landed === 100) {
      session.positions[username] = 100;
      session.status = 'done';
      session.winner = username;
    } else {
      if (SNL_LADDERS[landed] !== undefined) {
        jumped = { kind: 'ladder', from: landed, to: SNL_LADDERS[landed] };
        landed = SNL_LADDERS[landed];
      } else if (SNL_SNAKES[landed] !== undefined) {
        jumped = { kind: 'snake', from: landed, to: SNL_SNAKES[landed] };
        landed = SNL_SNAKES[landed];
      }
      session.positions[username] = landed;
    }
    session.lastRoll = { by: username, dice, from, to: landed, jumped };
    if (session.status !== 'done') {
      if (dice !== 6) {
        const other = username === session.inviter ? session.opponent : session.inviter;
        session.turn = other;
      }
    }
    emitToThread(peer, 'snakeladder:state', { peer, session: snlPublicState(session) });
    if (typeof ack === 'function') ack({ ok: true, session: snlPublicState(session) });
  });

  socket.on('snakeladder:rematch', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer);
    if (!session || session.status !== 'done') {
      if (typeof ack === 'function') ack({ error: 'Belum ada sesi selesai' });
      return;
    }
    if (username !== session.inviter && username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    const newInviter = username;
    const newOpponent = newInviter === session.inviter ? session.opponent : session.inviter;
    const next = snlNewSession(peer, newInviter, newOpponent);
    next.status = 'active';
    snlSessions.set(peer, next);
    emitToThread(peer, 'snakeladder:state', { peer, session: snlPublicState(next) });
    if (typeof ack === 'function') ack({ ok: true, session: snlPublicState(next) });
  });

  socket.on('snakeladder:leave', (payload, ack) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const session = snlSessions.get(peer);
    if (!session) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    if (username !== session.inviter && username !== session.opponent) {
      if (typeof ack === 'function') ack({ error: 'Bukan peserta' });
      return;
    }
    if (session.status === 'active') {
      session.status = 'done';
      session.winner = username === session.inviter ? session.opponent : session.inviter;
      session.resigned = username;
      emitToThread(peer, 'snakeladder:state', { peer, session: snlPublicState(session), reason: 'resigned', by: username });
    } else {
      snlSessions.delete(peer);
      emitToThread(peer, 'snakeladder:state', { peer, session: null, reason: 'left', by: username });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('typing', (payload) => {
    const typing = !!(payload && payload.typing);
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) return;
    const recipient = recipientOf(username, peer);
    io.to(userRoom(recipient)).emit('typing', { username, peer, typing });
  });

  socket.on('ping:thinking', (payload) => {
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) return;
    const now = Date.now();
    if (now - (lastPingAt.get(username) || 0) < 3000) return;
    lastPingAt.set(username, now);
    const recipient = recipientOf(username, peer);
    io.to(userRoom(recipient)).emit('ping:thinking', { from: username, peer });
  });

  socket.on('panic:trigger', (payload, ack) => {
    const PANIC_PAIR = { occupatus: 'turki', turki: 'occupatus' };
    const partner = PANIC_PAIR[username];
    if (partner) {
      io.to(userRoom(partner)).emit('panic:remote', { from: username });
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('reaction:toggle', async (payload, ack) => {
    const id = Number(payload && payload.id);
    const rawEmoji = payload && typeof payload.emoji === 'string' ? payload.emoji.trim() : '';
    // Reject empty, overly long, or emojis containing whitespace/newlines
    if (!Number.isFinite(id) || id <= 0 || !rawEmoji || rawEmoji.length > 16 || /\s/.test(rawEmoji)) {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    try {
      const msg = await getMessageById(id);
      if (!msg) {
        if (typeof ack === 'function') ack({ error: 'Not found' });
        return;
      }
      const peer = msg.peer;
      const allowed = username === HUB_USER || username === peer;
      if (!allowed) {
        if (typeof ack === 'function') ack({ error: 'Forbidden' });
        return;
      }
      const existing = await db.execute({
        sql: 'SELECT 1 FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ? LIMIT 1',
        args: [id, username, rawEmoji],
      });
      let added = false;
      if (existing.rows.length) {
        await db.execute({
          sql: 'DELETE FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?',
          args: [id, username, rawEmoji],
        });
      } else {
        await db.execute({
          sql: 'INSERT INTO message_reactions (message_id, username, emoji, peer, time) VALUES (?, ?, ?, ?, ?)',
          args: [id, username, rawEmoji, peer, new Date().toISOString()],
        });
        added = true;
      }
      const listRes = await db.execute({
        sql: 'SELECT username, emoji FROM message_reactions WHERE message_id = ?',
        args: [id],
      });
      const reactions = listRes.rows.map((r) => ({ username: String(r.username), emoji: String(r.emoji) }));
      emitToThread(peer, 'reaction:update', { id, peer, reactions, actor: username, emoji: rawEmoji, added });
      if (typeof ack === 'function') ack({ ok: true, added });
    } catch (e) {
      console.error('reaction error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  function resolveCallTarget(payloadPeer) {
    const peer = resolvePeer(username, payloadPeer);
    if (!peer) return null;
    return recipientOf(username, peer);
  }

  function clearActiveCall(reason) {
    const call = activeCalls.get(username);
    if (!call) return;
    activeCalls.delete(username);
    const other = call.peer;
    const otherCall = activeCalls.get(other);
    if (otherCall && otherCall.callId === call.callId) {
      activeCalls.delete(other);
    }
    io.to(userRoom(other)).emit('call:end', { from: username, callId: call.callId, reason: reason || 'ended' });
  }

  socket.on('call:invite', (payload, ack) => {
    const target = resolveCallTarget(payload && payload.peer);
    if (!target) {
      if (typeof ack === 'function') ack({ error: 'Invalid peer' });
      return;
    }
    const callId = typeof payload.callId === 'string' && payload.callId.length <= 64 ? payload.callId : null;
    if (!callId || !payload.sdp || typeof payload.sdp !== 'object') {
      if (typeof ack === 'function') ack({ error: 'Invalid invite' });
      return;
    }
    if (activeCalls.has(username)) {
      if (typeof ack === 'function') ack({ error: 'You are already in a call' });
      return;
    }
    if (activeCalls.has(target)) {
      if (typeof ack === 'function') ack({ error: 'busy', code: 'BUSY' });
      return;
    }
    if (!onlineUsers.has(target)) {
      // Still allow — push notif may wake them. Caller can time out.
    }
    activeCalls.set(username, { peer: target, callId, role: 'caller' });
    activeCalls.set(target, { peer: username, callId, role: 'callee' });
    io.to(userRoom(target)).emit('call:invite', {
      from: username,
      callId,
      sdp: payload.sdp,
      media: payload.media === 'audio' ? 'audio' : 'video',
    });
    sendPushToRecipient(target, {
      title: `Incoming call from ${username}`,
      body: 'Tap to answer',
      url: '/',
      tag: `call-${callId}`,
    }).catch(() => {});
    if (typeof ack === 'function') ack({ ok: true, callId });
  });

  socket.on('call:accept', (payload, ack) => {
    const call = activeCalls.get(username);
    if (!call || call.callId !== (payload && payload.callId)) {
      if (typeof ack === 'function') ack({ error: 'No matching call' });
      return;
    }
    if (!payload.sdp || typeof payload.sdp !== 'object') {
      if (typeof ack === 'function') ack({ error: 'Invalid sdp' });
      return;
    }
    io.to(userRoom(call.peer)).emit('call:accept', {
      from: username,
      callId: call.callId,
      sdp: payload.sdp,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('call:reject', (payload, ack) => {
    const call = activeCalls.get(username);
    if (!call || call.callId !== (payload && payload.callId)) {
      if (typeof ack === 'function') ack({ error: 'No matching call' });
      return;
    }
    const target = call.peer;
    activeCalls.delete(username);
    const otherCall = activeCalls.get(target);
    if (otherCall && otherCall.callId === call.callId) activeCalls.delete(target);
    io.to(userRoom(target)).emit('call:reject', {
      from: username,
      callId: call.callId,
      reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 40) : 'declined',
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('call:ice', (payload, ack) => {
    const call = activeCalls.get(username);
    if (!call || call.callId !== (payload && payload.callId)) {
      if (typeof ack === 'function') ack({ error: 'No matching call' });
      return;
    }
    if (!payload.candidate || typeof payload.candidate !== 'object') {
      if (typeof ack === 'function') ack({ error: 'Invalid candidate' });
      return;
    }
    io.to(userRoom(call.peer)).emit('call:ice', {
      from: username,
      callId: call.callId,
      candidate: payload.candidate,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('call:end', (payload, ack) => {
    const call = activeCalls.get(username);
    if (!call) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    if (payload && payload.callId && payload.callId !== call.callId) {
      if (typeof ack === 'function') ack({ error: 'Stale call id' });
      return;
    }
    clearActiveCall((payload && typeof payload.reason === 'string') ? payload.reason.slice(0, 40) : 'ended');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const peer = socket.data.activePeer;
    const other = recipientOf(username, peer);
    if (peer) {
      io.to(userRoom(other)).emit('typing', { username, peer, typing: false });
    }
    const remaining = detachPeerSocket(username, other, socket.id);
    const iso = new Date().toISOString();
    touchPeerLastSeen(username, other, iso);
    if (remaining === 0 && !isPresenceHidden(username)) {
      emitPresenceTo(other, username);
    }
    const count = (socketCounts.get(username) || 1) - 1;
    if (count > 0) {
      socketCounts.set(username, count);
      return;
    }
    socketCounts.delete(username);
    onlineUsers.delete(username);
    if (activeCalls.has(username)) clearActiveCall('peer_disconnected');
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => loadPasswordCache())
  .then(() => seedPasswords())
  .then(() => loadAllReadState())
  .then(() => loadAllPeerPresence())
  .then(() => loadAllPresenceVisibility())
  .then(() => loadAllAvatars())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat running at http://localhost:${PORT}`);
      console.log(`DB: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : 'local file (chat.db)'}`);
      console.log(`Push notifications: ${pushEnabled ? 'enabled' : 'disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)'}`);
      console.log(`R2 video storage: ${r2Enabled ? `enabled (${R2_BUCKET})` : 'disabled (set R2_* env vars)'}`);
      console.log('Available users:', [...users].join(', '));
    });
  })
  .catch((err) => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
