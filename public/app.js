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
const panicBtn = document.getElementById('panic-btn');
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
const HUB_USER = 'occupatus';
const DEFAULT_PEER = 'mutatio';
let currentPeer = null;
let availablePeers = [];
const unreadByPeer = {};
const readStateMap = {};
const peerSwitcherEl = document.getElementById('peer-switcher');
const peerSwitcherBtn = document.getElementById('peer-switcher-btn');
const peerSwitcherLabel = document.getElementById('peer-switcher-label');
const peerSwitcherBadge = document.getElementById('peer-switcher-badge');
const peerSwitcherMenu = document.getElementById('peer-switcher-menu');
function isHub() { return me === HUB_USER; }
function getPartner() { return isHub() ? currentPeer : HUB_USER; }
const presenceEl = document.getElementById('presence-status');
const typingIndicatorEl = document.getElementById('typing-indicator');
const typingNameEl = typingIndicatorEl.querySelector('.typing-name');
const presenceState = {};
const typingState = {};
const typingExpireTimers = {};
let presenceTimerId = null;
let typingSending = false;
let typingStopTimerId = null;
const TYPING_IDLE_MS = 3000;
const TYPING_EXPIRE_MS = 6000;

function sendTypingStart() {
  if (!socket || !currentPeer) return;
  if (!typingSending) {
    typingSending = true;
    socket.emit('typing', { typing: true, peer: currentPeer });
  }
  if (typingStopTimerId) clearTimeout(typingStopTimerId);
  typingStopTimerId = setTimeout(() => sendTypingStop(), TYPING_IDLE_MS);
}

function sendTypingStop() {
  if (typingStopTimerId) { clearTimeout(typingStopTimerId); typingStopTimerId = null; }
  if (!typingSending) return;
  typingSending = false;
  if (socket && currentPeer) socket.emit('typing', { typing: false, peer: currentPeer });
}

function formatLastSeen(iso) {
  if (!iso) return 'belum pernah online';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'belum pernah online';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 45) return 'baru saja';
  if (diffSec < 3600) return Math.max(1, Math.floor(diffSec / 60)) + ' menit lalu';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' jam lalu';
  if (diffSec < 7 * 86400) return Math.floor(diffSec / 86400) + ' hari lalu';
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function renderPresence() {
  const partner = getPartner();
  if (!partner) {
    presenceEl.classList.add('hidden');
    if (window.chatCall) window.chatCall.setCallButtonEnabled(false);
    return;
  }
  const info = presenceState[partner] || {};
  presenceEl.classList.remove('hidden');
  if (info.online) {
    presenceEl.classList.add('online');
    presenceEl.textContent = partner + ' • Online';
  } else {
    presenceEl.classList.remove('online');
    presenceEl.textContent = partner + ' • ' + formatLastSeen(info.lastSeen);
  }
  if (window.chatCall) window.chatCall.setCallButtonEnabled(!!info.online);
}

function renderTyping() {
  const names = Object.keys(typingState).filter((u) => u !== me);
  if (!names.length) {
    typingIndicatorEl.classList.add('hidden');
    typingNameEl.textContent = '';
    return;
  }
  typingNameEl.textContent = names.length === 1 ? names[0] : names.join(', ');
  typingIndicatorEl.classList.remove('hidden');
}

function startPresenceTimer() {
  if (presenceTimerId) return;
  presenceTimerId = setInterval(() => {
    if (getPartner()) renderPresence();
  }, 30000);
}

function totalUnread() {
  let sum = 0;
  for (const k in unreadByPeer) {
    if (k !== currentPeer) sum += unreadByPeer[k] || 0;
  }
  return sum;
}

function renderPeerSwitcherButton() {
  if (!isHub()) {
    peerSwitcherEl.classList.add('hidden');
    return;
  }
  peerSwitcherEl.classList.remove('hidden');
  peerSwitcherLabel.textContent = currentPeer || '—';
  const total = totalUnread();
  if (total > 0) {
    peerSwitcherBadge.textContent = total > 99 ? '99+' : String(total);
    peerSwitcherBadge.classList.remove('hidden');
  } else {
    peerSwitcherBadge.classList.add('hidden');
  }
}

function renderPeerSwitcherMenu() {
  peerSwitcherMenu.innerHTML = '';
  availablePeers.forEach((peer) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'peer-menu-item' + (peer === currentPeer ? ' active' : '');
    btn.setAttribute('role', 'menuitem');
    const name = document.createElement('span');
    name.className = 'peer-menu-name';
    const dot = document.createElement('span');
    dot.className = 'peer-menu-dot' + (presenceState[peer] && presenceState[peer].online ? ' online' : '');
    name.appendChild(dot);
    name.appendChild(document.createTextNode(peer));
    btn.appendChild(name);
    const unread = unreadByPeer[peer] || 0;
    if (unread > 0 && peer !== currentPeer) {
      const badge = document.createElement('span');
      badge.className = 'peer-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => {
      closePeerMenu();
      if (peer !== currentPeer) switchPeer(peer);
      else reloadCurrentPeer();
    });
    peerSwitcherMenu.appendChild(btn);
  });
}

