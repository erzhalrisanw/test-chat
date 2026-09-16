const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg');
const meNameEl = document.getElementById('me-name');
const logoutBtn = document.getElementById('logout');
const notifBtn = document.getElementById('notif-toggle');
const presenceBtn = document.getElementById('presence-toggle');
const themeToggleBtn = document.getElementById('theme-toggle');
const panicBtn = document.getElementById('panic-btn');
const fileInput = document.getElementById('file-input');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('preview-img');
const previewVideo = document.getElementById('preview-video');
const previewCancel = document.getElementById('preview-cancel');
const previewViewOnceBtn = document.getElementById('preview-view-once');
const previewEditBtn = document.getElementById('preview-edit');
const recViewOnceBtn = document.getElementById('rec-view-once');

let pendingImage = null;
let pendingVideo = null;
let pendingViewOnce = false;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 15000;
let pendingQueue = [];
let tempIdCounter = 0;

const OUTBOX_DB_NAME = 'chat-outbox';
const OUTBOX_STORE = 'pending';
let outboxDbPromise = null;
function openOutboxDb() {
  if (outboxDbPromise) return outboxDbPromise;
  outboxDbPromise = new Promise(function(resolve, reject) {
    try {
      var req = indexedDB.open(OUTBOX_DB_NAME, 1);
      req.onupgradeneeded = function() {
        var db = req.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    } catch (err) { reject(err); }
  });
  outboxDbPromise.catch(function() { outboxDbPromise = null; });
  return outboxDbPromise;
}
function newOutboxId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function outboxAdd(record) {
  return openOutboxDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(OUTBOX_STORE, 'readwrite');
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { resolve(); };
      try { tx.objectStore(OUTBOX_STORE).put(record); } catch (_) { resolve(); }
    });
  }).catch(function() {});
}
function outboxDelete(id) {
  if (!id) return Promise.resolve();
  return openOutboxDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(OUTBOX_STORE, 'readwrite');
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { resolve(); };
      try { tx.objectStore(OUTBOX_STORE).delete(id); } catch (_) { resolve(); }
    });
  }).catch(function() {});
}
function outboxGet(id) {
  if (!id) return Promise.resolve(null);
  return openOutboxDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(OUTBOX_STORE, 'readonly');
      var req = tx.objectStore(OUTBOX_STORE).get(id);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { resolve(null); };
    });
  }).catch(function() { return null; });
}
function outboxUpdate(id, patch) {
  if (!id) return Promise.resolve();
  return outboxGet(id).then(function(rec) {
    if (!rec) return;
    return outboxAdd(Object.assign({}, rec, patch, { id: id }));
  });
}
function outboxListForPeer(user, peer) {
  return openOutboxDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(OUTBOX_STORE, 'readonly');
      var req = tx.objectStore(OUTBOX_STORE).getAll();
      req.onsuccess = function() {
        var all = req.result || [];
        resolve(all.filter(function(r) { return r.user === user && r.peer === peer; }));
      };
      req.onerror = function() { resolve([]); };
    });
  }).catch(function() { return []; });
}
function restoreOutboxForCurrentPeer() {
  var peer = currentPeer;
  if (!peer || !me) return;
  outboxListForPeer(me, peer).then(function(records) {
    if (peer !== currentPeer) return;
    records.sort(function(a, b) {
      return new Date(a.time).getTime() - new Date(b.time).getTime();
    });
    records.forEach(function(rec) {
      tempIdCounter++;
      var tempId = tempIdCounter;
      var textForBubble = rec.kind === 'text' ? (rec.text || '') : (rec.caption || '');
      var msg = {
        text: textForBubble,
        replyToId: rec.replyToId,
        replyTo: rec.replyTo,
        _pending: true,
        _tempId: tempId,
        _outboxId: rec.id,
        _failed: !!rec.failed,
        _errorMsg: rec.errorMsg || '',
        id: null,
        username: me,
        time: rec.time,
        peer: peer,
      };
      if (rec.kind === 'image') msg.image = rec.dataUrl;
      else if (rec.kind === 'audio') msg.audio = rec.dataUrl;
      else if (rec.kind === 'sticker') msg.sticker = rec.stickerUrl;
      else if (rec.kind === 'video' && rec.blob) {
        try { msg.video = URL.createObjectURL(rec.blob); } catch (_) {}
      }
      addMessage(msg);
      if (rec.failed) {
        markPendingFailed(tempId, rec.errorMsg || 'Belum terkirim', { skipOutbox: true });
      }
    });
    if (records.length) messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}
function cancelPendingBubble(div) {
  if (!div) return;
  var outboxId = div.dataset.outboxId;
  if (outboxId) outboxDelete(outboxId);
  var vid = div.querySelector('video.chat-vid');
  if (vid && vid.src && vid.src.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(vid.src); } catch (_) {}
  }
  if (div.parentNode) div.parentNode.removeChild(div);
}
function resendPendingBubble(div) {
  if (!div) return;
  var outboxId = div.dataset.outboxId;
  if (!outboxId) return;
  outboxGet(outboxId).then(function(rec) {
    if (!rec) return;
    var vid = div.querySelector('video.chat-vid');
    if (vid && vid.src && vid.src.indexOf('blob:') === 0) {
      try { URL.revokeObjectURL(vid.src); } catch (_) {}
    }
    if (div.parentNode) div.parentNode.removeChild(div);
    outboxUpdate(outboxId, { failed: false, errorMsg: '' });
    if (rec.kind === 'video' && rec.blob) {
      var pv = { blob: rec.blob };
      try { pv.previewUrl = URL.createObjectURL(rec.blob); } catch (_) { pv.previewUrl = ''; }
      queueVideoUpload(pv, rec.caption || '', rec.replyToId || null, rec.replyTo || null, outboxId);
    } else {
      var eventName = rec.kind === 'text' ? 'message' : rec.kind;
      queueMessage(eventName, {
        text: rec.text || '',
        caption: rec.caption || '',
        dataUrl: rec.dataUrl || '',
        name: rec.name || '',
        stickerUrl: rec.stickerUrl || '',
        replyToId: rec.replyToId || null,
        replyTo: rec.replyTo || null,
        autoSayang: !!rec.autoSayang,
      }, outboxId);
    }
  });
}

const VIEW_ONCE_MARKER = '\u2063\u200B\u2063\u200B';
function hasViewOnceMarker(s) {
  return typeof s === 'string' && s.indexOf(VIEW_ONCE_MARKER) !== -1;
}
function stripViewOnceMarker(s) {
  if (typeof s !== 'string') return s;
  return s.split(VIEW_ONCE_MARKER).join('');
}

const TRUTH_DARE_MARKER = '\u2063\u200C\u2063\u200C';
const TRUTH_STREAK_LIMIT = 4;
function parseTruthDarePayload(text) {
  if (typeof text !== 'string' || text.indexOf(TRUTH_DARE_MARKER) !== 0) return null;
  try { return JSON.parse(text.slice(TRUTH_DARE_MARKER.length)); } catch (_) { return null; }
}
function truthStreakKey(peer) { return 'td_truth_streak_' + (peer || ''); }
function getTruthStreak(peer) {
  if (!peer) return 0;
  const v = parseInt(localStorage.getItem(truthStreakKey(peer)) || '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function setTruthStreak(peer, n) {
  if (!peer) return;
  try { localStorage.setItem(truthStreakKey(peer), String(Math.max(0, n | 0))); } catch (_) {}
}
function isViewOnceOpened(id) {
  if (!id) return false;
  try { return localStorage.getItem('viewOnceOpened:' + id) === '1'; } catch (_) { return false; }
}
function markViewOnceOpened(id) {
  if (!id) return;
  try { localStorage.setItem('viewOnceOpened:' + id, '1'); } catch (_) {}
}
function setPendingViewOnce(on) {
  pendingViewOnce = !!on;
  [previewViewOnceBtn, recViewOnceBtn].forEach(function(btn) {
    if (btn) btn.setAttribute('aria-pressed', pendingViewOnce ? 'true' : 'false');
  });
}

let contentProtectionActive = false;
function showScreenshotShield(reason) {
  let shield = document.getElementById('screenshot-shield');
  if (!shield) {
    shield = document.createElement('div');
    shield.id = 'screenshot-shield';
    shield.innerHTML = '<div class="ss-shield-inner"><div class="ss-shield-icon">🔒</div><div class="ss-shield-text">Konten dilindungi</div><div class="ss-shield-sub">Screenshot/rekam layar tidak diizinkan</div></div>';
    document.body.appendChild(shield);
  }
  shield.classList.add('visible');
  if (shield._hideTimer) clearTimeout(shield._hideTimer);
  shield._hideTimer = setTimeout(function() { shield.classList.remove('visible'); }, 1500);
}
function applyContentProtection(username) {
  if (username === 'occupatus') {
    document.body.classList.remove('content-protected');
    return;
  }
  if (contentProtectionActive) return;
  contentProtectionActive = true;
  document.body.classList.add('content-protected');

  document.addEventListener('contextmenu', function(e) {
    if (!contentProtectionActive) return;
    e.preventDefault();
  }, true);
  document.addEventListener('dragstart', function(e) {
    if (!contentProtectionActive) return;
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) e.preventDefault();
  }, true);
  document.addEventListener('keydown', function(e) {
    if (!contentProtectionActive) return;
    const k = e.key;
    if (k === 'PrintScreen' || k === 'F12') {
      showScreenshotShield('key');
      e.preventDefault();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (k === '3' || k === '4' || k === '5' || k === 's' || k === 'S')) {
      showScreenshotShield('shortcut');
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'p' || k === 'P' || k === 's' || k === 'S')) {
      e.preventDefault();
      showScreenshotShield('save');
    }
  }, true);
  document.addEventListener('keyup', function(e) {
    if (!contentProtectionActive) return;
    if (e.key === 'PrintScreen') {
      try { navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.writeText(''); } catch (_) {}
      showScreenshotShield('key');
    }
  }, true);
  document.addEventListener('visibilitychange', function() {
    if (!contentProtectionActive) return;
    if (document.hidden) {
      document.body.classList.add('screen-obscured');
    } else {
      document.body.classList.remove('screen-obscured');
    }
  });
  window.addEventListener('blur', function() {
    if (!contentProtectionActive) return;
    document.body.classList.add('screen-obscured');
  });
  window.addEventListener('focus', function() {
    if (!contentProtectionActive) return;
    document.body.classList.remove('screen-obscured');
  });
}

const replyPreview = document.getElementById('reply-preview');
const replyPreviewUser = document.getElementById('reply-preview-user');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancelBtn = document.getElementById('reply-cancel');
let replyTarget = null;

const galleryBtn = document.getElementById('gallery-btn');
const gameBtn = document.getElementById('game-btn');
const pingBtn = document.getElementById('ping-btn');
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
    if (typeof updatePetState === 'function') updatePetState();
  }
  if (typingStopTimerId) clearTimeout(typingStopTimerId);
  typingStopTimerId = setTimeout(() => sendTypingStop(), TYPING_IDLE_MS);
}

function sendTypingStop() {
  if (typingStopTimerId) { clearTimeout(typingStopTimerId); typingStopTimerId = null; }
  if (!typingSending) return;
  typingSending = false;
  if (socket && currentPeer) socket.emit('typing', { typing: false, peer: currentPeer });
  if (typeof updatePetState === 'function') updatePetState();
}

function formatLastSeen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60 * 60 * 1000) {
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    return mins <= 0 ? 'Baru saja' : mins + ' menit lalu';
  }
  const time = then.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
  const key = (d) => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  if (key(then) === key(now)) return time;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (key(then) === key(yest)) return 'Kemarin ' + time;
  return then.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

const avatarState = {};
const partnerAvatarEl = document.getElementById('partner-avatar');

function renderPartnerAvatar() {
  if (!partnerAvatarEl) return;
  const partner = getPartner();
  if (!partner) {
    partnerAvatarEl.textContent = '';
    partnerAvatarEl.classList.add('hidden');
    partnerAvatarEl.classList.remove('is-placeholder');
    return;
  }
  const val = avatarState[partner];
  partnerAvatarEl.textContent = val || '👤';
  partnerAvatarEl.classList.remove('hidden');
  partnerAvatarEl.classList.toggle('is-placeholder', !val);
}

function renderMeAvatar() {
  if (!meNameEl || !me) return;
  const hasOwn = !!avatarState[me];
  meNameEl.classList.toggle('needs-avatar', !hasOwn);
  meNameEl.title = hasOwn ? 'Ganti avatar' : 'Pilih avatar kamu';
}

const presenceTextEl = document.getElementById('presence-text');

function renderPresence() {
  renderPartnerAvatar();
  const partner = getPartner();
  if (!partner) {
    presenceEl.classList.add('hidden');
    if (window.chatCall) window.chatCall.setCallButtonEnabled(false);
    return;
  }
  const info = presenceState[partner] || {};
  presenceEl.classList.remove('hidden');
  let text;
  if (info.online) text = partner + ' • Online';
  else {
    const last = formatLastSeen(info.lastSeen);
    text = last ? partner + ' • ' + last : partner;
  }
  presenceEl.classList.toggle('online', !!info.online);
  if (presenceTextEl) presenceTextEl.textContent = text;
  if (window.chatCall) window.chatCall.setCallButtonEnabled(!!info.online);
}

const typingBubbleEl = typingIndicatorEl.querySelector('.typing-bubble');
const typingPetEl = document.getElementById('typing-pet');

const PETS = [
  { id: 'cat', label: 'Kucing', emoji: '🐱' },
  { id: 'tiger', label: 'Harimau', emoji: '🐯' },
  { id: 'dog', label: 'Anjing', emoji: '🐶' },
  { id: 'fox', label: 'Rubah', emoji: '🦊' },
  { id: 'panda', label: 'Panda', emoji: '🐼' },
  { id: 'lion', label: 'Singa', emoji: '🦁' },
  { id: 'bear', label: 'Beruang', emoji: '🐻' },
  { id: 'monkey', label: 'Monyet', emoji: '🐵' },
  { id: 'frog', label: 'Kodok', emoji: '🐸' },
  { id: 'pig', label: 'Babi', emoji: '🐷' },
  { id: 'rabbit', label: 'Kelinci', emoji: '🐰' },
  { id: 'penguin', label: 'Penguin', emoji: '🐧' },
  { id: 'unicorn', label: 'Unicorn', emoji: '🦄' },
  { id: 'dragon', label: 'Naga', emoji: '🐲' },
  { id: 'octopus', label: 'Gurita', emoji: '🐙' },
  { id: 'ghost', label: 'Hantu', emoji: '👻' },
  { id: 'robot', label: 'Robot', emoji: '🤖' },
  { id: 'doraemon', label: 'Doraemon', img: '/doraemon.svg' },
];
const PET_ANIMS = [
  { id: 'breathe', label: 'Nafas/Tidur', kf: 'pet-idle-breathe', dur: '3.2s', timing: 'ease-in-out' },
  { id: 'shake', label: 'Goyang', kf: 'pet-shake', dur: '.4s', timing: 'ease-in-out' },
  { id: 'jump', label: 'Melonjak', kf: 'pet-jump', dur: '.9s', timing: 'ease-in-out' },
  { id: 'roll', label: 'Koprol', kf: 'pet-roll', dur: '4s', timing: 'linear' },
];
const PET_DEFAULT_ANIMS = { active: 'shake' };
const petToggleBtn = document.getElementById('pet-toggle');
const petMenuEl = document.getElementById('pet-menu');
let petPrefs = null;

function defaultPetIdForUser(username) {
  return username === 'ocean' ? 'doraemon' : 'cat';
}
function loadPetPrefs(username) {
  const fallback = { pet: defaultPetIdForUser(username), ...PET_DEFAULT_ANIMS };
  try {
    const raw = localStorage.getItem('petPrefs:' + username);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const pet = PETS.find((p) => p.id === parsed.pet) ? parsed.pet : fallback.pet;
    const pick = (v, def) => (PET_ANIMS.find((a) => a.id === v) ? v : def);
    const activeSrc = parsed.active !== undefined ? parsed.active : parsed.typing;
    return { pet, active: pick(activeSrc, fallback.active) };
  } catch (_) {
    return fallback;
  }
}
function savePetPrefs() {
  if (!me || !petPrefs) return;
  try { localStorage.setItem('petPrefs:' + me, JSON.stringify(petPrefs)); } catch (_) {}
  savePetPrefsToServer(petPrefs);
}

async function savePetPrefsToServer(prefs) {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    await fetch('/user-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pet: prefs.pet, petActiveAnim: prefs.active }),
    });
  } catch (_) {}
}
function applyPetBody(petId) {
  if (!typingPetEl) return;
  const pet = PETS.find((p) => p.id === petId) || PETS[0];
  const body = typingPetEl.querySelector('.pet-body');
  if (!body) return;
  if (pet.img) {
    if (body.tagName === 'IMG' && body.getAttribute('src') === pet.img) return;
    const img = document.createElement('img');
    img.className = 'pet-body';
    img.src = pet.img;
    img.alt = '';
    img.width = 30;
    img.height = 30;
    img.draggable = false;
    body.replaceWith(img);
  } else {
    if (body.tagName === 'SPAN' && body.textContent === pet.emoji) return;
    const span = document.createElement('span');
    span.className = 'pet-body';
    span.textContent = pet.emoji;
    body.replaceWith(span);
  }
  if (petToggleBtn) {
    const iconEl = petToggleBtn.querySelector('.pet-toggle-icon');
    if (iconEl) {
      if (pet.img) iconEl.innerHTML = `<img src="${pet.img}" alt="" />`;
      else iconEl.textContent = pet.emoji;
    }
  }
}
function applyPetAnims(prefs) {
  if (!typingPetEl) return;
  const anim = PET_ANIMS.find((a) => a.id === prefs.active) || PET_ANIMS[0];
  typingPetEl.style.setProperty('--pet-active-anim', anim.kf);
  typingPetEl.style.setProperty('--pet-active-dur', anim.dur);
  typingPetEl.style.setProperty('--pet-active-timing', anim.timing);
}
function applyPetPrefs(prefs) {
  petPrefs = prefs;
  applyPetBody(prefs.pet);
  applyPetAnims(prefs);
}
function applyTypingPetForUser(username) {
  applyPetPrefs(loadPetPrefs(username));
}
let petDraft = null;

