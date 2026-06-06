const express = require('express');
const http = require('http');
const path = require('path');
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
  await db.execute({
    sql: 'INSERT INTO messages (username, text, image, time) VALUES (?, ?, ?, ?)',
    args: [msg.username, msg.text || null, msg.image || null, msg.time],
  });
}

async function getHistory(limit = 50) {
  const result = await db.execute({
    sql: 'SELECT username, text, image, time FROM messages ORDER BY id DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.reverse().map((r) => ({
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

const sessions = new Map();

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username & password wajib diisi' });
  }
  if (users[username] !== password) {
    return res.status(401).json({ ok: false, error: 'Username atau password salah' });
  }
  const token = `${username}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessions.set(token, username);
  res.json({ ok: true, token, username });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const username = token && sessions.get(token);
  if (!username) return next(new Error('Unauthorized'));
  socket.data.username = username;
  next();
});

const onlineUsers = new Set();

io.on('connection', async (socket) => {
  const username = socket.data.username;
  onlineUsers.add(username);

  try {
    socket.emit('history', await getHistory(50));
  } catch (err) {
    console.error('history error:', err.message);
    socket.emit('history', []);
  }
  io.emit('system', { text: `${username} bergabung`, online: [...onlineUsers] });

  socket.on('message', async (text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const msg = {
      username,
      text: text.slice(0, 1000),
      time: new Date().toISOString(),
    };
    try { await saveMessage(msg); } catch (e) { console.error('save error:', e.message); }
    io.emit('message', msg);
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
    try { await saveMessage(msg); } catch (e) { console.error('save error:', e.message); }
    io.emit('message', msg);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(username);
    io.emit('system', { text: `${username} keluar`, online: [...onlineUsers] });
  });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat berjalan di http://localhost:${PORT}`);
      console.log(`DB: ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : 'local file (chat.db)'}`);
      console.log('Akun demo:');
      Object.entries(users).forEach(([u, p]) => console.log(`  ${u} / ${p}`));
    });
  })
  .catch((err) => {
    console.error('Gagal init DB:', err);
    process.exit(1);
  });
