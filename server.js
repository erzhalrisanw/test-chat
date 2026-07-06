const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const webPush = require('web-push');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 15 * 1024 * 1024 });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:chat.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const HUB_USER = 'occupatus';
const LEGACY_PEER = 'mutatio';

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

async function loadAllPresence() {
  const result = await db.execute('SELECT username, last_seen FROM presence');
  for (const row of result.rows) {
    lastSeen.set(String(row.username), String(row.last_seen));
  }
}

async function persistLastSeen(username, iso) {
  await db.execute({
    sql: `INSERT INTO presence (username, last_seen) VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET last_seen = excluded.last_seen`,
    args: [username, iso],
  });
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

const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const ALLOWED_VIDEO_MIME = new Set(['video/webm', 'video/mp4', 'video/quicktime']);
const R2_PUBLIC_VIDEO_PREFIX = r2Enabled ? `${R2_PUBLIC_URL}/videos/` : '';

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
  if (!recipient || onlineUsers.has(recipient)) return;
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
  if (username === 'occupatus') {
    return text.replace(/\bayang(?!nya\b)/gi, (m) => (m[0] === 'A' ? 'Sayang' : 'sayang'));
  }
  return text;
}

async function saveMessage(msg) {
  const result = await db.execute({
    sql: 'INSERT INTO messages (username, text, image, video, audio, time, reply_to_id, peer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [msg.username, msg.text || null, msg.image || null, msg.video || null, msg.audio || null, msg.time, msg.replyToId || null, msg.peer],
  });
  return Number(result.lastInsertRowid);
}

function mapRow(r) {
  const out = {
    id: Number(r.id),
    username: r.username,
    text: r.text,
    image: r.image,
    video: r.video,
    audio: r.audio,
    time: r.time,
    peer: r.peer,
    unsent: !!Number(r.unsent || 0),
  };
  if (r.reply_to_id) {
    out.replyTo = {
      id: Number(r.reply_to_id),
      username: r.reply_username,
      text: r.reply_text,
      hasImage: !!r.reply_image,
      hasVideo: !!r.reply_video,
      hasAudio: !!r.reply_audio,
      unsent: !!Number(r.reply_unsent || 0),
    };
  }
  return out;
}

async function getMessageById(id) {
  const result = await db.execute({
    sql: `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent,
                 p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
          FROM messages m
          LEFT JOIN messages p ON m.reply_to_id = p.id
          WHERE m.id = ?`,
    args: [id],
  });
  if (!result.rows.length) return null;
  return mapRow(result.rows[0]);
}

