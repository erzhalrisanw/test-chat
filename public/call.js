(function () {
  'use strict';

  const FALLBACK_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const ICE_CACHE_MS = 50 * 60 * 1000;
  let iceCache = { servers: null, expiresAt: 0 };
  let getAuthToken = () => null;

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
    dom.cameraBtn = $('call-camera');
    dom.endBtn = $('call-end');
    dom.minimizeBtn = $('call-minimize');
    dom.expandBtn = $('call-expand');
    dom.pipBtn = $('call-pip');
    dom.switchBtn = $('call-switch');
    dom.incoming = $('call-incoming');
    dom.incomingFrom = $('call-incoming-from');
    dom.acceptBtn = $('call-accept');
    dom.declineBtn = $('call-decline');

    dom.callBtn.addEventListener('click', onCallBtnClick);
    dom.endBtn.addEventListener('click', () => endCall('ended'));
    dom.muteBtn.addEventListener('click', toggleMute);
    dom.cameraBtn.addEventListener('click', toggleCamera);
    dom.minimizeBtn.addEventListener('click', minimize);
    dom.expandBtn.addEventListener('click', expand);
    dom.pipBtn.addEventListener('click', togglePip);
    dom.switchBtn.addEventListener('click', switchCamera);
    dom.acceptBtn.addEventListener('click', acceptCall);
    dom.declineBtn.addEventListener('click', () => rejectCall('declined'));

    if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
      dom.pipBtn.classList.remove('hidden');
    }
    detectMultipleCameras().then((multi) => {
      if (multi) dom.switchBtn.classList.remove('hidden');
    });
    dom.remoteVideo.addEventListener('leavepictureinpicture', () => {
      if (call.state === STATE.CONNECTED) expand();
    });

    ready = true;
  }

  function minimize() {
    dom.modal.classList.add('minimized');
    dom.expandBtn.classList.remove('hidden');
  }

  function expand() {
    dom.modal.classList.remove('minimized');
    dom.expandBtn.classList.add('hidden');
    if (document.pictureInPictureElement === dom.remoteVideo) {
      document.exitPictureInPicture().catch(() => {});
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
    dom.modal.classList.add('hidden');
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
    if (call.pc) {
      try { call.pc.ontrack = null; call.pc.onicecandidate = null; call.pc.oniceconnectionstatechange = null; call.pc.close(); } catch (_) {}
    }
    if (call.localStream) call.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    if (call.remoteStream) call.remoteStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    resetCallState();
    if (ready) {
      dom.muteBtn.dataset.on = 'true'; dom.muteBtn.textContent = '🎤';
      dom.cameraBtn.dataset.on = 'true'; dom.cameraBtn.textContent = '📹';
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
    if (ready) dom.localVideo.classList.remove('mirror-off');
  }

  function toggleMute() {
    if (!call.localStream) return;
    const on = dom.muteBtn.dataset.on === 'true';
    call.localStream.getAudioTracks().forEach((t) => { t.enabled = !on; });
    dom.muteBtn.dataset.on = on ? 'false' : 'true';
    dom.muteBtn.textContent = on ? '🚫' : '🎤';
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
    },
    setSocket,
    setCallButtonEnabled,
    getPartner: null,
    isBusy,
  };
  window.chatCall = api;
})();