function renderPetMenu() {
  if (!petMenuEl || !petDraft) return;
  petMenuEl.innerHTML = '';
  const addTitle = (text) => {
    const t = document.createElement('div');
    t.className = 'pet-menu-section-title';
    t.textContent = text;
    petMenuEl.appendChild(t);
  };
  addTitle('Pet');
  const grid = document.createElement('div');
  grid.className = 'pet-menu-grid';
  PETS.forEach((pet) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pet-menu-pet' + (pet.id === petDraft.pet ? ' active' : '');
    btn.title = pet.label;
    btn.setAttribute('aria-label', pet.label);
    if (pet.img) btn.innerHTML = `<img src="${pet.img}" alt="" />`;
    else btn.textContent = pet.emoji;
    btn.addEventListener('click', () => {
      petDraft.pet = pet.id;
      renderPetMenu();
    });
    grid.appendChild(btn);
  });
  petMenuEl.appendChild(grid);

  const addAnimRow = (title, key) => {
    addTitle(title);
    const row = document.createElement('div');
    row.className = 'pet-menu-anims';
    PET_ANIMS.forEach((anim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pet-menu-anim' + (anim.id === petDraft[key] ? ' active' : '');
      b.textContent = anim.label;
      b.addEventListener('click', () => {
        petDraft[key] = anim.id;
        renderPetMenu();
      });
      row.appendChild(b);
    });
    petMenuEl.appendChild(row);
  };
  addAnimRow('Saat ngetik', 'active');

  const actions = document.createElement('div');
  actions.className = 'pet-menu-actions';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pet-menu-reset';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    const defaults = { pet: defaultPetIdForUser(me), ...PET_DEFAULT_ANIMS };
    petDraft = defaults;
    renderPetMenu();
  });
  actions.appendChild(reset);

  const spacer = document.createElement('span');
  spacer.className = 'pet-menu-actions-spacer';
  actions.appendChild(spacer);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pet-menu-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => closePetMenu());
  actions.appendChild(close);

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'pet-menu-apply';
  apply.textContent = 'Pilih';
  apply.addEventListener('click', () => {
    petPrefs = { ...petDraft };
    applyPetPrefs(petPrefs);
    savePetPrefs();
    closePetMenu();
  });
  actions.appendChild(apply);

  petMenuEl.appendChild(actions);
}
function openPetMenu() {
  document.dispatchEvent(new CustomEvent('header:submenu:open', { detail: 'pet' }));
  petDraft = petPrefs ? { ...petPrefs } : { pet: defaultPetIdForUser(me), ...PET_DEFAULT_ANIMS };
  renderPetMenu();
  if (petMenuEl) petMenuEl.classList.remove('hidden');
  if (petToggleBtn) petToggleBtn.setAttribute('aria-expanded', 'true');
}
function closePetMenu() {
  if (petMenuEl) petMenuEl.classList.add('hidden');
  if (petToggleBtn) petToggleBtn.setAttribute('aria-expanded', 'false');
  petDraft = null;
}
function togglePetMenu() {
  if (!petMenuEl) return;
  if (petMenuEl.classList.contains('hidden')) openPetMenu();
  else closePetMenu();
}
if (petToggleBtn) {
  petToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePetMenu();
  });
}
if (petMenuEl) {
  petMenuEl.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('header:submenu:open', (e) => {
  if (e.detail !== 'pet') closePetMenu();
});
document.addEventListener('header:menu:close', () => closePetMenu());
document.addEventListener('click', (e) => {
  if (!petMenuEl || petMenuEl.classList.contains('hidden')) return;
  if (!petMenuEl.contains(e.target) && e.target !== petToggleBtn && !petToggleBtn.contains(e.target)) closePetMenu();
});

function updatePetState() {
  if (!typingPetEl) return;
  const peerNames = Object.keys(typingState).filter((u) => u !== me);
  let cls = 'pet-idle';
  if (typingSending) cls = 'pet-me-typing';
  else if (peerNames.length) cls = 'pet-peer-typing';
  if (!typingPetEl.classList.contains(cls)) {
    typingPetEl.classList.remove('pet-idle', 'pet-me-typing', 'pet-peer-typing');
    typingPetEl.classList.add(cls);
  }
}

function renderTyping() {
  const names = Object.keys(typingState).filter((u) => u !== me);
  if (!names.length) {
    if (typingBubbleEl) typingBubbleEl.classList.add('hidden');
    typingNameEl.textContent = '';
    updatePetState();
    return;
  }
  typingNameEl.textContent = names.length === 1 ? names[0] : names.join(', ');
  if (typingBubbleEl) typingBubbleEl.classList.remove('hidden');
  updatePetState();
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
    const info = presenceState[peer] || {};
    const name = document.createElement('span');
    name.className = 'peer-menu-name';
    const dot = document.createElement('span');
    dot.className = 'peer-menu-dot' + (info.online ? ' online' : '');
    name.appendChild(dot);
    name.appendChild(document.createTextNode(peer));
    const status = document.createElement('span');
    status.className = 'peer-menu-status';
    status.textContent = info.online ? 'Online' : formatLastSeen(info.lastSeen);
    name.appendChild(status);
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
  if (typeof clearPendingKeywordAnims === 'function') clearPendingKeywordAnims();
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
  if (currentPeer) saveDraft(currentPeer, msgInput.value);
  currentPeer = peer;
  if (isHub()) localStorage.setItem('activePeer', peer);
  unreadByPeer[peer] = 0;
  resetThreadView();
  renderPeerSwitcherButton();
  renderPresence();
  applyReadStateForCurrentPeer();
  applyDraftForCurrentPeer();
  socket.emit('selectPeer', { peer });
  if (typeof window.__tttBannerSync === 'function') window.__tttBannerSync();
  if (typeof window.__snlBannerSync === 'function') window.__snlBannerSync();
  if (typeof closeJournalModal === 'function' && journalModal && !journalModal.classList.contains('hidden')) {
    closeJournalModal();
  }
  if (typeof closePinnedModal === 'function' && pinnedModal && !pinnedModal.classList.contains('hidden')) {
    closePinnedModal();
  }
  if (typeof closeSearchModal === 'function' && searchModal && !searchModal.classList.contains('hidden')) {
    closeSearchModal();
  }
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

const headerMenuBtn = document.getElementById('header-menu-btn');
const headerMenu = document.getElementById('header-menu');
function closeHeaderMenu() {
  if (!headerMenu) return;
  headerMenu.classList.add('hidden');
  headerMenuBtn.setAttribute('aria-expanded', 'false');
  document.dispatchEvent(new CustomEvent('header:menu:close'));
}
function toggleHeaderMenu() {
  if (!headerMenu) return;
  const isHidden = headerMenu.classList.toggle('hidden');
  headerMenuBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
  if (isHidden) document.dispatchEvent(new CustomEvent('header:menu:close'));
}
if (headerMenuBtn && headerMenu) {
  headerMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHeaderMenu();
  });
  document.addEventListener('click', (e) => {
    if (headerMenu.classList.contains('hidden')) return;
    if (!headerMenu.contains(e.target) && e.target !== headerMenuBtn) closeHeaderMenu();
  });
  headerMenu.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('.header-menu-sub')) return;
    if (target.closest('#theme-menu, #weather-menu, #pet-menu')) return;
    closeHeaderMenu();
  });
}

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
  closeStickerPanel();
  toggleEmojiPanel();
});
document.addEventListener('click', (e) => {
  if (emojiPanel.classList.contains('hidden')) return;
  if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) closeEmojiPanel();
});

const stickerBtn = document.getElementById('sticker-btn');
const stickerPanel = document.getElementById('sticker-panel');
let stickersLoaded = false;
let stickerManifest = [];
function packOf(file) {
  const i = file.indexOf('/');
  return i > 0 ? file.slice(0, i) : 'default';
}
function packLabel(pack) {
  if (pack === 'default') return 'Basic';
  return pack.charAt(0).toUpperCase() + pack.slice(1);
}
function buildStickerButton(s) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = s.label || s.name;
  b.setAttribute('aria-label', s.label || s.name);
  const isVideo = /\.webm$/i.test(s.file);
  const media = document.createElement(isVideo ? 'video' : 'img');
  media.src = '/stickers/' + s.file;
  if (isVideo) {
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
  } else {
    media.alt = s.label || s.name;
    media.loading = 'lazy';
    if (/\.(png|webp|jpe?g|gif)$/i.test(s.file)) media.classList.add('sticker-photo');
  }
  b.appendChild(media);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    sendSticker(s.name);
    closeStickerPanel();
  });
  return b;
}
async function loadStickers() {
  if (stickersLoaded) return;
  try {
    const resp = await fetch('/stickers/manifest', { cache: 'no-store', headers: authHeader() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    stickerManifest = Array.isArray(data.stickers) ? data.stickers : [];

    const groups = new Map();
    stickerManifest.forEach((s) => {
      const pack = packOf(s.file);
      if (!groups.has(pack)) groups.set(pack, []);
      groups.get(pack).push(s);
    });

    stickerPanel.innerHTML = '';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'sticker-tabs';
    const gridEl = document.createElement('div');
    gridEl.className = 'sticker-grid';
    stickerPanel.appendChild(tabsEl);
    stickerPanel.appendChild(gridEl);

    const packNames = [...groups.keys()];
    const tabButtons = new Map();
    const renderPack = (pack) => {
      tabButtons.forEach((btn, p) => btn.classList.toggle('active', p === pack));
      gridEl.innerHTML = '';
      (groups.get(pack) || []).forEach((s) => gridEl.appendChild(buildStickerButton(s)));
      try { localStorage.setItem('sticker.activePack', pack); } catch (_) {}
    };

    packNames.forEach((pack) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'sticker-tab';
      t.textContent = packLabel(pack);
      t.addEventListener('click', (e) => { e.stopPropagation(); renderPack(pack); });
      tabsEl.appendChild(t);
      tabButtons.set(pack, t);
    });

    if (packNames.length) {
      let initial = null;
      try { initial = localStorage.getItem('sticker.activePack'); } catch (_) {}
      renderPack(packNames.includes(initial) ? initial : packNames[0]);
    }
    stickersLoaded = true;
  } catch (err) {
    console.error('load stickers failed:', err);
    stickerPanel.textContent = 'Gagal memuat sticker';
  }
}
function closeStickerPanel() {
  stickerPanel.classList.add('hidden');
  stickerBtn.setAttribute('aria-expanded', 'false');
}
function toggleStickerPanel() {
  const isHidden = stickerPanel.classList.toggle('hidden');
  stickerBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
  if (!isHidden) loadStickers();
}
stickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeEmojiPanel();
  toggleStickerPanel();
});
document.addEventListener('click', (e) => {
  if (stickerPanel.classList.contains('hidden')) return;
  if (!stickerPanel.contains(e.target) && e.target !== stickerBtn) closeStickerPanel();
});

function sendSticker(name) {
  if (!name || !socket) return;
  const replyToSnapshot = replyTarget;
  clearReply();
  const manifestEntry = stickerManifest.find((s) => s.name === name);
  const pendingUrl = '/stickers/' + (manifestEntry && manifestEntry.file ? manifestEntry.file : name + '.svg');
  queueMessage('sticker', {
    name: name,
    stickerUrl: pendingUrl,
    replyToId: replyToSnapshot ? replyToSnapshot.id : null,
    replyTo: replyToSnapshot || null,
  });
}

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
const camTorch = document.getElementById('cam-torch');
const camZoom = document.getElementById('cam-zoom');
let camStream = null;
let camFacing = 'user';
let camTorchOn = false;
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
let presenceVisible = true;
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

async function compressImageFile(file, opts) {
  opts = opts || {};
  var maxDim = opts.maxDimension || 1600;
  var quality = opts.quality || 0.85;
  var type = (file && file.type) || '';
  var dataUrl = await new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(new Error('Failed to read image')); };
    reader.readAsDataURL(file);
  });
  if (/^image\/gif/i.test(type)) return dataUrl;
  try {
    var img = await new Promise(function(resolve, reject) {
      var i = new Image();
      i.onload = function() { resolve(i); };
      i.onerror = function() { reject(new Error('Failed to load image')); };
      i.src = dataUrl;
    });
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;
    var scale = Math.min(1, maxDim / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale));
    var th = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    var ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, tw, th);
    var out = canvas.toDataURL('image/jpeg', quality);
    return out.length < dataUrl.length ? out : dataUrl;
  } catch (_) {
    return dataUrl;
  }
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
  if (!canCaptureVideoStream() || !window.MediaRecorder) return file;
  if (typeof onStage === 'function') onStage('compress', file.size);
  try {
    var isLarge = file.size > 50 * 1024 * 1024;
    var isMedium = file.size > 10 * 1024 * 1024;
    var compressed = await compressVideoFile(file, {
      videoBitsPerSecond: isLarge ? 600000 : (isMedium ? 700000 : 900000),
      maxDimension: isLarge ? 480 : (isMedium ? 720 : 960),
    });
    if (compressed.size >= file.size) return file;
    return compressed;
  } catch (err) {
    console.warn('Compression failed, uploading raw:', err && err.message);
    return file;
  }
}

function updateNotifBtn() {
  const icon = notifBtn.querySelector('.header-menu-icon');
  const state = notifBtn.querySelector('.header-menu-state');
  if (icon) icon.textContent = notifEnabled ? '🔔' : '🔕';
  if (state) state.textContent = notifEnabled ? 'On' : 'Off';
  notifBtn.classList.toggle('off', !notifEnabled);
}

function updatePresenceBtn() {
  if (!presenceBtn) return;
  const icon = presenceBtn.querySelector('.header-menu-icon');
  const state = presenceBtn.querySelector('.header-menu-state');
  if (icon) icon.textContent = presenceVisible ? '👁️' : '🙈';
  if (state) state.textContent = presenceVisible ? 'On' : 'Off';
  presenceBtn.classList.toggle('off', !presenceVisible);
  presenceBtn.classList.toggle('hidden', me !== HUB_USER);
}

async function savePresenceVisible(visible) {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    await fetch('/user-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ presenceVisible: visible }),
    });
  } catch (_) {}
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
      if (notifEnabled) {
        if ('Notification' in window && Notification.permission === 'granted') setupPush();
      } else {
        unsubscribePush();
      }
    }
    if (data && typeof data.theme === 'string' && data.theme !== currentTheme()) {
      applyTheme(data.theme);
    }
    if (data && typeof data.presenceVisible === 'boolean') {
      presenceVisible = data.presenceVisible;
      updatePresenceBtn();
    }
    if (data && petPrefs) {
      const serverPet = PETS.find((p) => p.id === data.pet) ? data.pet : null;
      const serverActive = PET_ANIMS.find((a) => a.id === data.petActiveAnim) ? data.petActiveAnim : null;
      let changed = false;
      if (serverPet && serverPet !== petPrefs.pet) { petPrefs.pet = serverPet; changed = true; }
      if (serverActive && serverActive !== petPrefs.active) { petPrefs.active = serverActive; changed = true; }
      if (changed) {
        try { localStorage.setItem('petPrefs:' + me, JSON.stringify(petPrefs)); } catch (_) {}
        applyPetPrefs(petPrefs);
        if (petMenuEl && !petMenuEl.classList.contains('hidden')) renderPetMenu();
      }
    }
  } catch (_) {}
}

async function saveThemeToServer(themeId) {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    await fetch('/user-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ theme: themeId }),
    });
  } catch (_) {}
}

if (presenceBtn) {
  presenceBtn.addEventListener('click', () => {
    if (me !== HUB_USER) return;
    presenceVisible = !presenceVisible;
    updatePresenceBtn();
    savePresenceVisible(presenceVisible);
  });
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

function setupTicTacToeBanner() {
  if (!socket) return;
  const banner = document.getElementById('ttt-incoming');
  const fromEl = document.getElementById('ttt-incoming-from');
  const acceptBtn = document.getElementById('ttt-incoming-accept');
  const declineBtn = document.getElementById('ttt-incoming-decline');
  if (!banner || !fromEl || !acceptBtn || !declineBtn) return;

  let pendingPeer = null;

  function hide() {
    pendingPeer = null;
    banner.classList.add('hidden');
    fromEl.textContent = '';
  }
  function show(inviter, peer) {
    pendingPeer = peer;
    fromEl.textContent = inviter;
    banner.classList.remove('hidden');
  }

  acceptBtn.addEventListener('click', () => {
    if (!pendingPeer) { hide(); return; }
    const peer = pendingPeer;
    hide();
    if (isHub() && peer !== currentPeer) switchPeer(peer);
    socket.emit('tictactoe:accept', { peer }, (resp) => {
      if (resp && resp.error) return;
      if (window.MiniGames && typeof window.MiniGames.open === 'function') {
        window.MiniGames.open('tictactoe');
      }
    });
  });
  declineBtn.addEventListener('click', () => {
    if (!pendingPeer) { hide(); return; }
    const peer = pendingPeer;
    hide();
    socket.emit('tictactoe:decline', { peer }, () => {});
  });

  socket.on('tictactoe:state', (payload) => {
    if (!payload) return;
    const s = payload.session;
    if (!s || s.status !== 'pending') { hide(); return; }
    if (s.opponent !== me) { hide(); return; }
    show(s.inviter, s.peer);
  });

  function syncForCurrent() {
    if (!currentPeer) { hide(); return; }
    socket.emit('tictactoe:sync', { peer: currentPeer }, (resp) => {
      if (!resp || !resp.ok) return;
      const s = resp.session;
      if (s && s.status === 'pending' && s.opponent === me) show(s.inviter, s.peer);
      else hide();
    });
  }
  syncForCurrent();
  window.__tttBannerSync = syncForCurrent;
}

function setupSnakeLadderBanner() {
  if (!socket) return;
  const banner = document.getElementById('snl-incoming');
  const fromEl = document.getElementById('snl-incoming-from');
  const acceptBtn = document.getElementById('snl-incoming-accept');
  const declineBtn = document.getElementById('snl-incoming-decline');
  if (!banner || !fromEl || !acceptBtn || !declineBtn) return;

  let pendingPeer = null;

  function hide() {
    pendingPeer = null;
    banner.classList.add('hidden');
    fromEl.textContent = '';
  }
  function show(inviter, peer) {
    pendingPeer = peer;
    fromEl.textContent = inviter;
    banner.classList.remove('hidden');
  }

  acceptBtn.addEventListener('click', () => {
    if (!pendingPeer) { hide(); return; }
    const peer = pendingPeer;
    hide();
    if (isHub() && peer !== currentPeer) switchPeer(peer);
    socket.emit('snakeladder:accept', { peer }, (resp) => {
      if (resp && resp.error) return;
      if (window.MiniGames && typeof window.MiniGames.open === 'function') {
        window.MiniGames.open('snakeladder');
      }
    });
  });
  declineBtn.addEventListener('click', () => {
    if (!pendingPeer) { hide(); return; }
    const peer = pendingPeer;
    hide();
    socket.emit('snakeladder:decline', { peer }, () => {});
  });

  socket.on('snakeladder:state', (payload) => {
    if (!payload) return;
    const s = payload.session;
    if (!s || s.status !== 'pending') { hide(); return; }
    if (s.opponent !== me) { hide(); return; }
    show(s.inviter, s.peer);
  });

  function syncForCurrent() {
    if (!currentPeer) { hide(); return; }
    socket.emit('snakeladder:sync', { peer: currentPeer }, (resp) => {
      if (!resp || !resp.ok) return;
      const s = resp.session;
      if (s && s.status === 'pending' && s.opponent === me) show(s.inviter, s.peer);
      else hide();
    });
  }
  syncForCurrent();
  window.__snlBannerSync = syncForCurrent;
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

const SHOWER_EMOJIS = ['❤️', '💕', '💖', '💗', '💘', '💝', '🥰'];
function spawnHeartShower({ intensity = 22, local = false } = {}) {
  const container = document.createElement('div');
  container.className = 'heart-shower' + (local ? ' local' : '');
  for (let i = 0; i < intensity; i++) {
    const h = document.createElement('span');
    h.className = 'shower-heart';
    h.textContent = SHOWER_EMOJIS[Math.floor(Math.random() * SHOWER_EMOJIS.length)];
    h.style.left = Math.random() * 100 + 'vw';
    h.style.fontSize = (20 + Math.random() * 26) + 'px';
    h.style.animationDelay = (Math.random() * 0.7) + 's';
    h.style.animationDuration = (2.4 + Math.random() * 1.8) + 's';
    container.appendChild(h);
  }
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 4800);
}

let pingCooldownUntil = 0;
if (pingBtn) {
  pingBtn.addEventListener('click', () => {
    const now = Date.now();
    if (now < pingCooldownUntil) return;
    if (!socket || !socket.connected) return;
    const peer = getPartner();
    if (!peer) return;
    socket.emit('ping:thinking', { peer });
    pingCooldownUntil = now + 3500;
    pingBtn.classList.add('cooling', 'pulse');
    setTimeout(() => pingBtn.classList.remove('pulse'), 500);
    setTimeout(() => pingBtn.classList.remove('cooling'), 3500);
    spawnHeartShower({ intensity: 8, local: true });
    if ('vibrate' in navigator) { try { navigator.vibrate(40); } catch (_) {} }
  });
}

const REACTION_EMOJIS = ['❤️', '🥰', '😘', '🤗', '😊', '😂', '😮', '😢', '🙏', '👍', '👎', '🔥', '🎉'];
const reactionsById = {};
const pinnedById = {};
let openReactionPickerEl = null;

function isPinned(id) { return !!pinnedById[id]; }

function renderPinnedBadgeFor(id, msgEl) {
  if (!id) return;
  const el = msgEl || messagesEl.querySelector('.msg[data-id="' + id + '"]');
  if (!el) return;
  let badge = el.querySelector('.msg-pin-badge');
  if (isPinned(id)) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'msg-pin-badge';
      badge.setAttribute('aria-label', 'Pinned');
      badge.textContent = '📌';
      el.appendChild(badge);
    }
    badge.classList.remove('hidden');
  } else if (badge) {
    badge.remove();
  }
}

function setPinnedState(id, pinned) {
  if (!id) return;
  if (pinned) pinnedById[id] = true;
  else delete pinnedById[id];
  renderPinnedBadgeFor(id);
}

function togglePin(id) {
  if (!socket || !id) return;
  socket.emit('pin:toggle', { id });
}

function closeReactionPicker() {
  if (!openReactionPickerEl) return;
  openReactionPickerEl.remove();
  openReactionPickerEl = null;
}

