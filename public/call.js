(function () {
  'use strict';

  const FALLBACK_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const ICE_CACHE_MS = 50 * 60 * 1000;
  let iceCache = { servers: null, expiresAt: 0 };
  let getAuthToken = () => null;
  let getMe = () => null;
  const SHARE_ALLOWED_USERS = new Set(['occupatus', 'ocean']);

  async function loadIceServers() {
    const now = Date.now();
    if (iceCache.servers && iceCache.expiresAt > now) return iceCache.servers;
    try {
      const token = getAuthToken();
      const resp = await fetch('/ice-servers', {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const servers = (data && Array.isArray(data.iceServers) && data.iceServers.length)
        ? data.iceServers
        : FALLBACK_ICE;
      iceCache = { servers, expiresAt: now + ICE_CACHE_MS };
      return servers;
    } catch (err) {
      console.warn('ice-servers fetch failed, using fallback STUN:', err.message);
      return FALLBACK_ICE;
    }
  }

  const RING_TIMEOUT_MS = 45000;

  const STATE = {
    IDLE: 'idle',
    OUTGOING: 'outgoing',
    INCOMING: 'incoming',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    ENDED: 'ended',
  };

  const dom = {};
  let ready = false;
  let socket = null;

  const call = {
    state: STATE.IDLE,
    role: null,
    peer: null,
    callId: null,
    media: 'video',
    pc: null,
    localStream: null,
    remoteStream: null,
    pendingCandidates: [],
    remoteDescSet: false,
    ringTimer: null,
    connectTimer: null,
    startedAt: null,
    ringtone: null,
    facingMode: 'user',
    switching: false,
    sharing: false,
    shareBusy: false,
    screenStream: null,
    savedCameraTrack: null,
    savedMicTrack: null,
    mixerCtx: null,
  };

  function $(id) { return document.getElementById(id); }

  function initDom() {
    dom.callBtn = $('call-btn');
    dom.modal = $('call-modal');
    dom.remoteVideo = $('call-remote-video');
    dom.localVideo = $('call-local-video');
    dom.placeholder = $('call-remote-placeholder');
    dom.peerName = $('call-peer-name');
    dom.stateEl = $('call-state');
    dom.timer = $('call-timer');
    dom.muteBtn = $('call-mute');
    dom.speakerBtn = $('call-speaker');
    dom.cameraBtn = $('call-camera');
    dom.endBtn = $('call-end');
    dom.minimizeBtn = $('call-minimize');
    dom.expandBtn = $('call-expand');
    dom.pipBtn = $('call-pip');
    dom.switchBtn = $('call-switch');
    dom.selfViewBtn = $('call-self-view');
    dom.shareBtn = $('call-share');
    dom.resizeHandle = $('call-resize-handle');
    dom.dragHint = $('call-drag-hint');
    dom.incoming = $('call-incoming');
    dom.incomingFrom = $('call-incoming-from');
    dom.acceptBtn = $('call-accept');
    dom.declineBtn = $('call-decline');

    dom.callBtn.addEventListener('click', onCallBtnClick);
    dom.endBtn.addEventListener('click', () => endCall('ended'));
    dom.muteBtn.addEventListener('click', toggleMute);
    dom.speakerBtn.addEventListener('click', toggleSpeaker);
    dom.cameraBtn.addEventListener('click', toggleCamera);
    dom.minimizeBtn.addEventListener('click', minimize);
    dom.expandBtn.addEventListener('click', expand);
    dom.pipBtn.addEventListener('click', togglePip);
    dom.switchBtn.addEventListener('click', switchCamera);
    dom.selfViewBtn.addEventListener('click', toggleSelfView);
    dom.shareBtn.addEventListener('click', toggleScreenShare);
    dom.acceptBtn.addEventListener('click', acceptCall);
    dom.declineBtn.addEventListener('click', () => rejectCall('declined'));

    if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
      dom.pipBtn.classList.remove('hidden');
    }
    detectMultipleCameras().then((multi) => {
      if (multi) dom.switchBtn.classList.remove('hidden');
    });
    updateShareBtnVisibility();
    dom.remoteVideo.addEventListener('leavepictureinpicture', () => {
      if (call.state === STATE.CONNECTED) expand();
    });
    dom.remoteVideo.addEventListener('loadedmetadata', updateRemoteRotation);
    dom.remoteVideo.addEventListener('resize', updateRemoteRotation);
    window.addEventListener('resize', updateRemoteRotation);

    setupDragAndResize();

    ready = true;
  }

  function setupDragAndResize() {
    const modal = dom.modal;
    const pointers = new Map();
    let mode = null;
    let startX = 0, startY = 0, startL = 0, startT = 0, startW = 0, startH = 0;
    let pinchStartDist = 0, pinchRelX = 0, pinchRelY = 0;
    const MIN_W = 220, MIN_H = 170;

    function pinPosition() {
      const rect = modal.getBoundingClientRect();
      modal.style.left = rect.left + 'px';
      modal.style.top = rect.top + 'px';
      modal.style.right = 'auto';
      modal.style.bottom = 'auto';
      modal.style.width = rect.width + 'px';
      modal.style.height = rect.height + 'px';
    }

    function distance(p1, p2) {
      return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    function captureBaseline() {
      const rect = modal.getBoundingClientRect();
      startL = rect.left;
      startT = rect.top;
      startW = rect.width;
      startH = rect.height;
    }

    function startPinch() {
      const pts = [...pointers.values()];
      const p1 = pts[0], p2 = pts[1];
      captureBaseline();
      pinchStartDist = Math.max(10, distance(p1, p2));
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      pinchRelX = startW > 0 ? (cx - startL) / startW : 0.5;
      pinchRelY = startH > 0 ? (cy - startT) / startH : 0.5;
      mode = 'pinch';
    }

    modal.addEventListener('pointerdown', (e) => {
      if (!modal.classList.contains('minimized')) return;
      if (e.target.closest('button')) return;
      if (e.target.closest('video')) return;

      pinPosition();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { modal.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();

      if (pointers.size === 1) {
        mode = e.target === dom.resizeHandle ? 'resize' : 'drag';
        captureBaseline();
        startX = e.clientX;
        startY = e.clientY;
      } else if (pointers.size === 2) {
        startPinch();
      }
    });

    modal.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!mode) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (mode === 'pinch' && pointers.size >= 2) {
        const pts = [...pointers.values()];
        const p1 = pts[0], p2 = pts[1];
        const dist = Math.max(10, distance(p1, p2));
        const ratio = dist / pinchStartDist;
        const cx = (p1.x + p2.x) / 2;
        const cy = (p1.y + p2.y) / 2;
        const newW = Math.max(MIN_W, Math.min(vw - 16, startW * ratio));
        const newH = Math.max(MIN_H, Math.min(vh - 16, startH * ratio));
        let nextL = cx - pinchRelX * newW;
        let nextT = cy - pinchRelY * newH;
        nextL = Math.max(8, Math.min(vw - newW - 8, nextL));
        nextT = Math.max(8, Math.min(vh - newH - 8, nextT));
        modal.style.width = newW + 'px';
        modal.style.height = newH + 'px';
        modal.style.left = nextL + 'px';
        modal.style.top = nextT + 'px';
      } else if (mode === 'drag') {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const nextL = Math.max(8, Math.min(vw - startW - 8, startL + dx));
        const nextT = Math.max(8, Math.min(vh - startH - 8, startT + dy));
        modal.style.left = nextL + 'px';
        modal.style.top = nextT + 'px';
      } else if (mode === 'resize') {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxW = vw - startL - 8;
        const maxH = vh - startT - 8;
        modal.style.width = Math.max(MIN_W, Math.min(maxW, startW + dx)) + 'px';
        modal.style.height = Math.max(MIN_H, Math.min(maxH, startH + dy)) + 'px';
      }
    });

    function endGesture(e) {
      if (pointers.has(e.pointerId)) {
        pointers.delete(e.pointerId);
        try { modal.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      if (pointers.size === 0) {
        mode = null;
      } else if (pointers.size === 1 && mode === 'pinch') {
        const remaining = [...pointers.values()][0];
        captureBaseline();
        startX = remaining.x;
        startY = remaining.y;
        mode = 'drag';
      }
    }
    modal.addEventListener('pointerup', endGesture);
    modal.addEventListener('pointercancel', endGesture);
  }

  function clearInlineLayout() {
    if (!ready) return;
    dom.modal.style.left = '';
    dom.modal.style.top = '';
    dom.modal.style.right = '';
    dom.modal.style.bottom = '';
    dom.modal.style.width = '';
    dom.modal.style.height = '';
  }

  function minimize() {
    dom.modal.classList.add('minimized');
    dom.expandBtn.classList.remove('hidden');
    updateRemoteRotation();
  }

  function expand() {
    dom.modal.classList.remove('minimized');
    dom.expandBtn.classList.add('hidden');
    clearInlineLayout();
    if (document.pictureInPictureElement === dom.remoteVideo) {
      document.exitPictureInPicture().catch(() => {});
    }
    updateRemoteRotation();
  }

  function updateRemoteRotation() {
    if (!ready) return;
    const modal = dom.modal;
    const video = dom.remoteVideo;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const landscapeContent = vw > 0 && vh > 0 && vw > vh * 1.1;
    const shouldRotate = portrait && landscapeContent && !modal.classList.contains('minimized') && !modal.classList.contains('hidden');
    modal.classList.toggle('rotate-remote', shouldRotate);
    if (shouldRotate) {
      const wrap = video.parentElement;
      modal.style.setProperty('--rot-w', wrap.clientWidth + 'px');
      modal.style.setProperty('--rot-h', wrap.clientHeight + 'px');
    } else {
      modal.style.removeProperty('--rot-w');
      modal.style.removeProperty('--rot-h');
    }
  }

  async function togglePip() {
    if (!document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement === dom.remoteVideo) {
        await document.exitPictureInPicture();
      } else {
        if (!dom.remoteVideo.srcObject) return;
        await dom.remoteVideo.requestPictureInPicture();
        minimize();
      }
    } catch (err) {
      console.warn('PiP toggle failed:', err.message);
    }
  }

  function setSocket(s) {
    socket = s;
    if (!socket) return;
    socket.on('call:invite', onSocketInvite);
    socket.on('call:accept', onSocketAccept);
    socket.on('call:reject', onSocketReject);
    socket.on('call:ice', onSocketIce);
    socket.on('call:end', onSocketEnd);
  }

  function setCallButtonEnabled(enabled) {
    if (!ready) return;
    if (enabled) dom.callBtn.classList.remove('hidden');
    else dom.callBtn.classList.add('hidden');
  }

  function isBusy() {
    return call.state !== STATE.IDLE && call.state !== STATE.ENDED;
  }

  function setState(next) {
    call.state = next;
    if (!ready) return;
    if (next === STATE.OUTGOING) dom.stateEl.textContent = 'Ringing…';
    else if (next === STATE.INCOMING) dom.stateEl.textContent = 'Incoming call';
    else if (next === STATE.CONNECTING) dom.stateEl.textContent = 'Connecting…';
    else if (next === STATE.CONNECTED) dom.stateEl.textContent = 'Connected';
    else if (next === STATE.ENDED) dom.stateEl.textContent = 'Call ended';
  }

  function showModal() {
    dom.modal.classList.remove('hidden');
  }

  function hideModal() {
    if (document.pictureInPictureElement === dom.remoteVideo) {
      document.exitPictureInPicture().catch(() => {});
    }
    dom.modal.classList.remove('minimized');
    dom.expandBtn.classList.add('hidden');
    clearInlineLayout();
    dom.modal.classList.add('hidden');
    dom.modal.classList.remove('rotate-remote');
    dom.modal.style.removeProperty('--rot-w');
    dom.modal.style.removeProperty('--rot-h');
    dom.timer.classList.add('hidden');
    dom.timer.textContent = '0:00';
    dom.remoteVideo.srcObject = null;
    dom.localVideo.srcObject = null;
    dom.placeholder.classList.remove('hidden');
  }

  function showIncoming(from) {
    dom.incomingFrom.textContent = from;
    dom.incoming.classList.remove('hidden');
    startRingtone();
  }

  function hideIncoming() {
    dom.incoming.classList.add('hidden');
    stopRingtone();
  }

  function startRingtone() {
    stopRingtone();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      gain.connect(ctx.destination);
      let cancelled = false;
      function beep() {
        if (cancelled) return;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 520;
        osc.connect(gain);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
      beep();
      const iv = setInterval(beep, 1400);
      call.ringtone = { stop: () => { cancelled = true; clearInterval(iv); try { ctx.close(); } catch (_) {} } };
    } catch (_) {
      call.ringtone = null;
    }
  }

  function stopRingtone() {
    if (call.ringtone) {
      try { call.ringtone.stop(); } catch (_) {}
      call.ringtone = null;
    }
  }

  function startTimer() {
    call.startedAt = Date.now();
    dom.timer.classList.remove('hidden');
    const tick = () => {
      if (call.state !== STATE.CONNECTED) return;
      const s = Math.floor((Date.now() - call.startedAt) / 1000);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      dom.timer.textContent = mm + ':' + ss;
    };
    tick();
    call.connectTimer = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (call.connectTimer) { clearInterval(call.connectTimer); call.connectTimer = null; }
  }

  function newCallId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function getMedia(withVideo) {
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: call.facingMode }
        : false,
    });
  }

  async function listVideoInputs() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch (_) { return []; }
  }

  async function detectMultipleCameras() {
    const cams = await listVideoInputs();
    return cams.length >= 2;
  }

  async function tryGetVideoStream(constraints) {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  }

  function updateShareBtnVisibility() {
    if (!ready) return;
    const supported = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
    const me = getMe && getMe();
    const allowed = supported && me && SHARE_ALLOWED_USERS.has(me);
    dom.shareBtn.classList.toggle('hidden', !allowed);
  }

  function findSender(kind) {
    if (!call.pc) return null;
    return call.pc.getSenders().find((s) => s.track && s.track.kind === kind) || null;
  }

  async function toggleScreenShare() {
    if (call.shareBusy) return;
    if (call.state !== STATE.CONNECTED && call.state !== STATE.CONNECTING) {
      alert('Screen share hanya bisa saat panggilan tersambung.');
      return;
    }
    if (call.sharing) await stopScreenShare();
    else await startScreenShare();
  }

  async function startScreenShare() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      alert('Browser ini tidak mendukung screen share.');
      return;
    }
    call.shareBusy = true;
    dom.shareBtn.disabled = true;
    let displayStream = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') console.warn('getDisplayMedia:', err);
      call.shareBusy = false;
      dom.shareBtn.disabled = false;
      return;
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    const audioTrack = displayStream.getAudioTracks()[0] || null;
    const videoSender = findSender('video');
    const audioSender = findSender('audio');

    if (videoSender && videoTrack) {
      call.savedCameraTrack = videoSender.track;
      try { await videoSender.replaceTrack(videoTrack); } catch (err) {
        console.warn('replaceTrack video:', err);
        displayStream.getTracks().forEach((t) => t.stop());
        call.shareBusy = false;
        dom.shareBtn.disabled = false;
        return;
      }
    }

    if (audioTrack && audioSender && audioSender.track) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const dest = ctx.createMediaStreamDestination();
        const micSource = ctx.createMediaStreamSource(new MediaStream([audioSender.track]));
        const tabSource = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const micGain = ctx.createGain();
        const tabGain = ctx.createGain();
        micGain.gain.value = 1.0;
        tabGain.gain.value = 0.8;
        micSource.connect(micGain).connect(dest);
        tabSource.connect(tabGain).connect(dest);
        const mixedTrack = dest.stream.getAudioTracks()[0];
        if (mixedTrack) {
          call.savedMicTrack = audioSender.track;
          call.mixerCtx = ctx;
          await audioSender.replaceTrack(mixedTrack);
        } else {
          try { ctx.close(); } catch (_) {}
        }
      } catch (err) {
        console.warn('audio mixer setup failed:', err);
      }
    }

    videoTrack.addEventListener('ended', () => {
      if (call.sharing) stopScreenShare();
    });

    call.screenStream = displayStream;
    call.sharing = true;
    dom.shareBtn.dataset.on = 'true';
    dom.shareBtn.title = 'Stop sharing';
    dom.localVideo.srcObject = displayStream;
    dom.localVideo.classList.add('mirror-off');
    dom.cameraBtn.disabled = true;
    dom.switchBtn.disabled = true;
    call.shareBusy = false;
    dom.shareBtn.disabled = false;
  }

  async function stopScreenShare() {
    if (!call.sharing) return;
    call.shareBusy = true;
    dom.shareBtn.disabled = true;

    const videoSender = findSender('video');
    const audioSender = findSender('audio');

    if (videoSender && call.savedCameraTrack && call.savedCameraTrack.readyState === 'live') {
      try { await videoSender.replaceTrack(call.savedCameraTrack); } catch (err) { console.warn('restore video:', err); }
    } else if (videoSender) {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: call.facingMode },
        });
        const t = fresh.getVideoTracks()[0];
        if (t) {
          await videoSender.replaceTrack(t);
          const oldLocalVideo = call.localStream.getVideoTracks()[0];
          if (oldLocalVideo) { call.localStream.removeTrack(oldLocalVideo); try { oldLocalVideo.stop(); } catch (_) {} }
          call.localStream.addTrack(t);
        }
      } catch (err) { console.warn('camera reacquire failed:', err); }
    }

    if (audioSender && call.savedMicTrack && call.savedMicTrack.readyState === 'live') {
      try { await audioSender.replaceTrack(call.savedMicTrack); } catch (err) { console.warn('restore audio:', err); }
    }

    if (call.mixerCtx) {
      try { await call.mixerCtx.close(); } catch (_) {}
      call.mixerCtx = null;
    }
    if (call.screenStream) {
      call.screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      call.screenStream = null;
    }
    call.savedCameraTrack = null;
    call.savedMicTrack = null;
    call.sharing = false;
    dom.shareBtn.dataset.on = 'false';
    dom.shareBtn.title = 'Share screen (nonton bareng)';
    dom.localVideo.srcObject = call.localStream;
    dom.localVideo.classList.toggle('mirror-off', call.facingMode === 'environment');
    dom.cameraBtn.disabled = false;
    dom.switchBtn.disabled = false;
    call.shareBusy = false;
    dom.shareBtn.disabled = false;
  }

  async function switchCamera() {
    if (call.switching || !call.pc || !call.localStream) return;
    call.switching = true;
    dom.switchBtn.disabled = true;

    const currentTrack = call.localStream.getVideoTracks()[0];
    const currentSettings = currentTrack && currentTrack.getSettings ? currentTrack.getSettings() : {};
    const currentDeviceId = currentSettings.deviceId || null;
    const currentFacing = currentSettings.facingMode || call.facingMode;

    // Stop current track first — some devices (iOS) only allow one active camera at a time.
    if (currentTrack) {
      try { currentTrack.stop(); } catch (_) {}
    }

    const cams = await listVideoInputs();
    let newStream = null;
    let chosenFacing = currentFacing === 'user' ? 'environment' : 'user';

    // Strategy 1: facingMode exact (best on mobile)
    try {
      newStream = await tryGetVideoStream({
        width: { ideal: 1280 }, height: { ideal: 720 },
        facingMode: { exact: chosenFacing },
      });
    } catch (_) {}

    // Strategy 2: cycle through deviceIds (works on desktop + as fallback)
    if (!newStream && cams.length >= 2 && currentDeviceId) {
      const idx = cams.findIndex((c) => c.deviceId === currentDeviceId);
      const next = cams[(idx + 1) % cams.length];
      try {
        newStream = await tryGetVideoStream({
          width: { ideal: 1280 }, height: { ideal: 720 },
          deviceId: { exact: next.deviceId },
        });
      } catch (_) {}
    }

    // Strategy 3: facingMode loose
    if (!newStream) {
      try {
        newStream = await tryGetVideoStream({ facingMode: chosenFacing });
      } catch (err) {
        console.warn('switch camera failed:', err.message);
      }
    }

    if (!newStream) {
      // Restore previous camera to avoid black feed
      try {
        const restore = await tryGetVideoStream({ facingMode: currentFacing });
        const track = restore.getVideoTracks()[0];
        call.localStream.addTrack(track);
        const sender = call.pc.getSenders().find((s) => s.track === null || (s.track && s.track.kind === 'video'));
        if (sender) await sender.replaceTrack(track);
        dom.localVideo.srcObject = call.localStream;
      } catch (_) {}
      alert('Tidak bisa switch camera (browser menolak / hanya 1 kamera aktif).');
      call.switching = false;
      dom.switchBtn.disabled = false;
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];
    const newSettings = newTrack.getSettings ? newTrack.getSettings() : {};
    const oldTrack = call.localStream.getVideoTracks()[0];
    const sender = call.pc.getSenders().find((s) => s.track === null || (s.track && s.track.kind === 'video'));
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (err) { console.warn('replaceTrack:', err.message); }
    }
    if (oldTrack) {
      call.localStream.removeTrack(oldTrack);
      try { oldTrack.stop(); } catch (_) {}
    }
    call.localStream.addTrack(newTrack);
    dom.localVideo.srcObject = call.localStream;
    call.facingMode = newSettings.facingMode || chosenFacing;
    dom.localVideo.classList.toggle('mirror-off', call.facingMode === 'environment');
    call.switching = false;
    dom.switchBtn.disabled = false;
  }

  async function createPeerConnection() {
    const iceServers = await loadIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (!e.candidate || !socket || !call.callId) return;
      socket.emit('call:ice', { peer: call.peer, callId: call.callId, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (!call.remoteStream) {
        call.remoteStream = new MediaStream();
        dom.remoteVideo.srcObject = call.remoteStream;
      }
      e.streams[0].getTracks().forEach((t) => {
        if (!call.remoteStream.getTracks().includes(t)) call.remoteStream.addTrack(t);
      });
      dom.placeholder.classList.add('hidden');
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        if (call.state !== STATE.CONNECTED) {
          setState(STATE.CONNECTED);
          startTimer();
        }
      } else if (s === 'failed' || s === 'disconnected') {
        if (call.state === STATE.CONNECTED) endCall('connection_lost');
      }
    };
    return pc;
  }

  async function drainCandidates() {
    if (!call.pc || !call.remoteDescSet) return;
    while (call.pendingCandidates.length) {
      const c = call.pendingCandidates.shift();
      try { await call.pc.addIceCandidate(c); } catch (err) { console.warn('addIceCandidate:', err); }
    }
  }

  async function onCallBtnClick() {
    if (isBusy()) return;
    const partner = window.chatCall && typeof window.chatCall.getPartner === 'function'
      ? window.chatCall.getPartner()
      : null;
    if (!partner) {
      alert('Pilih chat partner dulu.');
      return;
    }
    await startOutgoing(partner);
  }

  async function startOutgoing(peer) {
    resetCallState();
    call.role = 'caller';
    call.peer = peer;
    call.callId = newCallId();
    call.media = 'video';
    dom.peerName.textContent = peer;
    setState(STATE.OUTGOING);
    showModal();
    try {
      call.localStream = await getMedia(true);
    } catch (err) {
      alert('Camera/mic access denied: ' + err.message);
      cleanupCall();
      hideModal();
      return;
    }
    dom.localVideo.srcObject = call.localStream;
    call.pc = await createPeerConnection();
    call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
    let offer;
    try {
      offer = await call.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await call.pc.setLocalDescription(offer);
    } catch (err) {
      console.error('createOffer failed:', err);
      cleanupCall();
      hideModal();
      return;
    }
    socket.emit(
      'call:invite',
      { peer, callId: call.callId, sdp: { type: offer.type, sdp: offer.sdp }, media: 'video' },
      (ack) => {
        if (!ack || ack.error) {
          const reason = ack && ack.error === 'busy' ? 'Peer is busy' : (ack && ack.error) || 'Failed to call';
          alert(reason);
          cleanupCall();
          hideModal();
        }
      }
    );
    call.ringTimer = setTimeout(() => {
      if (call.state === STATE.OUTGOING) endCall('no_answer');
    }, RING_TIMEOUT_MS);
  }

  function onSocketInvite(msg) {
    if (!msg || !msg.callId) return;
    if (isBusy()) {
      socket.emit('call:reject', { callId: msg.callId, reason: 'busy' });
      return;
    }
    resetCallState();
    call.role = 'callee';
    call.peer = msg.from;
    call.callId = msg.callId;
    call.media = msg.media || 'video';
    call.pendingOffer = msg.sdp;
    setState(STATE.INCOMING);
    showIncoming(msg.from);
    call.ringTimer = setTimeout(() => {
      if (call.state === STATE.INCOMING) rejectCall('no_answer');
    }, RING_TIMEOUT_MS);
  }

  async function acceptCall() {
    if (call.state !== STATE.INCOMING || !call.pendingOffer) return;
    hideIncoming();
    dom.peerName.textContent = call.peer;
    setState(STATE.CONNECTING);
    showModal();
    try {
      call.localStream = await getMedia(true);
    } catch (err) {
      alert('Camera/mic access denied: ' + err.message);
      rejectCall('media_denied');
      return;
    }
    dom.localVideo.srcObject = call.localStream;
    call.pc = await createPeerConnection();
    call.localStream.getTracks().forEach((t) => call.pc.addTrack(t, call.localStream));
    try {
      await call.pc.setRemoteDescription(new RTCSessionDescription(call.pendingOffer));
      call.remoteDescSet = true;
      await drainCandidates();
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      socket.emit(
        'call:accept',
        { peer: call.peer, callId: call.callId, sdp: { type: answer.type, sdp: answer.sdp } },
        (ack) => {
          if (!ack || ack.error) {
            alert((ack && ack.error) || 'Accept failed');
            endCall('error');
          }
        }
      );
    } catch (err) {
      console.error('accept flow error:', err);
      endCall('error');
    }
  }

  function rejectCall(reason) {
    if (call.state !== STATE.INCOMING) return;
    const callId = call.callId;
    hideIncoming();
    if (socket && callId) socket.emit('call:reject', { peer: call.peer, callId, reason: reason || 'declined' });
    cleanupCall();
  }

  async function onSocketAccept(msg) {
    if (!msg || msg.callId !== call.callId || call.role !== 'caller') return;
    setState(STATE.CONNECTING);
    try {
      await call.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      call.remoteDescSet = true;
      await drainCandidates();
    } catch (err) {
      console.error('setRemoteDescription answer error:', err);
      endCall('error');
    }
  }

  function onSocketReject(msg) {
    if (!msg || msg.callId !== call.callId) return;
    hideIncoming();
    const reason = msg.reason === 'busy' ? 'Peer is busy' : 'Call declined';
    if (call.state === STATE.OUTGOING) {
      setState(STATE.ENDED);
      dom.stateEl.textContent = reason;
      setTimeout(() => { cleanupCall(); hideModal(); }, 1200);
    } else {
      cleanupCall();
    }
  }

  async function onSocketIce(msg) {
    if (!msg || !msg.candidate || msg.callId !== call.callId) return;
    const cand = new RTCIceCandidate(msg.candidate);
    if (!call.pc || !call.remoteDescSet) {
      call.pendingCandidates.push(cand);
      return;
    }
    try { await call.pc.addIceCandidate(cand); } catch (err) { console.warn('addIceCandidate:', err); }
  }

  function onSocketEnd(msg) {
    if (!msg || (call.callId && msg.callId !== call.callId)) return;
    hideIncoming();
    if (call.state === STATE.OUTGOING || call.state === STATE.INCOMING) {
      cleanupCall();
      hideModal();
      return;
    }
    if (call.state === STATE.CONNECTING || call.state === STATE.CONNECTED) {
      setState(STATE.ENDED);
      dom.stateEl.textContent = 'Call ended';
      setTimeout(() => { cleanupCall(); hideModal(); }, 800);
    }
  }

  function endCall(reason) {
    if (call.state === STATE.IDLE) return;
    const callId = call.callId;
    const wasConnected = call.state === STATE.CONNECTED || call.state === STATE.CONNECTING;
    if (socket && callId) socket.emit('call:end', { peer: call.peer, callId, reason: reason || 'ended' });
    if (wasConnected) {
      setState(STATE.ENDED);
      dom.stateEl.textContent = reason === 'no_answer' ? 'No answer' : 'Call ended';
      setTimeout(() => { cleanupCall(); hideModal(); }, 600);
    } else {
      cleanupCall();
      hideModal();
    }
  }

  function cleanupCall() {
    stopTimer();
    stopRingtone();
    if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; }
    if (call.screenStream) {
      call.screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      call.screenStream = null;
    }
    if (call.mixerCtx) { try { call.mixerCtx.close(); } catch (_) {} call.mixerCtx = null; }
    if (call.pc) {
      try { call.pc.ontrack = null; call.pc.onicecandidate = null; call.pc.oniceconnectionstatechange = null; call.pc.close(); } catch (_) {}
    }
    if (call.localStream) call.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    if (call.remoteStream) call.remoteStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    resetCallState();
    if (ready) {
      dom.muteBtn.dataset.on = 'true'; dom.muteBtn.textContent = '🎤'; dom.muteBtn.title = 'Mute mic';
      dom.speakerBtn.dataset.on = 'true'; dom.speakerBtn.textContent = '🔊'; dom.speakerBtn.title = 'Mute speaker';
      dom.cameraBtn.dataset.on = 'true'; dom.cameraBtn.textContent = '📹';
      dom.cameraBtn.disabled = false;
      dom.switchBtn.disabled = false;
      dom.shareBtn.dataset.on = 'false';
      dom.shareBtn.title = 'Share screen (nonton bareng)';
      dom.shareBtn.disabled = false;
      dom.selfViewBtn.dataset.on = 'true';
      dom.selfViewBtn.title = 'Hide self view';
      dom.modal.classList.remove('hide-self');
      dom.remoteVideo.muted = false;
    }
  }

  function resetCallState() {
    call.state = STATE.IDLE;
    call.role = null;
    call.peer = null;
    call.callId = null;
    call.pc = null;
    call.localStream = null;
    call.remoteStream = null;
    call.pendingCandidates = [];
    call.remoteDescSet = false;
    call.pendingOffer = null;
    call.startedAt = null;
    call.facingMode = 'user';
    call.switching = false;
    call.sharing = false;
    call.shareBusy = false;
    call.screenStream = null;
    call.savedCameraTrack = null;
    call.savedMicTrack = null;
    call.mixerCtx = null;
    if (ready) dom.localVideo.classList.remove('mirror-off');
  }

  function toggleMute() {
    if (!call.localStream) return;
    const on = dom.muteBtn.dataset.on === 'true';
    call.localStream.getAudioTracks().forEach((t) => { t.enabled = !on; });
    dom.muteBtn.dataset.on = on ? 'false' : 'true';
    dom.muteBtn.textContent = on ? '🚫' : '🎤';
    dom.muteBtn.title = on ? 'Unmute mic' : 'Mute mic';
  }

  function toggleSpeaker() {
    const on = dom.speakerBtn.dataset.on === 'true';
    dom.remoteVideo.muted = on;
    dom.speakerBtn.dataset.on = on ? 'false' : 'true';
    dom.speakerBtn.textContent = on ? '🔇' : '🔊';
    dom.speakerBtn.title = on ? 'Unmute speaker' : 'Mute speaker';
  }

  function toggleSelfView() {
    const on = dom.selfViewBtn.dataset.on === 'true';
    dom.modal.classList.toggle('hide-self', on);
    dom.selfViewBtn.dataset.on = on ? 'false' : 'true';
    dom.selfViewBtn.title = on ? 'Show self view' : 'Hide self view';
  }

  function toggleCamera() {
    if (!call.localStream) return;
    const on = dom.cameraBtn.dataset.on === 'true';
    call.localStream.getVideoTracks().forEach((t) => { t.enabled = !on; });
    dom.cameraBtn.dataset.on = on ? 'false' : 'true';
    dom.cameraBtn.textContent = on ? '📷' : '📹';
  }

  const api = {
    init(opts) {
      initDom();
      if (opts && opts.socket) setSocket(opts.socket);
      if (opts && typeof opts.getPartner === 'function') api.getPartner = opts.getPartner;
      if (opts && typeof opts.getToken === 'function') getAuthToken = opts.getToken;
      if (opts && typeof opts.getMe === 'function') getMe = opts.getMe;
      updateShareBtnVisibility();
    },
    setSocket,
    setCallButtonEnabled,
    getPartner: null,
    isBusy,
  };
  window.chatCall = api;
})();