function openPeerMenu() {
  renderPeerSwitcherMenu();
  peerSwitcherMenu.classList.remove('hidden');
  peerSwitcherBtn.setAttribute('aria-expanded', 'true');
}
function closePeerMenu() {
  peerSwitcherMenu.classList.add('hidden');
  peerSwitcherBtn.setAttribute('aria-expanded', 'false');
}
function togglePeerMenu() {
  if (peerSwitcherMenu.classList.contains('hidden')) openPeerMenu();
  else closePeerMenu();
}
peerSwitcherBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePeerMenu();
});
document.addEventListener('click', (e) => {
  if (peerSwitcherMenu.classList.contains('hidden')) return;
  if (!peerSwitcherMenu.contains(e.target) && e.target !== peerSwitcherBtn) closePeerMenu();
});

const messagesLoadingEl = document.getElementById('messages-loading');
function showMessagesLoading() {
  if (messagesLoadingEl) messagesLoadingEl.classList.remove('hidden');
}
function hideMessagesLoading() {
  if (messagesLoadingEl) messagesLoadingEl.classList.add('hidden');
}

function resetThreadView() {
  messagesEl.innerHTML = '';
  lastIncomingId = 0;
  lastReadByOthers = 0;
  oldestLoadedId = null;
  hasMoreHistory = false;
  loadingMore = false;
  Object.keys(typingState).forEach((k) => delete typingState[k]);
  Object.keys(typingExpireTimers).forEach((k) => {
    clearTimeout(typingExpireTimers[k]);
    delete typingExpireTimers[k];
  });
  renderTyping();
  clearReply();
  sendTypingStop();
  showMessagesLoading();
}

function switchPeer(peer) {
  if (!socket || !peer || peer === currentPeer) return;
  currentPeer = peer;
  if (isHub()) localStorage.setItem('activePeer', peer);
  unreadByPeer[peer] = 0;
  resetThreadView();
  renderPeerSwitcherButton();
  renderPresence();
  applyReadStateForCurrentPeer();
  socket.emit('selectPeer', { peer });
}

function reloadCurrentPeer() {
  if (!socket || !currentPeer) return;
  resetThreadView();
  socket.emit('selectPeer', { peer: currentPeer });
}

function applyReadStateForCurrentPeer() {
  if (!currentPeer) return;
  const other = isHub() ? currentPeer : HUB_USER;
  const otherMap = readStateMap[other] || {};
  lastReadByOthers = otherMap[currentPeer] || 0;
  updateReceipts();
}

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

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🥳','😉','😋','😜','🤪','😇','🙂',
  '🙃','😌','😔','😢','😭','😤','😡','🤬','🤔','🤯','😱','🥺','🤗','🤭','🤫','🤥',
  '😴','🤤','🥱','🤒','🤕','🤢','🤮','🥴','😵','🤠','👍','👎','👏','🙏','💪','🫶',
  '👋','🤝','✌️','🤞','🤟','🤙','👌','🫰','❤️','🧡','💛','💚','💙','💜','🖤','🤍',
  '💔','💯','🔥','✨','🎉','🎊','🎁','🍕','🍔','🍟','🍰','☕','🍺','🌹','🌈','⭐',
];
const emojiBtn = document.getElementById('emoji-btn');
const emojiPanel = document.getElementById('emoji-panel');
EMOJIS.forEach((ch) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = ch;
  b.setAttribute('aria-label', ch);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    insertEmoji(ch);
  });
  emojiPanel.appendChild(b);
});
function closeEmojiPanel() {
  emojiPanel.classList.add('hidden');
  emojiBtn.setAttribute('aria-expanded', 'false');
}
function toggleEmojiPanel() {
  const isHidden = emojiPanel.classList.toggle('hidden');
  emojiBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
}
function insertEmoji(ch) {
  const start = msgInput.selectionStart ?? msgInput.value.length;
  const end = msgInput.selectionEnd ?? msgInput.value.length;
  const before = msgInput.value.slice(0, start);
  const after = msgInput.value.slice(end);
  msgInput.value = before + ch + after;
  const pos = start + ch.length;
  msgInput.focus();
  msgInput.setSelectionRange(pos, pos);
  msgInput.dispatchEvent(new Event('input', { bubbles: true }));
}
emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEmojiPanel();
});
document.addEventListener('click', (e) => {
  if (emojiPanel.classList.contains('hidden')) return;
  if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) closeEmojiPanel();
});

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
let mirrorCanvasStream = null;
let mirrorRafId = null;