function openReactionPicker(msgEl, id) {
  closeReactionPicker();
  closeOpenMsgMenu();
  const bar = document.createElement('div');
  bar.className = 'msg-reaction-picker';
  bar.setAttribute('role', 'menu');
  const mine = (reactionsById[id] || []).filter((r) => r.username === me).map((r) => r.emoji);
  REACTION_EMOJIS.forEach((emo) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msg-reaction-pick' + (mine.includes(emo) ? ' selected' : '');
    b.textContent = emo;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReaction(id, emo);
      closeReactionPicker();
    });
    bar.appendChild(b);
  });
  msgEl.appendChild(bar);
  openReactionPickerEl = bar;
  if ('vibrate' in navigator) { try { navigator.vibrate(20); } catch (_) {} }
}

function toggleReaction(id, emoji) {
  if (!socket || !id || !emoji) return;
  socket.emit('reaction:toggle', { id, emoji });
}

function renderReactionsFor(id, containerOverride) {
  if (!id) return;
  let container = containerOverride;
  if (!container) {
    const el = messagesEl.querySelector(`.msg[data-id="${id}"]`);
    if (!el) return;
    container = el.querySelector('.msg-reactions');
  }
  if (!container) return;
  const list = reactionsById[id] || [];
  const order = [];
  const groups = {};
  for (const r of list) {
    if (!groups[r.emoji]) { groups[r.emoji] = { count: 0, mine: false }; order.push(r.emoji); }
    groups[r.emoji].count++;
    if (r.username === me) groups[r.emoji].mine = true;
  }
  container.innerHTML = '';
  if (!order.length) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  for (const emo of order) {
    const g = groups[emo];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'msg-reaction-chip' + (g.mine ? ' mine' : '');
    chip.title = g.mine ? 'Tap untuk lepas reaksi' : 'Tap untuk reaksi sama';
    const emoSpan = document.createElement('span');
    emoSpan.className = 'reaction-emo';
    emoSpan.textContent = emo;
    const countSpan = document.createElement('span');
    countSpan.className = 'reaction-count';
    countSpan.textContent = String(g.count);
    chip.appendChild(emoSpan);
    chip.appendChild(countSpan);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReaction(id, emo);
    });
    container.appendChild(chip);
  }
}

function triggerReactionBurst(bubble, emoji) {
  if (!bubble || !emoji) return;
  const burst = document.createElement('div');
  burst.className = 'reaction-burst';
  bubble.appendChild(burst);
  for (let i = 0; i < 5; i++) {
    const h = document.createElement('span');
    h.className = 'reaction-float';
    h.textContent = emoji;
    h.style.setProperty('--dx', (Math.random() * 44 - 22) + 'px');
    h.style.left = (30 + Math.random() * 40) + '%';
    h.style.animationDelay = (Math.random() * 0.18) + 's';
    burst.appendChild(h);
  }
  setTimeout(() => burst.remove(), 1900);
}

function attachReactionLongPress(div, id) {
  if (!id) return;
  let timer = null;
  let cancelled = false;
  const start = (e) => {
    if (e.target.closest('.msg-menu-btn, .msg-menu, .msg-reaction-chip, .msg-reaction-picker, .chat-img, .chat-vid, .chat-aud, .reply-quote, a')) return;
    cancelled = false;
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      openReactionPicker(div, id);
    }, 420);
  };
  const cancel = () => {
    cancelled = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  div.addEventListener('pointerdown', start);
  div.addEventListener('pointerup', cancel);
  div.addEventListener('pointerleave', cancel);
  div.addEventListener('pointercancel', cancel);
  div.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) cancel();
  });
  div.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.chat-img, .chat-vid, .chat-aud, a')) return;
    e.preventDefault();
    openReactionPicker(div, id);
  });
}

document.addEventListener('pointerdown', (e) => {
  if (!openReactionPickerEl) return;
  if (!e.target.closest('.msg-reaction-picker')) closeReactionPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReactionPicker();
});

function maybeLoveAnim(msg) {
  if (!msg || typeof msg.text !== 'string') return;
  if (OTW_RE.test(msg.text)) return;
  if (/sayang/i.test(msg.text)) setTimeout(() => triggerHeartBurst(msg), 2000);
}

const CRACK_RE = /gempa|pecah|retak|hancur|meledak/i;
function maybeCrackAnim(msg) {
  if (!msg || typeof msg.text !== 'string') return;
  if (OTW_RE.test(msg.text)) return;
  if (!CRACK_RE.test(msg.text)) return;
  triggerCrackFx();
}

let crackActive = false;
function triggerCrackFx() {
  if (crackActive) return;
  crackActive = true;
  const overlay = document.createElement('div');
  overlay.className = 'crack-fx';
  overlay.innerHTML = buildCrackSvg();
  document.body.appendChild(overlay);
  document.body.classList.add('shaking');
  if ('vibrate' in navigator) { try { navigator.vibrate([80, 40, 80, 40, 140]); } catch (_) {} }
  playBeep();
  setTimeout(() => document.body.classList.remove('shaking'), 700);
  setTimeout(() => {
    overlay.classList.add('fading');
    setTimeout(() => { overlay.remove(); crackActive = false; }, 600);
  }, 1500);
}

function buildCrackSvg() {
  const cx = 20 + Math.random() * 60;
  const cy = 20 + Math.random() * 60;
  const spokes = 7 + Math.floor(Math.random() * 3);
  const parts = [];
  for (let i = 0; i < spokes; i++) {
    const angle = (Math.PI * 2 * i) / spokes + (Math.random() - 0.5) * 0.5;
    const len = 60 + Math.random() * 50;
    const x2 = cx + Math.cos(angle) * len;
    const y2 = cy + Math.sin(angle) * len;
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" />`);
    const branches = 1 + Math.floor(Math.random() * 2);
    for (let b = 0; b < branches; b++) {
      const t = 0.35 + Math.random() * 0.5;
      const mx = cx + Math.cos(angle) * len * t;
      const my = cy + Math.sin(angle) * len * t;
      const bAngle = angle + (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.7);
      const bLen = 8 + Math.random() * 22;
      const bx = mx + Math.cos(bAngle) * bLen;
      const by = my + Math.sin(bAngle) * bLen;
      parts.push(`<line x1="${mx}" y1="${my}" x2="${bx}" y2="${by}" stroke-width="0.5" />`);
    }
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

const OTW_RE = /\botw\b/i;
function maybeOtwAnim(msg) {
  if (!msg || typeof msg.text !== 'string') return;
  if (!OTW_RE.test(msg.text)) return;
  triggerPlaneFly();
}

const LUV_RE = /\b(?:luv|love|lup|luph|lof)\s*(?:u|you|yu|yuh)\b/i;

let luvActive = false;
function triggerLuvArrow() {
  if (luvActive) return;
  luvActive = true;
  const overlay = document.createElement('div');
  overlay.className = 'luv-arrow-fx';
  overlay.innerHTML =
    '<div class="luv-heart-big">❤️</div>' +
    '<svg class="luv-arrow-shape" viewBox="0 0 220 40" preserveAspectRatio="none">' +
      '<line x1="30" y1="20" x2="180" y2="20" stroke="#2b1a0d" stroke-width="5" stroke-linecap="round"/>' +
      '<polygon points="200,20 175,7 175,33" fill="#2b1a0d"/>' +
      '<polygon points="30,20 8,8 16,20 8,32" fill="#c0392b"/>' +
      '<polygon points="42,20 22,10 28,20 22,30" fill="#e74c3c"/>' +
    '</svg>';
  document.body.appendChild(overlay);
  playBeep();
  setTimeout(() => {
    document.body.classList.add('shaking');
    if ('vibrate' in navigator) { try { navigator.vibrate([40, 30, 90]); } catch (_) {} }
  }, 850);
  setTimeout(() => document.body.classList.remove('shaking'), 1250);
  setTimeout(() => {
    overlay.classList.add('fading');
    setTimeout(() => { overlay.remove(); luvActive = false; }, 500);
  }, 2400);
}

const pendingKeywordAnims = {};

function detectKeywordAnim(text) {
  if (typeof text !== 'string') return null;
  if (OTW_RE.test(text)) return 'otw';
  if (LUV_RE.test(text)) return 'luv';
  if (CRACK_RE.test(text)) return 'crack';
  return null;
}

function runKeywordAnim(kind) {
  if (kind === 'otw') triggerPlaneFly();
  else if (kind === 'crack') triggerCrackFx();
  else if (kind === 'luv') triggerLuvArrow();
}

function tryQueueKeywordAnim(msg) {
  if (!msg || !msg.peer) return;
  if (msg.unsent) return;
  const kind = detectKeywordAnim(msg.text);
  if (!kind) return;
  const id = Number(msg.id) || 0;
  if (id <= 0) return;
  const peer = msg.peer;
  const isMine = msg.username === me;
  if (isMine && peer === currentPeer && id <= lastReadByOthers) {
    runKeywordAnim(kind);
    return;
  }
  if (!pendingKeywordAnims[peer]) pendingKeywordAnims[peer] = [];
  pendingKeywordAnims[peer].push({ id, kind, mine: isMine });
}

function flushKeywordAnims(peer, upToId, mineOnly) {
  const list = pendingKeywordAnims[peer];
  if (!list || !list.length) return;
  const remaining = [];
  list.forEach((item) => {
    const matchOwner = mineOnly ? item.mine : !item.mine;
    if (matchOwner && item.id <= upToId) runKeywordAnim(item.kind);
    else remaining.push(item);
  });
  if (remaining.length) pendingKeywordAnims[peer] = remaining;
  else delete pendingKeywordAnims[peer];
}

function clearPendingKeywordAnims() {
  Object.keys(pendingKeywordAnims).forEach((k) => delete pendingKeywordAnims[k]);
}

const OTW_VEHICLES = [
  { emoji: '✈️', kind: 'plane' },
  { emoji: '🏍️', kind: 'motor' },
  { emoji: '🚗', kind: 'car' },
];

let planeActive = false;
function triggerPlaneFly() {
  if (planeActive) return;
  planeActive = true;

  const vehicle = OTW_VEHICLES[Math.floor(Math.random() * OTW_VEHICLES.length)];
  const isPlane = vehicle.kind === 'plane';

  const container = document.createElement('div');
  container.className = 'plane-fly';

  const el = document.createElement('div');
  el.className = 'plane roaming ' + vehicle.kind;
  el.innerHTML = '<span class="plane-emoji">' + vehicle.emoji + '</span>';
  el.style.fontSize = (64 + Math.random() * 28) + 'px';

  const points = [];
  const startLeft = Math.random() < 0.5;

  if (isPlane) {
    const enterX = startLeft ? -12 : 112;
    const exitX = startLeft ? 112 : -12;
    const enterY = 15 + Math.random() * 55;
    const exitY = 15 + Math.random() * 55;
    points.push({ x: enterX, y: enterY });
    const stepCount = 22 + Math.floor(Math.random() * 8);
    const waveAmp = 8 + Math.random() * 10;
    const waveFreq = 1.5 + Math.random() * 1.5;
    const wavePhase = Math.random() * Math.PI * 2;
    for (let i = 1; i < stepCount; i++) {
      const t = i / stepCount;
      const x = enterX + (exitX - enterX) * t;
      const baseY = enterY + (exitY - enterY) * t;
      const y = baseY + Math.sin(wavePhase + t * Math.PI * waveFreq) * waveAmp;
      points.push({ x, y });
    }
    points.push({ x: exitX, y: exitY });
  } else {
    const roadY = 72 + Math.random() * 18;
    const startX = startLeft ? -12 : 112;
    const endX = startLeft ? 112 : -12;
    points.push({ x: startX, y: roadY });
    const stepCount = 10 + Math.floor(Math.random() * 6);
    for (let i = 1; i < stepCount; i++) {
      const t = i / stepCount;
      const x = startX + (endX - startX) * t;
      points.push({ x: x + (Math.random() - 0.5) * 4, y: roadY + (Math.random() - 0.5) * 3 });
    }
    points.push({ x: endX, y: roadY });
    if (startLeft) el.querySelector('.plane-emoji').classList.add('face-right');
  }

  const rots = points.map((_, i) => {
    if (!isPlane) return 0;
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, points.length - 1)];
    return Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI) + 45;
  });

  const host = document.querySelector('.messages-wrap') || document.body;
  const rect = host.getBoundingClientRect();
  const W = rect.width || window.innerWidth;
  const H = rect.height || window.innerHeight;

  const duration = isPlane ? (14 + Math.random() * 6) : (7 + Math.random() * 4);
  const id = 'planePath' + Date.now() + Math.floor(Math.random() * 1000);
  const kf = points.map((p, i) => {
    const t = (i / (points.length - 1)) * 100;
    const px = (p.x / 100) * W;
    const py = (p.y / 100) * H;
    return t.toFixed(2) + '% { transform: translate(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px) rotate(' + rots[i].toFixed(1) + 'deg); }';
  }).join(' ');

  const style = document.createElement('style');
  style.textContent = '@keyframes ' + id + ' { ' + kf + ' } '
    + '.plane.roaming.' + id + ' { animation: ' + id + ' ' + duration.toFixed(2) + 's linear forwards; }';
  el.classList.add(id);
  container.appendChild(style);
  container.appendChild(el);
  host.appendChild(container);

  setTimeout(() => { container.remove(); planeActive = false; }, (duration + 0.5) * 1000);
}

function notify(msg) {
  if (!notifEnabled) return;
  if (msg.username === me) return;
  playBeep();
  if ('vibrate' in navigator) {
    try { navigator.vibrate(200); } catch (_) {}
  }
}

(function setupQuickLogin() {
  const title = document.querySelector('#login-view h1');
  if (!title) return;
  const HOLD_MS = 3000;
  const OCCUPATUS_PASSWORD = (window.__APP_CFG__ && window.__APP_CFG__.occupatusPassword) || '';
  const EXPECTED_PATTERN = [0, 4, 8, 5, 2]; // TODO: ubah pola sesuai selera (indeks 0..8 grid 3x3)
  let holdTimer = null;
  let firing = false;

  const overlay = document.createElement('div');
  overlay.className = 'pattern-overlay hidden';
  overlay.innerHTML =
    '<div class="pattern-card" role="dialog" aria-label="Gambar pola">' +
      '<div class="pattern-title">Gambar pola</div>' +
      '<div class="pattern-grid">' +
        Array.from({ length: 9 }, (_, i) => '<div class="pattern-dot" data-i="' + i + '"></div>').join('') +
      '</div>' +
      '<div class="pattern-hint"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const grid = overlay.querySelector('.pattern-grid');
  const hint = overlay.querySelector('.pattern-hint');
  let drawing = false;
  let path = [];

  function resetPath() {
    path = [];
    overlay.querySelectorAll('.pattern-dot').forEach((d) => d.classList.remove('active'));
  }
  function hideModal() {
    overlay.classList.add('hidden');
    resetPath();
    hint.textContent = '';
    drawing = false;
  }
  function showModal() {
    overlay.classList.remove('hidden');
    resetPath();
    hint.textContent = '';
  }
  function addDot(el) {
    if (!el || !el.classList || !el.classList.contains('pattern-dot')) return;
    const i = Number(el.dataset.i);
    if (path.indexOf(i) !== -1) return;
    path.push(i);
    el.classList.add('active');
  }
  function submitLogin() {
    hideModal();
    const userEl = document.getElementById('username');
    const passEl = document.getElementById('password');
    if (userEl) userEl.value = 'occupatus';
    if (passEl) passEl.value = OCCUPATUS_PASSWORD;
    if (typeof loginForm.requestSubmit === 'function') loginForm.requestSubmit();
    else loginForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  function finishDrawing() {
    if (!drawing) return;
    drawing = false;
    const ok = path.length === EXPECTED_PATTERN.length && path.every((v, idx) => v === EXPECTED_PATTERN[idx]);
    if (ok) {
      submitLogin();
    } else {
      hint.textContent = 'Pola salah';
      grid.classList.add('shake');
      setTimeout(() => grid.classList.remove('shake'), 400);
      setTimeout(() => { resetPath(); }, 500);
    }
  }
  grid.addEventListener('pointerdown', (e) => {
    drawing = true;
    resetPath();
    try { grid.setPointerCapture(e.pointerId); } catch (_) {}
    addDot(document.elementFromPoint(e.clientX, e.clientY));
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    addDot(document.elementFromPoint(e.clientX, e.clientY));
  });
  grid.addEventListener('pointerup', finishDrawing);
  grid.addEventListener('pointercancel', finishDrawing);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideModal(); });

  function startHold(e) {
    if (firing) return;
    if (e.button !== undefined && e.button !== 0) return;
    holdTimer = setTimeout(() => {
      firing = true;
      showModal();
      setTimeout(() => { firing = false; }, 500);
    }, HOLD_MS);
  }
  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  }
  title.addEventListener('pointerdown', startHold);
  title.addEventListener('pointerup', cancelHold);
  title.addEventListener('pointerleave', cancelHold);
  title.addEventListener('pointercancel', cancelHold);
  title.addEventListener('contextmenu', (e) => e.preventDefault());
})();

(function wirePasswordToggle() {
  const btn = document.getElementById('password-toggle');
  const inp = document.getElementById('password');
  if (!btn || !inp) return;
  btn.addEventListener('click', () => {
    const showing = inp.type === 'text';
    inp.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁️' : '🙈';
    btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
    btn.setAttribute('aria-label', showing ? 'Tampilkan password' : 'Sembunyikan password');
    inp.focus();
  });
})();

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

