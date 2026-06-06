const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
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
  io.emit('system', { text: `${username} joined`, online: [...onlineUsers] });

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
    io.emit('system', { text: `${username} left`, online: [...onlineUsers] });
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat running at http://localhost:${PORT}`);
      console.log(`DB: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : 'local file (chat.db)'}`);
      console.log('Demo accounts:');
      Object.entries(users).forEach(([u, p]) => console.log(`  ${u} / ${p}`));
    });
  })
  .catch((err) => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });
