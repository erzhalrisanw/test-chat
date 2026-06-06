const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const webPush = require('web-push');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });

app.use(express.json({ limit: '6mb' }));
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
      time TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      subscription TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
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

async function sendPushToOfflineUsers(sender, payload) {
  if (!pushEnabled) return;
  const recipients = Object.keys(users).filter((u) => u !== sender && !onlineUsers.has(u));
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
    sql: 'INSERT INTO messages (username, text, image, time) VALUES (?, ?, ?, ?)',
    args: [msg.username, msg.text || null, msg.image || null, msg.time],
  });
  return Number(result.lastInsertRowid);
}

async function getHistory(limit = 50) {
  const result = await db.execute({
    sql: 'SELECT id, username, text, image, time FROM messages ORDER BY id DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.reverse().map((r) => ({
    id: Number(r.id),
    username: r.username,
    text: r.text,
    image: r.image,
    time: r.time,
  }));
}

const users = {
  A: 'A123',
  B: 'B123',
};

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
    if (!data.u || !users[data.u]) return null;
    if (Date.now() - data.iat > SESSION_MAX_AGE_MS) return null;
    return data.u;
  } catch {
    return null;
  }
}

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username & password are required' });
  }
  if (users[username] !== password) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
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
    socket.emit('history', await getHistory(50));
  } catch (err) {
    console.error('history error:', err.message);
    socket.emit('history', []);
  }
  socket.emit('readState', Object.fromEntries(lastRead));
  io.emit('presence', { online: [...onlineUsers] });

  socket.on('message', async (text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const msg = {
      username,
      text: text.slice(0, 1000),
      time: new Date().toISOString(),
    };
    try {
      const id = await saveMessage(msg);
      io.emit('message', { ...msg, id });
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: msg.text,
        url: '/',
      }).catch(() => {});
    } catch (e) {
      console.error('save error:', e.message);
    }
  });

  socket.on('image', async (payload) => {
    if (!payload || typeof payload.dataUrl !== 'string') return;
    const { dataUrl, caption } = payload;
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return;
    if (dataUrl.length > 6 * 1024 * 1024) return;
    const msg = {
      username,
      image: dataUrl,
      text: typeof caption === 'string' ? caption.slice(0, 500) : '',
      time: new Date().toISOString(),
    };
    try {
      const id = await saveMessage(msg);
      io.emit('message', { ...msg, id });
      sendPushToOfflineUsers(username, {
        title: `Message from ${username}`,
        body: msg.text || '📷 Sent a photo',
        url: '/',
      }).catch(() => {});
    } catch (e) {
      console.error('save error:', e.message);
    }
  });

  socket.on('read', (msgId) => {
    const id = Number(msgId);
    if (!Number.isFinite(id) || id <= 0) return;
    const prev = lastRead.get(username) || 0;
    if (id <= prev) return;
    lastRead.set(username, id);
    io.emit('read', { username, lastReadId: id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(username);
    io.emit('presence', { online: [...onlineUsers] });
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat running at http://localhost:${PORT}`);
      console.log(`DB: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : 'local file (chat.db)'}`);
      console.log(`Push notifications: ${pushEnabled ? 'enabled' : 'disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)'}`);
      console.log('Demo accounts:');
      Object.entries(users).forEach(([u, p]) => console.log(`  ${u} / ${p}`));
    });
  })
  .catch((err) => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