function startChat(token, username) {
  me = username;
  if (meNameEl) meNameEl.textContent = username;
  applyTypingPetForUser(username);
  applyContentProtection(username);
  loginView.classList.add('hidden');
  chatView.classList.remove('hidden');
  panicBtn.classList.remove('hidden');
  applyBirthdayPanic(username);
  loadServerInfo();
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
  applyDraftForCurrentPeer();
  renderPeerSwitcherButton();
  updateNotifBtn();
  updatePresenceBtn();
  updateGalleryBtn();
  updateClearHistoryBtn();
  updateSayangStatsBtn();
  updateJournalBtn();
  updatePinnedBtn();
  updateSearchBtn();
  if (gameBtn) gameBtn.classList.remove('hidden');
  if (pingBtn) pingBtn.classList.remove('hidden');
  renderMeAvatar();
  renderPresence();
  startPresenceTimer();
  loadNotifEnabled();
  if (notifEnabled && 'Notification' in window) {
    if (Notification.permission === 'default') {
      Notification.requestPermission().then((result) => {
        if (result === 'granted') setupPush();
      }).catch(() => {});
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

  if (window.MiniGames && typeof window.MiniGames.init === 'function') {
    window.MiniGames.init({
      socket,
      getPartner,
      getMe: () => me,
    });
  }

  setupTicTacToeBanner();
  setupSnakeLadderBanner();

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
    const myLastRead = (readStateMap[me] && readStateMap[me][currentPeer]) || 0;
    const KEYWORD_SCAN_TAIL = 5;
    const scanFromIdx = Math.max(0, list.length - KEYWORD_SCAN_TAIL);
    list.forEach((m, idx) => {
      addMessage(m);
      if (m.id) lastIncomingId = Math.max(lastIncomingId, m.id);
      if (idx < scanFromIdx) return;
      if (m && m.username !== me && m.id && m.id > myLastRead) {
        tryQueueKeywordAnim(m);
      }
    });
    applyReadStateForCurrentPeer();
    maybeMarkRead();
    restoreOutboxForCurrentPeer();
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
      if (info && Object.prototype.hasOwnProperty.call(info, 'avatar')) {
        avatarState[u] = info.avatar || null;
      }
    });
    renderPresence();
    renderMeAvatar();
  });

  socket.on('avatar:update', ({ username, avatar }) => {
    if (!username) return;
    avatarState[username] = avatar || null;
    if (username === me) renderMeAvatar();
    if (username === getPartner()) renderPartnerAvatar();
    if (avatarModal && !avatarModal.classList.contains('hidden') && username === me) {
      renderAvatarPreview();
      markSelectedPreset();
    }
  });

  socket.on('journal:new', (entry) => {
    if (!entry || !journalModal || journalModal.classList.contains('hidden')) return;
    if (entry.peer !== journalState.peer) return;
    if (journalState.entries.some((e) => e.id === entry.id)) return;
    journalState.entries.unshift(entry);
    renderJournalList();
  });

  socket.on('journal:update', (entry) => {
    if (!entry || !journalModal || journalModal.classList.contains('hidden')) return;
    if (entry.peer !== journalState.peer) return;
    const idx = journalState.entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) return;
    journalState.entries[idx] = Object.assign({}, journalState.entries[idx], entry);
    renderJournalList();
  });

  socket.on('journal:delete', ({ id, peer }) => {
    if (!journalModal || journalModal.classList.contains('hidden')) return;
    if (peer !== journalState.peer) return;
    const idx = journalState.entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    journalState.entries.splice(idx, 1);
    if (journalState.editingId === id) journalState.editingId = null;
    renderJournalList();
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

  socket.on('ping:thinking', (payload) => {
    if (!payload || payload.from === me) return;
    spawnHeartShower();
    playBeep();
    if ('vibrate' in navigator) { try { navigator.vibrate([80, 60, 120]); } catch (_) {} }
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
    flushKeywordAnims(peer, lastReadId, true);
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
    tryQueueKeywordAnim(m);
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

  socket.on('reaction:update', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (payload.peer && payload.peer !== currentPeer) return;
    reactionsById[id] = Array.isArray(payload.reactions) ? payload.reactions : [];
    renderReactionsFor(id);
    if (payload.added && payload.emoji) {
      const el = messagesEl.querySelector(`.msg[data-id="${id}"]`);
      if (el) triggerReactionBurst(el, payload.emoji);
    }
  });

  socket.on('pin:update', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (payload.peer && currentPeer && payload.peer !== currentPeer) return;
    setPinnedState(id, !!payload.pinned);
    if (pinnedState.peer && payload.peer === pinnedState.peer) refreshPinnedList();
  });

  socket.on('unsend', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    const peer = payload.peer;
    if (!Number.isFinite(id) || id <= 0) return;
    if (peer && peer !== currentPeer) return;
    applyUnsendToView(id);
    triggerCrackFx();
  });

  socket.on('resend', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    const peer = payload.peer;
    if (!Number.isFinite(id) || id <= 0) return;
    if (peer && peer !== currentPeer) return;
    applyResendToView(payload.message || { id });
  });

  socket.on('delete-message', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    const peer = payload.peer;
    if (!Number.isFinite(id) || id <= 0) return;
    if (peer && peer !== currentPeer) return;
    applyDeleteToView(id);
  });

  socket.on('clear-history', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const peer = payload.peer;
    if (!peer) return;
    applyClearHistoryToView(peer);
  });

  socket.on('truth-dare:update', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const id = Number(payload.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (payload.peer && payload.peer !== currentPeer) return;
    if (!payload.payload) return;
    const td = payload.payload;
    if (td.state === 'answered' && td.picker === me && td.challenger) {
      if (td.choice === 'truth') {
        setTruthStreak(td.challenger, getTruthStreak(td.challenger) + 1);
      } else if (td.choice === 'dare') {
        setTruthStreak(td.challenger, 0);
      }
      refreshPendingTruthDareCards(td.challenger);
    }
    applyTruthDareUpdate(id, td);
  });

  socket.on('panic:remote', () => {
    runPanic();
  });

  socket.on('peer-server:update', (payload) => {
    if (!payload || typeof payload.username !== 'string') return;
    upsertPeerServerRow(payload);
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
      hideServerInfo();
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
  var td = parseTruthDarePayload(msg && msg.text);
  if (td) {
    if (td.state === 'answered') return '🎲 T/D · ' + (td.choice === 'truth' ? 'Truth' : 'Dare');
    return '🎲 Truth or Dare?';
  }
  var hasMedia = !!(msg.image || msg.hasImage || msg.video || msg.hasVideo || msg.audio || msg.hasAudio);
  if (hasMedia && hasViewOnceMarker(msg.text)) {
    if (msg.image || msg.hasImage) return '🕐 Foto sekali lihat';
    if (msg.video || msg.hasVideo) return '🕐 Video sekali lihat';
    if (msg.audio || msg.hasAudio) return '🕐 Voice note sekali lihat';
  }
  var cleanText = hasMedia ? stripViewOnceMarker(msg.text) : msg.text;
  if (cleanText) return cleanText;
  if (msg.sticker || msg.hasSticker) return '🎨 Sticker';
  if (msg.image || msg.hasImage) return '📷 Photo';
  if (msg.video || msg.hasVideo) return '🎬 Video';
  if (msg.audio || msg.hasAudio) return '🎤 Voice note';
  return '';
}

function renderTruthDareCardHtml(td, viewer) {
  const isChallenger = viewer === td.challenger;
  const cls = ['td-card'];
  if (td.state === 'pending') cls.push('td-pending');
  else cls.push('td-answered', 'td-' + td.choice);
  const challengerAttr = td.challenger ? ' data-td-challenger="' + escapeHtml(td.challenger) + '"' : '';
  let inner = '';
  if (td.state === 'pending') {
    let body;
    if (isChallenger) {
      body = '<div class="td-waiting">Menunggu lawan memilih…</div>';
    } else {
      const streak = getTruthStreak(td.challenger);
      const truthDisabled = streak >= TRUTH_STREAK_LIMIT;
      const truthAttr = truthDisabled ? ' disabled' : '';
      const hint = truthDisabled
        ? '<div class="td-sub td-streak-hint">Sudah ' + streak + '× Truth berturut — pilih Dare dulu.</div>'
        : '';
      body =
        '<div class="td-sub"><b>' + escapeHtml(td.challenger) + '</b> menantangmu. Pilih:</div>' +
        '<div class="td-buttons">' +
          '<button type="button" class="td-btn td-btn-truth" data-td-choice="truth"' + truthAttr + '>✨ Truth</button>' +
          '<button type="button" class="td-btn td-btn-dare" data-td-choice="dare">🔥 Dare</button>' +
        '</div>' + hint;
    }
    inner =
      '<div class="td-header"><span class="td-emoji">🎲</span><span class="td-title">Truth or Dare</span></div>' +
      body;
  } else {
    const label = td.choice === 'truth' ? '✨ Truth' : '🔥 Dare';
    inner =
      '<div class="td-header"><span class="td-emoji">🎲</span><span class="td-title">Truth or Dare</span>' +
        '<span class="td-choice-pill">' + label + '</span></div>' +
      '<div class="td-prompt">' + escapeHtml(td.prompt || '') + '</div>' +
      '<div class="td-foot">dipilih oleh <b>' + escapeHtml(td.picker || '') + '</b></div>';
  }
  return '<div class="' + cls.join(' ') + '"' + challengerAttr + '>' + inner + '</div>';
}

function refreshPendingTruthDareCards(challenger) {
  if (!challenger || !messagesEl) return;
  const selector = '.td-card.td-pending[data-td-challenger="' + challenger.replace(/"/g, '\\"') + '"]';
  const cards = messagesEl.querySelectorAll(selector);
  const streak = getTruthStreak(challenger);
  const disable = streak >= TRUTH_STREAK_LIMIT;
  cards.forEach(function(card) {
    const truthBtn = card.querySelector('.td-btn-truth');
    if (truthBtn) truthBtn.disabled = disable;
    let hint = card.querySelector('.td-streak-hint');
    if (disable) {
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'td-sub td-streak-hint';
        card.appendChild(hint);
      }
      hint.textContent = 'Sudah ' + streak + '× Truth berturut — pilih Dare dulu.';
    } else if (hint) {
      hint.remove();
    }
  });
}

function applyTruthDareUpdate(id, payload) {
  const el = messagesEl.querySelector('.msg[data-id="' + id + '"]');
  if (!el) return;
  const card = el.querySelector('.td-card');
  if (!card) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderTruthDareCardHtml(payload, me);
  const fresh = wrapper.firstChild;
  card.replaceWith(fresh);
  wireTruthDareButtons(el, id);
}

function wireTruthDareButtons(rootEl, id) {
  const btns = rootEl.querySelectorAll('.td-btn[data-td-choice]');
  btns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const choice = btn.getAttribute('data-td-choice');
      if (choice !== 'truth' && choice !== 'dare') return;
      rootEl.querySelectorAll('.td-btn').forEach(function(b) { b.disabled = true; });
      btn.textContent = choice === 'truth' ? 'Meracik pertanyaan…' : 'Meracik tantangan…';
      socket.emit('truth-dare:pick', { id: id, choice: choice }, function(ack) {
        if (ack && ack.error) {
          const sub = rootEl.querySelector('.td-sub');
          if (sub) sub.textContent = 'Gagal: ' + ack.error;
          rootEl.querySelectorAll('.td-btn').forEach(function(b) {
            b.disabled = false;
            b.textContent = b.getAttribute('data-td-choice') === 'truth' ? '✨ Truth' : '🔥 Dare';
          });
        }
      });
    });
  });
}

function buildMessageNodes(msg) {
  const { id, username, text, time, image, sticker, replyTo } = msg;
  const div = document.createElement('div');
  const isPending = msg._pending || false;
  const tempId = msg._tempId || null;
  const isUnsent = !!msg.unsent;
  const hideContent = shouldHideUnsentContent(msg);
  const isStickerOnly = !!sticker && !text && !hideContent && !isUnsent;
  const cls = ['msg', username === me ? 'mine' : 'other'];
  if (isUnsent) cls.push('unsent');
  if (hideContent) cls.push('unsent-hidden');
  if (isStickerOnly) cls.push('has-sticker');
  div.className = cls.join(' ');
  if (id) div.dataset.id = String(id);
  if (tempId) div.dataset.tempId = String(tempId);
  if (msg._outboxId) div.dataset.outboxId = msg._outboxId;
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
  const hasMedia = !!(image || msg.video || msg.audio);
  const isViewOnce = hasMedia && hasViewOnceMarker(text);
  const displayText = isViewOnce ? stripViewOnceMarker(text) : text;
  const tdPayload = hideContent ? null : parseTruthDarePayload(text);
  if (hideContent) {
    body = '<span class="msg-text unsent-placeholder">' + escapeHtml(UNSENT_PLACEHOLDER_TEXT) + '</span>';
  } else if (tdPayload) {
    body = renderTruthDareCardHtml(tdPayload, me);
  } else if (isViewOnce) {
    body = displayText ? '<span class="msg-text">' + renderMsgTextHtml(displayText, msg) + '</span>' : '';
    let voKind = 'foto';
    if (msg.video) voKind = 'video';
    else if (msg.audio) voKind = 'voice note';
    const isMine = username === me;
    const opened = !isMine && id ? isViewOnceOpened(id) : false;
    const openedCls = opened ? ' opened' : '';
    const hint = isMine ? 'Ketuk untuk lihat ulang' : (opened ? 'Sudah dibuka' : 'Ketuk untuk lihat sekali');
    const voBubble =
      '<div class="view-once-bubble' + openedCls + '" role="button" tabindex="0" aria-label="Sekali lihat">' +
        '<span class="vo-icon">🕐</span>' +
        '<span class="vo-label">' +
          '<span class="vo-title">Sekali lihat · ' + escapeHtml(voKind) + '</span>' +
          '<span class="vo-hint">' + escapeHtml(hint) + '</span>' +
        '</span>' +
      '</div>';
    body = body ? body + voBubble : voBubble;
  } else {
    body = displayText ? '<span class="msg-text">' + renderMsgTextHtml(displayText, msg) + '</span>' : '';
    if (sticker && /^\/stickers\/[a-z0-9_./-]+\.(svg|png|webp|jpe?g|gif|webm)$/i.test(sticker)) {
      const isVideoSticker = /\.webm$/i.test(sticker);
      const isPhotoSticker = /\.(png|webp|jpe?g|gif)$/i.test(sticker);
      const stickerCls = 'chat-sticker' + (isPhotoSticker ? ' chat-sticker-photo' : '');
      const st = isVideoSticker
        ? '<video class="' + stickerCls + '" src="' + sticker + '" autoplay loop muted playsinline draggable="false"></video>'
        : '<img class="' + stickerCls + '" src="' + sticker + '" alt="sticker" draggable="false" />';
      body = body ? body + st : st;
    }
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
  const voEl = div.querySelector('.view-once-bubble');
  if (voEl && isViewOnce) {
    const isMine = username === me;
    voEl.addEventListener('click', function() {
      if (!isMine && voEl.classList.contains('opened')) return;
      const targetId = Number(div.dataset.id);
      if (!isMine) {
        if (targetId) markViewOnceOpened(targetId);
        const hintEl = voEl.querySelector('.vo-hint');
        if (hintEl) hintEl.textContent = 'Sudah dibuka';
        voEl.classList.add('opened');
      }
      openViewOncePreview(msg, false);
    });
  }
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
  if (tdPayload && tdPayload.state === 'pending' && id) {
    wireTruthDareButtons(div, id);
  }
  attachMsgMenu(div, { id, username, isUnsent, hideContent, isPending });
  const reactionsContainer = document.createElement('div');
  reactionsContainer.className = 'msg-reactions hidden';
  div.appendChild(reactionsContainer);
  if (id) {
    if (Array.isArray(msg.reactions)) reactionsById[id] = msg.reactions.slice();
    renderReactionsFor(id, reactionsContainer);
    if (!isUnsent && !hideContent) attachReactionLongPress(div, id);
    if (msg.pinned) pinnedById[id] = true;
    else if (msg.pinned === false) delete pinnedById[id];
    renderPinnedBadgeFor(id, div);
  }
  return [div];
}

let copyToastTimer = null;
function showCopyToast(msg) {
  let el = document.getElementById('copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'copy-toast';
    el.className = 'copy-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { el.classList.remove('visible'); }, 1400);
}
function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return;
  const done = () => showCopyToast('Disalin');
  const fail = () => showCopyToast('Gagal menyalin');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(() => {
      if (fallbackCopy(value)) done(); else fail();
    });
    return;
  }
  if (fallbackCopy(value)) done(); else fail();
}
function fallbackCopy(value) {
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

function attachMsgMenu(div, opts) {
  if (div.querySelector('.msg-menu-btn')) return;
  const { id, username, isUnsent, hideContent, isPending } = opts;
  const canReply = id && !hideContent && !isUnsent;
  const canUnsend = id && username === me && !isUnsent;
  const canResend = id && username === me && isUnsent;
  const canForward = id && isHub() && !hideContent && !isUnsent;
  const textEl = div.querySelector('.msg-text');
  const canCopy = !!(textEl && !hideContent && !isUnsent && textEl.textContent.trim());
  const canCancel = !!(isPending && username === me);
  const canResendPending = !!(isPending && username === me && div.dataset.outboxId);
  const canPin = id && !hideContent && !isUnsent && !isPending;
  if (!canReply && !canUnsend && !canForward && !canCopy && !canResend && !canCancel && !canResendPending && !canPin) return;
  const items = [];
  if (canReply) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="reply"><span class="msg-menu-icon">↩</span><span class="msg-menu-label">Balas</span></button>');
  if (canCopy) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="copy"><span class="msg-menu-icon">📋</span><span class="msg-menu-label">Salin</span></button>');
  if (canForward) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="forward"><span class="msg-menu-icon">➤</span><span class="msg-menu-label">Teruskan</span></button>');
  if (canPin) {
    const pinned = isPinned(id);
    items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="pin"><span class="msg-menu-icon">📌</span><span class="msg-menu-label">' + (pinned ? 'Lepas pin' : 'Pin pesan') + '</span></button>');
  }
  if (canResendPending) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="resend-pending"><span class="msg-menu-icon">↻</span><span class="msg-menu-label">Kirim ulang</span></button>');
  if (canUnsend) items.push('<button class="msg-menu-item msg-menu-item-danger" type="button" role="menuitem" data-action="unsend"><span class="msg-menu-icon">🚫</span><span class="msg-menu-label">Tarik pesan</span></button>');
  if (canResend) items.push('<button class="msg-menu-item" type="button" role="menuitem" data-action="resend"><span class="msg-menu-icon">↻</span><span class="msg-menu-label">Kirim ulang</span></button>');
  if (canCancel) items.push('<button class="msg-menu-item msg-menu-item-danger" type="button" role="menuitem" data-action="cancel"><span class="msg-menu-icon">🗑</span><span class="msg-menu-label">Batalkan</span></button>');
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
      const pinItem = menuEl.querySelector('.msg-menu-item[data-action="pin"] .msg-menu-label');
      if (pinItem && id) pinItem.textContent = isPinned(id) ? 'Lepas pin' : 'Pin pesan';
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
        const voEl = div.querySelector('.view-once-bubble');
        const voKind = voEl ? (voEl.querySelector('.vo-title') || {}).textContent || '' : '';
        const hasImage = !!div.querySelector('img.chat-img') || /foto/i.test(voKind);
        const hasVideo = !!div.querySelector('video.chat-vid') || /video/i.test(voKind);
        const hasAudio = !!div.querySelector('audio.chat-aud') || /voice/i.test(voKind);
        const hasSticker = !!div.querySelector('.chat-sticker');
        const snapText = voEl ? VIEW_ONCE_MARKER + replyText : replyText;
        setReplyTarget({ id: currentId, username, text: snapText, hasImage, hasVideo, hasAudio, hasSticker });
      } else if (action === 'forward' && currentId) {
        openForwardPicker(currentId);
      } else if (action === 'unsend' && currentId) {
        requestUnsend(currentId);
      } else if (action === 'resend' && currentId) {
        requestResend(currentId);
      } else if (action === 'resend-pending') {
        resendPendingBubble(div);
      } else if (action === 'copy') {
        const t = div.querySelector('.msg-text');
        if (t) copyTextToClipboard(t.textContent);
      } else if (action === 'cancel') {
        cancelPendingBubble(div);
      } else if (action === 'pin' && currentId) {
        togglePin(currentId);
      }
    });
  });
}

let openMsgMenu = null;
let openMsgMenuBtn = null;
function closeOpenMsgMenu() {
  if (!openMsgMenu) return;
  openMsgMenu.classList.add('hidden');
  if (openMsgMenu.classList.contains('gallery-menu')) {
    openMsgMenu.style.left = '';
    openMsgMenu.style.top = '';
  }
  if (openMsgMenuBtn) openMsgMenuBtn.setAttribute('aria-expanded', 'false');
  openMsgMenu = null;
  openMsgMenuBtn = null;
}
document.addEventListener('click', () => closeOpenMsgMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOpenMsgMenu();
});

const forwardModal = document.getElementById('forward-modal');
const forwardList = document.getElementById('forward-list');
const forwardCloseBtn = document.getElementById('forward-close');
let forwardSourceId = null;

function openForwardPicker(id) {
  if (!isHub() || !id) return;
  forwardSourceId = id;
  forwardList.innerHTML = '';
  const targets = availablePeers.filter((p) => p !== currentPeer);
  if (!targets.length) {
    const empty = document.createElement('div');
    empty.className = 'forward-empty';
    empty.textContent = 'Tidak ada peer lain';
    forwardList.appendChild(empty);
  } else {
    targets.forEach((peer) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'forward-item';
      const info = presenceState[peer] || {};
      const dot = document.createElement('span');
      dot.className = 'forward-dot' + (info.online ? ' online' : '');
      const name = document.createElement('span');
      name.className = 'forward-name';
      name.textContent = peer;
      btn.appendChild(dot);
      btn.appendChild(name);
      btn.addEventListener('click', () => {
        sendForward(forwardSourceId, peer);
        closeForwardPicker();
      });
      forwardList.appendChild(btn);
    });
  }
  forwardModal.classList.remove('hidden');
}

function closeForwardPicker() {
  forwardModal.classList.add('hidden');
  forwardSourceId = null;
}

function sendForward(sourceId, targetPeer) {
  if (!socket || !sourceId || !targetPeer) return;
  socket.emit('forward', { sourceId, peer: targetPeer }, (ack) => {
    if (ack && ack.error) {
      console.error('forward failed:', ack.error);
      addSystem('Gagal meneruskan pesan: ' + ack.error);
    }
  });
}

