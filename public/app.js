const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg');
const meEl = document.getElementById('me');
const logoutBtn = document.getElementById('logout');
const notifBtn = document.getElementById('notif-toggle');
const fileInput = document.getElementById('file-input');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('preview-img');
const previewVideo = document.getElementById('preview-video');
const previewCancel = document.getElementById('preview-cancel');

let pendingImage = null;
let pendingVideo = null;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 15000;
let pendingQueue = [];
let tempIdCounter = 0;

const replyPreview = document.getElementById('reply-preview');
const replyPreviewUser = document.getElementById('reply-preview-user');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancelBtn = document.getElementById('reply-cancel');
let replyTarget = null;

const galleryBtn = document.getElementById('gallery-btn');
const galleryModal = document.getElementById('gallery-modal');
const galleryGrid = document.getElementById('gallery-grid');
const galleryClose = document.getElementById('gallery-close');
const galleryEmpty = document.getElementById('gallery-empty');
const GALLERY_ALLOWED = new Set(['occupatus', 'london']);

const attachMenuBtn = document.getElementById('attach-menu-btn');
const attachMenu = document.getElementById('attach-menu');

function closeAttachMenu() {
  attachMenu.classList.add('hidden');
  attachMenuBtn.setAttribute('aria-expanded', 'false');
}
function toggleAttachMenu() {
  const isHidden = attachMenu.classList.toggle('hidden');
  attachMenuBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
}
attachMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAttachMenu();
});
document.addEventListener('click', (e) => {
  if (attachMenu.classList.contains('hidden')) return;
  if (!attachMenu.contains(e.target) && e.target !== attachMenuBtn) closeAttachMenu();
});
attachMenu.addEventListener('click', () => closeAttachMenu());

const micBtn = document.getElementById('mic-btn');
const recorderBar = document.getElementById('recorder');
const recTimerEl = document.getElementById('rec-timer');
const recCancelBtn = document.getElementById('rec-cancel');
const recSendBtn = document.getElementById('rec-send');
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 60_000;
let audioRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioTimerId = null;
let audioAutoStopId = null;
let audioStartTime = 0;
let audioCancelled = false;

const cameraBtn = document.getElementById('camera-btn');
const camModal = document.getElementById('camera-modal');
const camVideo = document.getElementById('cam-video');
const camSnap = document.getElementById('cam-snap');
const camClose = document.getElementById('cam-close');
const camSwitch = document.getElementById('cam-switch');
const camRecord = document.getElementById('cam-record');
const camTimer = document.getElementById('cam-timer');
const camError = document.getElementById('cam-error');
let camStream = null;
let camFacing = 'user';
let mediaRecorder = null;
let recordChunks = [];
let recordTimerId = null;
let recordAutoStopId = null;
let recordStartTime = 0;

let socket = null;
let me = null;
let lastIncomingId = 0;
let lastReadByOthers = 0;
let oldestLoadedId = null;
let hasMoreHistory = false;
let loadingMore = false;
let notifEnabled = localStorage.getItem('notifEnabled') !== '0';
let audioCtx = null;
let reconnectTimer = null;

function canCaptureVideoStream() {
  const v = document.createElement('video');
  return typeof v.captureStream === 'function' || typeof v.mozCaptureStream === 'function';
}

function captureStreamFrom(videoEl) {
  if (typeof videoEl.captureStream === 'function') return videoEl.captureStream();
  if (typeof videoEl.mozCaptureStream === 'function') return videoEl.mozCaptureStream();
  return null;
}

function pickRecorderMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function compressVideoFile(file, opts) {
  opts = opts || {};
  var videoBps = opts.videoBitsPerSecond || 700000;
  var audioBps = opts.audioBitsPerSecond || 64000;
  if (!canCaptureVideoStream() || !window.MediaRecorder) {
    throw new Error('Browser does not support video compression');
  }
  var mime = pickRecorderMime();
  if (!mime) throw new Error('No supported video codec for compression');

  var url = URL.createObjectURL(file);
  var video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  video.muted = true;
  video.preload = 'auto';
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '0';
  document.body.appendChild(video);

  function cleanup() {
    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    if (video.parentNode) video.parentNode.removeChild(video);
    URL.revokeObjectURL(url);
  }

  try {
    await new Promise(function(resolve, reject) {
      var to = setTimeout(function() { reject(new Error('Video load timeout')); }, 30000);
      video.onloadedmetadata = function() { clearTimeout(to); resolve(); };
      video.onerror = function() { clearTimeout(to); reject(new Error('Failed to load video')); };
    });

    await video.play();
    var stream = captureStreamFrom(video);
    if (!stream) throw new Error('captureStream returned no stream');

    var recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: audioBps,
    });
    var chunks = [];
    recorder.ondataavailable = function(e) {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    var blob = await new Promise(function(resolve, reject) {
      var done = false;
      recorder.onstop = function() {
        if (done) return;
        done = true;
        var baseType = mime.split(';')[0];
        resolve(new Blob(chunks, { type: baseType }));
      };
      recorder.onerror = function(e) {
        if (done) return;
        done = true;
        reject((e && e.error) || new Error('Recording error'));
      };
      video.onended = function() {
        try { recorder.stop(); } catch (_) {}
      };
      recorder.start(250);
    });

    return blob;
  } finally {
    cleanup();
  }
}

function authHeader() {
  var t = localStorage.getItem('token');
  return t ? { Authorization: 'Bearer ' + t } : {};
}

async function uploadVideoToR2(blob, onProgress) {
  var contentType = blob.type || 'video/webm';
  if (contentType !== 'video/webm' && contentType !== 'video/mp4') {
    var base = contentType.split(';')[0];
    contentType = base === 'video/mp4' ? 'video/mp4' : 'video/webm';
  }
  var headers = Object.assign(
    { 'Content-Type': 'application/json' },
    authHeader()
  );
  var presignRes = await fetch('/r2-presign-video', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ contentType: contentType, size: blob.size }),
  });
  if (!presignRes.ok) {
    var errData = null;
    try { errData = await presignRes.json(); } catch (_) {}
    throw new Error((errData && errData.error) || 'Failed to get upload URL');
  }
  var data = await presignRes.json();
  if (!data.ok || !data.uploadUrl || !data.publicUrl) {
    throw new Error((data && data.error) || 'Presign response invalid');
  }

  await new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', data.uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('Upload failed (' + xhr.status + ')'));
    };
    xhr.onerror = function() { reject(new Error('Upload network error')); };
    xhr.onabort = function() { reject(new Error('Upload aborted')); };
    xhr.send(blob);
  });

  return data.publicUrl;
}