let socket = null;
let me = null;
let lastIncomingId = 0;
let lastReadByOthers = 0;
let oldestLoadedId = null;
let hasMoreHistory = false;
let loadingMore = false;
let notifEnabled = localStorage.getItem('notifEnabled') === '1';
let audioCtx = null;

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
  var maxDim = opts.maxDimension || 720;
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

  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  var rafId = null;
  var rvfcId = null;
  var renderRunning = false;

  function stopRender() {
    renderRunning = false;
    if (rafId) { try { cancelAnimationFrame(rafId); } catch (_) {} rafId = null; }
    if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(rvfcId); } catch (_) {}
      rvfcId = null;
    }
  }

  function cleanup() {
    stopRender();
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

    var srcW = video.videoWidth || 1280;
    var srcH = video.videoHeight || 720;
    var scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    var w = Math.max(2, Math.round(srcW * scale));
    var h = Math.max(2, Math.round(srcH * scale));
    if (w % 2) w--;
    if (h % 2) h--;
    canvas.width = w;
    canvas.height = h;

    await video.play();

    var canvasStream = canvas.captureStream(30);
    if (!canvasStream) throw new Error('canvas.captureStream not supported');
    try {
      var srcStream = captureStreamFrom(video);
      if (srcStream) {
        var audioTracks = srcStream.getAudioTracks();
        for (var i = 0; i < audioTracks.length; i++) {
          canvasStream.addTrack(audioTracks[i]);
        }
      }
    } catch (_) {}

    renderRunning = true;
    var useRvfc = typeof video.requestVideoFrameCallback === 'function';
    function drawRvfc() {
      if (!renderRunning) return;
      try { ctx.drawImage(video, 0, 0, w, h); } catch (_) {}
      try { rvfcId = video.requestVideoFrameCallback(drawRvfc); } catch (_) {}
    }
    function drawRaf() {
      if (!renderRunning) return;
      try { ctx.drawImage(video, 0, 0, w, h); } catch (_) {}
      rafId = requestAnimationFrame(drawRaf);
    }
    if (useRvfc) {
      try { rvfcId = video.requestVideoFrameCallback(drawRvfc); } catch (_) { drawRaf(); }
    } else {
      drawRaf();
    }

    var recorder = new MediaRecorder(canvasStream, {
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
        stopRender();
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
  var rawType = blob.type || 'video/webm';
  var base = rawType.split(';')[0].trim().toLowerCase();
  var contentType;
  if (base === 'video/mp4') contentType = 'video/mp4';
  else if (base === 'video/quicktime' || base === 'video/mov') contentType = 'video/quicktime';
  else contentType = 'video/webm';
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
  if (file.size <= MAX_VIDEO_BYTES) return file;
  if (!canCaptureVideoStream()) return file;
  if (typeof onStage === 'function') onStage('compress', file.size);
  try {
    var isLarge = file.size > 50 * 1024 * 1024;
    var compressed = await compressVideoFile(file, {
      videoBitsPerSecond: isLarge ? 600000 : 700000,
      maxDimension: isLarge ? 480 : 720,
    });
    if (compressed.size >= file.size) return file;
    return compressed;
  } catch (err) {
    console.warn('Compression failed, uploading raw:', err && err.message);
    return file;
  }
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
  if (GALLERY_ALLOWED.has(me)) panicBtn.classList.remove('hidden');
  else panicBtn.classList.add('hidden');
  maybePlaySunrise();
  messagesEl.innerHTML = '';
  showMessagesLoading();
  Object.keys(unreadByPeer).forEach((k) => delete unreadByPeer[k]);
  Object.keys(readStateMap).forEach((k) => delete readStateMap[k]);
  if (isHub()) {
    const saved = localStorage.getItem('activePeer');
    currentPeer = saved || DEFAULT_PEER;
  } else {
    currentPeer = me;
  }
  renderPeerSwitcherButton();
  updateNotifBtn();
  updateGalleryBtn();
  renderPresence();
  startPresenceTimer();
  loadNotifEnabled();
  if (notifEnabled && 'Notification' in window) {
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    } else if (Notification.permission === 'granted') {
      setupPush();
    }
  }

  socket = io({
    auth: { token },
    timeout: 30000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  if (window.chatCall) {
    window.chatCall.init({
      socket,
      getPartner,
      getToken: () => localStorage.getItem('token'),
      getMe: () => me,
    });
  }

  socket.on('history', (payload) => {
    const peer = payload && payload.peer;
    if (peer && peer !== currentPeer) return;
    const list = Array.isArray(payload) ? payload : (payload && payload.messages) || [];
    hasMoreHistory = !!(payload && payload.hasMore);
    messagesEl.innerHTML = '';
    hideMessagesLoading();
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
    applyReadStateForCurrentPeer();
    maybeMarkRead();
  });

  socket.on('peers', (list) => {
    if (!Array.isArray(list)) return;
    availablePeers = list.filter((p) => typeof p === 'string');
    if (isHub() && availablePeers.length && !availablePeers.includes(currentPeer)) {
      currentPeer = availablePeers[0];
      localStorage.setItem('activePeer', currentPeer);
      resetThreadView();
      socket.emit('selectPeer', { peer: currentPeer });
    }
    renderPeerSwitcherButton();
  });

  socket.on('presence:init', (snap) => {
    if (!snap || typeof snap !== 'object') return;
    Object.keys(presenceState).forEach((k) => delete presenceState[k]);
    Object.entries(snap).forEach(([u, info]) => {
      presenceState[u] = {
        online: !!(info && info.online),
        lastSeen: info && info.lastSeen ? info.lastSeen : null,
      };
    });
    renderPresence();
  });

  socket.on('typing', ({ username, peer, typing }) => {
    if (!username || username === me) return;
    if (peer && peer !== currentPeer) return;
    if (typingExpireTimers[username]) {
      clearTimeout(typingExpireTimers[username]);
      delete typingExpireTimers[username];
    }
    if (typing) {
      typingState[username] = true;
      typingExpireTimers[username] = setTimeout(() => {
        delete typingState[username];
        delete typingExpireTimers[username];
        renderTyping();
      }, TYPING_EXPIRE_MS);
    } else {
      delete typingState[username];
    }
    renderTyping();
  });

  socket.on('presence:update', ({ username, online, lastSeen }) => {
    if (!username) return;
    presenceState[username] = {
      online: !!online,
      lastSeen: lastSeen || (presenceState[username] && presenceState[username].lastSeen) || null,
    };
    if (!online) {
      delete typingState[username];
      if (typingExpireTimers[username]) {
        clearTimeout(typingExpireTimers[username]);
        delete typingExpireTimers[username];
      }
      renderTyping();
    }
    renderPresence();
    if (isHub() && !peerSwitcherMenu.classList.contains('hidden')) renderPeerSwitcherMenu();
  });

  socket.on('readState', (state) => {
    if (!state || typeof state !== 'object') return;
    Object.keys(readStateMap).forEach((k) => delete readStateMap[k]);
    Object.entries(state).forEach(([u, peerMap]) => {
      if (peerMap && typeof peerMap === 'object') {
        readStateMap[u] = { ...peerMap };
      }
    });
    applyReadStateForCurrentPeer();
  });

  socket.on('read', ({ username, peer, lastReadId }) => {
    if (typeof lastReadId !== 'number' || !peer) return;
    if (!readStateMap[username]) readStateMap[username] = {};
    if ((readStateMap[username][peer] || 0) < lastReadId) {
      readStateMap[username][peer] = lastReadId;
    }
    if (username === me) return;
    if (peer !== currentPeer) return;
    if (lastReadId > lastReadByOthers) {
      lastReadByOthers = lastReadId;
      updateReceipts();
    }
  });

  socket.on('message', (m) => {
    const msgPeer = m && m.peer;
    if (msgPeer && msgPeer !== currentPeer) {
      if (isHub() && m.username !== me) {
        unreadByPeer[msgPeer] = (unreadByPeer[msgPeer] || 0) + 1;
        renderPeerSwitcherButton();
        if (!peerSwitcherMenu.classList.contains('hidden')) renderPeerSwitcherMenu();
      }
      notify(m);
      return;
    }
    if (m.id && messagesEl.querySelector('.msg[data-id="' + m.id + '"]')) return;
    if (m.username === me && m.id && m.clientId != null) {
      var pendingEl = messagesEl.querySelector('.msg[data-temp-id="' + m.clientId + '"]');
      if (pendingEl) {
        if (typeof m.text === 'string') {
          var textEl = pendingEl.querySelector('.msg-text');
          if (textEl) textEl.innerHTML = linkify(m.text);
        }
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

  socket.on('unsend', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    const peer = payload.peer;
    if (!Number.isFinite(id) || id <= 0) return;
    if (peer && peer !== currentPeer) return;
    applyUnsendToView(id);
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
      panicBtn.classList.add('hidden');
      loginView.classList.remove('hidden');
      loginError.textContent = 'Session expired, please log in again';
      return;
    }
    showConnState('reconnecting');
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') {
      socket.connect();
    }
    showConnState('reconnecting');
  });

  socket.on('connect', () => {
    clearConnState();
    if (isHub() && currentPeer && currentPeer !== DEFAULT_PEER) {
      socket.emit('selectPeer', { peer: currentPeer });
    }
    if (pendingQueue.length > 0) {
      const toResend = pendingQueue.slice();
      pendingQueue = [];
      toResend.forEach((item) => {
        emitWithAck(item);
      });
    }
  });

  socket.io.on('reconnect_attempt', () => {
    showConnState('reconnecting');
  });

  socket.io.on('reconnect', () => {
    clearConnState();
  });
}

const UNSENT_PLACEHOLDER_TEXT = '🚫 Pesan ditarik';

function shouldHideUnsentContent(msg) {
  return !!(msg && msg.unsent) && !isHub();
}

function replySnippet(msg) {
  if (msg && msg.unsent && !isHub()) return UNSENT_PLACEHOLDER_TEXT;
  if (msg.text) return msg.text;
  if (msg.image || msg.hasImage) return '📷 Photo';
  if (msg.video || msg.hasVideo) return '🎬 Video';
  if (msg.audio || msg.hasAudio) return '🎤 Voice note';
  return '';
}

function buildMessageNodes(msg) {
  const { id, username, text, time, image, replyTo } = msg;
  const div = document.createElement('div');
  const isPending = msg._pending || false;
  const tempId = msg._tempId || null;
  const isUnsent = !!msg.unsent;
  const hideContent = shouldHideUnsentContent(msg);
  const cls = ['msg', username === me ? 'mine' : 'other'];
  if (isUnsent) cls.push('unsent');
  if (hideContent) cls.push('unsent-hidden');
  div.className = cls.join(' ');
  if (id) div.dataset.id = String(id);
  if (tempId) div.dataset.tempId = String(tempId);
  const t = new Date(time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  div.dataset.day = dayKey(time);
  let tick = '';
  if (username === me && !hideContent) {
    if (isPending) {
      tick = '<span class="tick pending" aria-label="pending">🕐</span>';
    } else if (id) {
      tick = `<span class="tick ${id <= lastReadByOthers ? 'read' : 'sent'}" data-id="${id}" aria-label="${id <= lastReadByOthers ? 'read' : 'sent'}"><svg viewBox="0 0 18 12" width="16" height="12" aria-hidden="true"><path d="M1 6.5 L4.5 10 L11 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 6.5 L9.5 10 L17 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    }
  }
  const unsentTag = (isUnsent && !hideContent) ? '<span class="unsent-tag" title="Pesan ditarik oleh pengirim">ditarik</span>' : '';
  const meta = '<div class="meta">' + escapeHtml(username) + ' • ' + t + tick + unsentTag + '</div>';
  let quote = '';
  if (replyTo && !hideContent) {
    const replyHide = !!(replyTo.unsent && !isHub());
    const replyText = replyHide ? UNSENT_PLACEHOLDER_TEXT : replySnippet(replyTo);
    const replyUser = replyHide ? '' : escapeHtml(replyTo.username || '');
    const quoteCls = 'reply-quote' + (replyHide ? ' reply-quote-unsent' : '');
    quote = '<div class="' + quoteCls + '" data-target="' + replyTo.id + '">' +
      '<div class="reply-quote-body">' +
      '<div class="reply-quote-user">' + replyUser + '</div>' +
      '<div class="reply-quote-text">' + escapeHtml(replyText) + '</div>' +
      '</div>' +
      '</div>';
  }
  let body = '';
  if (hideContent) {
    body = '<span class="msg-text unsent-placeholder">' + escapeHtml(UNSENT_PLACEHOLDER_TEXT) + '</span>';
  } else {
    body = text ? '<span class="msg-text">' + linkify(text) + '</span>' : '';
    if (image && /^data:image\//.test(image)) {
      const img = '<img class="chat-img" src="' + image + '" alt="photo" />';
      body = body ? body + img : img;
    }
    if (msg.video && isPlayableVideoSrc(msg.video)) {
      const vid = '<video class="chat-vid" src="' + escapeHtml(msg.video) + '" controls controlslist="nodownload noplaybackrate" playsinline preload="metadata" oncontextmenu="return false"></video>';
      body = body ? body + vid : vid;
    }
    if (msg.audio && /^data:audio\//.test(msg.audio)) {
      const aud = '<audio class="chat-aud" src="' + msg.audio + '" controls preload="metadata"></audio>';
      body = body ? body + aud : aud;
    }
  }
  div.innerHTML = meta + quote + body;
  const imgEl = div.querySelector('img.chat-img');
  if (imgEl) {
    imgEl.addEventListener('click', () => openImageViewer(image));
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
  attachMsgMenu(div, { id, username, isUnsent, hideContent });
  return [div];
}

function attachMsgMenu(div, opts) {
  if (div.querySelector('.msg-menu-btn')) return;
  const { id, username, isUnsent, hideContent } = opts;
  const canReply = id && !hideContent && !isUnsent;
  const canUnsend = id && username === me && !isUnsent;
  if (!canReply && !canUnsend) return;
  const items = [];
  if (canReply) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="reply"><span class="msg-menu-icon">↩</span><span class="msg-menu-label">Balas</span></button>');
  if (canUnsend) items.push('<button class="msg-menu-item msg-menu-item-danger" type="button" role="menuitem" data-action="unsend"><span class="msg-menu-icon">🚫</span><span class="msg-menu-label">Tarik pesan</span></button>');
  const menuMarkup =
    '<button class="msg-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Aksi pesan" title="Aksi pesan">⋯</button>' +
    '<div class="msg-menu hidden" role="menu">' + items.join('') + '</div>';
  div.insertAdjacentHTML('beforeend', menuMarkup);
  const menuBtn = div.querySelector('.msg-menu-btn');
  const menuEl = div.querySelector('.msg-menu');
  if (!menuBtn || !menuEl) return;
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menuEl.classList.contains('hidden');
    closeOpenMsgMenu();
    if (!isOpen) {
      menuEl.classList.remove('hidden');
      menuBtn.setAttribute('aria-expanded', 'true');
      openMsgMenu = menuEl;
      openMsgMenuBtn = menuBtn;
    }
  });
  menuEl.querySelectorAll('.msg-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      closeOpenMsgMenu();
      const currentId = Number(div.dataset.id) || id;
      if (action === 'reply' && currentId) {
        const textEl = div.querySelector('.msg-text');
        const replyText = textEl ? textEl.textContent : '';
        const hasImage = !!div.querySelector('img.chat-img');
        const hasVideo = !!div.querySelector('video.chat-vid');
        const hasAudio = !!div.querySelector('audio.chat-aud');
        setReplyTarget({ id: currentId, username, text: replyText, hasImage, hasVideo, hasAudio });
      } else if (action === 'unsend' && currentId) {
        requestUnsend(currentId);
      }
    });
  });
}

let openMsgMenu = null;
let openMsgMenuBtn = null;
function closeOpenMsgMenu() {
  if (!openMsgMenu) return;
  openMsgMenu.classList.add('hidden');
  if (openMsgMenuBtn) openMsgMenuBtn.setAttribute('aria-expanded', 'false');
  openMsgMenu = null;
  openMsgMenuBtn = null;
}
document.addEventListener('click', () => closeOpenMsgMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOpenMsgMenu();
});

function requestUnsend(id) {
  if (!socket || !id) return;
  if (!confirm('Tarik pesan ini? Pesan akan diganti placeholder.')) return;
  socket.emit('unsend', { id }, (resp) => {
    if (resp && resp.error) {
      console.error('unsend failed:', resp.error);
      addSystem('Gagal menarik pesan: ' + resp.error);
    }
  });
}

function applyUnsendToView(id) {
  const targetId = String(id);
  const el = messagesEl.querySelector('.msg[data-id="' + targetId + '"]');
  if (el) {
    if (replyTarget && Number(replyTarget.id) === Number(id)) clearReply();
    el.classList.add('unsent');
    if (openMsgMenu && el.contains(openMsgMenu)) closeOpenMsgMenu();
    el.querySelectorAll('.msg-menu-btn, .msg-menu').forEach((n) => n.remove());
    if (isHub()) {
      const meta = el.querySelector('.meta');
      if (meta && !meta.querySelector('.unsent-tag')) {
        const span = document.createElement('span');
        span.className = 'unsent-tag';
        span.title = 'Pesan ditarik oleh pengirim';
        span.textContent = 'ditarik';
        meta.appendChild(span);
      }
    } else {
      el.classList.add('unsent-hidden');
      const meta = el.querySelector('.meta');
      if (meta) {
        meta.querySelectorAll('.tick, .unsent-tag').forEach((n) => n.remove());
      }
      el.querySelectorAll('.reply-quote, .msg-text, .chat-img, .chat-vid, .chat-aud').forEach((n) => n.remove());
      const placeholder = document.createElement('span');
      placeholder.className = 'msg-text unsent-placeholder';
      placeholder.textContent = UNSENT_PLACEHOLDER_TEXT;
      el.appendChild(placeholder);
    }
  }
  if (!isHub()) {
    messagesEl.querySelectorAll('.reply-quote[data-target="' + targetId + '"]').forEach((quoteEl) => {
      quoteEl.classList.add('reply-quote-unsent');
      const userEl = quoteEl.querySelector('.reply-quote-user');
      const textEl = quoteEl.querySelector('.reply-quote-text');
      if (userEl) userEl.textContent = '';
      if (textEl) textEl.textContent = UNSENT_PLACEHOLDER_TEXT;
    });
  }
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
  if (!socket || !lastIncomingId || !currentPeer) return;
  if (document.visibilityState !== 'visible') return;
  if (chatView.classList.contains('hidden')) return;
  socket.emit('read', { msgId: lastIncomingId, peer: currentPeer });
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

function forceReconnectIfNeeded() {
  if (!socket) return;
  if (socket.connected) return;
  showConnState('reconnecting');
  try {
    if (socket.io && typeof socket.io.engine !== 'undefined') {
      try { socket.disconnect(); } catch (_) {}
    }
    socket.connect();
  } catch (_) {}
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') forceReconnectIfNeeded();
});
window.addEventListener('focus', forceReconnectIfNeeded);
window.addEventListener('online', forceReconnectIfNeeded);

let connStateEl = null;
function showConnState(state) {
  if (!connStateEl) {
    connStateEl = document.createElement('div');
    connStateEl.id = 'conn-state';
    connStateEl.className = 'conn-state';
    document.body.appendChild(connStateEl);
  }
  if (state === 'reconnecting') {
    connStateEl.textContent = 'Reconnecting…';
    connStateEl.classList.remove('hidden');
  } else {
    connStateEl.classList.add('hidden');
  }
}
function clearConnState() {
  if (connStateEl) connStateEl.classList.add('hidden');
}

function loadMoreHistory() {
  if (!socket || loadingMore || !hasMoreHistory || !oldestLoadedId || !currentPeer) return Promise.resolve();
  loadingMore = true;
  const loader = document.createElement('div');
  loader.className = 'msg system';
  loader.id = 'history-loader';
  loader.textContent = 'Loading older messages...';
  messagesEl.insertBefore(loader, messagesEl.firstChild);
  const prevScrollTop = messagesEl.scrollTop;
  const prevScrollHeight = messagesEl.scrollHeight;
  const requestedPeer = currentPeer;
  return new Promise((resolve) => {
  socket.emit('loadMore', { beforeId: oldestLoadedId, peer: requestedPeer }, (resp) => {
    if (requestedPeer !== currentPeer) {
      const loaderEl = document.getElementById('history-loader');
      if (loaderEl) loaderEl.remove();
      loadingMore = false;
      resolve();
      return;
    }
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
    node.setAttribute('controlslist', 'nodownload noplaybackrate');
    node.addEventListener('contextmenu', (e) => e.preventDefault());
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
    replyTo: msgData.replyTo || null,
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
  attachMsgMenu(el, { id: realId, username: me, isUnsent: false, hideContent: false });
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
  var status = el.querySelector('.upload-status');
  if (status) {
    status.classList.add('failed');
    status.textContent = 'Failed: ' + (errorMsg || 'Upload error');
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
    if (msgData.peer) payload.peer = msgData.peer;
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
  if (msgData.replyTo) data.replyTo = msgData.replyTo;
  data.peer = currentPeer;
  data._tempId = null;
  data._pending = true;
  data._type = eventName;
  var tempId = showPendingLocally(data);
  data._tempId = tempId;
  emitWithAck(data);
}

function formatMB(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function setUploadStatus(tempId, stage, percent, totalBytes) {
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
  if (stage === 'compress') {
    label = 'Compressing video';
    if (totalBytes != null) label += ' ' + formatMB(totalBytes);
    label += '... please wait';
  } else if (stage === 'uploading') {
    label = 'Uploading';
    if (percent != null) label += ' ' + percent + '%';
    if (totalBytes != null) label += ' of ' + formatMB(totalBytes);
  } else if (stage === 'sending') label = 'Sending...';
  else label = stage;
  status.textContent = label;
}

function clearUploadStatus(tempId) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  var status = el.querySelector('.upload-status');
  if (status && status.parentNode) status.parentNode.removeChild(status);
}

async function queueVideoUpload(pv, caption, replyToId, replyTo) {
  tempIdCounter++;
  var tempId = tempIdCounter;
  var capturedPeer = currentPeer;
  var pendingMsg = {
    text: caption || '',
    replyToId: replyToId || null,
    replyTo: replyTo || null,
    _pending: true,
    _tempId: tempId,
    id: null,
    username: me,
    time: new Date().toISOString(),
    video: pv.previewUrl,
    peer: capturedPeer,
  };
  addMessage(pendingMsg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  var willCompress = pv.blob.size > MAX_VIDEO_BYTES && canCaptureVideoStream();
  setUploadStatus(tempId, willCompress ? 'compress' : 'uploading', null, pv.blob.size);

  try {
    var uploadBlob = await prepareVideoForUpload(pv.blob, function(stage, size) {
      setUploadStatus(tempId, stage, null, size != null ? size : pv.blob.size);
    });
    setUploadStatus(tempId, 'uploading', 0, uploadBlob.size);
    var publicUrl = await uploadVideoToR2(uploadBlob, function(p) {
      setUploadStatus(tempId, 'uploading', Math.round(p * 100), uploadBlob.size);
    });
    setUploadStatus(tempId, 'sending');

    if (!socket || !socket.connected) {
      markPendingFailed(tempId, 'Disconnected');
      return;
    }
    var payload = { url: publicUrl, clientId: tempId };
    if (caption) payload.caption = caption;
    if (replyToId) payload.replyToId = replyToId;
    if (capturedPeer) payload.peer = capturedPeer;
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

msgInput.addEventListener('input', function() {
  if (msgInput.value.length === 0) {
    sendTypingStop();
  } else {
    sendTypingStart();
  }
});
msgInput.addEventListener('blur', function() { sendTypingStop(); });

chatForm.addEventListener('submit', function(e) {
  e.preventDefault();
  if (!socket) return;
  sendTypingStop();
  var text = msgInput.value.trim();
  var replyToId = replyTarget ? replyTarget.id : null;
  var replyToSnap = replyTarget ? Object.assign({}, replyTarget) : null;
  if (pendingVideo) {
    var pv = pendingVideo;
    pendingVideo = null;
    queueVideoUpload(pv, text, replyToId, replyToSnap);
    clearPreview();
    clearReply();
    msgInput.value = '';
    return;
  }
  if (pendingImage) {
    queueMessage('image', { dataUrl: pendingImage, caption: text, replyToId: replyToId, replyTo: replyToSnap });
    clearPreview();
    clearReply();
    msgInput.value = '';
    return;
  }
  if (!text) return;
  queueMessage('message', { text: text, replyToId: replyToId, replyTo: replyToSnap });
  msgInput.value = '';
  clearReply();
});

fileInput.addEventListener('change', function() {
  var file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (file.type.startsWith('video/')) {
    var ABS_MAX_VIDEO_BYTES = 500 * 1024 * 1024;
    if (file.size > ABS_MAX_VIDEO_BYTES) {
      alert('Maximum video size is 500 MB');
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
    camVideo.classList.toggle('mirrored', camFacing === 'user');
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
  stopMirrorStream();
}

function buildMirroredStream(srcStream) {
  var vw = camVideo.videoWidth;
  var vh = camVideo.videoHeight;
  if (!vw || !vh) return null;
  var canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  var ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') return null;
  ctx.translate(vw, 0);
  ctx.scale(-1, 1);
  function draw() {
    ctx.drawImage(camVideo, 0, 0, vw, vh);
    mirrorRafId = requestAnimationFrame(draw);
  }
  draw();
  var stream = canvas.captureStream(30);
  srcStream.getAudioTracks().forEach(function(t) { stream.addTrack(t); });
  mirrorCanvasStream = stream;
  return stream;
}

function stopMirrorStream() {
  if (mirrorRafId) { cancelAnimationFrame(mirrorRafId); mirrorRafId = null; }
  if (mirrorCanvasStream) {
    mirrorCanvasStream.getVideoTracks().forEach(function(t) { t.stop(); });
    mirrorCanvasStream = null;
  }
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
      camVideo.classList.toggle('mirrored', camFacing === 'user');
    } catch (err) {
      camError.textContent = 'Cannot access camera/mic: ' + (err.message || err.name);
      return;
    }
  }
  var recordStream = camStream;
  if (camFacing === 'user') {
    var mirrored = buildMirroredStream(camStream);
    if (mirrored) recordStream = mirrored;
  }
  var mime = pickVideoMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(recordStream, { mimeType: mime, videoBitsPerSecond: 600000 })
      : new MediaRecorder(recordStream, { videoBitsPerSecond: 600000 });
  } catch (err) {
    stopMirrorStream();
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
  if (!token || !currentPeer) return;
  galleryLoading = true;
  var loadingEl = document.getElementById('gallery-loading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  galleryEmpty.classList.add('hidden');
  try {
    var url = '/gallery?limit=' + GALLERY_PAGE_SIZE + '&page=' + page + '&peer=' + encodeURIComponent(currentPeer);
    var res = await fetch(url, {
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
    var replyToSnap = replyTarget ? Object.assign({}, replyTarget) : null;
    queueMessage('audio', { dataUrl: dataUrl, replyToId: replyToId, replyTo: replyToSnap });
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
  hideMessagesLoading();
  chatView.classList.add('hidden');
  panicBtn.classList.add('hidden');
  loginView.classList.remove('hidden');
  if (presenceTimerId) { clearInterval(presenceTimerId); presenceTimerId = null; }
  sendTypingStop();
  Object.keys(typingExpireTimers).forEach((k) => { clearTimeout(typingExpireTimers[k]); delete typingExpireTimers[k]; });
  Object.keys(typingState).forEach((k) => delete typingState[k]);
  presenceEl.classList.add('hidden');
  presenceEl.classList.remove('online');
  presenceEl.textContent = '';
  typingIndicatorEl.classList.add('hidden');
  typingNameEl.textContent = '';
  peerSwitcherEl.classList.add('hidden');
  closePeerMenu();
  currentPeer = null;
  availablePeers = [];
  Object.keys(unreadByPeer).forEach((k) => delete unreadByPeer[k]);
  Object.keys(readStateMap).forEach((k) => delete readStateMap[k]);
});

panicBtn.addEventListener('click', function() {
  try { if (socket) socket.disconnect(); } catch (_) {}
  try { localStorage.clear(); } catch (_) {}
  try { sessionStorage.clear(); } catch (_) {}
  try { window.close(); } catch (_) {}
  try {
    location.replace('https://www.google.com');
  } catch (_) {
    location.href = 'https://www.google.com';
  }
});

var savedToken = localStorage.getItem('token');
var savedUser = localStorage.getItem('username');
if (savedToken && savedUser) {
  startChat(savedToken, savedUser);
}