if (forwardCloseBtn) forwardCloseBtn.addEventListener('click', closeForwardPicker);
if (forwardModal) forwardModal.addEventListener('click', (e) => {
  if (e.target === forwardModal) closeForwardPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !forwardModal.classList.contains('hidden')) closeForwardPicker();
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

function requestResend(id) {
  if (!socket || !id) return;
  socket.emit('resend', { id }, (resp) => {
    if (resp && resp.error) {
      console.error('resend failed:', resp.error);
      addSystem('Gagal mengirim ulang pesan: ' + resp.error);
    }
  });
}

function applyDeleteToView(id) {
  const targetId = String(id);
  const el = messagesEl.querySelector('.msg[data-id="' + targetId + '"]');
  if (el) {
    if (replyTarget && Number(replyTarget.id) === Number(id)) clearReply();
    if (openMsgMenu && el.contains(openMsgMenu)) closeOpenMsgMenu();
    const wrapper = el.closest('.msg-group') || el;
    wrapper.remove();
  }
  messagesEl.querySelectorAll('.reply-quote[data-target="' + targetId + '"]').forEach((quoteEl) => {
    quoteEl.classList.add('reply-quote-unsent');
    const userEl = quoteEl.querySelector('.reply-quote-user');
    const textEl = quoteEl.querySelector('.reply-quote-text');
    if (userEl) userEl.textContent = '';
    if (textEl) textEl.textContent = UNSENT_PLACEHOLDER_TEXT;
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
      el.classList.remove('has-sticker');
      el.querySelectorAll('.reply-quote, .msg-text, .chat-img, .chat-sticker, .chat-vid, .chat-aud').forEach((n) => n.remove());
      const placeholder = document.createElement('span');
      placeholder.className = 'msg-text unsent-placeholder';
      placeholder.textContent = UNSENT_PLACEHOLDER_TEXT;
      el.appendChild(placeholder);
    }
    if (el.classList.contains('mine')) {
      attachMsgMenu(el, { id: Number(id), username: me, isUnsent: true, hideContent: !isHub() });
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

function applyResendToView(msg) {
  if (!msg || !msg.id) return;
  const targetId = String(msg.id);
  const el = messagesEl.querySelector('.msg[data-id="' + targetId + '"]');
  if (el) {
    if (openMsgMenu && el.contains(openMsgMenu)) closeOpenMsgMenu();
    const nodes = buildMessageNodes(Object.assign({}, msg, { _history: true }));
    if (nodes.length) el.replaceWith(nodes[0]);
  }
  messagesEl.querySelectorAll('.reply-quote[data-target="' + targetId + '"]').forEach((quoteEl) => {
    quoteEl.classList.remove('reply-quote-unsent');
    const userEl = quoteEl.querySelector('.reply-quote-user');
    const textEl = quoteEl.querySelector('.reply-quote-text');
    if (userEl) userEl.textContent = msg.username || '';
    if (textEl) textEl.textContent = replySnippet(msg);
  });
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
  flushKeywordAnims(currentPeer, lastIncomingId, false);
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

let viewerCloseCb = null;
function closeImageViewer() {
  imageViewer.classList.add('hidden');
  viewerContent.innerHTML = '';
  viewerItems = [];
  document.body.style.overflow = '';
  const cb = viewerCloseCb;
  viewerCloseCb = null;
  if (typeof cb === 'function') { try { cb(); } catch (_) {} }
}

function openViewOncePreview(msg, markOnClose, onOpened) {
  if (msg.audio) {
    viewerContent.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;color:#fff;';
    const label = document.createElement('div');
    label.textContent = '🕐 Voice note sekali lihat';
    label.style.cssText = 'font-weight:700;';
    const aud = document.createElement('audio');
    aud.src = msg.audio;
    aud.controls = true;
    aud.autoplay = true;
    wrap.appendChild(label);
    wrap.appendChild(aud);
    viewerContent.appendChild(wrap);
    viewerItems = [];
    viewerCounter.style.display = 'none';
    viewerPrev.style.display = 'none';
    viewerNext.style.display = 'none';
    imageViewer.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    viewerCloseCb = markOnClose ? onOpened : null;
    return;
  }
  const src = msg.video || msg.image;
  if (!src) return;
  const type = msg.video ? 'video' : 'image';
  viewerItems = [{ type: type, src: src }];
  viewerIndex = 0;
  renderViewerItem();
  imageViewer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  viewerCloseCb = markOnClose ? onOpened : null;
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

function renderMsgTextHtml(text, msg) {
  var html = linkify(text);
  if (me === 'occupatus' && msg && msg.autoSayang) {
    html = html.replace(/sayang(?![\s\S]*sayang)/i, function(match) {
      return '<span class="auto-sayang" title="ditambah otomatis">' + match + '</span>';
    });
  }
  return html;
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
    _outboxId: msgData._outboxId || null,
    id: null,
    username: me,
    time: new Date().toISOString()
  };
  if (msgData._type === 'image') pendingMsg.image = msgData.dataUrl;
  else if (msgData._type === 'video') pendingMsg.video = msgData.dataUrl;
  else if (msgData._type === 'audio') pendingMsg.audio = msgData.dataUrl;
  else if (msgData._type === 'sticker') pendingMsg.sticker = msgData.stickerUrl;
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

function markPendingFailed(tempId, errorMsg, opts) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  el.dataset.failed = '1';
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
  var outboxId = el.dataset.outboxId;
  if (outboxId && !(opts && opts.skipOutbox)) {
    outboxUpdate(outboxId, { failed: true, errorMsg: errorMsg || '' });
  }
}
function markPendingRetrying(tempId) {
  var el = messagesEl.querySelector('.msg[data-temp-id="' + tempId + '"]');
  if (!el) return;
  delete el.dataset.failed;
  var tick = el.querySelector('.tick');
  if (tick) {
    tick.className = 'tick pending';
    tick.setAttribute('aria-label', 'pending');
    tick.removeAttribute('title');
    tick.textContent = '🕐';
  }
  var status = el.querySelector('.upload-status');
  if (status && status.classList.contains('failed')) {
    status.classList.remove('failed');
    status.textContent = '';
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
    if (msgData.name) payload.name = msgData.name;
    if (msgData.replyToId) payload.replyToId = msgData.replyToId;
    if (msgData.peer) payload.peer = msgData.peer;
    if (msgData.autoSayang) payload.autoSayang = true;
    if (tempId != null) payload.clientId = tempId;
    socket.emit(event, payload, function(ack) {
      if (ack && ack.id) {
        updatePendingToSent(tempId, ack.id);
        lastIncomingId = Math.max(lastIncomingId, ack.id);
        if (msgData._outboxId) outboxDelete(msgData._outboxId);
      } else if (ack && ack.error) {
        // Server menolak (validasi/ukuran): tandai gagal, biarkan outbox agar bisa Kirim ulang manual
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

function queueMessage(eventName, msgData, reuseOutboxId) {
  var data = {};
  if (msgData.dataUrl) data.dataUrl = msgData.dataUrl;
  if (msgData.text) data.text = msgData.text;
  if (msgData.caption) data.caption = msgData.caption;
  if (msgData.name) data.name = msgData.name;
  if (msgData.stickerUrl) data.stickerUrl = msgData.stickerUrl;
  if (msgData.replyToId) data.replyToId = msgData.replyToId;
  if (msgData.replyTo) data.replyTo = msgData.replyTo;
  if (msgData.autoSayang) data.autoSayang = true;
  data.peer = currentPeer;
  data._tempId = null;
  data._pending = true;
  data._type = eventName;
  var kind = eventName === 'message' ? 'text' : eventName;
  var recordTime = new Date().toISOString();
  data._outboxId = reuseOutboxId || newOutboxId();
  outboxAdd({
    id: data._outboxId,
    user: me,
    peer: currentPeer,
    kind: kind,
    text: data.text || '',
    dataUrl: data.dataUrl || '',
    caption: data.caption || '',
    name: data.name || '',
    stickerUrl: data.stickerUrl || '',
    replyToId: data.replyToId || null,
    replyTo: data.replyTo || null,
    autoSayang: !!data.autoSayang,
    time: recordTime,
    failed: false,
    errorMsg: '',
  });
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

async function queueVideoUpload(pv, caption, replyToId, replyTo, reuseOutboxId) {
  tempIdCounter++;
  var tempId = tempIdCounter;
  var capturedPeer = currentPeer;
  var outboxId = reuseOutboxId || newOutboxId();
  var pendingMsg = {
    text: caption || '',
    replyToId: replyToId || null,
    replyTo: replyTo || null,
    _pending: true,
    _tempId: tempId,
    _outboxId: outboxId,
    id: null,
    username: me,
    time: new Date().toISOString(),
    video: pv.previewUrl,
    peer: capturedPeer,
  };
  addMessage(pendingMsg);
  outboxAdd({
    id: outboxId,
    user: me,
    peer: capturedPeer,
    kind: 'video',
    blob: pv.blob,
    caption: caption || '',
    replyToId: replyToId || null,
    replyTo: replyTo || null,
    time: pendingMsg.time,
    failed: false,
    errorMsg: '',
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
  var willCompress = canCaptureVideoStream() && !!window.MediaRecorder;
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
        outboxDelete(outboxId);
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

function autoResizeMsgInput() {
  if (msgInput.tagName !== 'TEXTAREA') return;
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
}

function applyTurkiSayangQuirk(text) {
  if (!text) return { text: text, auto: false };
  if (/\bsayang\b/i.test(text)) return { text: text, auto: false };
  const body = text.trim();
  if (!body) return { text: text, auto: false };
  const words = body.split(/\s+/);
  // Focus on short single-clause messages.
  if (words.length > 8) return { text: text, auto: false };
  // Single-word only allowed for a few affirmations.
  if (words.length < 2 && !/^(?:iya+|oke+|yaa*)[.!?…]*$/i.test(body)) return { text: text, auto: false };
  // Multi-clause (multiple ./!/?/… groups) — skip so we don't land mid-sentence.
  if ((body.match(/[.!?…]+/g) || []).length > 1) return { text: text, auto: false };
  if (Math.random() >= 0.3) return { text: text, auto: false };

  const m = text.match(/^(.*?)(\s*[.!?…]+\s*)$/s);
  if (m) {
    const head = m[1].replace(/\s+$/, '');
    if (!head) return { text: text, auto: false };
    return { text: head + ' sayang' + m[2].replace(/^\s+/, ''), auto: true };
  }
  return { text: text.replace(/\s+$/, '') + ' sayang..', auto: true };
}

const drafts = {};
function draftKey(peer) { return 'draft:' + me + ':' + peer; }
function loadDraft(peer) {
  if (!peer) return '';
  if (peer in drafts) return drafts[peer];
  try {
    const v = localStorage.getItem(draftKey(peer));
    drafts[peer] = v || '';
    return drafts[peer];
  } catch (_) { return ''; }
}
function saveDraft(peer, text) {
  if (!peer) return;
  const value = text || '';
  drafts[peer] = value;
  try {
    if (value) localStorage.setItem(draftKey(peer), value);
    else localStorage.removeItem(draftKey(peer));
  } catch (_) {}
}
function applyDraftForCurrentPeer() {
  const value = loadDraft(currentPeer);
  msgInput.value = value;
  autoResizeMsgInput();
}

msgInput.addEventListener('input', function() {
  autoResizeMsgInput();
  if (currentPeer) saveDraft(currentPeer, msgInput.value);
  if (msgInput.value.length === 0) {
    sendTypingStop();
  } else {
    sendTypingStart();
  }
});
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (typeof chatForm.requestSubmit === 'function') chatForm.requestSubmit();
    else chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
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
  var isVO = pendingViewOnce;
  if (pendingVideo) {
    var pv = pendingVideo;
    pendingVideo = null;
    var captionV = isVO ? (VIEW_ONCE_MARKER + (text || '')) : text;
    queueVideoUpload(pv, captionV, replyToId, replyToSnap);
    clearPreview();
    clearReply();
    msgInput.value = '';
    saveDraft(currentPeer, '');
    autoResizeMsgInput();
    return;
  }
  if (pendingImage) {
    var captionI = isVO ? (VIEW_ONCE_MARKER + (text || '')) : text;
    queueMessage('image', { dataUrl: pendingImage, caption: captionI, replyToId: replyToId, replyTo: replyToSnap });
    clearPreview();
    clearReply();
    msgInput.value = '';
    saveDraft(currentPeer, '');
    autoResizeMsgInput();
    return;
  }
  if (!text) return;
  var autoSayang = false;
  if (me === 'turki') {
    var quirked = applyTurkiSayangQuirk(text);
    text = quirked.text;
    autoSayang = quirked.auto;
  }
  var msgPayload = { text: text, replyToId: replyToId, replyTo: replyToSnap };
  if (autoSayang) msgPayload.autoSayang = true;
  queueMessage('message', msgPayload);
  msgInput.value = '';
  saveDraft(currentPeer, '');
  autoResizeMsgInput();
  clearReply();
});

fileInput.addEventListener('change', async function() {
  var file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (file.type.startsWith('video/')) {
    setPendingVideo(file);
    return;
  }
  if (!file.type.startsWith('image/')) {
    alert('File must be an image or video');
    return;
  }
  try {
    var dataUrl = await compressImageFile(file);
    pendingImage = dataUrl;
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
    if (previewEditBtn) previewEditBtn.classList.remove('hidden');
    msgInput.placeholder = 'Add a caption (optional)...';
    msgInput.focus();
  } catch (err) {
    alert('Failed to prepare image: ' + ((err && err.message) || err));
  }
});

previewCancel.addEventListener('click', clearPreview);

if (previewEditBtn) {
  previewEditBtn.addEventListener('click', () => {
    if (!pendingImage || !window.PhotoEditor || typeof window.PhotoEditor.open !== 'function') return;
    window.PhotoEditor.open(pendingImage, {
      me,
      onSave: (dataUrl) => {
        if (!dataUrl) return;
        pendingImage = dataUrl;
        previewImg.src = dataUrl;
      },
    });
  });
}

if (previewViewOnceBtn) {
  previewViewOnceBtn.addEventListener('click', function(e) {
    e.preventDefault();
    setPendingViewOnce(!pendingViewOnce);
  });
}
if (recViewOnceBtn) {
  recViewOnceBtn.addEventListener('click', function(e) {
    e.preventDefault();
    setPendingViewOnce(!pendingViewOnce);
  });
}

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
  if (previewEditBtn) previewEditBtn.classList.add('hidden');
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
  if (previewEditBtn) previewEditBtn.classList.add('hidden');
  msgInput.placeholder = 'Type a message...';
  setPendingViewOnce(false);
}

cameraBtn.addEventListener('click', function() { openCamera(); });
camClose.addEventListener('click', closeCamera);
camSwitch.addEventListener('click', function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  camFacing = camFacing === 'user' ? 'environment' : 'user';
  openCamera();
});
if (camTorch) {
  camTorch.addEventListener('click', async function() {
    var track = getCamVideoTrack();
    if (!track) return;
    var next = !camTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      camTorchOn = next;
      camTorch.dataset.on = next ? 'true' : 'false';
    } catch (err) {
      camError.textContent = 'Flashlight not supported: ' + (err.message || err.name);
    }
  });
}
if (camZoom) {
  camZoom.addEventListener('input', async function() {
    var track = getCamVideoTrack();
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Number(camZoom.value) }] });
    } catch (err) {
      camError.textContent = 'Zoom not supported: ' + (err.message || err.name);
    }
  });
}
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
  previewImg.classList.remove('hidden');
  previewVideo.classList.add('hidden');
  preview.classList.remove('hidden');
  if (previewEditBtn) previewEditBtn.classList.remove('hidden');
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
      video: {
        facingMode: camFacing,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    camVideo.srcObject = camStream;
    camVideo.classList.toggle('mirrored', camFacing === 'user');
    applyCameraCapabilities();
  } catch (err) {
    camError.textContent = 'Cannot access camera: ' + (err.message || err.name);
  }
}

function getCamVideoTrack() {
  if (!camStream) return null;
  var tracks = camStream.getVideoTracks();
  return tracks && tracks[0] ? tracks[0] : null;
}

function readCameraCapabilities() {
  var track = getCamVideoTrack();
  if (!track || typeof track.getCapabilities !== 'function') {
    camError.textContent = 'getCapabilities() not supported in this browser';
    return;
  }
  var caps = {};
  try { caps = track.getCapabilities() || {}; } catch (_) {}
  var keys = Object.keys(caps);
  var hasTorch = !!caps.torch;
  var hasZoom = !!caps.zoom;
  if (!hasTorch && !hasZoom) {
    camError.textContent = 'no torch/zoom. caps: ' + (keys.join(',') || '(empty)');
  } else {
    camError.textContent = '';
  }
  if (caps.torch && camTorch) camTorch.classList.remove('hidden');
  if (caps.zoom && camZoom) {
    var zmin = typeof caps.zoom.min === 'number' ? caps.zoom.min : Number(caps.zoom.min);
    var zmax = typeof caps.zoom.max === 'number' ? caps.zoom.max : Number(caps.zoom.max);
    var zstep = typeof caps.zoom.step === 'number' ? caps.zoom.step : Number(caps.zoom.step);
    if (isFinite(zmin) && isFinite(zmax) && zmax > zmin) {
      var settings = {};
      try { settings = track.getSettings() || {}; } catch (_) {}
      camZoom.min = String(zmin);
      camZoom.max = String(zmax);
      camZoom.step = String(isFinite(zstep) && zstep > 0 ? zstep : 0.1);
      camZoom.value = String(settings.zoom || zmin);
      camZoom.classList.remove('hidden');
    }
  }
}

function applyCameraCapabilities() {
  camTorchOn = false;
  if (camTorch) {
    camTorch.dataset.on = 'false';
    camTorch.classList.add('hidden');
  }
  if (camZoom) camZoom.classList.add('hidden');
  readCameraCapabilities();
  // Some browsers only populate zoom/torch caps after the track is fully live —
  // re-check on loadedmetadata and after a short delay as a fallback.
  var onMeta = function() {
    camVideo.removeEventListener('loadedmetadata', onMeta);
    readCameraCapabilities();
  };
  camVideo.addEventListener('loadedmetadata', onMeta);
  setTimeout(readCameraCapabilities, 400);
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
        video: {
          facingMode: camFacing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: true,
      });
      camVideo.srcObject = camStream;
      camVideo.classList.toggle('mirrored', camFacing === 'user');
      applyCameraCapabilities();
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

const sayangStatsBtn = document.getElementById('sayang-stats-btn');
const sayangStatsModal = document.getElementById('sayang-stats-modal');
const sayangStatsCloseBtn = document.getElementById('sayang-stats-close');
const sayangStatsStateEl = document.getElementById('sayang-stats-state');
const sayangStatsContentEl = document.getElementById('sayang-stats-content');

function updateSayangStatsBtn() {
  if (!sayangStatsBtn) return;
  if (isHub()) sayangStatsBtn.classList.remove('hidden');
  else sayangStatsBtn.classList.add('hidden');
}

function closeSayangStatsModal() {
  if (!sayangStatsModal) return;
  sayangStatsModal.classList.add('hidden');
}

function escapeHtmlSS(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSayangTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return '—';
  }
}

function highlightSayang(text) {
  const safe = escapeHtmlSS(text || '');
  return safe.replace(/sayang/gi, (m) => '<mark>' + m + '</mark>');
}

function renderSayangDaily(daily) {
  const el = document.getElementById('ss-daily');
  if (!el) return;
  el.innerHTML = '';
  const map = new Map((daily || []).map((d) => [d.day, d.count]));
  const today = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, count: map.get(key) || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  if (days.every((d) => d.count === 0)) {
    const empty = document.createElement('div');
    empty.className = 'sayang-stats-daily-empty';
    empty.textContent = 'Belum ada pesan manual 30 hari terakhir.';
    el.appendChild(empty);
    return;
  }
  for (const d of days) {
    const bar = document.createElement('div');
    bar.className = 'ss-bar';
    const h = d.count === 0 ? 3 : Math.max(6, Math.round((d.count / max) * 70));
    bar.style.height = h + 'px';
    if (d.count === 0) bar.style.opacity = '0.25';
    bar.title = d.day + ' — ' + d.count + ' pesan';
    el.appendChild(bar);
  }
}

function renderSayangStats(data) {
  const totals = data.totals || {};
  const csEl = document.getElementById('ss-counter-start');
  if (csEl) csEl.textContent = formatSayangTime(totals.counterStart);
  document.getElementById('ss-manual').textContent = String(totals.manual || 0);
  document.getElementById('ss-manual-occ').textContent = (totals.manualOccurrences || 0) + ' kata';
  document.getElementById('ss-auto').textContent = String(totals.auto || 0);
  document.getElementById('ss-total').textContent = String(totals.totalTextMessages || 0);
  const total = Number(totals.totalTextMessages || 0);
  const manual = Number(totals.manual || 0);
  const ratioEl = document.getElementById('ss-ratio');
  ratioEl.textContent = total > 0
    ? ((manual / total) * 100).toFixed(1) + '% manual sayang'
    : '— % manual sayang';
  document.getElementById('ss-first').textContent = formatSayangTime(totals.firstManualAt);
  document.getElementById('ss-last').textContent = formatSayangTime(totals.lastManualAt);

  renderSayangDaily(data.daily || []);

  const recentEl = document.getElementById('ss-recent');
  recentEl.innerHTML = '';
  const recent = Array.isArray(data.recent) ? data.recent : [];
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'sayang-stats-recent-empty';
    empty.textContent = 'Belum ada.';
    recentEl.appendChild(empty);
  } else {
    for (const r of recent) {
      const li = document.createElement('li');
      const time = document.createElement('div');
      time.className = 'ss-recent-time';
      time.textContent = formatSayangTime(r.time) + (r.peer ? ' • ' + r.peer : '');
      const body = document.createElement('div');
      body.innerHTML = highlightSayang(r.text);
      li.appendChild(time);
      li.appendChild(body);
      recentEl.appendChild(li);
    }
  }
}

async function openSayangStatsModal() {
  if (!sayangStatsModal || !isHub()) return;
  sayangStatsModal.classList.remove('hidden');
  sayangStatsContentEl.classList.add('hidden');
  sayangStatsStateEl.classList.remove('hidden');
  sayangStatsStateEl.textContent = 'Memuat…';
  try {
    const token = localStorage.getItem('token');
    if (!token) throw new Error('Not logged in');
    const res = await fetch('/sayang-stats', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    renderSayangStats(data);
    sayangStatsStateEl.classList.add('hidden');
    sayangStatsContentEl.classList.remove('hidden');
  } catch (err) {
    sayangStatsStateEl.textContent = 'Gagal memuat: ' + (err.message || err);
  }
}

if (sayangStatsBtn) sayangStatsBtn.addEventListener('click', openSayangStatsModal);
if (sayangStatsCloseBtn) sayangStatsCloseBtn.addEventListener('click', closeSayangStatsModal);
if (sayangStatsModal) sayangStatsModal.addEventListener('click', (e) => {
  if (e.target === sayangStatsModal) closeSayangStatsModal();
});

const journalBtn = document.getElementById('journal-btn');
const journalModal = document.getElementById('journal-modal');
const journalCloseBtn = document.getElementById('journal-close');
const journalPeerLabel = document.getElementById('journal-peer-label');
const journalForm = document.getElementById('journal-form');
const journalInput = document.getElementById('journal-input');
const journalSubmitBtn = document.getElementById('journal-submit');
const journalErrorEl = document.getElementById('journal-error');
const journalStateEl = document.getElementById('journal-state');
const journalListEl = document.getElementById('journal-list');
const journalLoadMoreBtn = document.getElementById('journal-load-more');

const journalState = {
  peer: null,
  entries: [],
  hasMore: false,
  loading: false,
  editingId: null,
};

function updateJournalBtn() {
  if (!journalBtn) return;
  if (me) journalBtn.classList.remove('hidden');
  else journalBtn.classList.add('hidden');
}

function journalPeerFor() {
  return isHub() ? currentPeer : me;
}

function formatJournalTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return ''; }
}