async function prepareVideoForUpload(file, onStage) {
  var blob = file;
  if (blob.size > MAX_VIDEO_BYTES) {
    if (typeof onStage === 'function') onStage('compress');
    blob = await compressVideoFile(file, { videoBitsPerSecond: 700000 });
    if (blob.size > MAX_VIDEO_BYTES) {
      throw new Error('Compressed video still over 10 MB. Try a shorter clip.');
    }
  }
  return blob;
}

function updateNotifBtn() {
  notifBtn.textContent = notifEnabled ? '🔔 On' : '🔕 Off';
  notifBtn.classList.toggle('off', !notifEnabled);
}

async function saveNotifEnabled(enabled) {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    await fetch('/user-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notifEnabled: enabled }),
    });
  } catch (_) {}
}

async function loadNotifEnabled() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const res = await fetch('/user-settings', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.notifEnabled === 'boolean') {
      notifEnabled = data.notifEnabled;
      localStorage.setItem('notifEnabled', notifEnabled ? '1' : '0');
      updateNotifBtn();
      if (!notifEnabled) unsubscribePush();
    }
  } catch (_) {}
}

notifBtn.addEventListener('click', async () => {
  notifEnabled = !notifEnabled;
  localStorage.setItem('notifEnabled', notifEnabled ? '1' : '0');
  saveNotifEnabled(notifEnabled);
  updateNotifBtn();
  unlockAudio();
  if (notifEnabled && 'Notification' in window) {
    if (Notification.permission === 'default') {
      try {
        const result = await Notification.requestPermission();
        if (result === 'denied') {
          alert('Notifications blocked. Enable them in your browser settings.');
          return;
        }
      } catch (_) {}
    } else if (Notification.permission === 'denied') {
      alert('Notifications are blocked. Enable them in your browser settings.');
      return;
    }
    setupPush();
  } else if (!notifEnabled) {
    unsubscribePush();
  }
});

async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const res = await fetch('/vapid-public');
      if (!res.ok) return;
      const { key } = await res.json();
      if (!key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    const token = localStorage.getItem('token');
    if (!token) return;
    await fetch('/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(sub),
    });
  } catch (err) {
    console.warn('Push setup failed:', err);
  }
}

async function unsubscribePush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const token = localStorage.getItem('token');
    if (token) {
      await fetch('/push-unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
    }
    await sub.unsubscribe();
  } catch (_) {}
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio, { passive: true });

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

function triggerHeartBurstOnElement(bubble) {
  if (!bubble) return;
  const burst = document.createElement('div');
  burst.className = 'heart-burst';
  bubble.appendChild(burst);
  const emojis = ['❤️', '💕', '💖', '💗', '💘', '💝', '🥰', '😍'];
  for (let i = 0; i < 12; i++) {
    const h = document.createElement('span');
    h.className = 'heart';
    h.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    h.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
    h.style.left = (5 + Math.random() * 85) + '%';
    h.style.fontSize = (16 + Math.random() * 14) + 'px';
    h.style.animationDelay = (Math.random() * 0.5) + 's';
    h.style.animationDuration = (1.8 + Math.random() * 0.9) + 's';
    burst.appendChild(h);
  }
  setTimeout(() => burst.remove(), 3500);
}

function triggerHeartBurst(msg) {
  if (!msg || !msg.id) return;
  const bubble = messagesEl.querySelector(`.msg[data-id="${msg.id}"]`);
  triggerHeartBurstOnElement(bubble);
}

function maybeLoveAnim(msg) {
  if (!msg || typeof msg.text !== 'string') return;
  if (/sayang/i.test(msg.text)) setTimeout(() => triggerHeartBurst(msg), 2000);
}

function notify(msg) {
  if (!notifEnabled) return;
  if (msg.username === me) return;
  playBeep();
  if ('vibrate' in navigator) {
    try { navigator.vibrate(200); } catch (_) {}
  }
  const body = msg.text || (msg.image ? '📷 Sent a photo' : msg.video ? '🎬 Sent a video' : msg.audio ? '🎤 Sent a voice note' : '');
  showDesktopNotification(`Message from ${msg.username}`, body);
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
      loginError.textContent = data.error || 'Login failed';
      return;
    }
    localStorage.setItem('token', data.token);
    localStorage.setItem('username', data.username);
    startChat(data.token, data.username);
  } catch (err) {
    loginError.textContent = 'Network error occurred';
  }
});

function maybePlaySunrise() {
  const now = new Date();
  const hour = now.getHours();
  if (hour < 4 || hour >= 12) return;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (localStorage.getItem('sunriseShown') === today) return;
  const overlay = document.getElementById('sunrise-overlay');
  if (!overlay) return;
  localStorage.setItem('sunriseShown', today);
  document.body.classList.add('sunrise-playing');
  overlay.classList.remove('hidden', 'fade-out');
  void overlay.offsetWidth;
  // 0-5s sun rises, 4.5-5.5s overlay fades, 5-7s chat slides up (CSS delay 5s)
  setTimeout(() => {
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('fade-out');
    }, 1000);
  }, 4500);
  setTimeout(() => {
    document.body.classList.remove('sunrise-playing');
  }, 7000);
}