async function getHistory(peer, limit = 50, beforeId = null) {
  const sql = beforeId
    ? `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       WHERE m.peer = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    : `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id, m.peer, m.unsent,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio, p.unsent AS reply_unsent
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       WHERE m.peer = ?
       ORDER BY m.id DESC LIMIT ?`;
  const args = beforeId ? [peer, beforeId, limit] : [peer, limit];
  const result = await db.execute({ sql, args });
  return result.rows.reverse().map(mapRow);
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

const GALLERY_PAGE_DEFAULT = 8;
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
  try {
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) AS cnt FROM messages WHERE peer = ? AND (image IS NOT NULL OR video IS NOT NULL)${unsentFilter}`,
      args: [peer],
    });
    const totalItems = Number(countResult.rows[0].cnt);
    const totalPages = Math.ceil(totalItems / limit);

    const result = await db.execute({
      sql: `SELECT id, username, image, video, time
             FROM messages
            WHERE peer = ? AND (image IS NOT NULL OR video IS NOT NULL)${unsentFilter}
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
    }));

    res.json({ ok: true, items, totalItems, totalPages, page, peer });
  } catch (err) {
    console.error('gallery error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/user-settings', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  try {
    const notifEnabled = await getNotifEnabled(username);
    res.json({ ok: true, notifEnabled });
  } catch (err) {
    console.error('settings get error:', err.message);
    res.status(500).json({ ok: false });
  }
});

app.post('/user-settings', async (req, res) => {
  const username = authFromReq(req);
  if (!username) return res.status(401).json({ ok: false });
  const { notifEnabled } = req.body || {};
  if (typeof notifEnabled !== 'boolean') return res.status(400).json({ ok: false });
  try {
    await setNotifEnabled(username, notifEnabled);
    res.json({ ok: true });
  } catch (err) {
    console.error('settings set error:', err.message);
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
const lastSeen = new Map();
const activeCalls = new Map();

function presenceSnapshot() {
  const snap = {};
  for (const u of users) {
    snap[u] = {
      online: onlineUsers.has(u),
      lastSeen: lastSeen.get(u) || null,
    };
  }
  return snap;
}

function touchLastSeen(username, iso) {
  lastSeen.set(username, iso);
  persistLastSeen(username, iso).catch((e) => console.error('persist last seen:', e.message));
}

io.on('connection', async (socket) => {
  const username = socket.data.username;
  socket.join(userRoom(username));
  const prev = socketCounts.get(username) || 0;
  socketCounts.set(username, prev + 1);
  const wasOffline = prev === 0;
  if (wasOffline) {
    onlineUsers.add(username);
    touchLastSeen(username, new Date().toISOString());
  }

  const initialPeer = defaultPeerFor(username);
  socket.data.activePeer = initialPeer;

  async function emitHistoryFor(peer) {
    try {
      const list = await getHistory(peer, 50);
      socket.emit('history', { peer, messages: list, hasMore: list.length === 50 });
    } catch (err) {
      console.error('history error:', err.message);
      socket.emit('history', { peer, messages: [], hasMore: false });
    }
  }

  await emitHistoryFor(initialPeer);
  socket.emit('readState', readStateSnapshot(username));
  socket.emit('presence:init', presenceSnapshot());
  if (username === HUB_USER) socket.emit('peers', peersList());
  if (wasOffline) {
    socket.broadcast.emit('presence:update', { username, online: true, lastSeen: lastSeen.get(username) || null });
  }

  socket.on('selectPeer', async (payload, ack) => {
    const requested = payload && typeof payload.peer === 'string' ? payload.peer : null;
    if (username !== HUB_USER) {
      socket.data.activePeer = username;
      if (typeof ack === 'function') ack({ ok: true, peer: username });
      return;
    }
    if (!requested || !users.has(requested) || requested === HUB_USER) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Invalid peer' });
      return;
    }
    socket.data.activePeer = requested;
    await emitHistoryFor(requested);
    if (typeof ack === 'function') ack({ ok: true, peer: requested });
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
    const { msg, pushBody } = built;
    const clientId = payload && payload.clientId;
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      emitToThread(peer, 'message', broadcast);
      touchLastSeen(username, msg.time);
      sendPushToRecipient(recipientOf(username, peer), {
        title: `Message from ${username}`,
        body: pushBody,
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
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object') {
      text = payload.text;
      replyToId = Number(payload.replyToId) || null;
    }
    if (typeof text !== 'string' || !text.trim()) {
      if (typeof ack === 'function') ack({ error: 'No text' });
      return;
    }
    await handleOutgoing(payload && typeof payload === 'object' ? payload : {}, ack, (peer) => {
      const safe = applyUserTextTransforms(username, text.slice(0, 1000));
      return {
        msg: { username, text: safe, time: new Date().toISOString(), replyToId, peer },
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
    const { dataUrl, replyToId } = payload;
    const m = /^data:(audio\/(webm|mp4|ogg|mpeg|wav))(;codecs=[A-Za-z0-9.,-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      if (typeof ack === 'function') ack({ error: 'Invalid audio' });
      return;
    }
    if (dataUrl.length > 3 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ error: 'Too large' });
      return;
    }
    await handleOutgoing(payload, ack, (peer) => ({
      msg: {
        username,
        audio: dataUrl,
        time: new Date().toISOString(),
        replyToId: Number(replyToId) || null,
        peer,
      },
      pushBody: '🎤 Sent a voice note',
    }));
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

  socket.on('typing', (payload) => {
    const typing = !!(payload && payload.typing);
    const peer = resolvePeer(username, payload && payload.peer);
    if (!peer) return;
    const recipient = recipientOf(username, peer);
    io.to(userRoom(recipient)).emit('typing', { username, peer, typing });
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
    if (peer) {
      const recipient = recipientOf(username, peer);
      io.to(userRoom(recipient)).emit('typing', { username, peer, typing: false });
    }
    const count = (socketCounts.get(username) || 1) - 1;
    if (count > 0) {
      socketCounts.set(username, count);
      return;
    }
    socketCounts.delete(username);
    onlineUsers.delete(username);
    if (activeCalls.has(username)) clearActiveCall('peer_disconnected');
    const iso = new Date().toISOString();
    touchLastSeen(username, iso);
    io.emit('presence:update', { username, online: false, lastSeen: iso });
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => loadPasswordCache())
  .then(() => seedPasswords())
  .then(() => loadAllReadState())
  .then(() => loadAllPresence())
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