function escapeHtmlJournal(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showJournalError(msg) {
  if (!journalErrorEl) return;
  if (!msg) {
    journalErrorEl.textContent = '';
    journalErrorEl.classList.add('hidden');
  } else {
    journalErrorEl.textContent = msg;
    journalErrorEl.classList.remove('hidden');
  }
}

function renderJournalList() {
  if (!journalListEl) return;
  journalListEl.innerHTML = '';
  if (!journalState.entries.length) {
    journalListEl.classList.add('hidden');
    journalStateEl.textContent = 'Belum ada entry. Yuk tulis yang pertama.';
    journalStateEl.classList.remove('hidden');
    journalLoadMoreBtn.classList.add('hidden');
    return;
  }
  journalStateEl.classList.add('hidden');
  journalListEl.classList.remove('hidden');
  for (const entry of journalState.entries) {
    const li = document.createElement('li');
    li.className = 'journal-entry' + (entry.author === me ? ' mine' : '');
    li.dataset.id = String(entry.id);

    const meta = document.createElement('div');
    meta.className = 'journal-entry-meta';
    const left = document.createElement('div');
    const author = document.createElement('span');
    author.className = 'journal-entry-author';
    author.textContent = entry.author;
    const time = document.createElement('span');
    time.className = 'journal-entry-time';
    time.textContent = ' • ' + formatJournalTime(entry.createdAt);
    left.appendChild(author);
    left.appendChild(time);
    if (entry.updatedAt) {
      const edited = document.createElement('span');
      edited.className = 'journal-entry-edited';
      edited.textContent = '(diedit)';
      left.appendChild(edited);
    }
    meta.appendChild(left);

    if (entry.author === me) {
      const actions = document.createElement('div');
      actions.className = 'journal-entry-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => beginEditJournal(entry.id));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Hapus';
      delBtn.addEventListener('click', () => confirmDeleteJournal(entry.id));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      meta.appendChild(actions);
    }
    li.appendChild(meta);

    if (journalState.editingId === entry.id) {
      const wrap = document.createElement('div');
      wrap.className = 'journal-entry-edit';
      const ta = document.createElement('textarea');
      ta.value = entry.body;
      ta.maxLength = 4000;
      const row = document.createElement('div');
      row.className = 'journal-composer-row';
      const err = document.createElement('span');
      err.className = 'journal-error hidden';
      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '6px';
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = 'Simpan';
      save.className = 'journal-entry-save';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Batal';
      cancel.className = 'journal-entry-cancel';
      save.addEventListener('click', () => submitEditJournal(entry.id, ta.value, err, save));
      cancel.addEventListener('click', () => { journalState.editingId = null; renderJournalList(); });
      btnRow.appendChild(cancel);
      btnRow.appendChild(save);
      row.appendChild(err);
      row.appendChild(btnRow);
      wrap.appendChild(ta);
      wrap.appendChild(row);
      li.appendChild(wrap);
      setTimeout(() => ta.focus(), 0);
    } else {
      const body = document.createElement('div');
      body.className = 'journal-entry-body';
      body.textContent = entry.body;
      li.appendChild(body);
    }
    journalListEl.appendChild(li);
  }
  journalLoadMoreBtn.classList.toggle('hidden', !journalState.hasMore);
}

async function loadJournal(reset) {
  const peer = journalPeerFor();
  if (!peer) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  if (reset) {
    journalState.entries = [];
    journalState.hasMore = false;
    journalState.editingId = null;
    journalListEl.classList.add('hidden');
    journalStateEl.classList.remove('hidden');
    journalStateEl.textContent = 'Memuat…';
    journalLoadMoreBtn.classList.add('hidden');
  }
  journalState.loading = true;
  try {
    const before = !reset && journalState.entries.length
      ? journalState.entries[journalState.entries.length - 1].id
      : null;
    const params = new URLSearchParams({ limit: '30' });
    if (before) params.set('before', String(before));
    const res = await fetch('/journal/' + encodeURIComponent(peer) + '?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    if (reset) journalState.entries = data.items || [];
    else journalState.entries = journalState.entries.concat(data.items || []);
    journalState.hasMore = !!data.hasMore;
    renderJournalList();
  } catch (err) {
    journalStateEl.textContent = 'Gagal memuat: ' + (err.message || err);
    journalStateEl.classList.remove('hidden');
    journalListEl.classList.add('hidden');
  } finally {
    journalState.loading = false;
  }
}

function beginEditJournal(id) {
  journalState.editingId = id;
  renderJournalList();
}

async function submitEditJournal(id, value, errEl, btn) {
  const peer = journalPeerFor();
  const body = String(value || '').trim();
  if (!body) {
    errEl.textContent = 'Kosong';
    errEl.classList.remove('hidden');
    return;
  }
  const token = localStorage.getItem('token');
  if (!token || !peer) return;
  btn.disabled = true;
  try {
    const res = await fetch('/journal/' + encodeURIComponent(peer) + '/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const idx = journalState.entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      journalState.entries[idx] = Object.assign({}, journalState.entries[idx], data.item || { body });
    }
    journalState.editingId = null;
    renderJournalList();
  } catch (err) {
    errEl.textContent = 'Gagal: ' + (err.message || err);
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function confirmDeleteJournal(id) {
  if (!window.confirm('Hapus entry ini?')) return;
  const peer = journalPeerFor();
  const token = localStorage.getItem('token');
  if (!token || !peer) return;
  try {
    const res = await fetch('/journal/' + encodeURIComponent(peer) + '/' + id, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  } catch (err) {
    alert('Gagal menghapus: ' + (err.message || err));
  }
}

async function openJournalModal() {
  if (!journalModal) return;
  const peer = journalPeerFor();
  if (!peer) return;
  journalState.peer = peer;
  journalPeerLabel.textContent = peer;
  showJournalError('');
  journalInput.value = '';
  journalModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await loadJournal(true);
  setTimeout(() => { if (journalInput) journalInput.focus(); }, 50);
}

function closeJournalModal() {
  if (!journalModal) return;
  journalModal.classList.add('hidden');
  journalState.editingId = null;
  document.body.style.overflow = '';
}

if (journalForm) {
  journalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const peer = journalPeerFor();
    const body = journalInput.value.trim();
    if (!peer) return;
    if (!body) { showJournalError('Kosong'); return; }
    const token = localStorage.getItem('token');
    if (!token) return;
    showJournalError('');
    journalSubmitBtn.disabled = true;
    try {
      const res = await fetch('/journal/' + encodeURIComponent(peer), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      journalInput.value = '';
    } catch (err) {
      showJournalError('Gagal: ' + (err.message || err));
    } finally {
      journalSubmitBtn.disabled = false;
    }
  });
}
if (journalBtn) journalBtn.addEventListener('click', openJournalModal);
if (journalCloseBtn) journalCloseBtn.addEventListener('click', closeJournalModal);
if (journalModal) journalModal.addEventListener('click', (e) => {
  if (e.target === journalModal) closeJournalModal();
});
if (journalLoadMoreBtn) journalLoadMoreBtn.addEventListener('click', () => loadJournal(false));


const pinnedBtn = document.getElementById('pinned-btn');
const pinnedModal = document.getElementById('pinned-modal');
const pinnedCloseBtn = document.getElementById('pinned-close');
const pinnedPeerLabel = document.getElementById('pinned-peer-label');
const pinnedStateEl = document.getElementById('pinned-state');
const pinnedListEl = document.getElementById('pinned-list');

const pinnedState = {
  peer: null,
  items: [],
  loading: false,
};

function updatePinnedBtn() {
  if (!pinnedBtn) return;
  if (me) pinnedBtn.classList.remove('hidden');
  else pinnedBtn.classList.add('hidden');
}

function pinnedPeerFor() {
  return isHub() ? currentPeer : me;
}

function formatPinnedTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return ''; }
}

function escapeHtmlPinned(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pinnedMediaTag(m) {
  if (m.image) return '🖼️ Foto';
  if (m.video) return '🎬 Video';
  if (m.audio) return '🎙️ Voice';
  return '';
}

function renderPinnedList() {
  if (!pinnedListEl || !pinnedStateEl) return;
  pinnedListEl.innerHTML = '';
  if (!pinnedState.items.length) {
    pinnedListEl.classList.add('hidden');
    pinnedStateEl.textContent = 'Belum ada pesan yang di-pin.';
    pinnedStateEl.classList.remove('hidden');
    return;
  }
  pinnedStateEl.classList.add('hidden');
  pinnedListEl.classList.remove('hidden');
  for (const m of pinnedState.items) {
    const li = document.createElement('li');
    li.className = 'pinned-item' + (m.username === me ? ' mine' : '');
    li.dataset.id = String(m.id);
    const body = m.text ? escapeHtmlPinned(m.text) : '';
    const mediaTag = pinnedMediaTag(m);
    const bodyHtml = body
      ? '<div class="pinned-body-text">' + body + '</div>'
      : (mediaTag ? '<div class="pinned-media-tag">' + mediaTag + '</div>' : '');
    li.innerHTML =
      '<div class="pinned-meta">' +
        '<span class="pinned-author">' + escapeHtmlPinned(m.username) + '</span>' +
        '<span class="pinned-time">' + escapeHtmlPinned(formatPinnedTime(m.time)) + '</span>' +
      '</div>' +
      bodyHtml +
      '<div class="pinned-meta">' +
        '<span class="pinned-pinby">di-pin oleh ' + escapeHtmlPinned(m.pinnedBy || '-') + '</span>' +
        '<span class="pinned-actions">' +
          '<button type="button" data-action="jump">Buka</button>' +
          '<button type="button" data-action="unpin">Lepas</button>' +
        '</span>' +
      '</div>';
    li.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      const action = btn && btn.dataset.action;
      if (action === 'unpin') {
        e.stopPropagation();
        togglePin(m.id);
        return;
      }
      closePinnedModal();
      jumpToMessage(m.id);
    });
    pinnedListEl.appendChild(li);
  }
}

async function refreshPinnedList() {
  const peer = pinnedState.peer;
  if (!peer) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  pinnedState.loading = true;
  try {
    const res = await fetch('/pinned/' + encodeURIComponent(peer), {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    pinnedState.items = Array.isArray(data.items) ? data.items : [];
    for (const m of pinnedState.items) {
      if (m && m.id) pinnedById[m.id] = true;
      renderPinnedBadgeFor(m.id);
    }
    renderPinnedList();
  } catch (err) {
    if (pinnedStateEl) {
      pinnedStateEl.textContent = 'Gagal memuat: ' + (err.message || err);
      pinnedStateEl.classList.remove('hidden');
    }
    if (pinnedListEl) pinnedListEl.classList.add('hidden');
  } finally {
    pinnedState.loading = false;
  }
}

async function openPinnedModal() {
  if (!pinnedModal) return;
  const peer = pinnedPeerFor();
  if (!peer) return;
  pinnedState.peer = peer;
  if (pinnedPeerLabel) pinnedPeerLabel.textContent = peer;
  if (pinnedStateEl) {
    pinnedStateEl.textContent = 'Memuat…';
    pinnedStateEl.classList.remove('hidden');
  }
  if (pinnedListEl) pinnedListEl.classList.add('hidden');
  pinnedModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await refreshPinnedList();
}

function closePinnedModal() {
  if (!pinnedModal) return;
  pinnedModal.classList.add('hidden');
  pinnedState.peer = null;
  document.body.style.overflow = '';
}

if (pinnedBtn) pinnedBtn.addEventListener('click', openPinnedModal);
if (pinnedCloseBtn) pinnedCloseBtn.addEventListener('click', closePinnedModal);
if (pinnedModal) pinnedModal.addEventListener('click', (e) => {
  if (e.target === pinnedModal) closePinnedModal();
});


const searchBtn = document.getElementById('search-btn');
const searchModal = document.getElementById('search-modal');
const searchCloseBtn = document.getElementById('search-close');
const searchPeerLabel = document.getElementById('search-peer-label');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear');
const searchStateEl = document.getElementById('search-state');
const searchListEl = document.getElementById('search-list');
const searchLoadMoreBtn = document.getElementById('search-load-more');

const searchState = {
  peer: null,
  q: '',
  items: [],
  hasMore: false,
  loading: false,
  reqId: 0,
  timer: null,
};

function updateSearchBtn() {
  if (!searchBtn) return;
  if (me) searchBtn.classList.remove('hidden');
  else searchBtn.classList.add('hidden');
}

function searchPeerFor() {
  return isHub() ? currentPeer : me;
}

function escapeHtmlSearch(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightHit(text, q) {
  const safe = escapeHtmlSearch(text);
  const term = q.trim();
  if (!term) return safe;
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + escapedTerm + ')', 'ig');
  return safe.replace(re, '<span class="search-hit">$1</span>');
}

function formatSearchTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return ''; }
}

function renderSearchList() {
  if (!searchListEl || !searchStateEl || !searchLoadMoreBtn) return;
  searchListEl.innerHTML = '';
  if (!searchState.q) {
    searchStateEl.textContent = 'Ketik untuk mulai mencari.';
    searchStateEl.classList.remove('hidden');
    searchListEl.classList.add('hidden');
    searchLoadMoreBtn.classList.add('hidden');
    return;
  }
  if (searchState.loading && !searchState.items.length) {
    searchStateEl.textContent = 'Mencari…';
    searchStateEl.classList.remove('hidden');
    searchListEl.classList.add('hidden');
    searchLoadMoreBtn.classList.add('hidden');
    return;
  }
  if (!searchState.items.length) {
    searchStateEl.textContent = 'Nggak ada yang cocok.';
    searchStateEl.classList.remove('hidden');
    searchListEl.classList.add('hidden');
    searchLoadMoreBtn.classList.add('hidden');
    return;
  }
  searchStateEl.classList.add('hidden');
  searchListEl.classList.remove('hidden');
  for (const m of searchState.items) {
    const li = document.createElement('li');
    li.className = 'search-item' + (m.username === me ? ' mine' : '');
    li.dataset.id = String(m.id);
    li.innerHTML =
      '<div class="search-item-meta">' +
        '<span class="search-item-author">' + escapeHtmlSearch(m.username) + '</span>' +
        '<span class="search-item-time">' + escapeHtmlSearch(formatSearchTime(m.time)) + '</span>' +
      '</div>' +
      '<div class="search-item-text">' + highlightHit(m.text || '', searchState.q) + '</div>';
    li.addEventListener('click', () => {
      closeSearchModal();
      jumpToMessage(m.id);
    });
    searchListEl.appendChild(li);
  }
  if (searchState.hasMore) searchLoadMoreBtn.classList.remove('hidden');
  else searchLoadMoreBtn.classList.add('hidden');
}

async function runSearch(append) {
  const peer = searchState.peer;
  const q = searchState.q;
  if (!peer || !q) { searchState.items = []; searchState.hasMore = false; renderSearchList(); return; }
  const token = localStorage.getItem('token');
  if (!token) return;
  const reqId = ++searchState.reqId;
  searchState.loading = true;
  if (!append) renderSearchList();
  const params = new URLSearchParams({ peer, q });
  if (append && searchState.items.length) {
    params.set('before', String(searchState.items[searchState.items.length - 1].id));
  }
  try {
    const res = await fetch('/search?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (reqId !== searchState.reqId) return;
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    const items = Array.isArray(data.items) ? data.items : [];
    searchState.items = append ? searchState.items.concat(items) : items;
    searchState.hasMore = !!data.hasMore;
    renderSearchList();
  } catch (err) {
    if (reqId !== searchState.reqId) return;
    if (searchStateEl) {
      searchStateEl.textContent = 'Gagal mencari: ' + (err.message || err);
      searchStateEl.classList.remove('hidden');
    }
    if (searchListEl) searchListEl.classList.add('hidden');
    if (searchLoadMoreBtn) searchLoadMoreBtn.classList.add('hidden');
  } finally {
    if (reqId === searchState.reqId) searchState.loading = false;
  }
}

function scheduleSearch() {
  if (searchState.timer) clearTimeout(searchState.timer);
  searchState.timer = setTimeout(() => {
    searchState.timer = null;
    runSearch(false);
  }, 220);
}

function openSearchModal() {
  if (!searchModal) return;
  const peer = searchPeerFor();
  if (!peer) return;
  searchState.peer = peer;
  searchState.q = '';
  searchState.items = [];
  searchState.hasMore = false;
  if (searchInput) searchInput.value = '';
  if (searchClearBtn) searchClearBtn.classList.add('hidden');
  if (searchPeerLabel) searchPeerLabel.textContent = peer;
  renderSearchList();
  searchModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => { if (searchInput) searchInput.focus(); }, 50);
}

function closeSearchModal() {
  if (!searchModal) return;
  searchModal.classList.add('hidden');
  searchState.peer = null;
  searchState.q = '';
  searchState.items = [];
  searchState.hasMore = false;
  searchState.reqId++;
  if (searchState.timer) { clearTimeout(searchState.timer); searchState.timer = null; }
  document.body.style.overflow = '';
}

if (searchBtn) searchBtn.addEventListener('click', openSearchModal);
if (searchCloseBtn) searchCloseBtn.addEventListener('click', closeSearchModal);
if (searchModal) searchModal.addEventListener('click', (e) => {
  if (e.target === searchModal) closeSearchModal();
});
if (searchInput) {
  searchInput.addEventListener('input', () => {
    searchState.q = searchInput.value.trim();
    if (searchClearBtn) searchClearBtn.classList.toggle('hidden', !searchInput.value);
    scheduleSearch();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchModal(); }
  });
}
if (searchClearBtn) searchClearBtn.addEventListener('click', () => {
  if (!searchInput) return;
  searchInput.value = '';
  searchState.q = '';
  searchClearBtn.classList.add('hidden');
  searchState.items = [];
  searchState.hasMore = false;
  renderSearchList();
  searchInput.focus();
});
if (searchLoadMoreBtn) searchLoadMoreBtn.addEventListener('click', () => runSearch(true));