function startChat(token, username) {
  me = username;
  meEl.textContent = `— ${username}`;
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
  maybePlaySunrise();
  messagesEl.innerHTML = '';
  updateNotifBtn();
  updateGalleryBtn();
  loadNotifEnabled();
  if (notifEnabled && 'Notification' in window) {
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    } else if (Notification.permission === 'granted') {
      setupPush();
    }
  }

  socket = io({ auth: { token } });

  socket.on('history', (payload) => {
    const list = Array.isArray(payload) ? payload : (payload && payload.messages) || [];
    hasMoreHistory = !!(payload && payload.hasMore);
    if (list.length) {
      const sep = document.createElement('div');
      sep.className = 'msg system';
      sep.textContent = '— chat history —';
      messagesEl.appendChild(sep);
      oldestLoadedId = list[0].id || null;
    }
    list.forEach((m) => {
      addMessage(m);
      if (m.id) lastIncomingId = Math.max(lastIncomingId, m.id);
    });
    maybeMarkRead();
  });

  socket.on('readState', (state) => {
    if (!state || typeof state !== 'object') return;
    Object.entries(state).forEach(([u, id]) => {
      if (u !== me && typeof id === 'number' && id > lastReadByOthers) {
        lastReadByOthers = id;
      }
    });
    updateReceipts();
  });

  socket.on('read', ({ username, lastReadId }) => {
    if (username === me) return;
    if (typeof lastReadId !== 'number') return;
    if (lastReadId > lastReadByOthers) {
      lastReadByOthers = lastReadId;
      updateReceipts();
    }
  });

  socket.on('message', (m) => {
    // Cegah duplikasi: jika pesan dengan id ini sudah ada di DOM, skip
    if (m.id && messagesEl.querySelector('.msg[data-id="' + m.id + '"]')) return;
    // Jika ini pesan kita sendiri yang sudah pending, update pending ke sent (match by clientId/tempId)
    if (m.username === me && m.id && m.clientId != null) {
      var pendingEl = messagesEl.querySelector('.msg[data-temp-id="' + m.clientId + '"]');
      if (pendingEl) {
        updatePendingToSent(m.clientId, m.id);
        lastIncomingId = Math.max(lastIncomingId, m.id);
        return;
      }
    }
    addMessage(m);
    if (m.id) lastIncomingId = Math.max(lastIncomingId, m.id);
    if (m.username !== me) {
      maybeMarkRead();
      maybeLoveAnim(m);
    }
    notify(m);
  });

  socket.on('system', (m) => {
    if (m.text) addSystem(m.text);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'Unauthorized') {
      localStorage.removeItem('token');
      localStorage.removeItem('username');
      socket.disconnect();
      chatView.classList.add('hidden');
      loginView.classList.remove('hidden');
      loginError.textContent = 'Session expired, please log in again';
      return;
    }
    addSystem(`Connection failed: ${err.message}`);
  });

  socket.on('disconnect', () => {
    // Try reconnect with pending resend
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!socket || !socket.connected) {
        socket.connect();
      }
    }, 3000);
  });

  socket.on('connect', () => {
    // Resend pending messages on reconnect
    if (pendingQueue.length > 0) {
      const toResend = pendingQueue.slice();
      pendingQueue = [];
      toResend.forEach((item) => {
        emitWithAck(item);
      });
    }
  });
}

function replySnippet(msg) {
  if (msg.text) return msg.text;
  if (msg.image || msg.hasImage) return '📷 Photo';
  if (msg.video || msg.hasVideo) return '🎬 Video';
  if (msg.audio || msg.hasAudio) return '🎤 Voice note';
  return '';
}

