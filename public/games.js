(function () {
  const modal = document.getElementById('game-modal');
  if (!modal) return;
  const picker = document.getElementById('game-picker');
  const stage = document.getElementById('game-stage');
  const leaderboardView = document.getElementById('game-leaderboard');
  const lbHeader = document.getElementById('game-lb-header');
  const lbBody = document.getElementById('game-lb-body');
  const lbEmpty = document.getElementById('game-lb-empty');
  const board = document.getElementById('game-board');
  const titleEl = document.getElementById('game-modal-title');
  const closeBtn = document.getElementById('game-close');
  const backBtn = document.getElementById('game-back');
  const lbBtn = document.getElementById('game-leaderboard-btn');
  const restartBtn = document.getElementById('game-restart');
  const scoreEl = document.getElementById('game-score');
  const bestEl = document.getElementById('game-best');
  const bestWrap = document.getElementById('game-best-wrap');
  const movesEl = document.getElementById('game-moves');
  const movesWrap = document.getElementById('game-moves-wrap');
  const hintEl = document.getElementById('game-hint');

  const HUB_USER = 'occupatus';
  const LEADERBOARD_GAMES = ['2048', 'snake', 'dino'];

  let currentGameId = null;
  let cleanupFn = null;

  const GAMES = {
    '2048':   { title: '2048',     mount: mount2048 },
    'snake':  { title: 'Snake',    mount: mountSnake },
    'memory': { title: 'Memory',   mount: mountMemory },
    'dino':   { title: 'Dino Run', mount: mountDino },
  };

  function styleVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function open() {
    modal.classList.remove('hidden');
    showPicker();
  }
  function close() {
    unmountCurrent();
    modal.classList.add('hidden');
  }
  function showPicker() {
    unmountCurrent();
    picker.classList.remove('hidden');
    stage.classList.add('hidden');
    leaderboardView.classList.add('hidden');
    backBtn.classList.add('hidden');
    if (lbBtn) lbBtn.classList.remove('hidden');
    titleEl.textContent = 'Pilih game';
    hintEl.textContent = '';
  }
  function getMeAndPeer() {
    const me = localStorage.getItem('username') || '';
    if (me === HUB_USER) {
      const peer = localStorage.getItem('activePeer') || '';
      return { me, peer, hub: HUB_USER };
    }
    return { me, peer: me, hub: HUB_USER };
  }
  function authHeaders() {
    const token = localStorage.getItem('token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }
  async function submitScore(game, score) {
    if (LEADERBOARD_GAMES.indexOf(game) < 0) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      await fetch('/game-score', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ game, score }),
      });
    } catch (_) {}
  }
  const GAME_LABEL = { '2048': '2048', 'snake': 'Snake', 'dino': 'Dino' };
  async function showLeaderboard() {
    unmountCurrent();
    picker.classList.add('hidden');
    stage.classList.add('hidden');
    leaderboardView.classList.remove('hidden');
    backBtn.classList.remove('hidden');
    if (lbBtn) lbBtn.classList.add('hidden');
    titleEl.textContent = 'Leaderboard';
    lbHeader.innerHTML = '';
    lbBody.innerHTML = '';
    lbEmpty.classList.add('hidden');

    const { me, peer } = getMeAndPeer();
    if (!peer) {
      lbBody.innerHTML = '';
      lbEmpty.textContent = 'Belum ada peer aktif';
      lbEmpty.classList.remove('hidden');
      return;
    }
    let data = null;
    try {
      const url = me === HUB_USER ? '/leaderboard?peer=' + encodeURIComponent(peer) : '/leaderboard';
      const res = await fetch(url, { headers: authHeaders() });
      data = await res.json();
      if (!data || !data.ok) throw new Error('failed');
    } catch (_) {
      lbEmpty.textContent = 'Gagal memuat leaderboard';
      lbEmpty.classList.remove('hidden');
      return;
    }

    const nameA = data.hub;
    const nameB = data.peer;
    const left = document.createElement('div');
    left.className = 'game-lb-name';
    left.textContent = nameA;
    const vs = document.createElement('div');
    vs.className = 'game-lb-vs';
    vs.textContent = 'VS';
    const right = document.createElement('div');
    right.className = 'game-lb-name';
    right.textContent = nameB;
    lbHeader.appendChild(left);
    lbHeader.appendChild(vs);
    lbHeader.appendChild(right);

    const scoresA = (data.scores && data.scores[nameA]) || {};
    const scoresB = (data.scores && data.scores[nameB]) || {};
    LEADERBOARD_GAMES.forEach((g) => {
      const a = Number(scoresA[g] || 0);
      const b = Number(scoresB[g] || 0);
      const row = document.createElement('div');
      row.className = 'game-lb-row';
      const sa = document.createElement('div');
      sa.className = 'game-lb-score' + (a > b && a > 0 ? ' win' : '');
      sa.textContent = a;
      const label = document.createElement('div');
      label.className = 'game-lb-game';
      label.textContent = GAME_LABEL[g] || g;
      const sb = document.createElement('div');
      sb.className = 'game-lb-score' + (b > a && b > 0 ? ' win' : '');
      sb.textContent = b;
      row.appendChild(sa);
      row.appendChild(label);
      row.appendChild(sb);
      lbBody.appendChild(row);
    });
  }
  function unmountCurrent() {
    try { if (cleanupFn) cleanupFn(); } catch (_) {}
    cleanupFn = null;
    currentGameId = null;
    board.innerHTML = '';
    scoreEl.textContent = '0';
    bestEl.textContent = '0';
    movesEl.textContent = '0';
    bestWrap.classList.add('hidden');
    movesWrap.classList.add('hidden');
  }
  function selectGame(id) {
    const g = GAMES[id];
    if (!g) return;
    unmountCurrent();
    currentGameId = id;
    picker.classList.add('hidden');
    stage.classList.remove('hidden');
    leaderboardView.classList.add('hidden');
    backBtn.classList.remove('hidden');
    if (lbBtn) lbBtn.classList.add('hidden');
    titleEl.textContent = g.title;
    cleanupFn = g.mount(board) || null;
  }
  function restart() {
    if (currentGameId) selectGame(currentGameId);
  }

  closeBtn.addEventListener('click', close);
  backBtn.addEventListener('click', showPicker);
  restartBtn.addEventListener('click', restart);
  if (lbBtn) lbBtn.addEventListener('click', showLeaderboard);
  picker.querySelectorAll('.game-card').forEach((card) => {
    card.addEventListener('click', () => selectGame(card.dataset.game));
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
  });

  // ------------------------------------------------------------------
  // 2048
  // ------------------------------------------------------------------
  function mount2048(host) {
    const grid = document.createElement('div');
    grid.className = 'g2048-grid';
    const cells = document.createElement('div');
    cells.className = 'g2048-cells';
    for (let i = 0; i < 16; i++) {
      const c = document.createElement('div');
      c.className = 'g2048-cell';
      cells.appendChild(c);
    }
    const tiles = document.createElement('div');
    tiles.className = 'g2048-tiles';
    grid.appendChild(cells);
    grid.appendChild(tiles);
    host.appendChild(grid);

    let boardState = new Array(16).fill(0);
    let score = 0;
    let best = parseInt(localStorage.getItem('game2048_best') || '0', 10) || 0;
    let over = false;

    bestWrap.classList.remove('hidden');
    bestEl.textContent = best;
    hintEl.textContent = 'Swipe atau tekan panah untuk gerak';

    function addRandom() {
      const empty = [];
      for (let i = 0; i < 16; i++) if (boardState[i] === 0) empty.push(i);
      if (!empty.length) return;
      const idx = empty[Math.floor(Math.random() * empty.length)];
      boardState[idx] = Math.random() < 0.9 ? 2 : 4;
    }
    function render() {
      tiles.innerHTML = '';
      for (let i = 0; i < 16; i++) {
        if (boardState[i] === 0) {
          tiles.appendChild(document.createElement('div'));
        } else {
          const t = document.createElement('div');
          t.className = 'g2048-tile';
          t.dataset.v = boardState[i];
          t.textContent = boardState[i];
          tiles.appendChild(t);
        }
      }
      scoreEl.textContent = score;
      if (score > best) {
        best = score;
        bestEl.textContent = best;
        try { localStorage.setItem('game2048_best', String(best)); } catch (_) {}
        submitScore('2048', best);
      }
    }
    function slide(row) {
      const nz = row.filter((v) => v !== 0);
      let added = 0;
      for (let i = 0; i < nz.length - 1; i++) {
        if (nz[i] === nz[i + 1]) {
          nz[i] *= 2;
          added += nz[i];
          nz.splice(i + 1, 1);
        }
      }
      while (nz.length < 4) nz.push(0);
      return { row: nz, added };
    }
    function move(dir) {
      if (over) return;
      const before = boardState.slice();
      let added = 0;
      for (let r = 0; r < 4; r++) {
        let row;
        if (dir === 0)      row = [boardState[r*4],   boardState[r*4+1], boardState[r*4+2], boardState[r*4+3]];
        else if (dir === 1) row = [boardState[r*4+3], boardState[r*4+2], boardState[r*4+1], boardState[r*4]];
        else if (dir === 2) row = [boardState[r],     boardState[r+4],   boardState[r+8],   boardState[r+12]];
        else                row = [boardState[r+12],  boardState[r+8],   boardState[r+4],   boardState[r]];
        const res = slide(row);
        added += res.added;
        const out = res.row;
        if (dir === 0)      { boardState[r*4]=out[0];   boardState[r*4+1]=out[1]; boardState[r*4+2]=out[2]; boardState[r*4+3]=out[3]; }
        else if (dir === 1) { boardState[r*4+3]=out[0]; boardState[r*4+2]=out[1]; boardState[r*4+1]=out[2]; boardState[r*4]=out[3]; }
        else if (dir === 2) { boardState[r]=out[0];     boardState[r+4]=out[1];   boardState[r+8]=out[2];   boardState[r+12]=out[3]; }
        else                { boardState[r+12]=out[0];  boardState[r+8]=out[1];   boardState[r+4]=out[2];   boardState[r]=out[3]; }
      }
      let changed = false;
      for (let i = 0; i < 16; i++) if (before[i] !== boardState[i]) { changed = true; break; }
      if (!changed) return;
      score += added;
      addRandom();
      render();
      if (isGameOver()) {
        over = true;
        const ov = document.createElement('div');
        ov.className = 'g2048-overlay';
        ov.innerHTML = '<div>Game Over</div><div style="font-size:14px;opacity:.8">Score ' + score + '</div>';
        grid.appendChild(ov);
      }
    }
    function isGameOver() {
      if (boardState.indexOf(0) !== -1) return false;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const v = boardState[r*4+c];
          if (c < 3 && v === boardState[r*4+c+1]) return false;
          if (r < 3 && v === boardState[(r+1)*4+c]) return false;
        }
      }
      return true;
    }

    function onKey(e) {
      if (e.key === 'ArrowLeft')       { e.preventDefault(); move(0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); move(2); }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); move(3); }
    }
    let touch = null;
    function onTouchStart(e) {
      const t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY };
    }
    function onTouchEnd(e) {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < 20) return;
      if (ax > ay) move(dx > 0 ? 1 : 0);
      else move(dy > 0 ? 3 : 2);
    }
    grid.addEventListener('touchstart', onTouchStart, { passive: true });
    grid.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('keydown', onKey);

    addRandom();
    addRandom();
    render();

    return function () {
      document.removeEventListener('keydown', onKey);
    };
  }

  // ------------------------------------------------------------------
  // Snake
  // ------------------------------------------------------------------
  function mountSnake(host) {
    const CELLS = 15;
    const SIZE = 340;
    const cellSize = SIZE / CELLS;
    const canvas = document.createElement('canvas');
    canvas.className = 'gsnake-canvas';
    canvas.width = SIZE;
    canvas.height = SIZE;
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let snake = [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
    let dir = { x: 1, y: 0 };
    let nextDir = dir;
    let food = placeFood();
    let score = 0;
    let best = parseInt(localStorage.getItem('gameSnake_best') || '0', 10) || 0;
    let over = false;
    let timer = null;

    bestWrap.classList.remove('hidden');
    bestEl.textContent = best;
    hintEl.textContent = 'Swipe atau tekan panah';

    function placeFood() {
      while (true) {
        const f = { x: Math.floor(Math.random() * CELLS), y: Math.floor(Math.random() * CELLS) };
        if (!snake.some((s) => s.x === f.x && s.y === f.y)) return f;
      }
    }
    function draw() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      const ink = styleVar('--toon-ink', '#000');
      const teal = styleVar('--toon-teal', '#2fb7c4');
      const pink = styleVar('--toon-pink', '#ff5d8f');

      ctx.fillStyle = pink;
      ctx.beginPath();
      ctx.arc(food.x * cellSize + cellSize / 2, food.y * cellSize + cellSize / 2, cellSize / 2 - 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = teal;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      snake.forEach((s) => {
        ctx.fillRect(s.x * cellSize + 1, s.y * cellSize + 1, cellSize - 2, cellSize - 2);
        ctx.strokeRect(s.x * cellSize + 1, s.y * cellSize + 1, cellSize - 2, cellSize - 2);
      });

      if (over) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 24px system-ui, sans-serif';
        ctx.fillText('Game Over', SIZE / 2, SIZE / 2 - 6);
        ctx.font = '14px system-ui, sans-serif';
        ctx.fillText('Score: ' + score, SIZE / 2, SIZE / 2 + 20);
      }
    }
    function step() {
      if (over) return;
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.x >= CELLS || head.y < 0 || head.y >= CELLS) return gameOver();
      if (snake.some((s) => s.x === head.x && s.y === head.y)) return gameOver();
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score += 10;
        scoreEl.textContent = score;
        if (score > best) {
          best = score;
          bestEl.textContent = best;
          try { localStorage.setItem('gameSnake_best', String(best)); } catch (_) {}
          submitScore('snake', best);
        }
        food = placeFood();
      } else {
        snake.pop();
      }
      draw();
    }
    function gameOver() {
      over = true;
      if (timer) { clearInterval(timer); timer = null; }
      draw();
    }
    function setDir(dx, dy) {
      if (dx === -dir.x && dy === -dir.y) return;
      nextDir = { x: dx, y: dy };
    }
    function onKey(e) {
      if (e.key === 'ArrowLeft')       { e.preventDefault(); setDir(-1, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setDir(1, 0); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); setDir(0, -1); }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); setDir(0, 1); }
    }
    let touch = null;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    canvas.addEventListener('touchend', (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < 20) return;
      if (ax > ay) setDir(dx > 0 ? 1 : -1, 0);
      else setDir(0, dy > 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('keydown', onKey);

    draw();
    timer = setInterval(step, 140);

    return function () {
      if (timer) clearInterval(timer);
      document.removeEventListener('keydown', onKey);
    };
  }

  // ------------------------------------------------------------------
  // Memory match
  // ------------------------------------------------------------------
  function mountMemory(host) {
    const EMOJIS = ['🍎', '🍌', '🍇', '🍓', '🍑', '🥝', '🍒', '🍍'];
    const deck = EMOJIS.concat(EMOJIS);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    const grid = document.createElement('div');
    grid.className = 'gmem-grid';
    host.appendChild(grid);

    movesWrap.classList.remove('hidden');
    let moves = 0;
    let matched = 0;
    let flipped = [];
    let lock = false;
    let timeoutId = null;
    hintEl.textContent = 'Cocokkan semua pasangan';

    deck.forEach((emoji, idx) => {
      const btn = document.createElement('button');
      btn.className = 'gmem-card';
      btn.type = 'button';
      btn.dataset.emoji = emoji;
      btn.dataset.idx = String(idx);
      const inner = document.createElement('div');
      inner.className = 'gmem-inner';
      const front = document.createElement('div');
      front.className = 'gmem-face gmem-front';
      front.textContent = '?';
      const back = document.createElement('div');
      back.className = 'gmem-face gmem-back';
      back.textContent = emoji;
      inner.appendChild(front);
      inner.appendChild(back);
      btn.appendChild(inner);
      btn.addEventListener('click', () => flip(btn));
      grid.appendChild(btn);
    });

    function flip(btn) {
      if (lock) return;
      if (btn.classList.contains('flipped') || btn.classList.contains('matched')) return;
      btn.classList.add('flipped');
      flipped.push(btn);
      if (flipped.length === 2) {
        moves++;
        movesEl.textContent = moves;
        const a = flipped[0], b = flipped[1];
        if (a.dataset.emoji === b.dataset.emoji) {
          a.classList.add('matched');
          b.classList.add('matched');
          flipped = [];
          matched += 2;
          if (matched === deck.length) {
            hintEl.textContent = '🎉 Selesai dalam ' + moves + ' moves';
          }
        } else {
          lock = true;
          timeoutId = setTimeout(() => {
            a.classList.remove('flipped');
            b.classList.remove('flipped');
            flipped = [];
            lock = false;
            timeoutId = null;
          }, 700);
        }
      }
    }

    return function () {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }

  // ------------------------------------------------------------------
  // Dino Run (Chrome offline clone)
  // ------------------------------------------------------------------
  function mountDino(host) {
    const W = 500, H = 160;
    const canvas = document.createElement('canvas');
    canvas.className = 'gdino-canvas';
    canvas.width = W;
    canvas.height = H;
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const GROUND_Y = H - 20;
    const GRAVITY = 0.55;
    const JUMP_V = -10.2;

    const dino = { x: 40, y: GROUND_Y, vy: 0, w: 22, h: 30, ducking: false };
    let obstacles = [];
    let speed = 3.8;
    const MAX_SPEED = 6.4;
    let score = 0;
    let best = parseInt(localStorage.getItem('gameDino_best') || '0', 10) || 0;
    let over = false;
    let raf = null;
    let spawnCooldown = 120;
    let tick = 0;

    bestWrap.classList.remove('hidden');
    bestEl.textContent = best;
    hintEl.textContent = 'Space / tap = lompat, ↓ = nunduk';

    function jump() {
      if (over) return;
      if (dino.y >= GROUND_Y) {
        dino.vy = JUMP_V;
      }
    }
    function duck(on) {
      if (over) return;
      dino.ducking = on;
      dino.h = on ? 16 : 30;
    }
    function spawn() {
      const r = Math.random();
      if (r < 0.55) {
        obstacles.push({ x: W, y: GROUND_Y - 22, w: 14, h: 22, kind: 'cactus' });
      } else if (r < 0.8) {
        obstacles.push({ x: W, y: GROUND_Y - 34, w: 20, h: 34, kind: 'cactus' });
      } else if (r < 0.92) {
        obstacles.push({ x: W, y: GROUND_Y - 22, w: 34, h: 22, kind: 'cactus-wide' });
      } else {
        obstacles.push({ x: W, y: GROUND_Y - 46, w: 24, h: 14, kind: 'ptero' });
      }
    }
    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }
    function loop() {
      if (over) return;
      tick++;

      dino.vy += GRAVITY;
      dino.y += dino.vy;
      if (dino.y > GROUND_Y) { dino.y = GROUND_Y; dino.vy = 0; }

      spawnCooldown -= speed;
      if (spawnCooldown <= 0) {
        spawn();
        spawnCooldown = 140 + Math.random() * 120;
      }

      for (let i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= speed;
        if (obstacles[i].x + obstacles[i].w < 0) obstacles.splice(i, 1);
      }

      const dinoBox = { x: dino.x + 2, y: dino.y - dino.h + 2, w: dino.w - 4, h: dino.h - 4 };
      for (let i = 0; i < obstacles.length; i++) {
        if (aabb(dinoBox, obstacles[i])) { gameOver(); return; }
      }

      if (tick % 3 === 0) {
        score++;
        scoreEl.textContent = score;
        if (score > best) {
          best = score;
          bestEl.textContent = best;
          try { localStorage.setItem('gameDino_best', String(best)); } catch (_) {}
        }
        if (score > 0 && score % 200 === 0 && speed < MAX_SPEED) {
          speed = Math.min(MAX_SPEED, speed + 0.15);
        }
      }

      draw();
      raf = requestAnimationFrame(loop);
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      const ink = styleVar('--toon-ink', '#000');
      const teal = styleVar('--toon-teal', '#2fb7c4');
      const orange = styleVar('--toon-orange', '#ff8a3d');
      const green = '#6ba368';

      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 1);
      ctx.lineTo(W, GROUND_Y + 1);
      ctx.stroke();

      ctx.fillStyle = teal;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.fillRect(dino.x, dino.y - dino.h, dino.w, dino.h);
      ctx.strokeRect(dino.x, dino.y - dino.h, dino.w, dino.h);
      ctx.fillStyle = ink;
      ctx.fillRect(dino.x + dino.w - 6, dino.y - dino.h + 5, 2, 2);

      for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        ctx.fillStyle = o.kind === 'ptero' ? orange : green;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      }

      if (over) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillText('Game Over', W / 2, H / 2 - 4);
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('Score ' + score + '  •  Restart untuk main lagi', W / 2, H / 2 + 18);
      }
    }
    function gameOver() {
      over = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      draw();
      if (score > 0) submitScore('dino', best);
    }

    function onKeyDown(e) {
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        jump();
      } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        duck(true);
      }
    }
    function onKeyUp(e) {
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') duck(false);
    }
    function onTap(e) {
      e.preventDefault();
      jump();
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onTap);
    canvas.addEventListener('touchstart', onTap, { passive: false });

    draw();
    raf = requestAnimationFrame(loop);

    return function () {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
  }

  window.MiniGames = { open: open, close: close };
})();