const clearHistoryBtn = document.getElementById('clear-history-btn');
const clearHistoryModal = document.getElementById('clear-history-modal');
const clearHistoryPeerEl = document.getElementById('clear-history-peer');
const clearHistoryPeerEcho = document.getElementById('clear-history-peer-echo');
const clearHistoryInput = document.getElementById('clear-history-input');
const clearHistoryConfirm = document.getElementById('clear-history-confirm');
const clearHistoryCancel = document.getElementById('clear-history-cancel');
const clearHistoryCancel2 = document.getElementById('clear-history-cancel-2');
const clearHistoryError = document.getElementById('clear-history-error');

function updateClearHistoryBtn() {
  if (!clearHistoryBtn) return;
  if (isHub()) clearHistoryBtn.classList.remove('hidden');
  else clearHistoryBtn.classList.add('hidden');
}

function openClearHistoryModal() {
  if (!isHub() || !currentPeer) return;
  clearHistoryPeerEl.textContent = currentPeer;
  clearHistoryPeerEcho.textContent = currentPeer;
  clearHistoryInput.value = '';
  clearHistoryConfirm.disabled = true;
  clearHistoryError.classList.add('hidden');
  clearHistoryError.textContent = '';
  clearHistoryModal.classList.remove('hidden');
  setTimeout(() => clearHistoryInput.focus(), 0);
}

function closeClearHistoryModal() {
  clearHistoryModal.classList.add('hidden');
}

async function submitClearHistory() {
  const peer = clearHistoryPeerEl.textContent;
  if (!peer || clearHistoryInput.value.trim() !== peer) return;
  clearHistoryConfirm.disabled = true;
  clearHistoryConfirm.textContent = 'Menghapus…';
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/history/' + encodeURIComponent(peer), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    closeClearHistoryModal();
  } catch (err) {
    clearHistoryError.textContent = 'Gagal menghapus: ' + (err.message || err);
    clearHistoryError.classList.remove('hidden');
    clearHistoryConfirm.disabled = false;
  } finally {
    clearHistoryConfirm.textContent = 'Hapus permanen';
  }
}

if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', openClearHistoryModal);
if (clearHistoryCancel) clearHistoryCancel.addEventListener('click', closeClearHistoryModal);
if (clearHistoryCancel2) clearHistoryCancel2.addEventListener('click', closeClearHistoryModal);
if (clearHistoryInput) clearHistoryInput.addEventListener('input', () => {
  const peer = clearHistoryPeerEl.textContent;
  clearHistoryConfirm.disabled = clearHistoryInput.value.trim() !== peer;
});
if (clearHistoryConfirm) clearHistoryConfirm.addEventListener('click', submitClearHistory);
if (clearHistoryModal) clearHistoryModal.addEventListener('click', (e) => {
  if (e.target === clearHistoryModal) closeClearHistoryModal();
});

function applyClearHistoryToView(peer) {
  if (!peer) return;
  if (Object.prototype.hasOwnProperty.call(unreadByPeer, peer)) unreadByPeer[peer] = 0;
  if (readStateMap && typeof readStateMap === 'object') {
    delete readStateMap[peer];
    if (readStateMap[HUB_USER]) delete readStateMap[HUB_USER][peer];
  }
  const shouldClearView = !isHub() || peer === currentPeer;
  if (shouldClearView && messagesEl) {
    messagesEl.innerHTML = '';
    try { lastReadByOthers = 0; } catch (_) {}
  }
  if (typeof renderPeerSwitcherButton === 'function') renderPeerSwitcherButton();
}

var GALLERY_PAGE_SIZE = 12;
var galleryCurrentPage = 1;
var galleryTotalPages = 0;
var galleryTotalItems = 0;
var galleryLoading = false;
var galleryItems = [];
var gallerySelectMode = false;
var gallerySelectedIds = new Set();

function renderGalleryPage() {
  galleryGrid.innerHTML = '';
  galleryItems.forEach(function(it, i) {
    var cell = document.createElement('div');
    cell.className = 'gallery-item';
    if (it.unsent) cell.classList.add('gallery-item-unsent');
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
    if (it.unsent) {
      var unsentTag = document.createElement('span');
      unsentTag.className = 'gallery-unsent-tag';
      unsentTag.textContent = 'ditarik';
      unsentTag.title = 'Pesan ditarik oleh pengirim';
      cell.appendChild(unsentTag);
    }
    // Menu titik tiga (view in chat / delete)
    if (it.id) {
      cell.dataset.id = String(it.id);
      if (gallerySelectedIds.has(it.id)) cell.classList.add('selected');
      attachGalleryMenu(cell, it.id);
    }
    cell.addEventListener('click', function() {
      if (gallerySelectMode) {
        if (!it.id) return;
        if (gallerySelectedIds.has(it.id)) {
          gallerySelectedIds.delete(it.id);
          cell.classList.remove('selected');
        } else {
          gallerySelectedIds.add(it.id);
          cell.classList.add('selected');
        }
        updateBulkDeleteBar();
        return;
      }
      viewerItems = galleryItems.map(function(g) { return { type: g.type, src: g.src }; });
      viewerIndex = i;
      renderViewerItem();
      imageViewer.classList.remove('hidden');
    });
    galleryGrid.appendChild(cell);
  });
  updatePaginationControls();
}

function updateBulkDeleteBar() {
  var countEl = document.getElementById('gallery-select-count');
  var delBtn = document.getElementById('gallery-bulk-delete');
  var count = gallerySelectedIds.size;
  if (countEl) countEl.textContent = count + ' dipilih';
  if (delBtn) delBtn.disabled = count === 0;
}

function setGallerySelectMode(next) {
  gallerySelectMode = !!next;
  if (!gallerySelectMode) gallerySelectedIds.clear();
  galleryModal.classList.toggle('select-mode', gallerySelectMode);
  var selBar = document.getElementById('gallery-select-bar');
  var selBtn = document.getElementById('gallery-select-btn');
  if (selBar) selBar.classList.toggle('hidden', !gallerySelectMode);
  if (selBtn) {
    selBtn.textContent = gallerySelectMode ? 'Batal' : 'Pilih';
    selBtn.classList.toggle('active', gallerySelectMode);
  }
  closeOpenMsgMenu();
  if (!gallerySelectMode) {
    galleryGrid.querySelectorAll('.gallery-item.selected').forEach(function(el) {
      el.classList.remove('selected');
    });
  }
  updateBulkDeleteBar();
}

function selectAllGalleryItems() {
  galleryItems.forEach(function(it) {
    if (!it.id) return;
    gallerySelectedIds.add(it.id);
  });
  galleryGrid.querySelectorAll('.gallery-item').forEach(function(cell) {
    var id = Number(cell.dataset.id);
    if (id && gallerySelectedIds.has(id)) cell.classList.add('selected');
  });
  updateBulkDeleteBar();
}

async function requestGalleryBulkDelete() {
  var ids = Array.from(gallerySelectedIds);
  if (!ids.length) return;
  if (!confirm('Hapus permanen ' + ids.length + ' item? File akan dihapus dari database dan Cloudflare R2.')) return;
  var token = localStorage.getItem('token');
  if (!token) return;
  try {
    var res = await fetch('/gallery/bulk-delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ ids: ids }),
    });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok || !data.ok) {
      alert('Gagal hapus: ' + ((data && data.error) || res.status));
      return;
    }
    var deletedCount = (data.deleted && data.deleted.length) || 0;
    var failCount = (data.failed && data.failed.length) || 0;
    if (failCount > 0) alert(failCount + ' item gagal dihapus.');
    var pageToReload = galleryCurrentPage;
    if (deletedCount >= galleryItems.length && galleryCurrentPage > 1) {
      pageToReload = galleryCurrentPage - 1;
    }
    setGallerySelectMode(false);
    galleryGrid.innerHTML = '';
    await loadGalleryPage(pageToReload);
  } catch (err) {
    alert('Gagal hapus: ' + (err.message || err));
  }
}

function positionGalleryMenu(menuEl, btn) {
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  var btnRect = btn.getBoundingClientRect();
  var mw = menuEl.offsetWidth;
  var mh = menuEl.offsetHeight;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var margin = 8;
  var top = btnRect.top - mh - 6;
  if (top < margin) top = btnRect.bottom + 6;
  if (top + mh > vh - margin) top = Math.max(margin, vh - margin - mh);
  var left = btnRect.right - mw;
  if (left < margin) left = margin;
  if (left + mw > vw - margin) left = vw - margin - mw;
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

function attachGalleryMenu(cell, id) {
  var items = [
    '<button class="gallery-menu-item" type="button" role="menuitem" data-action="view"><span class="gallery-menu-icon">💬</span><span class="gallery-menu-label">Lihat di chat</span></button>'
  ];
  if (isHub()) {
    items.push('<button class="gallery-menu-item gallery-menu-item-danger" type="button" role="menuitem" data-action="delete"><span class="gallery-menu-icon">🗑</span><span class="gallery-menu-label">Hapus permanen</span></button>');
  }
  var markup =
    '<button class="gallery-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Aksi" title="Aksi">⋯</button>' +
    '<div class="gallery-menu hidden" role="menu">' + items.join('') + '</div>';
  cell.insertAdjacentHTML('beforeend', markup);
  var menuBtn = cell.querySelector('.gallery-menu-btn');
  var menuEl = cell.querySelector('.gallery-menu');
  if (!menuBtn || !menuEl) return;
  menuBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var isOpen = !menuEl.classList.contains('hidden');
    closeOpenMsgMenu();
    if (!isOpen) {
      menuEl.classList.remove('hidden');
      menuBtn.setAttribute('aria-expanded', 'true');
      openMsgMenu = menuEl;
      openMsgMenuBtn = menuBtn;
      positionGalleryMenu(menuEl, menuBtn);
    }
  });
  menuEl.querySelectorAll('.gallery-menu-item').forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      var action = item.dataset.action;
      closeOpenMsgMenu();
      if (action === 'view') {
        closeGallery();
        jumpToMessage(id);
      } else if (action === 'delete') {
        requestGalleryDelete(id);
      }
    });
  });
}

async function requestGalleryDelete(id) {
  if (!id) return;
  if (!confirm('Hapus permanen? File akan dihapus dari database dan Cloudflare R2.')) return;
  var token = localStorage.getItem('token');
  if (!token) return;
  try {
    var res = await fetch('/gallery/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok || !data.ok) {
      alert('Gagal hapus: ' + ((data && data.error) || res.status));
      return;
    }
    var pageToReload = galleryCurrentPage;
    if (galleryItems.length === 1 && galleryCurrentPage > 1) pageToReload = galleryCurrentPage - 1;
    galleryGrid.innerHTML = '';
    await loadGalleryPage(pageToReload);
  } catch (err) {
    alert('Gagal hapus: ' + (err.message || err));
  }
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
  var selBtn = document.getElementById('gallery-select-btn');
  if (selBtn) selBtn.classList.toggle('hidden', !isHub());
  setGallerySelectMode(false);
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
  setGallerySelectMode(false);
  if (imageViewer.classList.contains('hidden')) document.body.style.overflow = '';
}

galleryBtn.addEventListener('click', openGallery);
if (gameBtn) {
  gameBtn.addEventListener('click', () => {
    if (window.MiniGames) window.MiniGames.open();
  });
}
galleryClose.addEventListener('click', closeGallery);
document.getElementById('gallery-prev').addEventListener('click', goToPrevPage);
document.getElementById('gallery-next').addEventListener('click', goToNextPage);
document.getElementById('gallery-select-btn').addEventListener('click', function() {
  setGallerySelectMode(!gallerySelectMode);
});
document.getElementById('gallery-select-all').addEventListener('click', selectAllGalleryItems);
document.getElementById('gallery-bulk-delete').addEventListener('click', requestGalleryBulkDelete);
galleryGrid.addEventListener('scroll', function() {
  if (openMsgMenu && openMsgMenu.classList.contains('gallery-menu')) closeOpenMsgMenu();
});
window.addEventListener('resize', function() {
  if (openMsgMenu && openMsgMenu.classList.contains('gallery-menu')) closeOpenMsgMenu();
});

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
  setPendingViewOnce(false);
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
    var isVO = pendingViewOnce;
    var audioMsg = { dataUrl: dataUrl, replyToId: replyToId, replyTo: replyToSnap };
    if (isVO) audioMsg.caption = VIEW_ONCE_MARKER;
    queueMessage('audio', audioMsg);
    setPendingViewOnce(false);
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

const truthDareBtn = document.getElementById('truth-dare-btn');
if (truthDareBtn) {
  truthDareBtn.addEventListener('click', function() {
    if (!currentPeer) return;
    if (!socket || !socket.connected) return;
    truthDareBtn.disabled = true;
    socket.emit('truth-dare:challenge', { peer: currentPeer }, function(ack) {
      truthDareBtn.disabled = false;
      if (ack && ack.error) alert('Gagal mulai Truth or Dare: ' + ack.error);
    });
  });
}

logoutBtn.addEventListener('click', function() {
  if (socket) socket.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  hideMessagesLoading();
  chatView.classList.add('hidden');
  panicBtn.classList.add('hidden');
  hideServerInfo();
  loginView.classList.remove('hidden');
  if (presenceTimerId) { clearInterval(presenceTimerId); presenceTimerId = null; }
  if (presenceBtn) presenceBtn.classList.add('hidden');
  sendTypingStop();
  Object.keys(typingExpireTimers).forEach((k) => { clearTimeout(typingExpireTimers[k]); delete typingExpireTimers[k]; });
  Object.keys(typingState).forEach((k) => delete typingState[k]);
  presenceEl.classList.add('hidden');
  presenceEl.classList.remove('online');
  if (presenceTextEl) presenceTextEl.textContent = '';
  typingIndicatorEl.classList.add('hidden');
  typingNameEl.textContent = '';
  peerSwitcherEl.classList.add('hidden');
  if (partnerAvatarEl) {
    partnerAvatarEl.classList.add('hidden');
    partnerAvatarEl.textContent = '';
  }
  Object.keys(avatarState).forEach((k) => delete avatarState[k]);
  closeAvatarModal();
  closeJournalModal();
  journalState.entries = [];
  journalState.peer = null;
  journalState.editingId = null;
  closePeerMenu();
  currentPeer = null;
  availablePeers = [];
  Object.keys(unreadByPeer).forEach((k) => delete unreadByPeer[k]);
  Object.keys(readStateMap).forEach((k) => delete readStateMap[k]);
  Object.keys(drafts).forEach((k) => delete drafts[k]);
  msgInput.value = '';
  autoResizeMsgInput();
});