function buildMessageNodes(msg) {
  const { id, username, text, time, image, replyTo } = msg;
  const div = document.createElement('div');
  div.className = 'msg ' + (username === me ? 'mine' : 'other');
  const isPending = msg._pending || false;
  const tempId = msg._tempId || null;
  if (id) div.dataset.id = String(id);
  if (tempId) div.dataset.tempId = String(tempId);
  const t = new Date(time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  div.dataset.day = dayKey(time);
  let tick = '';
  if (username === me) {
    if (isPending) {
      tick = '<span class="tick pending" aria-label="pending">🕐</span>';
    } else if (id) {
      tick = `<span class="tick ${id <= lastReadByOthers ? 'read' : 'sent'}" data-id="${id}" aria-label="${id <= lastReadByOthers ? 'read' : 'sent'}"><svg viewBox="0 0 18 12" width="16" height="12" aria-hidden="true"><path d="M1 6.5 L4.5 10 L11 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 6.5 L9.5 10 L17 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    }
  }
  const meta = '<div class="meta">' + escapeHtml(username) + ' • ' + t + tick + '</div>';
  let quote = '';
  if (replyTo) {
    quote = '<div class="reply-quote" data-target="' + replyTo.id + '">' +
      '<div class="reply-quote-body">' +
      '<div class="reply-quote-user">' + escapeHtml(replyTo.username || '') + '</div>' +
      '<div class="reply-quote-text">' + escapeHtml(replySnippet(replyTo)) + '</div>' +
      '</div>' +
      '</div>';
  }
  let body = text ? linkify(text) : '';
  if (image && /^data:image\//.test(image)) {
    const img = '<img class="chat-img" src="' + image + '" alt="photo" />';
    body = body ? body + img : img;
  }
  if (msg.video && isPlayableVideoSrc(msg.video)) {
    const vid = '<video class="chat-vid" src="' + escapeHtml(msg.video) + '" controls playsinline preload="metadata"></video>';
    body = body ? body + vid : vid;
  }
  if (msg.audio && /^data:audio\//.test(msg.audio)) {
    const aud = '<audio class="chat-aud" src="' + msg.audio + '" controls preload="metadata"></audio>';
    body = body ? body + aud : aud;
  }
  const replyBtn = id ? '<button class="reply-btn" type="button" title="Reply">↩</button>' : '';
  div.innerHTML = meta + quote + body + replyBtn;
  const imgEl = div.querySelector('img.chat-img');
  if (imgEl) {
    imgEl.addEventListener('click', () => openImageViewer(image));
    // Hanya scroll ke bottom jika ini pesan baru (bukan history lama)
    if (!msg._history) {
      imgEl.addEventListener('load', () => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  }
  const quoteEl = div.querySelector('.reply-quote');
  if (quoteEl && replyTo) {
    quoteEl.addEventListener('click', () => jumpToMessage(replyTo.id));
  }
  const btn = div.querySelector('.reply-btn');
  if (btn && id) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setReplyTarget({ id, username, text, hasImage: !!image, hasVideo: !!msg.video, hasAudio: !!msg.audio });
    });
  }
  return [div];
}

function dayKey(time) {
  const d = new Date(time);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function dateSeparatorLabel(time) {
  const d = new Date(time);
  const now = new Date();
  const k = dayKey(time);
  if (k === dayKey(now)) return 'Today';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (k === dayKey(yest)) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function makeDateSeparator(time) {
  const sep = document.createElement('div');
  sep.className = 'msg system date-sep';
  sep.textContent = dateSeparatorLabel(time);
  return sep;
}

function renderDateSeparators() {
  messagesEl.querySelectorAll('.date-sep').forEach((el) => el.remove());
  let prevDay = null;
  messagesEl.querySelectorAll('.msg[data-day]').forEach((el) => {
    const day = el.dataset.day;
    if (day !== prevDay) {
      const [y, mo, d] = day.split('-').map(Number);
      messagesEl.insertBefore(makeDateSeparator(new Date(y, mo - 1, d)), el);
      prevDay = day;
    }
  });
}

function addMessage(msg) {
  const nodes = buildMessageNodes(msg);
  const key = dayKey(msg.time);
  const existing = messagesEl.querySelectorAll('.msg[data-day]');
  const lastDay = existing.length ? existing[existing.length - 1].dataset.day : null;
  if (lastDay !== key) messagesEl.appendChild(makeDateSeparator(msg.time));
  nodes.forEach((n) => messagesEl.appendChild(n));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function prependMessage(msg, anchor) {
  const nodes = buildMessageNodes(msg);
  nodes.forEach((n) => messagesEl.insertBefore(n, anchor));
}

async function jumpToMessage(targetId) {
  var targetNum = Number(targetId);
  var el = messagesEl.querySelector('.msg[data-id="' + targetId + '"]');
  var safety = 0;
  while (!el && hasMoreHistory && oldestLoadedId && targetNum < Number(oldestLoadedId) && safety < 100) {
    safety++;
    await loadMoreHistory();
    el = messagesEl.querySelector('.msg[data-id="' + targetId + '"]');
  }
  if (!el) return;
  // Scroll messages container to center the target element
  const containerRect = messagesEl.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const relativeTop = elRect.top - containerRect.top;
  messagesEl.scrollTop = messagesEl.scrollTop + relativeTop - (containerRect.height / 2) + (elRect.height / 2);
  // Highlight animation
  el.classList.remove('highlight');
  void el.offsetWidth;
  el.classList.add('highlight');
}

function setReplyTarget(target) {
  replyTarget = target;
  replyPreviewUser.textContent = target.username || '';
  replyPreviewText.textContent = replySnippet(target);
  replyPreview.classList.remove('hidden');
  msgInput.focus();
}

function clearReply() {
  replyTarget = null;
  replyPreview.classList.add('hidden');
  replyPreviewUser.textContent = '';
  replyPreviewText.textContent = '';
}

replyCancelBtn.addEventListener('click', clearReply);

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function maybeMarkRead() {
  if (!socket || !lastIncomingId) return;
  if (document.visibilityState !== 'visible') return;
  if (chatView.classList.contains('hidden')) return;
  socket.emit('read', lastIncomingId);
}

function updateReceipts() {
  document.querySelectorAll('.tick').forEach((el) => {
    const id = Number(el.dataset.id || 0);
    if (!id) return;
    const isRead = id <= lastReadByOthers;
    el.classList.toggle('read', isRead);
    el.classList.toggle('sent', !isRead);
    el.setAttribute('aria-label', isRead ? 'read' : 'sent');
  });
}

document.addEventListener('visibilitychange', maybeMarkRead);
window.addEventListener('focus', maybeMarkRead);

function loadMoreHistory() {
  if (!socket || loadingMore || !hasMoreHistory || !oldestLoadedId) return Promise.resolve();
  loadingMore = true;
  const loader = document.createElement('div');
  loader.className = 'msg system';
  loader.id = 'history-loader';
  loader.textContent = 'Loading older messages...';
  messagesEl.insertBefore(loader, messagesEl.firstChild);
  const prevScrollTop = messagesEl.scrollTop;
  const prevScrollHeight = messagesEl.scrollHeight;
  return new Promise((resolve) => {
  socket.emit('loadMore', { beforeId: oldestLoadedId }, (resp) => {
    const list = (resp && resp.messages) || [];
    hasMoreHistory = !!(resp && resp.hasMore);
    if (list.length) {
      // Insert date separator before first message if needed
      const firstExisting = messagesEl.querySelector('.msg[data-day]');
      const firstExistingDay = firstExisting ? firstExisting.dataset.day : null;
      
      // Mark messages as history so onload won't scroll
      list.forEach(function(m) {
        m._history = true;
      });
      
      // Track which day keys we've seen while inserting
      const seenDays = new Set();
      list.forEach(function(m) {
        const day = dayKey(m.time);
        if (!seenDays.has(day)) {
          // Check if we need a date separator for this day
          const sep = makeDateSeparator(m.time);
          messagesEl.insertBefore(sep, firstExisting);
          seenDays.add(day);
        }
        const nodes = buildMessageNodes(m);
        nodes.forEach(function(n) { messagesEl.insertBefore(n, firstExisting); });
      });
      
      oldestLoadedId = list[0].id || oldestLoadedId;
      
      // Remove duplicate date separators that are next to each other
      var allMsgs = messagesEl.querySelectorAll('.msg.date-sep, .msg[data-day]');
      var prevDay = null;
      allMsgs.forEach(function(el) {
        if (el.classList.contains('date-sep')) {
          var nextMsg = el.nextElementSibling;
          while (nextMsg && !nextMsg.classList.contains('date-sep') && !nextMsg.matches('.msg[data-day]')) {
            nextMsg = nextMsg.nextElementSibling;
          }
          var dayAttr = nextMsg ? nextMsg.dataset.day : null;
          if (!dayAttr || dayAttr === prevDay) {
            el.remove();
          } else {
            prevDay = dayAttr;
          }
        } else if (el.dataset.day) {
          prevDay = el.dataset.day;
        }
      });
      
      // Adjust scroll position to compensate for added height
      var newScrollHeight = messagesEl.scrollHeight;
      messagesEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }
    // Remove loader
    const loaderEl = document.getElementById('history-loader');
    if (loaderEl) loaderEl.remove();
    loadingMore = false;
    resolve();
  });
  });
}

messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < 80) loadMoreHistory();
});

const imageViewer = document.getElementById('image-viewer');
const viewerContent = document.getElementById('viewer-content');
const viewerClose = document.getElementById('viewer-close');
const viewerPrev = document.getElementById('viewer-prev');
const viewerNext = document.getElementById('viewer-next');
const viewerCounter = document.getElementById('viewer-counter');

let viewerItems = [];
let viewerIndex = 0;

function renderViewerItem() {
  viewerContent.innerHTML = '';
  const item = viewerItems[viewerIndex];
  if (!item) return;
  let node;
  if (item.type === 'video') {
    node = document.createElement('video');
    node.src = item.src;
    node.controls = true;
    node.playsInline = true;
    node.preload = 'metadata';
  } else {
    node = document.createElement('img');
    node.src = item.src;
    node.alt = 'preview';
  }
  viewerContent.appendChild(node);
  if (viewerItems.length > 1) {
    viewerCounter.textContent = viewerIndex + 1 + ' / ' + viewerItems.length;
    viewerCounter.style.display = '';
    viewerPrev.style.display = '';
    viewerNext.style.display = '';
    viewerPrev.disabled = viewerIndex === 0;
    viewerNext.disabled = viewerIndex === viewerItems.length - 1;
  } else {
    viewerCounter.style.display = 'none';
    viewerPrev.style.display = 'none';
    viewerNext.style.display = 'none';
  }
}

function openImageViewer(src) {
  viewerItems = [{ type: 'image', src }];
  viewerIndex = 0;
  renderViewerItem();
  imageViewer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeImageViewer() {
  imageViewer.classList.add('hidden');
  viewerContent.innerHTML = '';
  viewerItems = [];
  document.body.style.overflow = '';
}

function viewerStep(delta) {
  const next = viewerIndex + delta;
  if (next < 0 || next >= viewerItems.length) return;
  viewerIndex = next;
  renderViewerItem();
}

viewerClose.addEventListener('click', closeImageViewer);
viewerPrev.addEventListener('click', (e) => { e.stopPropagation(); viewerStep(-1); });
viewerNext.addEventListener('click', (e) => { e.stopPropagation(); viewerStep(1); });
imageViewer.addEventListener('click', (e) => {
  if (e.target === imageViewer) closeImageViewer();
});
document.addEventListener('keydown', (e) => {
  if (imageViewer.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeImageViewer();
  else if (e.key === 'ArrowLeft') viewerStep(-1);
  else if (e.key === 'ArrowRight') viewerStep(1);
});

let viewerTouchX = 0;
let viewerTouchY = 0;
let viewerTouchActive = false;
viewerContent.addEventListener('touchstart', (e) => {
  if (!e.touches.length) return;
  viewerTouchX = e.touches[0].clientX;
  viewerTouchY = e.touches[0].clientY;
  viewerTouchActive = true;
}, { passive: true });
viewerContent.addEventListener('touchend', (e) => {
  if (!viewerTouchActive) return;
  viewerTouchActive = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - viewerTouchX;
  const dy = t.clientY - viewerTouchY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
    viewerStep(dx > 0 ? -1 : 1);
  }
}, { passive: true });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

function isPlayableVideoSrc(src) {
  if (typeof src !== 'string') return false;
  return src.indexOf('data:video/') === 0
    || src.indexOf('blob:') === 0
    || src.indexOf('https://') === 0;
}

function linkify(text) {
  var escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<]+|(?:^|[^"'>])(www\.[^\s<]+))/gi,
    function(match, url, prefix) {
      var href = url.indexOf('http') === 0 ? url : 'https://' + url;
      var display = url.indexOf('http') === 0 ? url : url;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + display + '</a>';
    }
  );
}

function showPendingLocally(msgData) {
  tempIdCounter++;
  var tempId = tempIdCounter;
  var pendingMsg = {
    text: msgData.text || msgData.caption || '',
    replyToId: msgData.replyToId,
    _pending: true,
    _tempId: tempId,
    id: null,
    username: me,
    time: new Date().toISOString()
  };
  if (msgData._type === 'image') pendingMsg.image = msgData.dataUrl;
  else if (msgData._type === 'video') pendingMsg.video = msgData.dataUrl;
  else if (msgData._type === 'audio') pendingMsg.audio = msgData.dataUrl;
  addMessage(pendingMsg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return tempId;
}

function updatePendingToSent(tempId, realId) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  el.dataset.id = String(realId);
  delete el.dataset.tempId;
  var tick = el.querySelector('.tick');
  if (tick) {
    tick.className = 'tick sent';
    tick.setAttribute('aria-label', 'sent');
    tick.innerHTML = '<svg viewBox="0 0 18 12" width="16" height="12" aria-hidden="true"><path d="M1 6.5 L4.5 10 L11 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 6.5 L9.5 10 L17 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}

function markPendingFailed(tempId, errorMsg) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  var tick = el.querySelector('.tick');
  if (tick) {
    tick.className = 'tick failed';
    tick.setAttribute('aria-label', 'failed');
    tick.setAttribute('title', errorMsg || 'Failed to send');
    tick.textContent = '❌';
  }
}

function emitWithAck(msgData) {
  var tempId = msgData._tempId;
  if (socket && socket.connected) {
    var event = msgData._type || 'message';
    var payload = {};
    if (msgData.dataUrl) payload.dataUrl = msgData.dataUrl;
    if (msgData.text) payload.text = msgData.text;
    if (msgData.caption) payload.caption = msgData.caption;
    if (msgData.replyToId) payload.replyToId = msgData.replyToId;
    if (tempId != null) payload.clientId = tempId;
    socket.emit(event, payload, function(ack) {
      if (ack && ack.id) {
        updatePendingToSent(tempId, ack.id);
        lastIncomingId = Math.max(lastIncomingId, ack.id);
      } else if (ack && ack.error) {
        // Server menolak (validasi/ukuran): tandai gagal, jangan re-queue
        markPendingFailed(tempId, ack.error);
      } else {
        // Tidak ada ack info: anggap perlu retry saat reconnect
        if (!pendingQueue.some(function(p) { return p._tempId === tempId; })) {
          pendingQueue.push(msgData);
        }
      }
    });
  } else {
    if (!pendingQueue.some(function(p) { return p._tempId === tempId; })) {
      pendingQueue.push(msgData);
    }
  }
}

function queueMessage(eventName, msgData) {
  var data = {};
  if (msgData.dataUrl) data.dataUrl = msgData.dataUrl;
  if (msgData.text) data.text = msgData.text;
  if (msgData.caption) data.caption = msgData.caption;
  if (msgData.replyToId) data.replyToId = msgData.replyToId;
  data._tempId = null;
  data._pending = true;
  data._type = eventName;
  var tempId = showPendingLocally(data);
  data._tempId = tempId;
  emitWithAck(data);
}

function setUploadStatus(tempId, stage, percent) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  var status = el.querySelector('.upload-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'upload-status';
    var tick = el.querySelector('.tick');
    if (tick && tick.parentNode) tick.parentNode.insertBefore(status, tick);
    else el.appendChild(status);
  }
  var label = '';
  if (stage === 'compress') label = 'Compressing video...';
  else if (stage === 'uploading') label = 'Uploading' + (percent != null ? ' ' + percent + '%' : '...');
  else if (stage === 'sending') label = 'Sending...';
  else label = stage;
  status.textContent = label;
}

function clearUploadStatus(tempId) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  var status = el.querySelector('.upload-status');
  if (status && status.parentNode) status.parentNode.removeChild(status);
}

async function queueVideoUpload(pv, caption, replyToId) {
  tempIdCounter++;
  var tempId = tempIdCounter;
  var pendingMsg = {
    text: caption || '',
    replyToId: replyToId || null,
    _pending: true,
    _tempId: tempId,
    id: null,
    username: me,
    time: new Date().toISOString(),
    video: pv.previewUrl,
  };
  addMessage(pendingMsg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  setUploadStatus(tempId, pv.blob.size > MAX_VIDEO_BYTES ? 'compress' : 'uploading');

  try {
    var uploadBlob = await prepareVideoForUpload(pv.blob, function(stage) {
      setUploadStatus(tempId, stage);
    });
    setUploadStatus(tempId, 'uploading', 0);
    var publicUrl = await uploadVideoToR2(uploadBlob, function(p) {
      setUploadStatus(tempId, 'uploading', Math.round(p * 100));
    });
    setUploadStatus(tempId, 'sending');

    if (!socket || !socket.connected) {
      markPendingFailed(tempId, 'Disconnected');
      return;
    }
    var payload = { url: publicUrl, clientId: tempId };
    if (caption) payload.caption = caption;
    if (replyToId) payload.replyToId = replyToId;
    socket.emit('video', payload, function(ack) {
      if (ack && ack.id) {
        updatePendingToSent(tempId, ack.id);
        lastIncomingId = Math.max(lastIncomingId, ack.id);
        clearUploadStatus(tempId);
      } else if (ack && ack.error) {
        markPendingFailed(tempId, ack.error);
      } else {
        markPendingFailed(tempId, 'No response from server');
      }
    });
  } catch (err) {
    markPendingFailed(tempId, (err && err.message) || 'Upload failed');
  }
}

chatForm.addEventListener('submit', function(e) {
  e.preventDefault();
  if (!socket) return;
  var text = msgInput.value.trim();
  var replyToId = replyTarget ? replyTarget.id : null;
  if (pendingVideo) {
    var pv = pendingVideo;
    pendingVideo = null;
    queueVideoUpload(pv, text, replyToId);
    clearPreview();
    clearReply();
    msgInput.value = '';
    return;
  }
  if (pendingImage) {
    queueMessage('image', { dataUrl: pendingImage, caption: text, replyToId: replyToId });
    clearPreview();
    clearReply();
    msgInput.value = '';
    return;
  }
  if (!text) return;
  queueMessage('message', { text: text, replyToId: replyToId });
  msgInput.value = '';
  clearReply();
});

fileInput.addEventListener('change', function() {
  var file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (file.type.startsWith('video/')) {
    var ABS_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
    if (file.size > ABS_MAX_VIDEO_BYTES) {
      alert('Maximum video size is 200 MB');
      return;
    }
    if (file.size > MAX_VIDEO_BYTES && !canCaptureVideoStream()) {
      alert('Maximum size is 10 MB (browser cannot compress larger videos)');
      return;
    }
    setPendingVideo(file);
    return;
  }
  if (!file.type.startsWith('image/')) {
    alert('File must be an image or video');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    alert('Maximum size is 4 MB');
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    pendingImage = reader.result;
    if (pendingVideo && pendingVideo.previewUrl) {
      try { URL.revokeObjectURL(pendingVideo.previewUrl); } catch (_) {}
    }
    pendingVideo = null;
    previewImg.src = pendingImage;
    previewImg.classList.remove('hidden');
    previewVideo.classList.add('hidden');
    previewVideo.removeAttribute('src');
    previewVideo.load();
    preview.classList.remove('hidden');
    msgInput.placeholder = 'Add a caption (optional)...';
    msgInput.focus();
  };
  reader.readAsDataURL(file);
});

previewCancel.addEventListener('click', clearPreview);

function setPendingVideo(blob) {
  if (pendingVideo && pendingVideo.previewUrl) {
    try { URL.revokeObjectURL(pendingVideo.previewUrl); } catch (_) {}
  }
  var previewUrl = URL.createObjectURL(blob);
  pendingVideo = { blob: blob, previewUrl: previewUrl };
  pendingImage = null;
  previewImg.classList.add('hidden');
  previewImg.src = '';
  previewVideo.src = previewUrl;
  previewVideo.classList.remove('hidden');
  preview.classList.remove('hidden');
  msgInput.placeholder = 'Add a caption (optional)...';
}

function clearPreview() {
  pendingImage = null;
  if (pendingVideo && pendingVideo.previewUrl) {
    try { URL.revokeObjectURL(pendingVideo.previewUrl); } catch (_) {}
  }
  pendingVideo = null;
  previewImg.src = '';
  previewImg.classList.remove('hidden');
  try { previewVideo.pause(); } catch (_) {}
  previewVideo.removeAttribute('src');
  previewVideo.load();
  previewVideo.classList.add('hidden');
  preview.classList.add('hidden');
  msgInput.placeholder = 'Type a message...';
}

cameraBtn.addEventListener('click', function() { openCamera(); });
camClose.addEventListener('click', closeCamera);
camSwitch.addEventListener('click', function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  camFacing = camFacing === 'user' ? 'environment' : 'user';
  openCamera();
});
camRecord.addEventListener('click', function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
});
camSnap.addEventListener('click', function() {
  if (!camStream) return;
  var w = camVideo.videoWidth;
  var h = camVideo.videoHeight;
  if (!w || !h) return;
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, w, h);
  var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
    var scale = Math.min(1, 1280 / Math.max(w, h));
    var sw = Math.round(w * scale);
    var sh = Math.round(h * scale);
    canvas.width = sw;
    canvas.height = sh;
    var shrink = canvas.getContext('2d');
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
    camError.textContent = 'Browser does not support camera access';
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
    camError.textContent = 'Cannot access camera: ' + (err.message || err.name);
  }
}

function closeCamera() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.onstop = null;
    try { mediaRecorder.stop(); } catch (_) {}
    recordChunks = [];
    resetRecordUI();
    mediaRecorder = null;
  }
  stopCamStream();
  camModal.classList.add('hidden');
}

function stopCamStream() {
  if (camStream) {
    camStream.getTracks().forEach(function(t) { t.stop(); });
    camStream = null;
  }
  camVideo.srcObject = null;
}

function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  var candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return '';
}

function resetRecordUI() {
  if (recordTimerId) { clearInterval(recordTimerId); recordTimerId = null; }
  if (recordAutoStopId) { clearTimeout(recordAutoStopId); recordAutoStopId = null; }
  camRecord.classList.remove('recording');
  camRecord.textContent = '🎥';
  camTimer.classList.add('hidden');
}

function updateRecordTimer() {
  var s = Math.floor((Date.now() - recordStartTime) / 1000);
  camTimer.textContent = '● 0:' + String(s).padStart(2, '0');
}

async function startRecording() {
  camError.textContent = '';
  if (typeof MediaRecorder === 'undefined') {
    camError.textContent = 'Browser does not support video recording';
    return;
  }
  if (!camStream || camStream.getAudioTracks().length === 0) {
    try {
      stopCamStream();
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camFacing },
        audio: true,
      });
      camVideo.srcObject = camStream;
    } catch (err) {
      camError.textContent = 'Cannot access camera/mic: ' + (err.message || err.name);
      return;
    }
  }
  var mime = pickVideoMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(camStream, { mimeType: mime, videoBitsPerSecond: 600000 })
      : new MediaRecorder(camStream, { videoBitsPerSecond: 600000 });
  } catch (err) {
    camError.textContent = 'Cannot record: ' + (err.message || err.name);
    return;
  }
  recordChunks = [];
  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size) recordChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  recordStartTime = Date.now();
  camRecord.classList.add('recording');
  camRecord.textContent = '⏹';
  camTimer.classList.remove('hidden');
  updateRecordTimer();
  recordTimerId = setInterval(updateRecordTimer, 250);
  recordAutoStopId = setTimeout(stopRecording, MAX_VIDEO_DURATION_MS);
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  try { mediaRecorder.stop(); } catch (_) {}
  resetRecordUI();
}

function blobToDataUrl(blob) {
  return new Promise(function(resolve, reject) {
    var r = new FileReader();
    r.onload = function() { resolve(r.result); };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function onRecordingStop() {
  var mime = (mediaRecorder && mediaRecorder.mimeType) || 'video/webm';
  var baseType = mime.split(';')[0];
  var blob = new Blob(recordChunks, { type: baseType });
  recordChunks = [];
  if (!blob.size) return;
  if (blob.size > MAX_VIDEO_BYTES && !canCaptureVideoStream()) {
    camError.textContent = 'Video too large; try a shorter clip.';
    return;
  }
  try {
    setPendingVideo(blob);
    closeCamera();
    msgInput.focus();
  } catch (err) {
    camError.textContent = 'Failed to process video: ' + (err.message || err);
  }
}

function updateGalleryBtn() {
  if (GALLERY_ALLOWED.has(me)) galleryBtn.classList.remove('hidden');
  else galleryBtn.classList.add('hidden');
}

var GALLERY_PAGE_SIZE = 8;
var galleryCurrentPage = 1;
var galleryTotalPages = 0;
var galleryTotalItems = 0;
var galleryLoading = false;
var galleryItems = [];

function renderGalleryPage() {
  galleryGrid.innerHTML = '';
  galleryItems.forEach(function(it, i) {
    var cell = document.createElement('div');
    cell.className = 'gallery-item';
    if (it.type === 'video') {
      var v = document.createElement('video');
      v.src = it.src;
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      cell.appendChild(v);
      var badge = document.createElement('span');
      badge.className = 'gallery-badge';
      badge.textContent = '▶';
      cell.appendChild(badge);
    } else {
      var img = document.createElement('img');
      img.src = it.src;
      img.loading = 'lazy';
      img.alt = 'photo';
      cell.appendChild(img);
    }
    // Tombol view in chat
    if (it.id) {
      var viewBtn = document.createElement('button');
      viewBtn.className = 'gallery-view-btn';
      viewBtn.textContent = '💬';
      viewBtn.title = 'View in chat';
      viewBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeGallery();
        jumpToMessage(it.id);
      });
      cell.appendChild(viewBtn);
    }
    cell.addEventListener('click', function() {
      viewerItems = galleryItems.map(function(g) { return { type: g.type, src: g.src }; });
      viewerIndex = i;
      renderViewerItem();
      imageViewer.classList.remove('hidden');
    });
    galleryGrid.appendChild(cell);
  });
  updatePaginationControls();
}

function updatePaginationControls() {
  var paginationEl = document.getElementById('gallery-pagination');
  var pageInfoEl = document.getElementById('gallery-page-info');
  var prevBtn = document.getElementById('gallery-prev');
  var nextBtn = document.getElementById('gallery-next');
  if (galleryTotalPages <= 1) {
    paginationEl.classList.add('hidden');
    return;
  }
  paginationEl.classList.remove('hidden');
  pageInfoEl.textContent = 'Halaman ' + galleryCurrentPage + ' dari ' + galleryTotalPages + ' (' + galleryTotalItems + ' gambar)';
  prevBtn.disabled = galleryCurrentPage === 1;
  nextBtn.disabled = galleryCurrentPage === galleryTotalPages;
}

async function loadGalleryPage(page) {
  if (galleryLoading) return;
  var token = localStorage.getItem('token');
  if (!token) return;
  galleryLoading = true;
  var loadingEl = document.getElementById('gallery-loading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  galleryEmpty.classList.add('hidden');
  try {
    var res = await fetch('/gallery?limit=' + GALLERY_PAGE_SIZE + '&page=' + page, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return;
    var data = await res.json();
    galleryItems = (data && data.items) || [];
    galleryTotalItems = data.totalItems || 0;
    galleryTotalPages = data.totalPages || 0;
    galleryCurrentPage = data.page || page;
    if (galleryTotalItems === 0) {
      galleryEmpty.classList.remove('hidden');
      document.getElementById('gallery-pagination').classList.add('hidden');
      return;
    }
    renderGalleryPage();
  } catch (_) {
  } finally {
    galleryLoading = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

async function openGallery() {
  galleryGrid.innerHTML = '';
  galleryEmpty.classList.add('hidden');
  document.getElementById('gallery-pagination').classList.add('hidden');
  galleryModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  galleryCurrentPage = 1;
  galleryTotalPages = 0;
  galleryTotalItems = 0;
  galleryLoading = false;
  galleryItems = [];
  await loadGalleryPage(1);
}

function goToPrevPage() {
  if (galleryCurrentPage > 1) {
    galleryGrid.innerHTML = '';
    loadGalleryPage(galleryCurrentPage - 1);
  }
}

function goToNextPage() {
  if (galleryCurrentPage < galleryTotalPages) {
    galleryGrid.innerHTML = '';
    loadGalleryPage(galleryCurrentPage + 1);
  }
}

function closeGallery() {
  galleryModal.classList.add('hidden');
  galleryGrid.innerHTML = '';
  galleryItems = [];
  galleryCurrentPage = 1;
  galleryTotalPages = 0;
  galleryTotalItems = 0;
  galleryLoading = false;
  if (imageViewer.classList.contains('hidden')) document.body.style.overflow = '';
}

galleryBtn.addEventListener('click', openGallery);
galleryClose.addEventListener('click', closeGallery);
document.getElementById('gallery-prev').addEventListener('click', goToPrevPage);
document.getElementById('gallery-next').addEventListener('click', goToNextPage);

function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  var candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return '';
}

function updateAudioTimer() {
  var s = Math.floor((Date.now() - audioStartTime) / 1000);
  recTimerEl.textContent = '0:' + String(s).padStart(2, '0');
}

function stopAudioStream() {
  if (audioStream) {
    audioStream.getTracks().forEach(function(t) { t.stop(); });
    audioStream = null;
  }
}

function resetRecorderUI() {
  if (audioTimerId) { clearInterval(audioTimerId); audioTimerId = null; }
  if (audioAutoStopId) { clearTimeout(audioAutoStopId); audioAutoStopId = null; }
  recorderBar.classList.add('hidden');
  recTimerEl.textContent = '0:00';
}

async function startVoiceRecording() {
  if (audioRecorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Browser does not support microphone access');
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    alert('Browser does not support audio recording');
    return;
  }
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Cannot access microphone: ' + (err.message || err.name));
    return;
  }
  var mime = pickAudioMime();
  try {
    audioRecorder = mime
      ? new MediaRecorder(audioStream, { mimeType: mime, audioBitsPerSecond: 32000 })
      : new MediaRecorder(audioStream, { audioBitsPerSecond: 32000 });
  } catch (err) {
    stopAudioStream();
    alert('Cannot record: ' + (err.message || err.name));
    return;
  }
  audioChunks = [];
  audioCancelled = false;
  audioRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size) audioChunks.push(e.data);
  };
  audioRecorder.onstop = onVoiceRecordingStop;
  audioRecorder.start();
  audioStartTime = Date.now();
  recorderBar.classList.remove('hidden');
  updateAudioTimer();
  audioTimerId = setInterval(updateAudioTimer, 250);
  audioAutoStopId = setTimeout(finishVoiceRecording, MAX_AUDIO_DURATION_MS);
}

function finishVoiceRecording() {
  if (!audioRecorder || audioRecorder.state === 'inactive') return;
  audioCancelled = false;
  try { audioRecorder.stop(); } catch (_) {}
}

function cancelVoiceRecording() {
  if (!audioRecorder) return;
  audioCancelled = true;
  try { audioRecorder.stop(); } catch (_) {}
}

async function onVoiceRecordingStop() {
  var mime = (audioRecorder && audioRecorder.mimeType) || 'audio/webm';
  var baseType = mime.split(';')[0];
  var blob = new Blob(audioChunks, { type: baseType });
  audioChunks = [];
  audioRecorder = null;
  stopAudioStream();
  resetRecorderUI();
  if (audioCancelled || !blob.size) return;
  if (blob.size > MAX_AUDIO_BYTES) {
    alert('Voice note too large; try a shorter clip.');
    return;
  }
  try {
    var dataUrl = await blobToDataUrl(blob);
    var replyToId = replyTarget ? replyTarget.id : null;
    queueMessage('audio', { dataUrl: dataUrl, replyToId: replyToId });
    clearReply();
  } catch (err) {
    alert('Failed to process voice note: ' + (err.message || err));
  }
}

micBtn.addEventListener('click', function() {
  if (audioRecorder) finishVoiceRecording();
  else startVoiceRecording();
});
recSendBtn.addEventListener('click', finishVoiceRecording);
recCancelBtn.addEventListener('click', cancelVoiceRecording);

logoutBtn.addEventListener('click', function() {
  if (socket) socket.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  chatView.classList.add('hidden');
  loginView.classList.remove('hidden');
});

var savedToken = localStorage.getItem('token');
var savedUser = localStorage.getItem('username');
if (savedToken && savedUser) {
  startChat(savedToken, savedUser);
}