const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg');
const meEl = document.getElementById('me');
const onlineCountEl = document.getElementById('online-count');
const logoutBtn = document.getElementById('logout');
const notifBtn = document.getElementById('notif-toggle');
const fileInput = document.getElementById('file-input');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('preview-img');
const previewCancel = document.getElementById('preview-cancel');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let pendingImage = null;

const cameraBtn = document.getElementById('camera-btn');
const camModal = document.getElementById('camera-modal');
const camVideo = document.getElementById('cam-video');
const camSnap = document.getElementById('cam-snap');
const camClose = document.getElementById('cam-close');
const camSwitch = document.getElementById('cam-switch');
const camError = document.getElementById('cam-error');
let camStream = null;
let camFacing = 'user';

let socket = null;
let me = null;
let notifEnabled = localStorage.getItem('notifEnabled') !== '0';
let audioCtx = null;

function updateNotifBtn() {
  notifBtn.textContent = notifEnabled ? '🔔 On' : '🔕 Off';
  notifBtn.classList.toggle('off', !notifEnabled);
}

notifBtn.addEventListener('click', async () => {
  notifEnabled = !notifEnabled;
  localStorage.setItem('notifEnabled', notifEnabled ? '1' : '0');
  updateNotifBtn();
  if (notifEnabled && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (_) {}
  }
});

function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.26);
  } catch (_) {}
}

function showDesktopNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, icon: '/favicon.ico', tag: 'chat' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
}

function notify(msg) {
  if (!notifEnabled) return;
  if (msg.username === me) return;
  playBeep();
  const body = msg.text || (msg.image ? '📷 Mengirim foto' : '');
  showDesktopNotification(`Pesan dari ${msg.username}`, body);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.ok) {
      loginError.textContent = data.error || 'Login gagal';
      return;
    }
    sessionStorage.setItem('token', data.token);
    sessionStorage.setItem('username', data.username);
    startChat(data.token, data.username);
  } catch (err) {
    loginError.textContent = 'Terjadi kesalahan jaringan';
  }
});

function startChat(token, username) {
  me = username;
  meEl.textContent = `— ${username}`;
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
  messagesEl.innerHTML = '';
  updateNotifBtn();
  if (notifEnabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  socket = io({ auth: { token } });

  socket.on('history', (list) => {
    if (!Array.isArray(list)) return;
    if (list.length) {
      const sep = document.createElement('div');
      sep.className = 'msg system';
      sep.textContent = '— riwayat percakapan —';
      messagesEl.appendChild(sep);
    }
    list.forEach((m) => addMessage(m));
  });

  socket.on('message', (m) => {
    addMessage(m);
    notify(m);
  });

  socket.on('system', (m) => {
    addSystem(m.text);
    if (Array.isArray(m.online)) {
      onlineCountEl.textContent = `${m.online.length} online`;
    }
  });

  socket.on('connect_error', (err) => {
    addSystem(`Koneksi gagal: ${err.message}`);
  });
}

function addMessage({ username, text, time, image }) {
  const div = document.createElement('div');
  div.className = 'msg ' + (username === me ? 'mine' : 'other');
  const t = new Date(time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const meta = `<div class="meta">${escapeHtml(username)} • ${t}</div>`;
  let body = text ? escapeHtml(text) : '';
  if (image && /^data:image\//.test(image)) {
    const img = `<img class="chat-img" src="${image}" alt="foto" />`;
    body = body ? `${body}${img}` : img;
  }
  div.innerHTML = meta + body;
  const imgEl = div.querySelector('img.chat-img');
  if (imgEl) {
    imgEl.addEventListener('click', () => window.open(image, '_blank'));
    imgEl.addEventListener('load', () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!socket) return;
  const text = msgInput.value.trim();
  if (pendingImage) {
    socket.emit('image', { dataUrl: pendingImage, caption: text });
    clearPreview();
    msgInput.value = '';
    return;
  }
  if (!text) return;
  socket.emit('message', text);
  msgInput.value = '';
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('File harus berupa gambar');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    alert('Ukuran maksimal 4 MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = reader.result;
    previewImg.src = pendingImage;
    preview.classList.remove('hidden');
    msgInput.placeholder = 'Tambahkan caption (opsional)...';
    msgInput.focus();
  };
  reader.readAsDataURL(file);
});

previewCancel.addEventListener('click', clearPreview);

function clearPreview() {
  pendingImage = null;
  previewImg.src = '';
  preview.classList.add('hidden');
  msgInput.placeholder = 'Ketik pesan...';
}

cameraBtn.addEventListener('click', () => openCamera());
camClose.addEventListener('click', closeCamera);
camSwitch.addEventListener('click', () => {
  camFacing = camFacing === 'user' ? 'environment' : 'user';
  openCamera();
});
camSnap.addEventListener('click', () => {
  if (!camStream) return;
  const w = camVideo.videoWidth;
  const h = camVideo.videoHeight;
  if (!w || !h) return;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
    const shrink = canvas.getContext('2d');
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const sw = Math.round(w * scale);
    const sh = Math.round(h * scale);
    canvas.width = sw;
    canvas.height = sh;
    shrink.drawImage(camVideo, 0, 0, sw, sh);
    pendingImage = canvas.toDataURL('image/jpeg', 0.8);
  } else {
    pendingImage = dataUrl;
  }
  previewImg.src = pendingImage;
  preview.classList.remove('hidden');
  msgInput.placeholder = 'Tambahkan caption (opsional)...';
  closeCamera();
  msgInput.focus();
});

async function openCamera() {
  camError.textContent = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    camError.textContent = 'Browser tidak mendukung akses kamera';
    camModal.classList.remove('hidden');
    return;
  }
  stopCamStream();
  camModal.classList.remove('hidden');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camFacing },
      audio: false,
    });
    camVideo.srcObject = camStream;
  } catch (err) {
    camError.textContent = 'Tidak bisa mengakses kamera: ' + (err.message || err.name);
  }
}

function closeCamera() {
  stopCamStream();
  camModal.classList.add('hidden');
}

function stopCamStream() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  camVideo.srcObject = null;
}

logoutBtn.addEventListener('click', () => {
  if (socket) socket.disconnect();
  sessionStorage.clear();
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
  document.getElementById('password').value = '';
});

const savedToken = sessionStorage.getItem('token');
const savedUser = sessionStorage.getItem('username');
if (savedToken && savedUser) {
  startChat(savedToken, savedUser);
}