const BIRTHDAY_PANIC_USERS = new Set(['occupatus', 'turki']);
const BIRTHDAY_PANIC_DATE = '2026-08-17';
function isBirthdayPanicDay() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}` === BIRTHDAY_PANIC_DATE;
}
function applyBirthdayPanic(username) {
  if (!panicBtn) return;
  if (BIRTHDAY_PANIC_USERS.has(username) && isBirthdayPanicDay()) {
    panicBtn.classList.add('birthday-mode');
    panicBtn.setAttribute('aria-label', 'Happy Birthday');
    panicBtn.setAttribute('title', 'Happy Birthday!');
    panicBtn.innerHTML =
      '<div class="birthday-marquee">' +
        '<div class="birthday-track birthday-main"><span>HAPPY BIRTHDAY TO YOU CANTIK<span class="birthday-heart">❤</span></span></div>' +
        '<div class="birthday-track birthday-sub"><span>Semoga panjang umur dan sehat selalu sayangku, luv u <span class="birthday-heart">❤</span></span></div>' +
      '</div>';
    showGiftButton();
  } else {
    panicBtn.classList.remove('birthday-mode');
    panicBtn.setAttribute('aria-label', 'Panic');
    panicBtn.setAttribute('title', 'Panic: clear session & leave');
    panicBtn.textContent = '🚨';
    hideGiftButton();
  }
}

const BIRTHDAY_GIFT_IMAGE = '/pajero.jpeg';
let giftBtnEl = null;
let giftModalEl = null;
function ensureGiftElements() {
  if (!giftBtnEl) {
    giftBtnEl = document.createElement('button');
    giftBtnEl.id = 'gift-btn';
    giftBtnEl.type = 'button';
    giftBtnEl.setAttribute('aria-label', 'Buka hadiah');
    giftBtnEl.innerHTML = '<span class="gift-emoji">🎁</span><span class="gift-label">Buka Hadiah</span>';
    giftBtnEl.addEventListener('click', openGiftModal);
    document.body.appendChild(giftBtnEl);
  }
  if (!giftModalEl) {
    giftModalEl = document.createElement('div');
    giftModalEl.id = 'gift-modal';
    giftModalEl.className = 'hidden';
    giftModalEl.innerHTML =
      '<div class="gift-backdrop"></div>' +
      '<div class="gift-content" role="dialog" aria-modal="true" aria-label="Hadiah">' +
        '<button type="button" class="gift-close" aria-label="Tutup">×</button>' +
        '<img class="gift-image" alt="Hadiah" />' +
        '<div class="gift-caption">otw nichhh</div>' +
      '</div>';
    document.body.appendChild(giftModalEl);
    giftModalEl.querySelector('.gift-backdrop').addEventListener('click', closeGiftModal);
    giftModalEl.querySelector('.gift-close').addEventListener('click', closeGiftModal);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && giftModalEl && !giftModalEl.classList.contains('hidden')) {
        closeGiftModal();
      }
    });
  }
}
function showGiftButton() {
  ensureGiftElements();
  giftBtnEl.classList.remove('hidden');
}
function hideGiftButton() {
  if (giftBtnEl) giftBtnEl.classList.add('hidden');
  closeGiftModal();
}
function openGiftModal() {
  ensureGiftElements();
  const img = giftModalEl.querySelector('.gift-image');
  if (img && img.getAttribute('src') !== BIRTHDAY_GIFT_IMAGE) {
    img.setAttribute('src', BIRTHDAY_GIFT_IMAGE);
  }
  giftModalEl.classList.remove('hidden');
}
function closeGiftModal() {
  if (giftModalEl) giftModalEl.classList.add('hidden');
}

let panicFired = false;
function runPanic() {
  if (panicFired) return;
  panicFired = true;
  try { if (socket) socket.disconnect(); } catch (_) {}
  try { localStorage.clear(); } catch (_) {}
  try { sessionStorage.clear(); } catch (_) {}
  try { window.close(); } catch (_) {}
  try {
    location.replace('https://www.google.com');
  } catch (_) {
    location.href = 'https://www.google.com';
  }
}

panicBtn.addEventListener('click', function() {
  try {
    if (socket && socket.connected) {
      socket.emit('panic:trigger', { peer: currentPeer }, function() { runPanic(); });
      setTimeout(runPanic, 400);
      return;
    }
  } catch (_) {}
  runPanic();
});

const serverPickerBtn = document.getElementById('server-picker-btn');
const serverPickerModal = document.getElementById('server-picker-modal');
const serverPickerCloseBtn = document.getElementById('server-picker-close');
const serverPickerCancelBtn = document.getElementById('server-picker-cancel');
const serverPickerSaveBtn = document.getElementById('server-picker-save');
const serverPickerOptionsEl = document.getElementById('server-picker-options');
const serverPickerErrorEl = document.getElementById('server-picker-error');
const serverPickerPeersStateEl = document.getElementById('server-picker-peers-state');
const serverPickerPeersListEl = document.getElementById('server-picker-peers-list');

const SERVER_INFO_FALLBACK = [
  { key: 'chat00', host: 'test-chat-ewz1.onrender.com', display: 'bit.ly/chat00' },
  { key: 'test-doang', host: 'test-doang.onrender.com', display: 'bit.ly/test-doang' },
];

function detectServerKeyFromHost() {
  const host = (window.location && window.location.host) || '';
  const found = SERVER_INFO_FALLBACK.find((s) => s.host === host);
  return found ? found.key : null;
}

const serverInfoState = {
  activeKey: null,
  serverKey: null,
  match: false,
  canEdit: false,
  options: [],
  pickerSelectedKey: null,
};

function updateServerPickerBtn() {
  if (!serverPickerBtn) return;
  if (serverInfoState.canEdit) serverPickerBtn.classList.remove('hidden');
  else serverPickerBtn.classList.add('hidden');
}

function renderServerPickerOptions() {
  if (!serverPickerOptionsEl) return;
  serverPickerOptionsEl.innerHTML = '';
  for (const opt of serverInfoState.options) {
    const label = document.createElement('label');
    label.className = 'server-picker-option';
    if (opt.key === serverInfoState.activeKey) label.classList.add('is-current');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'server-picker';
    input.value = opt.key;
    input.checked = opt.key === serverInfoState.pickerSelectedKey;
    input.addEventListener('change', () => {
      serverInfoState.pickerSelectedKey = opt.key;
      updateServerPickerSaveBtn();
    });
    const text = document.createElement('span');
    text.textContent = opt.display + (opt.key === serverInfoState.activeKey ? ' (aktif)' : '');
    label.appendChild(input);
    label.appendChild(text);
    serverPickerOptionsEl.appendChild(label);
  }
}

function updateServerPickerSaveBtn() {
  if (!serverPickerSaveBtn) return;
  const sel = serverInfoState.pickerSelectedKey;
  serverPickerSaveBtn.disabled = !sel || sel === serverInfoState.activeKey;
}

function showServerPickerError(msg) {
  if (!serverPickerErrorEl) return;
  if (!msg) {
    serverPickerErrorEl.textContent = '';
    serverPickerErrorEl.classList.add('hidden');
  } else {
    serverPickerErrorEl.textContent = msg;
    serverPickerErrorEl.classList.remove('hidden');
  }
}

function openServerPickerModal() {
  if (!serverPickerModal || !serverInfoState.canEdit) return;
  serverInfoState.pickerSelectedKey = serverInfoState.activeKey;
  showServerPickerError('');
  renderServerPickerOptions();
  updateServerPickerSaveBtn();
  serverPickerModal.classList.remove('hidden');
  closeHeaderMenu && closeHeaderMenu();
  loadPeerServerStatus();
}

const peerServerState = { rows: [] };

function formatPeerServerTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return ''; }
}

function renderPeerServerList() {
  if (!serverPickerPeersListEl || !serverPickerPeersStateEl) return;
  const rows = peerServerState.rows;
  if (!rows.length) {
    serverPickerPeersListEl.classList.add('hidden');
    serverPickerPeersStateEl.classList.remove('hidden');
    serverPickerPeersStateEl.textContent = 'Belum ada peer yang tercatat.';
    return;
  }
  serverPickerPeersStateEl.classList.add('hidden');
  serverPickerPeersListEl.classList.remove('hidden');
  serverPickerPeersListEl.innerHTML = '';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'server-picker-peer';
    const left = document.createElement('div');
    left.className = 'server-picker-peer-left';
    const badge = document.createElement('span');
    badge.className = 'server-picker-peer-badge ' + (row.match ? 'ok' : 'bad');
    badge.textContent = row.match ? '✓' : '✕';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'server-picker-peer-name';
    name.textContent = row.username;
    const meta = document.createElement('div');
    meta.className = 'server-picker-peer-meta';
    const time = formatPeerServerTime(row.lastSeen);
    meta.textContent = (row.serverDisplay || row.serverKey) + (time ? ' • ' + time : '');
    info.appendChild(name);
    info.appendChild(meta);
    left.appendChild(badge);
    left.appendChild(info);
    li.appendChild(left);
    serverPickerPeersListEl.appendChild(li);
  }
}

function upsertPeerServerRow(payload) {
  const activeKey = serverInfoState.activeKey;
  const row = {
    username: String(payload.username),
    serverKey: String(payload.serverKey || ''),
    serverDisplay: String(payload.serverDisplay || payload.serverKey || ''),
    lastSeen: String(payload.lastSeen || ''),
    match: activeKey ? String(payload.serverKey) === activeKey : false,
  };
  const idx = peerServerState.rows.findIndex((r) => r.username === row.username);
  if (idx >= 0) peerServerState.rows[idx] = row;
  else peerServerState.rows.unshift(row);
  peerServerState.rows.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  if (serverPickerModal && !serverPickerModal.classList.contains('hidden')) {
    renderPeerServerList();
  }
}

function recomputePeerServerMatches() {
  const activeKey = serverInfoState.activeKey;
  if (!activeKey || !peerServerState.rows.length) return;
  for (const r of peerServerState.rows) r.match = r.serverKey === activeKey;
  if (serverPickerModal && !serverPickerModal.classList.contains('hidden')) {
    renderPeerServerList();
  }
}

async function loadPeerServerStatus() {
  if (!serverInfoState.canEdit) return;
  if (!serverPickerPeersStateEl || !serverPickerPeersListEl) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  serverPickerPeersStateEl.classList.remove('hidden');
  serverPickerPeersStateEl.textContent = 'Memuat…';
  serverPickerPeersListEl.classList.add('hidden');
  try {
    const res = await fetch('/peer-server-status', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    peerServerState.rows = Array.isArray(data.peers) ? data.peers : [];
    renderPeerServerList();
  } catch (err) {
    serverPickerPeersStateEl.textContent = 'Gagal memuat: ' + (err.message || err);
    serverPickerPeersStateEl.classList.remove('hidden');
    serverPickerPeersListEl.classList.add('hidden');
  }
}

function closeServerPickerModal() {
  if (!serverPickerModal) return;
  serverPickerModal.classList.add('hidden');
}

async function submitServerPicker() {
  const key = serverInfoState.pickerSelectedKey;
  const token = localStorage.getItem('token');
  if (!token || !key || key === serverInfoState.activeKey) return;
  serverPickerSaveBtn.disabled = true;
  showServerPickerError('');
  try {
    const res = await fetch('/active-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    serverInfoState.activeKey = data.activeKey;
    serverInfoState.match = serverInfoState.serverKey === data.activeKey;
    closeServerPickerModal();
    attemptRedirectToActive();
  } catch (err) {
    showServerPickerError('Gagal simpan: ' + (err.message || err));
    serverPickerSaveBtn.disabled = false;
  }
}

function applyServerInfoFallback() {
  const detected = detectServerKeyFromHost();
  const fallbackOptions = SERVER_INFO_FALLBACK.map(({ key, display }) => ({ key, display }));
  serverInfoState.options = fallbackOptions;
  serverInfoState.serverKey = detected;
  serverInfoState.activeKey = detected;
  serverInfoState.match = false;
  serverInfoState.canEdit = false;
  updateServerPickerBtn();
}

async function loadServerInfo() {
  const token = localStorage.getItem('token');
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  try {
    const res = await fetch('/active-server', { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { applyServerInfoFallback(); return; }
    serverInfoState.activeKey = data.activeKey;
    serverInfoState.serverKey = data.serverKey;
    serverInfoState.match = !!data.match;
    serverInfoState.canEdit = !!data.canEdit;
    serverInfoState.options = Array.isArray(data.options) && data.options.length
      ? data.options
      : SERVER_INFO_FALLBACK.map(({ key, display }) => ({ key, display }));
    updateServerPickerBtn();
    evaluateServerMismatch();
  } catch (_) {
    applyServerInfoFallback();
  }
}

function evaluateServerMismatch() {
  const activeKey = serverInfoState.activeKey;
  if (!activeKey) { hideServerMismatchBanner(); return; }
  const detected = detectServerKeyFromHost();
  if (!detected) { hideServerMismatchBanner(); return; }
  if (detected === activeKey) { hideServerMismatchBanner(); return; }
  showServerMismatchBanner();
}

function showServerMismatchBanner() {
  const banner = document.getElementById('server-mismatch-banner');
  if (!banner) return;
  const activeKey = serverInfoState.activeKey;
  const active = SERVER_INFO_FALLBACK.find((s) => s.key === activeKey);
  const targetEl = document.getElementById('server-mismatch-banner-target');
  if (targetEl) {
    const opt = (serverInfoState.options || []).find((o) => o.key === activeKey);
    targetEl.textContent = (opt && opt.display) || (active && active.display) || activeKey;
  }
  banner.classList.remove('hidden');
  if (chatView) chatView.classList.add('hidden');
}

function hideServerMismatchBanner() {
  const banner = document.getElementById('server-mismatch-banner');
  if (banner) banner.classList.add('hidden');
  if (chatView && localStorage.getItem('token')) chatView.classList.remove('hidden');
}

function attemptRedirectToActive() {
  const activeKey = serverInfoState.activeKey;
  if (!activeKey) return false;
  const active = SERVER_INFO_FALLBACK.find((s) => s.key === activeKey);
  if (!active) return false;
  const currentHost = (window.location && window.location.host) || '';
  if (currentHost === active.host) return false;
  const detected = detectServerKeyFromHost();
  if (!detected) return false;
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('username');
  const parts = [];
  if (token && user) {
    parts.push('t=' + encodeURIComponent(token));
    parts.push('u=' + encodeURIComponent(user));
  }
  const hash = parts.length ? '#' + parts.join('&') : '';
  const target = 'https://' + active.host + window.location.pathname + window.location.search + hash;
  window.location.replace(target);
  return true;
}

function hideServerInfo() {
  serverInfoState.activeKey = null;
  if (serverPickerBtn) serverPickerBtn.classList.add('hidden');
  closeServerPickerModal();
  hideServerMismatchBanner();
}

const serverMismatchGoBtn = document.getElementById('server-mismatch-banner-go');
if (serverMismatchGoBtn) {
  serverMismatchGoBtn.addEventListener('click', () => { attemptRedirectToActive(); });
}

if (serverPickerBtn) serverPickerBtn.addEventListener('click', openServerPickerModal);
if (serverPickerCloseBtn) serverPickerCloseBtn.addEventListener('click', closeServerPickerModal);
if (serverPickerCancelBtn) serverPickerCancelBtn.addEventListener('click', closeServerPickerModal);
if (serverPickerSaveBtn) serverPickerSaveBtn.addEventListener('click', submitServerPicker);
if (serverPickerModal) {
  serverPickerModal.addEventListener('click', (e) => {
    if (e.target === serverPickerModal) closeServerPickerModal();
  });
}

const avatarModal = document.getElementById('avatar-modal');
const avatarPreviewEl = document.getElementById('avatar-preview');
const avatarPresetGrid = document.getElementById('avatar-preset-grid');
const avatarErrorEl = document.getElementById('avatar-error');
const avatarModalCloseBtn = document.getElementById('avatar-modal-close');
const avatarRemoveBtn = document.getElementById('avatar-remove');

let avatarPresetGroups = null;
let avatarActiveGroupId = null;

function showAvatarError(msg) {
  if (!avatarErrorEl) return;
  if (!msg) {
    avatarErrorEl.textContent = '';
    avatarErrorEl.classList.add('hidden');
    return;
  }
  avatarErrorEl.textContent = msg;
  avatarErrorEl.classList.remove('hidden');
}

function renderAvatarPreview() {
  if (!avatarPreviewEl || !me) return;
  const val = avatarState[me];
  avatarPreviewEl.innerHTML = '';
  if (val) {
    const span = document.createElement('span');
    span.textContent = val;
    avatarPreviewEl.appendChild(span);
  } else {
    const initial = document.createElement('span');
    initial.className = 'user-avatar-initial';
    initial.textContent = (me || '?').charAt(0).toUpperCase();
    avatarPreviewEl.appendChild(initial);
  }
}

function markSelectedPreset() {
  if (!avatarPresetGrid) return;
  const current = avatarState[me] || null;
  avatarPresetGrid.querySelectorAll('.avatar-preset-item').forEach((btn) => {
    const isSelected = btn.dataset.preset === current;
    btn.classList.toggle('selected', isSelected);
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
}

function renderAvatarPicker() {
  if (!avatarPresetGrid || !avatarPresetGroups) return;
  avatarPresetGrid.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'avatar-tabs';
  avatarPresetGroups.forEach((g) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'avatar-tab' + (g.id === avatarActiveGroupId ? ' active' : '');
    tab.textContent = g.label;
    tab.addEventListener('click', () => {
      avatarActiveGroupId = g.id;
      renderAvatarPicker();
    });
    tabs.appendChild(tab);
  });
  avatarPresetGrid.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'avatar-preset-list';
  const active = avatarPresetGroups.find((g) => g.id === avatarActiveGroupId) || avatarPresetGroups[0];
  (active.items || []).forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-preset-item';
    btn.dataset.preset = emoji;
    btn.setAttribute('role', 'option');
    btn.textContent = emoji;
    btn.title = emoji;
    btn.addEventListener('click', () => saveAvatarPreset(emoji));
    grid.appendChild(btn);
  });
  avatarPresetGrid.appendChild(grid);
  markSelectedPreset();
}

async function ensureAvatarPresets() {
  if (avatarPresetGroups) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  const resp = await fetch('/avatars', { headers: { Authorization: 'Bearer ' + token } });
  if (!resp.ok) throw new Error('Gagal memuat pilihan avatar');
  const data = await resp.json();
  if (!data || !Array.isArray(data.presetGroups)) throw new Error('Data avatar tidak valid');
  avatarPresetGroups = data.presetGroups;
  if (!avatarActiveGroupId) avatarActiveGroupId = avatarPresetGroups[0] && avatarPresetGroups[0].id;
  if (data.avatars && typeof data.avatars === 'object') {
    Object.entries(data.avatars).forEach(([u, val]) => { avatarState[u] = val || null; });
  }
}

async function saveAvatarPreset(preset) {
  showAvatarError('');
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const resp = await fetch('/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ preset }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) {
      showAvatarError((data && data.error) || 'Gagal menyimpan avatar');
    }
  } catch (err) {
    showAvatarError('Gagal menyimpan: ' + (err.message || err));
  }
}

async function removeAvatar() {
  showAvatarError('');
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const resp = await fetch('/avatar', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) {
      showAvatarError((data && data.error) || 'Gagal menghapus avatar');
    }
  } catch (err) {
    showAvatarError('Gagal menghapus: ' + (err.message || err));
  }
}

async function openAvatarModal() {
  if (!avatarModal) return;
  showAvatarError('');
  renderAvatarPreview();
  avatarModal.classList.remove('hidden');
  try {
    await ensureAvatarPresets();
    renderAvatarPicker();
  } catch (err) {
    showAvatarError(err.message || 'Gagal memuat');
  }
}

function closeAvatarModal() {
  if (avatarModal) avatarModal.classList.add('hidden');
  showAvatarError('');
}

if (meNameEl) {
  meNameEl.addEventListener('click', openAvatarModal);
  meNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAvatarModal();
    }
  });
}
if (avatarModalCloseBtn) avatarModalCloseBtn.addEventListener('click', closeAvatarModal);
if (avatarRemoveBtn) avatarRemoveBtn.addEventListener('click', removeAvatar);
if (avatarModal) {
  avatarModal.addEventListener('click', (e) => {
    if (e.target === avatarModal) closeAvatarModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && avatarModal && !avatarModal.classList.contains('hidden')) closeAvatarModal();
});

const THEMES = [
  { id: 'merdeka', label: 'Merdeka 🇮🇩', icon: '🇮🇩', swatch: 'linear-gradient(180deg,#ce1126 0 50%,#fff 50% 100%)', metaColor: '#ce1126' },
  { id: 'light', label: 'Cream', icon: '🌤', swatch: '#ffe7c4', metaColor: '#2563eb' },
  { id: 'dark', label: 'Dark', icon: '🌙', swatch: '#141414', metaColor: '#141414' },
  { id: 'ocean', label: 'Ocean', icon: '🌊', swatch: '#cfe7ed', metaColor: '#2a8fa0' },
  { id: 'forest', label: 'Forest', icon: '🌿', swatch: '#e3d9b0', metaColor: '#6ba368' },
  { id: 'sunset', label: 'Sunset', icon: '🌅', swatch: '#fbc7e0', metaColor: '#d84f9a' },
];
const DEFAULT_THEME = 'light';

function updateMerdekaConfetti(themeId) {
  var existing = document.getElementById('merdeka-confetti');
  if (themeId !== 'merdeka') {
    if (existing) existing.remove();
    removeMerdekaFlags();
    return;
  }
  ensureMerdekaFlags();
  if (existing) return;
  var container = document.createElement('div');
  container.id = 'merdeka-confetti';
  container.setAttribute('aria-hidden', 'true');
  var COUNT = 32;
  var frag = document.createDocumentFragment();
  for (var i = 0; i < COUNT; i++) {
    var piece = document.createElement('span');
    piece.className = 'merdeka-piece ' + (i % 2 === 0 ? 'red' : 'white');
    var size = 6 + Math.random() * 8;
    piece.style.left = (Math.random() * 100) + 'vw';
    piece.style.width = size + 'px';
    piece.style.height = (size + 4 + Math.random() * 8) + 'px';
    piece.style.animationDuration = (6 + Math.random() * 6) + 's';
    piece.style.animationDelay = (-Math.random() * 10) + 's';
    piece.style.setProperty('--drift', ((Math.random() - 0.5) * 160) + 'px');
    piece.style.setProperty('--spin', (Math.random() > 0.5 ? 1 : -1) * (360 + Math.floor(Math.random() * 720)) + 'deg');
    frag.appendChild(piece);
  }
  container.appendChild(frag);
  document.body.appendChild(container);
}

function ensureMerdekaFlags() {
  if (document.getElementById('merdeka-flags')) return;
  var wrap = document.createElement('div');
  wrap.id = 'merdeka-flags';
  wrap.setAttribute('aria-hidden', 'true');
  var svg =
    "<svg viewBox='0 0 40 60' xmlns='http://www.w3.org/2000/svg'>" +
      "<rect x='19' y='0' width='2' height='60' fill='#3a0a0a'/>" +
      "<rect x='21' y='2' width='18' height='10' fill='#ce1126' stroke='#3a0a0a' stroke-width='1'/>" +
      "<rect x='21' y='12' width='18' height='10' fill='#ffffff' stroke='#3a0a0a' stroke-width='1'/>" +
    "</svg>";
  wrap.innerHTML =
    '<span class="merdeka-flag corner-tl">' + svg + '</span>' +
    '<span class="merdeka-flag corner-tr">' + svg + '</span>';
  document.body.appendChild(wrap);
}

function removeMerdekaFlags() {
  var el = document.getElementById('merdeka-flags');
  if (el) el.remove();
}
const themeMenuEl = document.getElementById('theme-menu');

function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (THEMES.find((t) => t.id === attr)) return attr;
  return attr ? 'light' : DEFAULT_THEME;
}
function applyTheme(themeId) {
  const theme = THEMES.find((t) => t.id === themeId) || THEMES.find((t) => t.id === DEFAULT_THEME) || THEMES[0];
  if (theme.id === 'light') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme.id);
  try { localStorage.setItem('theme', theme.id); } catch (e) {}
  updateMerdekaConfetti(theme.id);
  if (themeToggleBtn) {
    const iconEl = themeToggleBtn.querySelector('.theme-toggle-icon') || themeToggleBtn;
    iconEl.textContent = theme.icon;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.metaColor);
  renderThemeMenu();
}
function renderThemeMenu() {
  if (!themeMenuEl) return;
  const active = currentTheme();
  themeMenuEl.innerHTML = '';
  THEMES.forEach((theme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-menu-item' + (theme.id === active ? ' active' : '');
    btn.setAttribute('role', 'menuitem');
    const swatch = document.createElement('span');
    swatch.className = 'theme-menu-swatch';
    swatch.style.background = theme.swatch;
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(theme.label));
    btn.addEventListener('click', () => {
      closeThemeMenu();
      applyTheme(theme.id);
      saveThemeToServer(theme.id);
    });
    themeMenuEl.appendChild(btn);
  });
}
function openThemeMenu() {
  document.dispatchEvent(new CustomEvent('header:submenu:open', { detail: 'theme' }));
  renderThemeMenu();
  if (themeMenuEl) themeMenuEl.classList.remove('hidden');
  if (themeToggleBtn) themeToggleBtn.setAttribute('aria-expanded', 'true');
}
function closeThemeMenu() {
  if (themeMenuEl) themeMenuEl.classList.add('hidden');
  if (themeToggleBtn) themeToggleBtn.setAttribute('aria-expanded', 'false');
}
function toggleThemeMenu() {
  if (!themeMenuEl) return;
  if (themeMenuEl.classList.contains('hidden')) openThemeMenu();
  else closeThemeMenu();
}
applyTheme(currentTheme());
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThemeMenu();
  });
}
document.addEventListener('click', (e) => {
  if (!themeMenuEl || themeMenuEl.classList.contains('hidden')) return;
  if (!themeMenuEl.contains(e.target) && e.target !== themeToggleBtn) closeThemeMenu();
});
document.addEventListener('header:submenu:open', (e) => {
  if (e.detail !== 'theme') closeThemeMenu();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
document.addEventListener('header:menu:close', () => closeThemeMenu());

(function consumeAuthHash() {
  try {
    if (!window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const t = params.get('t');
    const u = params.get('u');
    if (t && u) {
      localStorage.setItem('token', t);
      localStorage.setItem('username', u);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch (_) {}
})();

loadServerInfo();

var savedToken = localStorage.getItem('token');
var savedUser = localStorage.getItem('username');
if (savedToken && savedUser) {
  startChat(savedToken, savedUser);
}