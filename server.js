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
      reply_to_id INTEGER
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
      username TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    )
  `);
}

async function loadAllReadState() {
  const result = await db.execute('SELECT username, last_read_id FROM read_state');
  for (const row of result.rows) {
    lastRead.set(String(row.username), Number(row.last_read_id));
  }
}

async function persistReadState(username, id) {
  await db.execute({
    sql: `INSERT INTO read_state (username, last_read_id) VALUES (?, ?)
          ON CONFLICT(username) DO UPDATE SET last_read_id = excluded.last_read_id`,
    args: [username, id],
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

const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_VIDEO_MIME = new Set(['video/webm', 'video/mp4']);
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

async function sendPushToOfflineUsers(sender, payload) {
  if (!pushEnabled) return;
  const recipients = [...users].filter((u) => u !== sender && !onlineUsers.has(u));
  await Promise.all(recipients.map(async (u) => {
    const subs = await getSubscriptionsFor(u);
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
  }));
}

async function saveMessage(msg) {
  const result = await db.execute({
    sql: 'INSERT INTO messages (username, text, image, video, audio, time, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [msg.username, msg.text || null, msg.image || null, msg.video || null, msg.audio || null, msg.time, msg.replyToId || null],
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
  };
  if (r.reply_to_id) {
    out.replyTo = {
      id: Number(r.reply_to_id),
      username: r.reply_username,
      text: r.reply_text,
      hasImage: !!r.reply_image,
      hasVideo: !!r.reply_video,
      hasAudio: !!r.reply_audio,
    };
  }
  return out;
}

async function getMessageById(id) {
  const result = await db.execute({
    sql: `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id,
                 p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio
          FROM messages m
          LEFT JOIN messages p ON m.reply_to_id = p.id
          WHERE m.id = ?`,
    args: [id],
  });
  if (!result.rows.length) return null;
  return mapRow(result.rows[0]);
}

async function getHistory(limit = 50, beforeId = null) {
  const sql = beforeId
    ? `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       WHERE m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    : `SELECT m.id, m.username, m.text, m.image, m.video, m.audio, m.time, m.reply_to_id,
              p.username AS reply_username, p.text AS reply_text, p.image AS reply_image, p.video AS reply_video, p.audio AS reply_audio
       FROM messages m
       LEFT JOIN messages p ON m.reply_to_id = p.id
       ORDER BY m.id DESC LIMIT ?`;
  const args = beforeId ? [beforeId, limit] : [limit];
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
    const ext = contentType === 'video/mp4' ? 'mp4' : 'webm';
    const date = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomBytes(16).toString('hex');
    const key = `videos/${date}/${rand}.${ext}`;
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: sz,
    });
    const uploadUrl = await getSignedUrl(r2Client, cmd, { expiresIn: 300 });
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
  
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(
    GALLERY_PAGE_MAX,
    Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : GALLERY_PAGE_DEFAULT)
  );
  
  const parsedPage = parseInt(req.query.page, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const offset = (page - 1) * limit;
  
  try {
    // Hitung total items untuk pagination info
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) AS cnt FROM messages WHERE image IS NOT NULL OR video IS NOT NULL`,
    });
    const totalItems = Number(countResult.rows[0].cnt);
    const totalPages = Math.ceil(totalItems / limit);
    
    // Ambil items untuk halaman tertentu (dari yang terbaru)
    const result = await db.execute({
      sql: `SELECT id, username, image, video, time
             FROM messages
            WHERE image IS NOT NULL OR video IS NOT NULL
            ORDER BY id DESC
            LIMIT ? OFFSET ?`,
      args: [limit, offset],
    });
    
    const items = result.rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      time: r.time,
      type: r.image ? 'image' : 'video',
      src: r.image || r.video,
    }));
    
    res.json({ ok: true, items, totalItems, totalPages, page });
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
const lastRead = new Map();

io.on('connection', async (socket) => {
  const username = socket.data.username;
  onlineUsers.add(username);

  try {
    const list = await getHistory(50);
    socket.emit('history', { messages: list, hasMore: list.length === 50 });
  } catch (err) {
    console.error('history error:', err.message);
    socket.emit('history', { messages: [], hasMore: false });
  }
  socket.emit('readState', Object.fromEntries(lastRead));

  socket.on('message', async (payload, ack) => {
    let text, replyToId, clientId;
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload && typeof payload === 'object') {
      text = payload.text;
      replyToId = Number(payload.replyToId) || null;
      clientId = payload.clientId;
    }
    if (typeof text !== 'string' || !text.trim()) {
      if (typeof ack === 'function') ack({ error: 'No text' });
      return;
    }
    const msg = {
      username,
      text: text.slice(0, 1000),
      time: new Date().toISOString(),
      replyToId,
    };
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      io.emit('message', broadcast);
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: msg.text,
        url: '/',
      }).catch(() => {});
      if (typeof ack === 'function') ack({ id });
    } catch (e) {
      console.error('save error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('image', async (payload, ack) => {
    if (!payload || typeof payload.dataUrl !== 'string') {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { dataUrl, caption, replyToId, clientId } = payload;
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      if (typeof ack === 'function') ack({ error: 'Invalid image' });
      return;
    }
    if (dataUrl.length > 15 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ error: 'Too large' });
      return;
    }
    const msg = {
      username,
      image: dataUrl,
      text: typeof caption === 'string' ? caption.slice(0, 500) : '',
      time: new Date().toISOString(),
      replyToId: Number(replyToId) || null,
    };
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      io.emit('message', broadcast);
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: msg.text || '📷 Sent a photo',
        url: '/',
      }).catch(() => {});
      if (typeof ack === 'function') ack({ id });
    } catch (e) {
      console.error('save error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('video', async (payload, ack) => {
    if (!payload) {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { url, dataUrl, caption, replyToId, clientId } = payload;
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
    const msg = {
      username,
      video: videoVal,
      text: typeof caption === 'string' ? caption.slice(0, 500) : '',
      time: new Date().toISOString(),
      replyToId: Number(replyToId) || null,
    };
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      io.emit('message', broadcast);
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: msg.text || '🎬 Sent a video',
        url: '/',
      }).catch(() => {});
      if (typeof ack === 'function') ack({ id });
    } catch (e) {
      console.error('save error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('audio', async (payload, ack) => {
    if (!payload || typeof payload.dataUrl !== 'string') {
      if (typeof ack === 'function') ack({ error: 'Invalid payload' });
      return;
    }
    const { dataUrl, replyToId, clientId } = payload;
    const m = /^data:(audio\/(webm|mp4|ogg|mpeg|wav))(;codecs=[A-Za-z0-9.,-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      if (typeof ack === 'function') ack({ error: 'Invalid audio' });
      return;
    }
    if (dataUrl.length > 3 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ error: 'Too large' });
      return;
    }
    const msg = {
      username,
      audio: dataUrl,
      time: new Date().toISOString(),
      replyToId: Number(replyToId) || null,
    };
    try {
      const id = await saveMessage(msg);
      const full = await getMessageById(id);
      const broadcast = full || { ...msg, id };
      if (clientId != null) broadcast.clientId = clientId;
      io.emit('message', broadcast);
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: '🎤 Sent a voice note',
        url: '/',
      }).catch(() => {});
      if (typeof ack === 'function') ack({ id });
    } catch (e) {
      console.error('save error:', e.message);
      if (typeof ack === 'function') ack({ error: e.message });
    }
  });

  socket.on('loadMore', async (payload, ack) => {
    const beforeId = Number(payload && payload.beforeId);
    if (!Number.isFinite(beforeId) || beforeId <= 0) {
      if (typeof ack === 'function') ack({ messages: [], hasMore: false });
      return;
    }
    try {
      const list = await getHistory(50, beforeId);
      const hasMore = list.length === 50;
      if (typeof ack === 'function') ack({ messages: list, hasMore });
    } catch (e) {
      console.error('loadMore error:', e.message);
      if (typeof ack === 'function') ack({ messages: [], hasMore: false });
    }
  });

  socket.on('read', (msgId) => {
    const id = Number(msgId);
    if (!Number.isFinite(id) || id <= 0) return;
    const prev = lastRead.get(username) || 0;
    if (id <= prev) return;
    lastRead.set(username, id);
    persistReadState(username, id).catch((e) => console.error('persist read state:', e.message));
    io.emit('read', { username, lastReadId: id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(username);
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => loadPasswordCache())
  .then(() => seedPasswords())
  .then(() => loadAllReadState())
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
