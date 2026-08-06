(function () {
  const modal = document.getElementById('photo-editor');
  if (!modal) return;

  const canvas = document.getElementById('pe-canvas');
  const stage = document.getElementById('pe-stage');
  const stickerLayer = document.getElementById('pe-sticker-layer');
  const cropOverlay = document.getElementById('pe-crop-overlay');
  const cropRect = document.getElementById('pe-crop-rect');
  const cancelBtn = document.getElementById('pe-cancel');
  const saveBtn = document.getElementById('pe-save');
  const toolCrop = document.getElementById('pe-tool-crop');
  const toolRotate = document.getElementById('pe-tool-rotate');
  const toolPen = document.getElementById('pe-tool-pen');
  const toolSticker = document.getElementById('pe-tool-sticker');
  const toolUndo = document.getElementById('pe-tool-undo');
  const toolReset = document.getElementById('pe-tool-reset');
  const toolPanel = document.getElementById('pe-tool-panel');
  const penPanel = document.getElementById('pe-pen-panel');
  const cropPanel = document.getElementById('pe-crop-panel');
  const stickerPanel = document.getElementById('pe-sticker-panel');
  const stickerGrid = document.getElementById('pe-sticker-grid');
  const cropApply = document.getElementById('pe-crop-apply');
  const cropCancel = document.getElementById('pe-crop-cancel');
  const cropRatioBtns = cropPanel ? cropPanel.querySelectorAll('.pe-ratio') : [];

  const ctx = canvas.getContext('2d');

  let originalDataUrl = null;
  let onSaveFn = null;
  let currentTool = null; // 'pen' | 'crop' | 'sticker' | null
  let history = []; // snapshots (dataURLs), stack
  let penColor = '#ff2d2d';
  let penSize = 6;
  let drawing = false;
  let lastPt = null;
  let stickerCatalog = [];
  let stickerCatalogPromise = null;
  let currentMe = '';

  // Fit canvas display to stage while keeping intrinsic pixel size
  function fitCanvasToStage() {
    const stageRect = stage.getBoundingClientRect();
    const availW = stageRect.width - 24;
    const availH = stageRect.height - 24;
    const ratio = canvas.width / canvas.height;
    let w = availW;
    let h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    positionStickerLayer();
  }

  function positionStickerLayer() {
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    stickerLayer.style.left = (cr.left - sr.left) + 'px';
    stickerLayer.style.top = (cr.top - sr.top) + 'px';
    stickerLayer.style.width = cr.width + 'px';
    stickerLayer.style.height = cr.height + 'px';
    cropOverlay.style.left = (cr.left - sr.left) + 'px';
    cropOverlay.style.top = (cr.top - sr.top) + 'px';
    cropOverlay.style.width = cr.width + 'px';
    cropOverlay.style.height = cr.height + 'px';
  }

  function pushHistory() {
    try {
      const snap = canvas.toDataURL('image/png');
      history.push(snap);
      if (history.length > 30) history.shift();
    } catch (_) {}
  }

  function popHistory() {
    if (history.length < 2) return;
    history.pop();
    const prev = history[history.length - 1];
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      fitCanvasToStage();
    };
    img.src = prev;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function open(dataUrl, opts) {
    originalDataUrl = dataUrl;
    onSaveFn = (opts && opts.onSave) || null;
    currentMe = (opts && opts.me) || '';
    history = [];
    modal.classList.remove('hidden');
    stickerLayer.innerHTML = '';
    setTool(null);
    try {
      const img = await loadImage(dataUrl);
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      fitCanvasToStage();
      pushHistory();
    } catch (_) {
      alert('Gagal muat foto');
      close();
    }
    ensureStickerCatalog();
  }

  function close() {
    modal.classList.add('hidden');
    stickerLayer.innerHTML = '';
    canvas.width = 1;
    canvas.height = 1;
    history = [];
    onSaveFn = null;
    setTool(null);
  }

  function setTool(tool) {
    currentTool = tool;
    [toolCrop, toolRotate, toolPen, toolSticker].forEach((b) => b.classList.remove('active'));
    penPanel.classList.add('hidden');
    cropPanel.classList.add('hidden');
    stickerPanel.classList.add('hidden');
    toolPanel.classList.add('hidden');
    cropOverlay.classList.add('hidden');
    canvas.style.cursor = '';
    canvas.style.pointerEvents = '';
    // clear any selected sticker highlights
    for (const el of stickerLayer.querySelectorAll('.pe-sticker.selected')) el.classList.remove('selected');
    if (tool === 'pen') {
      toolPen.classList.add('active');
      penPanel.classList.remove('hidden');
      toolPanel.classList.remove('hidden');
      canvas.style.cursor = 'crosshair';
      renderPenSelection();
    } else if (tool === 'crop') {
      toolCrop.classList.add('active');
      cropPanel.classList.remove('hidden');
      toolPanel.classList.remove('hidden');
      cropOverlay.classList.remove('hidden');
      initCropRect();
    } else if (tool === 'sticker') {
      toolSticker.classList.add('active');
      stickerPanel.classList.remove('hidden');
      toolPanel.classList.remove('hidden');
      renderStickerGrid();
    }
  }

  // ---- Pen ----
  function renderPenSelection() {
    for (const el of penPanel.querySelectorAll('.pe-swatch')) {
      el.classList.toggle('selected', el.dataset.color === penColor);
    }
    for (const el of penPanel.querySelectorAll('.pe-size')) {
      el.classList.toggle('selected', Number(el.dataset.size) === penSize);
    }
  }
  penPanel.querySelectorAll('.pe-swatch').forEach((btn) => {
    btn.addEventListener('click', () => { penColor = btn.dataset.color; renderPenSelection(); });
  });
  penPanel.querySelectorAll('.pe-size').forEach((btn) => {
    btn.addEventListener('click', () => { penSize = Number(btn.dataset.size); renderPenSelection(); });
  });

  function canvasCoord(evt) {
    const r = canvas.getBoundingClientRect();
    const x = (evt.clientX - r.left) * (canvas.width / r.width);
    const y = (evt.clientY - r.top) * (canvas.height / r.height);
    return { x, y };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (currentTool !== 'pen') return;
    e.preventDefault();
    drawing = true;
    lastPt = canvasCoord(e);
    ctx.strokeStyle = penColor;
    ctx.lineWidth = penSize * (canvas.width / canvas.getBoundingClientRect().width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPt.x, lastPt.y);
    ctx.lineTo(lastPt.x + 0.01, lastPt.y + 0.01);
    ctx.stroke();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || currentTool !== 'pen') return;
    const p = canvasCoord(e);
    ctx.beginPath();
    ctx.moveTo(lastPt.x, lastPt.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPt = p;
  });
  canvas.addEventListener('pointerup', () => {
    if (drawing) { drawing = false; pushHistory(); }
  });
  canvas.addEventListener('pointercancel', () => {
    if (drawing) { drawing = false; pushHistory(); }
  });

  // ---- Rotate 90° ----
  toolRotate.addEventListener('click', () => {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.height;
    tmp.height = canvas.width;
    const tctx = tmp.getContext('2d');
    tctx.translate(tmp.width, 0);
    tctx.rotate(Math.PI / 2);
    tctx.drawImage(canvas, 0, 0);
    canvas.width = tmp.width;
    canvas.height = tmp.height;
    ctx.drawImage(tmp, 0, 0);
    fitCanvasToStage();
    pushHistory();
  });

  // ---- Crop ----
  let cropDrag = null;
  let cropRatio = null; // null = free, else numeric width/height

  function ratioFromKey(key) {
    if (key === '1:1') return 1;
    if (key === '4:3') return 4 / 3;
    return null;
  }
  function renderRatioSelection(key) {
    cropRatioBtns.forEach((b) => b.classList.toggle('selected', b.dataset.ratio === key));
  }
  function fitRatioRect(ratio) {
    const cr = canvas.getBoundingClientRect();
    const pad = Math.min(cr.width, cr.height) * 0.08;
    const maxW = cr.width - pad * 2;
    const maxH = cr.height - pad * 2;
    let w = maxW;
    let h = ratio ? w / ratio : maxH;
    if (h > maxH) { h = maxH; w = ratio ? h * ratio : maxW; }
    const left = (cr.width - w) / 2;
    const top = (cr.height - h) / 2;
    setRect({ left, top, width: w, height: h });
  }
  function initCropRect() {
    cropRatio = null;
    renderRatioSelection('free');
    fitRatioRect(null);
  }
  cropRatioBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.ratio;
      cropRatio = ratioFromKey(key);
      renderRatioSelection(key);
      fitRatioRect(cropRatio);
    });
  });
  function rectBounds() {
    return {
      left: parseFloat(cropRect.style.left) || 0,
      top: parseFloat(cropRect.style.top) || 0,
      width: parseFloat(cropRect.style.width) || 0,
      height: parseFloat(cropRect.style.height) || 0,
    };
  }
  function setRect(r) {
    cropRect.style.left = r.left + 'px';
    cropRect.style.top = r.top + 'px';
    cropRect.style.width = r.width + 'px';
    cropRect.style.height = r.height + 'px';
  }
  cropRect.addEventListener('pointerdown', (e) => {
    if (currentTool !== 'crop') return;
    const isHandle = e.target.classList.contains('pe-crop-handle') || e.target.classList.contains('pe-crop-edge');
    if (isHandle) {
      cropDrag = { mode: 'resize', handle: e.target.dataset.h, startX: e.clientX, startY: e.clientY, rect: rectBounds() };
    } else {
      cropDrag = { mode: 'move', startX: e.clientX, startY: e.clientY, rect: rectBounds() };
    }
    cropRect.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cropRect.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    const dx = e.clientX - cropDrag.startX;
    const dy = e.clientY - cropDrag.startY;
    const bounds = cropOverlay.getBoundingClientRect();
    let r = { ...cropDrag.rect };
    const minSize = 30;
    if (cropDrag.mode === 'move') {
      r.left = Math.max(0, Math.min(bounds.width - r.width, r.left + dx));
      r.top = Math.max(0, Math.min(bounds.height - r.height, r.top + dy));
    } else if (cropRatio) {
      // Ratio-locked: compute new size then reposition anchored to opposite corner
      const h = cropDrag.handle;
      const anchorX = h.includes('l') ? cropDrag.rect.left + cropDrag.rect.width : cropDrag.rect.left;
      const anchorY = h.includes('t') ? cropDrag.rect.top + cropDrag.rect.height : cropDrag.rect.top;
      let signX = h.includes('l') ? -1 : 1;
      let signY = h.includes('t') ? -1 : 1;
      let newW = Math.max(minSize, cropDrag.rect.width + signX * dx);
      let newH = Math.max(minSize, cropDrag.rect.height + signY * dy);
      // Choose the dimension that moved more in ratio terms
      if (newW / newH > cropRatio) newW = newH * cropRatio;
      else newH = newW / cropRatio;
      // Clamp against bounds
      const maxW = signX > 0 ? bounds.width - anchorX : anchorX;
      const maxH = signY > 0 ? bounds.height - anchorY : anchorY;
      if (newW > maxW) { newW = maxW; newH = newW / cropRatio; }
      if (newH > maxH) { newH = maxH; newW = newH * cropRatio; }
      newW = Math.max(minSize, newW);
      newH = Math.max(minSize, newH);
      r.left = signX > 0 ? anchorX : anchorX - newW;
      r.top = signY > 0 ? anchorY : anchorY - newH;
      r.width = newW;
      r.height = newH;
    } else {
      if (cropDrag.handle.includes('l')) {
        const nl = Math.max(0, Math.min(r.left + r.width - minSize, r.left + dx));
        r.width = r.width + (r.left - nl);
        r.left = nl;
      }
      if (cropDrag.handle.includes('r')) {
        r.width = Math.max(minSize, Math.min(bounds.width - r.left, r.width + dx));
      }
      if (cropDrag.handle.includes('t')) {
        const nt = Math.max(0, Math.min(r.top + r.height - minSize, r.top + dy));
        r.height = r.height + (r.top - nt);
        r.top = nt;
      }
      if (cropDrag.handle.includes('b')) {
        r.height = Math.max(minSize, Math.min(bounds.height - r.top, r.height + dy));
      }
    }
    setRect(r);
  });
  cropRect.addEventListener('pointerup', () => { cropDrag = null; });
  cropRect.addEventListener('pointercancel', () => { cropDrag = null; });

  cropApply.addEventListener('click', () => {
    const cr = canvas.getBoundingClientRect();
    const r = rectBounds();
    const scaleX = canvas.width / cr.width;
    const scaleY = canvas.height / cr.height;
    const sx = Math.round(r.left * scaleX);
    const sy = Math.round(r.top * scaleY);
    const sw = Math.max(1, Math.round(r.width * scaleX));
    const sh = Math.max(1, Math.round(r.height * scaleY));
    const tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    tmp.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(tmp, 0, 0);
    fitCanvasToStage();
    pushHistory();
    setTool(null);
  });
  cropCancel.addEventListener('click', () => setTool(null));

  // ---- Stickers ----
  async function ensureStickerCatalog() {
    if (stickerCatalog.length) return stickerCatalog;
    if (stickerCatalogPromise) return stickerCatalogPromise;
    stickerCatalogPromise = fetch('/stickers/index.json')
      .then((r) => r.json())
      .then((data) => {
        const list = (data && data.stickers) || [];
        stickerCatalog = list.filter((s) => {
          if (!Array.isArray(s.users) || !s.users.length) return true;
          return currentMe && s.users.indexOf(currentMe) >= 0;
        });
        return stickerCatalog;
      })
      .catch(() => (stickerCatalog = []));
    return stickerCatalogPromise;
  }
  async function renderStickerGrid() {
    stickerGrid.innerHTML = '<div style="opacity:0.6; font-size:12px; padding:8px;">memuat…</div>';
    const list = await ensureStickerCatalog();
    stickerGrid.innerHTML = '';
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      const img = document.createElement('img');
      img.src = '/stickers/' + s.file;
      img.alt = s.label || s.name;
      b.appendChild(img);
      b.addEventListener('click', () => placeSticker('/stickers/' + s.file));
      stickerGrid.appendChild(b);
    }
    if (!list.length) {
      stickerGrid.innerHTML = '<div style="opacity:0.6; font-size:12px; padding:8px;">Belum ada stiker</div>';
    }
  }

  function placeSticker(src) {
    const lr = stickerLayer.getBoundingClientRect();
    const size = Math.min(lr.width, lr.height) * 0.25;
    const el = document.createElement('div');
    el.className = 'pe-sticker';
    el.dataset.src = src;
    const cx = lr.width / 2 - size / 2;
    const cy = lr.height / 2 - size / 2;
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    const img = document.createElement('img');
    img.src = src;
    el.appendChild(img);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'pe-sticker-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      el.remove();
    });
    el.appendChild(rm);
    const rs = document.createElement('span');
    rs.className = 'pe-sticker-resize';
    rs.textContent = '⇘';
    el.appendChild(rs);
    stickerLayer.appendChild(el);
    wireStickerDrag(el, rs);
    selectSticker(el);
  }

  function selectSticker(el) {
    for (const s of stickerLayer.querySelectorAll('.pe-sticker.selected')) s.classList.remove('selected');
    el.classList.add('selected');
  }

  function wireStickerDrag(el, resizeHandle) {
    let move = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target === resizeHandle) return;
      if (e.target.classList.contains('pe-sticker-remove')) return;
      selectSticker(el);
      move = {
        mode: 'move',
        startX: e.clientX,
        startY: e.clientY,
        origLeft: parseFloat(el.style.left) || 0,
        origTop: parseFloat(el.style.top) || 0,
      };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!move) return;
      const lr = stickerLayer.getBoundingClientRect();
      if (move.mode === 'move') {
        const w = parseFloat(el.style.width) || 0;
        const h = parseFloat(el.style.height) || 0;
        el.style.left = Math.max(-w * 0.3, Math.min(lr.width - w * 0.7, move.origLeft + (e.clientX - move.startX))) + 'px';
        el.style.top = Math.max(-h * 0.3, Math.min(lr.height - h * 0.7, move.origTop + (e.clientY - move.startY))) + 'px';
      } else if (move.mode === 'resize') {
        const dx = e.clientX - move.startX;
        const dy = e.clientY - move.startY;
        const delta = Math.max(dx, dy);
        const nw = Math.max(24, Math.min(lr.width, move.origW + delta));
        const nh = nw; // square
        el.style.width = nw + 'px';
        el.style.height = nh + 'px';
      }
    });
    el.addEventListener('pointerup', () => { move = null; });
    el.addEventListener('pointercancel', () => { move = null; });
    resizeHandle.addEventListener('pointerdown', (e) => {
      selectSticker(el);
      move = {
        mode: 'resize',
        startX: e.clientX,
        startY: e.clientY,
        origW: parseFloat(el.style.width) || 0,
      };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  async function bakeStickers() {
    const nodes = Array.from(stickerLayer.querySelectorAll('.pe-sticker'));
    if (!nodes.length) return;
    const cr = canvas.getBoundingClientRect();
    const scaleX = canvas.width / cr.width;
    const scaleY = canvas.height / cr.height;
    for (const el of nodes) {
      const src = el.dataset.src;
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      const w = parseFloat(el.style.width) || 0;
      const h = parseFloat(el.style.height) || 0;
      try {
        const img = await loadImage(src);
        ctx.drawImage(img, left * scaleX, top * scaleY, w * scaleX, h * scaleY);
      } catch (_) {}
    }
    stickerLayer.innerHTML = '';
    pushHistory();
  }

  // ---- Wiring ----
  toolCrop.addEventListener('click', () => setTool(currentTool === 'crop' ? null : 'crop'));
  toolPen.addEventListener('click', () => setTool(currentTool === 'pen' ? null : 'pen'));
  toolSticker.addEventListener('click', () => setTool(currentTool === 'sticker' ? null : 'sticker'));
  toolUndo.addEventListener('click', () => popHistory());
  toolReset.addEventListener('click', async () => {
    if (!originalDataUrl) return;
    stickerLayer.innerHTML = '';
    try {
      const img = await loadImage(originalDataUrl);
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      fitCanvasToStage();
      history = [];
      pushHistory();
      setTool(null);
    } catch (_) {}
  });

  cancelBtn.addEventListener('click', () => {
    close();
  });
  saveBtn.addEventListener('click', async () => {
    await bakeStickers();
    const MAX_BYTES = 4 * 1024 * 1024;
    let quality = 0.9;
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      while (dataUrl.length > MAX_BYTES * 1.4 && quality > 0.5) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      if (dataUrl.length > MAX_BYTES * 1.4) {
        const maxDim = 1280;
        const w = canvas.width;
        const h = canvas.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        if (scale < 1) {
          const tmp = document.createElement('canvas');
          tmp.width = Math.round(w * scale);
          tmp.height = Math.round(h * scale);
          tmp.getContext('2d').drawImage(canvas, 0, 0, tmp.width, tmp.height);
          dataUrl = tmp.toDataURL('image/jpeg', 0.8);
        }
      }
    } catch (_) {
      dataUrl = canvas.toDataURL('image/png');
    }
    const cb = onSaveFn;
    close();
    if (cb) cb(dataUrl);
  });

  window.addEventListener('resize', () => {
    if (!modal.classList.contains('hidden')) fitCanvasToStage();
  });

  window.PhotoEditor = { open: open, close: close };
})();
