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
  const LEADERBOARD_GAMES = ['2048', 'snake', 'dino', 'racing'];

  let currentGameId = null;
  let cleanupFn = null;
  let sharedSocket = null;
  let getPartnerFn = null;
  let getMeFn = null;

  function init(opts) {
    if (opts && opts.socket) sharedSocket = opts.socket;
    if (opts && typeof opts.getPartner === 'function') getPartnerFn = opts.getPartner;
    if (opts && typeof opts.getMe === 'function') getMeFn = opts.getMe;
  }

  const GAMES = {
    '2048':      { title: '2048',        mount: mount2048 },
    'snake':     { title: 'Snake',       mount: mountSnake },
    'memory':    { title: 'Memory',      mount: mountMemory },
    'dino':      { title: 'Dino Run',    mount: mountDino },
    'racing':    { title: 'Racing',      mount: mountRacing },
    'tictactoe': { title: 'Tic-Tac-Toe', mount: mountTicTacToe },
    'snakeladder': { title: 'Ular Tangga', mount: mountSnakeLadder },
    'remi':      { title: 'Remi Joker',  mount: mountRemi },
  };

  function styleVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function open(gameId) {
    modal.classList.remove('hidden');
    syncBestsFromServer();
    if (gameId && GAMES[gameId]) {
      selectGame(gameId);
    } else {
      showPicker();
    }
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
  const GAME_LABEL = { '2048': '2048', 'snake': 'Snake', 'dino': 'Dino', 'racing': 'Racing' };
  const BEST_LS_KEYS = { '2048': 'game2048_best', 'snake': 'gameSnake_best', 'dino': 'gameDino_best', 'racing': 'gameRacing_best' };

  async function syncBestsFromServer() {
    const { me, peer } = getMeAndPeer();
    if (!me || !peer) return;
    try {
      const url = me === HUB_USER ? '/leaderboard?peer=' + encodeURIComponent(peer) : '/leaderboard';
      const res = await fetch(url, { headers: authHeaders() });
      const data = await res.json();
      if (!data || !data.ok || !data.scores) return;
      const myScores = data.scores[me] || {};
      for (const g of Object.keys(BEST_LS_KEYS)) {
        const serverBest = Number(myScores[g] || 0);
        const localBest = parseInt(localStorage.getItem(BEST_LS_KEYS[g]) || '0', 10) || 0;
        if (serverBest > localBest) {
          try { localStorage.setItem(BEST_LS_KEYS[g], String(serverBest)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
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
  async function selectGame(id) {
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
    await syncBestsFromServer();
    if (currentGameId !== id) return;
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
        bestEl.textContent = best;
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
      bestEl.textContent = best;
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
    const tapZone = document.createElement('div');
    tapZone.className = 'gdino-tap';
    const canvas = document.createElement('canvas');
    canvas.className = 'gdino-canvas';
    canvas.width = W;
    canvas.height = H;
    tapZone.appendChild(canvas);
    host.appendChild(tapZone);
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
      bestEl.textContent = best;
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
    tapZone.addEventListener('mousedown', onTap);
    tapZone.addEventListener('touchstart', onTap, { passive: false });

    draw();
    raf = requestAnimationFrame(loop);

    return function () {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
  }

  // ------------------------------------------------------------------
  // Racing — top-down, dodge oncoming cars
  // ------------------------------------------------------------------
  function mountRacing(host) {
    const W = 300, H = 460;
    const LANES = 3;
    const LANE_W = W / LANES;
    const tapZone = document.createElement('div');
    tapZone.className = 'gracing-tap';
    const canvas = document.createElement('canvas');
    canvas.className = 'gracing-canvas';
    canvas.width = W;
    canvas.height = H;
    tapZone.appendChild(canvas);
    host.appendChild(tapZone);
    const ctx = canvas.getContext('2d');

    const CAR_W = 40, CAR_H = 66;
    let lane = 1;
    let targetX = laneCenter(lane) - CAR_W / 2;
    let carX = targetX;
    const carY = H - CAR_H - 16;

    let enemies = [];
    let dashes = [0, 100, 200, 300, 400];
    let speed = 2.2;
    const MAX_SPEED = 6.0;
    let spawnCd = 60;
    let score = 0;
    let best = parseInt(localStorage.getItem('gameRacing_best') || '0', 10) || 0;
    let over = false;
    let raf = null;
    let tick = 0;

    bestWrap.classList.remove('hidden');
    bestEl.textContent = best;
    hintEl.textContent = '← → / swipe / tap kiri-kanan';

    function laneCenter(i) { return i * LANE_W + LANE_W / 2; }
    function setLane(i) {
      if (over) return;
      lane = Math.max(0, Math.min(LANES - 1, i));
      targetX = laneCenter(lane) - CAR_W / 2;
    }

    function spawn() {
      const MIN_SAME_LANE_GAP = 170;
      const DANGER_BAND = 220;
      const freeLanes = [];
      for (let i = 0; i < LANES; i++) {
        let ok = true;
        for (let j = 0; j < enemies.length; j++) {
          if (enemies[j].lane === i && enemies[j].y < MIN_SAME_LANE_GAP) { ok = false; break; }
        }
        if (ok) freeLanes.push(i);
      }
      if (!freeLanes.length) return;
      const lanesInBand = new Set();
      for (let i = 0; i < enemies.length; i++) {
        if (enemies[i].y < DANGER_BAND) lanesInBand.add(enemies[i].lane);
      }
      const safe = freeLanes.filter((l) => {
        const test = new Set(lanesInBand);
        test.add(l);
        return test.size < LANES;
      });
      if (!safe.length) return;
      const l = safe[Math.floor(Math.random() * safe.length)];
      const colors = ['#ff5d8f', '#ffd23f', '#a855f7', '#f97316', '#22c55e'];
      enemies.push({
        lane: l,
        x: laneCenter(l) - CAR_W / 2,
        y: -CAR_H,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function loop() {
      if (over) return;
      tick++;

      carX += (targetX - carX) * 0.28;

      spawnCd -= speed;
      if (spawnCd <= 0) {
        spawn();
        spawnCd = 60 + Math.random() * 50;
      }

      for (let i = 0; i < dashes.length; i++) {
        dashes[i] += speed;
        if (dashes[i] > H) dashes[i] -= H + 40;
      }
      for (let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].y += speed;
        if (enemies[i].y > H) enemies.splice(i, 1);
      }

      const playerBox = { x: carX + 4, y: carY + 4, w: CAR_W - 8, h: CAR_H - 8 };
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (aabb(playerBox, { x: e.x + 4, y: e.y + 4, w: CAR_W - 8, h: CAR_H - 8 })) {
          gameOver();
          return;
        }
      }

      if (tick % 3 === 0) {
        score++;
        scoreEl.textContent = score;
        if (score > best) {
          best = score;
          try { localStorage.setItem('gameRacing_best', String(best)); } catch (_) {}
        }
        if (score > 0 && score % 80 === 0 && speed < MAX_SPEED) {
          speed = Math.min(MAX_SPEED, speed + 0.15);
        }
      }

      draw();
      raf = requestAnimationFrame(loop);
    }

    function drawCar(x, y, color) {
      const ink = styleVar('--toon-ink', '#000');
      ctx.fillStyle = color;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      roundRect(x, y, CAR_W, CAR_H, 8, true, true);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x + 6, y + 10, CAR_W - 12, 14);
      ctx.fillRect(x + 6, y + CAR_H - 26, CAR_W - 12, 12);
      ctx.fillStyle = ink;
      ctx.fillRect(x - 2, y + 8, 4, 10);
      ctx.fillRect(x + CAR_W - 2, y + 8, 4, 10);
      ctx.fillRect(x - 2, y + CAR_H - 18, 4, 10);
      ctx.fillRect(x + CAR_W - 2, y + CAR_H - 18, 4, 10);
    }

    function roundRect(x, y, w, h, r, fill, stroke) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      if (fill) ctx.fill();
      if (stroke) ctx.stroke();
    }

    function draw() {
      ctx.fillStyle = '#2a2a30';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#3a3a42';
      ctx.fillRect(0, 0, 8, H);
      ctx.fillRect(W - 8, 0, 8, H);

      ctx.fillStyle = '#f5f5f5';
      for (let i = 1; i < LANES; i++) {
        const lx = i * LANE_W - 2;
        for (let j = 0; j < dashes.length; j++) {
          ctx.fillRect(lx, dashes[j], 4, 20);
        }
      }

      for (let i = 0; i < enemies.length; i++) {
        drawCar(enemies[i].x, enemies[i].y, enemies[i].color);
      }
      drawCar(carX, carY, styleVar('--toon-teal', '#2fb7c4'));

      if (over) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 24px system-ui, sans-serif';
        ctx.fillText('Crashed!', W / 2, H / 2 - 6);
        ctx.font = '14px system-ui, sans-serif';
        ctx.fillText('Score ' + score, W / 2, H / 2 + 18);
      }
    }

    function gameOver() {
      over = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      bestEl.textContent = best;
      draw();
      if (score > 0) submitScore('racing', best);
    }

    function onKey(e) {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault(); setLane(lane - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault(); setLane(lane + 1);
      }
    }
    let touch = null;
    function onTouchStart(e) {
      const t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY, moved: false };
    }
    function onTouchEnd(e) {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax > 20 && ax > ay) {
        setLane(lane + (dx > 0 ? 1 : -1));
      } else if (ax < 15 && ay < 15) {
        const rect = canvas.getBoundingClientRect();
        const relX = t.clientX - rect.left;
        setLane(relX < rect.width / 2 ? lane - 1 : lane + 1);
      }
      touch = null;
    }
    function onMouseDown(e) {
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      setLane(relX < rect.width / 2 ? lane - 1 : lane + 1);
    }

    document.addEventListener('keydown', onKey);
    tapZone.addEventListener('touchstart', onTouchStart, { passive: true });
    tapZone.addEventListener('touchend', onTouchEnd, { passive: true });
    tapZone.addEventListener('mousedown', onMouseDown);

    draw();
    raf = requestAnimationFrame(loop);

    return function () {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
    };
  }

  // ------------------------------------------------------------------
  // Tic-Tac-Toe (multiplayer)
  // ------------------------------------------------------------------
  function mountTicTacToe(rootEl) {
    if (!sharedSocket) {
      rootEl.innerHTML = '<div class="ttt-wrap"><div class="ttt-status">Koneksi belum siap. Coba lagi sebentar.</div></div>';
      hintEl.textContent = '';
      return function () {};
    }
    const me = (getMeFn && getMeFn()) || localStorage.getItem('username') || '';
    const meIsHub = me === HUB_USER;
    const peer = meIsHub
      ? (getPartnerFn ? getPartnerFn() : localStorage.getItem('activePeer'))
      : me;
    if (!peer) {
      rootEl.innerHTML = '<div class="ttt-wrap"><div class="ttt-status">Pilih peer aktif dulu di daftar chat.</div></div>';
      hintEl.textContent = '';
      return function () {};
    }

    scoreEl.textContent = '0';
    bestWrap.classList.add('hidden');
    movesWrap.classList.add('hidden');
    hintEl.textContent = 'Sinkron dengan peer via realtime chat.';

    const wrap = document.createElement('div');
    wrap.className = 'ttt-wrap';
    const statusEl = document.createElement('div');
    statusEl.className = 'ttt-status';
    const grid = document.createElement('div');
    grid.className = 'ttt-grid';
    const actions = document.createElement('div');
    actions.className = 'ttt-actions';
    wrap.appendChild(statusEl);
    wrap.appendChild(grid);
    wrap.appendChild(actions);
    rootEl.innerHTML = '';
    rootEl.appendChild(wrap);

    const cells = [];
    for (let i = 0; i < 9; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ttt-cell';
      btn.dataset.index = String(i);
      btn.addEventListener('click', () => onCellClick(i));
      grid.appendChild(btn);
      cells.push(btn);
    }

    let currentSession = null;

    function symOf(username) {
      return currentSession && currentSession.symbols ? currentSession.symbols[username] : null;
    }

    function render() {
      actions.innerHTML = '';
      const s = currentSession;
      if (!s) {
        statusEl.textContent = 'Ajak peer main Tic-Tac-Toe.';
        for (const c of cells) {
          c.textContent = '';
          c.className = 'ttt-cell';
          c.disabled = true;
        }
        addBtn('Undang peer', 'primary', invite);
        return;
      }
      for (let i = 0; i < 9; i++) {
        const v = s.board[i];
        cells[i].textContent = v || '';
        cells[i].className = 'ttt-cell' + (v ? ' ' + v.toLowerCase() : '');
        if (s.winLine && s.winLine.indexOf(i) >= 0) cells[i].classList.add('win');
        cells[i].disabled = true;
      }
      const mySym = symOf(me);
      if (s.status === 'pending') {
        if (me === s.inviter) {
          statusEl.innerHTML = 'Menunggu <b>' + escapeText(s.opponent) + '</b> menerima undangan…';
          addBtn('Batalkan', 'secondary', decline);
        } else if (me === s.opponent) {
          statusEl.innerHTML = '<b>' + escapeText(s.inviter) + '</b> mengajakmu main. Terima?';
          addBtn('Terima', 'primary', accept);
          addBtn('Tolak', 'secondary', decline);
        } else {
          statusEl.textContent = 'Sesi sedang berlangsung.';
        }
      } else if (s.status === 'active') {
        const isMyTurn = mySym && s.turn === mySym;
        statusEl.innerHTML = isMyTurn
          ? 'Giliranmu ' + symChip(mySym)
          : 'Giliran peer ' + symChip(s.turn);
        if (isMyTurn) {
          for (let i = 0; i < 9; i++) if (!s.board[i]) cells[i].disabled = false;
        }
        addBtn('Menyerah', 'secondary', leave);
      } else if (s.status === 'done') {
        if (s.winner === 'draw') {
          statusEl.textContent = 'Seri! ✋';
        } else if (s.winner === me) {
          statusEl.innerHTML = 'Kamu menang ' + symChip(s.winnerSymbol) + ' 🎉';
        } else {
          statusEl.innerHTML = 'Kamu kalah dari <b>' + escapeText(s.winner || 'peer') + '</b>';
        }
        addBtn('Main lagi', 'primary', rematch);
        addBtn('Tutup', 'secondary', () => { leave(); });
      }
    }

    function addBtn(label, variant, handler) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ttt-btn' + (variant === 'secondary' ? ' secondary' : '');
      b.textContent = label;
      b.addEventListener('click', handler);
      actions.appendChild(b);
    }
    function symChip(sym) {
      if (!sym) return '';
      return '<span class="ttt-sym ' + sym.toLowerCase() + '">' + sym + '</span>';
    }
    function escapeText(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function onCellClick(i) {
      const s = currentSession;
      if (!s || s.status !== 'active') return;
      const mySym = symOf(me);
      if (!mySym || s.turn !== mySym) return;
      if (s.board[i]) return;
      sharedSocket.emit('tictactoe:move', { peer, index: i }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function invite() {
      sharedSocket.emit('tictactoe:invite', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function accept() {
      sharedSocket.emit('tictactoe:accept', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function decline() {
      sharedSocket.emit('tictactoe:decline', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function rematch() {
      sharedSocket.emit('tictactoe:rematch', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function leave() {
      sharedSocket.emit('tictactoe:leave', { peer }, () => {});
    }

    let hintTimer = null;
    function flashHint(msg) {
      hintEl.textContent = msg;
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hintEl.textContent = 'Sinkron dengan peer via realtime chat.'; }, 2500);
    }

    function onState(payload) {
      if (!payload || payload.peer !== peer) return;
      currentSession = payload.session || null;
      render();
    }
    sharedSocket.on('tictactoe:state', onState);
    sharedSocket.emit('tictactoe:sync', { peer }, (resp) => {
      if (resp && resp.ok) {
        currentSession = resp.session || null;
        render();
      } else {
        render();
      }
    });

    return function cleanup() {
      sharedSocket.off('tictactoe:state', onState);
      if (hintTimer) clearTimeout(hintTimer);
    };
  }

  // ------------------------------------------------------------------
  // Snakes & Ladders (multiplayer)
  // ------------------------------------------------------------------
  function mountSnakeLadder(rootEl) {
    if (!sharedSocket) {
      rootEl.innerHTML = '<div class="snl-wrap"><div class="snl-status">Koneksi belum siap. Coba lagi sebentar.</div></div>';
      hintEl.textContent = '';
      return function () {};
    }
    const me = (getMeFn && getMeFn()) || localStorage.getItem('username') || '';
    const meIsHub = me === HUB_USER;
    const peer = meIsHub
      ? (getPartnerFn ? getPartnerFn() : localStorage.getItem('activePeer'))
      : me;
    if (!peer) {
      rootEl.innerHTML = '<div class="snl-wrap"><div class="snl-status">Pilih peer aktif dulu di daftar chat.</div></div>';
      hintEl.textContent = '';
      return function () {};
    }

    scoreEl.textContent = '0';
    bestWrap.classList.add('hidden');
    movesWrap.classList.add('hidden');
    hintEl.textContent = 'Dapat angka 6 = lempar lagi.';

    const wrap = document.createElement('div');
    wrap.className = 'snl-wrap';
    const statusEl = document.createElement('div');
    statusEl.className = 'snl-status';
    const boardWrap = document.createElement('div');
    boardWrap.className = 'snl-board-wrap';
    const boardEl = document.createElement('div');
    boardEl.className = 'snl-board';
    const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlaySvg.setAttribute('class', 'snl-overlay');
    overlaySvg.setAttribute('viewBox', '0 0 100 100');
    overlaySvg.setAttribute('preserveAspectRatio', 'none');
    const pawnLayer = document.createElement('div');
    pawnLayer.className = 'snl-pawns';
    boardWrap.appendChild(boardEl);
    boardWrap.appendChild(overlaySvg);
    boardWrap.appendChild(pawnLayer);
    const infoRow = document.createElement('div');
    infoRow.className = 'snl-info';
    const diceEl = document.createElement('div');
    diceEl.className = 'snl-dice';
    diceEl.textContent = '🎲';
    const rollLog = document.createElement('div');
    rollLog.className = 'snl-log';
    infoRow.appendChild(diceEl);
    infoRow.appendChild(rollLog);
    const actions = document.createElement('div');
    actions.className = 'snl-actions';
    wrap.appendChild(statusEl);
    wrap.appendChild(boardWrap);
    wrap.appendChild(infoRow);
    wrap.appendChild(actions);
    rootEl.innerHTML = '';
    rootEl.appendChild(wrap);

    const cells = [];
    for (let row = 0; row < 10; row++) {
      const rowFromBottom = 9 - row;
      for (let col = 0; col < 10; col++) {
        const posInRow = rowFromBottom % 2 === 0 ? col : 9 - col;
        const n = rowFromBottom * 10 + posInRow + 1;
        const cell = document.createElement('div');
        cell.className = 'snl-cell';
        cell.textContent = String(n);
        cell.dataset.n = String(n);
        boardEl.appendChild(cell);
        cells[n] = cell;
      }
    }

    function cellCenter(n) {
      const rowFromBottom = Math.floor((n - 1) / 10);
      const posInRow = (n - 1) % 10;
      const col = rowFromBottom % 2 === 0 ? posInRow : 9 - posInRow;
      const rowFromTop = 9 - rowFromBottom;
      return { x: col * 10 + 5, y: rowFromTop * 10 + 5 };
    }

    let currentSession = null;

    function render() {
      actions.innerHTML = '';
      const s = currentSession;
      renderCells(s);
      renderOverlay(s);
      renderPawns(s);
      renderRoll(s);
      if (!s) {
        statusEl.textContent = 'Ajak peer main Ular Tangga.';
        addBtn('Undang peer', 'primary', invite);
        return;
      }
      if (s.status === 'pending') {
        if (me === s.inviter) {
          statusEl.innerHTML = 'Menunggu <b>' + escapeText(s.opponent) + '</b> menerima undangan…';
          addBtn('Batalkan', 'secondary', decline);
        } else if (me === s.opponent) {
          statusEl.innerHTML = '<b>' + escapeText(s.inviter) + '</b> mengajakmu main. Terima?';
          addBtn('Terima', 'primary', accept);
          addBtn('Tolak', 'secondary', decline);
        }
      } else if (s.status === 'active') {
        const isMyTurn = s.turn === me;
        const bonus = s.lastRoll && s.lastRoll.by === s.turn && s.lastRoll.dice === 6;
        statusEl.innerHTML = isMyTurn
          ? 'Giliranmu ' + pawnChip(me) + (bonus ? ' <small>(bonus, kena 6)</small>' : '')
          : 'Giliran ' + pawnChip(s.turn) + ' <b>' + escapeText(s.turn) + '</b>' + (bonus ? ' <small>(bonus)</small>' : '');
        if (isMyTurn) addBtn('Lempar dadu 🎲', 'primary', roll);
        addBtn('Menyerah', 'secondary', leave);
      } else if (s.status === 'done') {
        if (s.winner === me) statusEl.innerHTML = 'Kamu menang! 🎉';
        else statusEl.innerHTML = '<b>' + escapeText(s.winner || 'peer') + '</b> menang. Coba lagi?';
        addBtn('Main lagi', 'primary', rematch);
        addBtn('Tutup', 'secondary', () => { leave(); });
      }
    }

    function renderCells(s) {
      for (let n = 1; n <= 100; n++) {
        const cell = cells[n];
        cell.className = 'snl-cell';
        if (s && s.ladders && s.ladders[n] !== undefined) cell.classList.add('ladder-foot');
        if (s && s.snakes && s.snakes[n] !== undefined) cell.classList.add('snake-head');
        if (s && s.lastRoll && s.lastRoll.to === n) cell.classList.add('recent');
      }
    }

    function renderOverlay(s) {
      overlaySvg.innerHTML = '';
      if (!s) return;
      const drawLine = (from, to, cls) => {
        const a = cellCenter(from);
        const b = cellCenter(to);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(a.x));
        line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x));
        line.setAttribute('y2', String(b.y));
        line.setAttribute('class', cls);
        overlaySvg.appendChild(line);
      };
      if (s.ladders) for (const k in s.ladders) drawLine(Number(k), s.ladders[k], 'snl-ladder-line');
      if (s.snakes) for (const k in s.snakes) drawLine(Number(k), s.snakes[k], 'snl-snake-line');
    }

    function renderPawns(s) {
      pawnLayer.innerHTML = '';
      if (!s) return;
      const players = [s.inviter, s.opponent];
      players.forEach((u, idx) => {
        const pos = s.positions[u] || 0;
        if (pos < 1) {
          const badge = document.createElement('div');
          badge.className = 'snl-pawn-start pawn-' + (idx === 0 ? 'a' : 'b');
          badge.textContent = idx === 0 ? '🔴' : '🔵';
          badge.title = u + ' (mulai)';
          badge.dataset.user = u;
          badge.style.left = (idx === 0 ? 6 : 60) + '%';
          badge.style.top = '-14%';
          pawnLayer.appendChild(badge);
          return;
        }
        const c = cellCenter(pos);
        const p = document.createElement('div');
        p.className = 'snl-pawn pawn-' + (idx === 0 ? 'a' : 'b');
        p.textContent = idx === 0 ? '🔴' : '🔵';
        p.title = u + ' @ ' + pos;
        p.dataset.user = u;
        p.style.left = c.x + '%';
        p.style.top = c.y + '%';
        if (idx === 1) p.classList.add('pawn-offset');
        pawnLayer.appendChild(p);
      });
    }

    function moveToCell(pawnEl, n) {
      const c = cellCenter(n);
      pawnEl.style.left = c.x + '%';
      pawnEl.style.top = c.y + '%';
    }
    function setPawnTransition(pawnEl, ms) {
      pawnEl.style.transition = 'left ' + ms + 'ms linear, top ' + ms + 'ms linear';
    }

    let walkTimer = null;
    function walkPawn(next, lr, done) {
      const u = lr.by;
      const idx = u === next.inviter ? 0 : 1;
      const from = lr.from;
      const jumped = lr.jumped;
      const intermediate = jumped ? jumped.from : lr.to;
      if (from === lr.to && !jumped) { done(); return; }
      let pawnEl = pawnLayer.querySelector('.snl-pawn[data-user="' + cssEscape(u) + '"]');
      if (!pawnEl) {
        const startEl = pawnLayer.querySelector('.snl-pawn-start[data-user="' + cssEscape(u) + '"]');
        if (startEl) startEl.remove();
        pawnEl = document.createElement('div');
        pawnEl.className = 'snl-pawn pawn-' + (idx === 0 ? 'a' : 'b');
        pawnEl.textContent = idx === 0 ? '🔴' : '🔵';
        pawnEl.dataset.user = u;
        pawnEl.style.transition = 'none';
        if (idx === 1) pawnEl.classList.add('pawn-offset');
        moveToCell(pawnEl, Math.max(1, from));
        pawnLayer.appendChild(pawnEl);
        void pawnEl.offsetWidth;
      }
      let cur = Math.max(from, 1);
      const stepMs = 200;
      const loop = () => {
        if (cur >= intermediate) {
          if (jumped) {
            setPawnTransition(pawnEl, 500);
            moveToCell(pawnEl, jumped.to);
            walkTimer = setTimeout(() => { walkTimer = null; done(); }, 550);
          } else {
            done();
          }
          return;
        }
        cur += 1;
        setPawnTransition(pawnEl, stepMs);
        moveToCell(pawnEl, cur);
        walkTimer = setTimeout(loop, stepMs + 30);
      };
      loop();
    }

    function cssEscape(s) {
      if (window.CSS && CSS.escape) return CSS.escape(s);
      return String(s).replace(/[^\w-]/g, '\\$&');
    }

    function renderRoll(s) {
      if (!s || !s.lastRoll) {
        diceEl.textContent = '🎲';
        rollLog.textContent = 'Belum ada lemparan.';
        return;
      }
      const lr = s.lastRoll;
      diceEl.textContent = diceFace(lr.dice);
      let msg = escapeText(lr.by) + ' lempar ' + lr.dice + ' → ' + lr.from + ' ke ' + lr.to;
      if (lr.jumped) {
        msg += lr.jumped.kind === 'ladder' ? ' 🪜 naik' : ' 🐍 turun';
      }
      rollLog.textContent = msg;
    }

    function diceFace(n) {
      return ['⚀','⚁','⚂','⚃','⚄','⚅'][Math.max(0, Math.min(5, n - 1))];
    }

    function addBtn(label, variant, handler) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'snl-btn' + (variant === 'secondary' ? ' secondary' : '');
      b.innerHTML = label;
      b.addEventListener('click', handler);
      actions.appendChild(b);
    }
    function pawnChip(u) {
      if (!currentSession) return '';
      const idx = u === currentSession.inviter ? 0 : 1;
      return '<span class="snl-chip pawn-' + (idx === 0 ? 'a' : 'b') + '">' + (idx === 0 ? '🔴' : '🔵') + '</span>';
    }
    function escapeText(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function invite() {
      sharedSocket.emit('snakeladder:invite', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function accept() {
      sharedSocket.emit('snakeladder:accept', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function decline() {
      sharedSocket.emit('snakeladder:decline', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function roll() {
      if (animating) return;
      sharedSocket.emit('snakeladder:roll', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function rematch() {
      sharedSocket.emit('snakeladder:rematch', { peer }, (resp) => {
        if (resp && resp.error) flashHint(resp.error);
      });
    }
    function leave() {
      sharedSocket.emit('snakeladder:leave', { peer }, () => {});
    }

    let hintTimer = null;
    function flashHint(msg) {
      hintEl.textContent = msg;
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hintEl.textContent = 'Dapat angka 6 = lempar lagi.'; }, 2500);
    }

    let animating = false;
    let animTimer = null;
    function rollKey(lr) {
      if (!lr) return '';
      return lr.by + '|' + lr.dice + '|' + lr.from + '|' + lr.to;
    }
    function playDiceAnim(finalFace, onDone) {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      animating = true;
      diceEl.classList.add('rolling');
      const totalMs = 750;
      const stepMs = 90;
      const started = Date.now();
      animTimer = setInterval(() => {
        const r = 1 + Math.floor(Math.random() * 6);
        diceEl.textContent = diceFace(r);
        if (Date.now() - started >= totalMs) {
          clearInterval(animTimer);
          animTimer = null;
          diceEl.classList.remove('rolling');
          diceEl.textContent = diceFace(finalFace);
          animating = false;
          onDone();
        }
      }, stepMs);
    }

    function onState(payload) {
      if (!payload || payload.peer !== peer) return;
      const next = payload.session || null;
      const prevKey = rollKey(currentSession && currentSession.lastRoll);
      const nextKey = rollKey(next && next.lastRoll);
      if (next && next.lastRoll && nextKey && nextKey !== prevKey) {
        const lr = next.lastRoll;
        playDiceAnim(lr.dice, () => {
          animating = true;
          walkPawn(next, lr, () => { animating = false; currentSession = next; render(); });
        });
        return;
      }
      currentSession = next;
      render();
    }
    sharedSocket.on('snakeladder:state', onState);
    sharedSocket.emit('snakeladder:sync', { peer }, (resp) => {
      if (resp && resp.ok) currentSession = resp.session || null;
      render();
    });

    return function cleanup() {
      sharedSocket.off('snakeladder:state', onState);
      if (hintTimer) clearTimeout(hintTimer);
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      if (walkTimer) { clearTimeout(walkTimer); walkTimer = null; }
    };
  }

  // ============ Remi Joker ============
  function mountRemi(rootEl) {
    if (!sharedSocket) {
      rootEl.innerHTML = '<div class="remi-wrap"><div class="remi-status">Koneksi belum siap. Coba lagi sebentar.</div></div>';
      hintEl.textContent = '';
      return function () {};
    }
    const me = (getMeFn && getMeFn()) || localStorage.getItem('username') || '';
    const meIsHub = me === HUB_USER;
    const peer = meIsHub
      ? (getPartnerFn ? getPartnerFn() : localStorage.getItem('activePeer'))
      : me;
    // Bot mode does not require a peer

    scoreEl.textContent = '0';
    bestWrap.classList.add('hidden');
    movesWrap.classList.add('hidden');
    hintEl.textContent = 'Susun 7 kartu jadi kombinasi SET / URUT. Joker bebas.';

    const FACE = new Set(['J','Q','K']);
    const PIP_LAYOUTS = {
      '2':  [[50,10,false],[50,90,true]],
      '3':  [[50,10,false],[50,50,false],[50,90,true]],
      '4':  [[20,10,false],[80,10,false],[20,90,true],[80,90,true]],
      '5':  [[20,10,false],[80,10,false],[50,50,false],[20,90,true],[80,90,true]],
      '6':  [[20,10,false],[80,10,false],[20,50,false],[80,50,false],[20,90,true],[80,90,true]],
      '7':  [[20,10,false],[80,10,false],[50,30,false],[20,50,false],[80,50,false],[20,90,true],[80,90,true]],
      '8':  [[20,10,false],[80,10,false],[50,30,false],[20,50,false],[80,50,false],[50,70,true],[20,90,true],[80,90,true]],
      '9':  [[20,10,false],[80,10,false],[20,36,false],[80,36,false],[50,50,false],[20,64,true],[80,64,true],[20,90,true],[80,90,true]],
      '10': [[20,10,false],[80,10,false],[50,25,false],[20,40,false],[80,40,false],[20,60,true],[80,60,true],[50,75,true],[20,90,true],[80,90,true]],
    };

    const wrap = document.createElement('div');
    wrap.className = 'remi-wrap';

    // Top: opponent
    const topRow = document.createElement('div');
    topRow.className = 'remi-top';
    const oppName = document.createElement('div');
    oppName.className = 'remi-name';
    const oppPoin = document.createElement('div');
    oppPoin.className = 'remi-poin';
    oppPoin.innerHTML = 'Poin: <span>0</span>';
    topRow.appendChild(oppName);
    topRow.appendChild(oppPoin);
    const oppHandEl = document.createElement('div');
    oppHandEl.className = 'remi-opp-hand';
    const oppMeldsEl = document.createElement('div');
    oppMeldsEl.className = 'remi-melds opp';

    // Center piles
    const center = document.createElement('div');
    center.className = 'remi-center';
    const stockBlock = document.createElement('div');
    stockBlock.className = 'remi-pile-block';
    stockBlock.innerHTML = '<div class="remi-pile-label">Dek<br>Kartu</div><div><div class="remi-pile-stack" data-role="stock"></div><div class="remi-sisa">Sisa: <span data-role="stock-count">0</span></div></div>';
    const discardBlock = document.createElement('div');
    discardBlock.className = 'remi-pile-block right';
    discardBlock.innerHTML = '<div><div class="remi-pile-stack" data-role="discard"></div><div class="remi-sisa" style="visibility:hidden">.</div></div><div class="remi-pile-label">Kartu<br>Buangan</div>';
    center.appendChild(stockBlock);
    center.appendChild(discardBlock);

    // Draw buttons
    const drawRow = document.createElement('div');
    drawRow.className = 'remi-draw-row';
    const btnDrawStock = document.createElement('button');
    btnDrawStock.type = 'button';
    btnDrawStock.className = 'remi-btn';
    btnDrawStock.textContent = 'Ambil dari Dek';
    const btnDrawDiscard = document.createElement('button');
    btnDrawDiscard.type = 'button';
    btnDrawDiscard.className = 'remi-btn';
    btnDrawDiscard.textContent = 'Ambil dari Buangan';
    drawRow.appendChild(btnDrawStock);
    drawRow.appendChild(btnDrawDiscard);

    // Status
    const statusEl = document.createElement('div');
    statusEl.className = 'remi-status';

    // Player
    const playerHeader = document.createElement('div');
    playerHeader.className = 'remi-player-header';
    const meLabel = document.createElement('div');
    meLabel.className = 'remi-name';
    meLabel.textContent = 'Kartu Kamu';
    const mePoin = document.createElement('div');
    mePoin.className = 'remi-poin';
    mePoin.innerHTML = 'Poin: <span>0</span>';
    playerHeader.appendChild(meLabel);
    playerHeader.appendChild(mePoin);
    const meMeldsEl = document.createElement('div');
    meMeldsEl.className = 'remi-melds me';
    const meHandEl = document.createElement('div');
    meHandEl.className = 'remi-me-hand';

    // Bottom actions
    const actions = document.createElement('div');
    actions.className = 'remi-actions';

    wrap.appendChild(topRow);
    wrap.appendChild(oppMeldsEl);
    wrap.appendChild(oppHandEl);
    wrap.appendChild(center);
    wrap.appendChild(drawRow);
    wrap.appendChild(statusEl);
    wrap.appendChild(playerHeader);
    wrap.appendChild(meMeldsEl);
    wrap.appendChild(meHandEl);
    wrap.appendChild(actions);
    rootEl.innerHTML = '';
    rootEl.appendChild(wrap);

    let currentSession = null;
    let activeMode = null; // 'peer' | 'bot' | null
    const selectedIds = new Set();
    function ctxPayload(extra) {
      const base = Object.assign({}, extra || {});
      base.mode = activeMode || 'peer';
      if (base.mode === 'peer') base.peer = peer;
      return base;
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function makeCardBack() {
      const el = document.createElement('div');
      el.className = 'remi-card back';
      return el;
    }
    function makeCard(card, opts) {
      opts = opts || {};
      const el = document.createElement('div');
      el.className = 'remi-card';
      if (card.rank === 'JOKER') {
        el.classList.add('joker');
        el.innerHTML = '<div class="rc-corner top"><span class="rc-rank">JKR</span></div><div class="rc-face-center">🃏</div><div class="rc-corner bot"><span class="rc-rank">JKR</span></div>';
      } else {
        const isRed = card.suit === '♥' || card.suit === '♦';
        el.classList.add(isRed ? 'red' : 'black');
        const corners = '<div class="rc-corner top"><span class="rc-rank">' + card.rank + '</span><span class="rc-suit">' + card.suit + '</span></div><div class="rc-corner bot"><span class="rc-rank">' + card.rank + '</span><span class="rc-suit">' + card.suit + '</span></div>';
        if (FACE.has(card.rank)) {
          el.classList.add('face');
          el.innerHTML = corners + '<div class="rc-face-center"><div class="rc-face-letter">' + card.rank + '</div><div class="rc-face-suit">' + card.suit + '</div></div>';
        } else if (card.rank === 'A') {
          el.classList.add('ace');
          el.innerHTML = corners + '<div class="rc-pips"><div class="rc-pip big-ace" style="top:50%;left:50%;">' + card.suit + '</div></div>';
        } else {
          const layout = PIP_LAYOUTS[card.rank] || [];
          const pipHtml = layout.map((p) => '<div class="rc-pip' + (p[2] ? ' flip' : '') + '" style="left:' + p[0] + '%;top:' + p[1] + '%;">' + card.suit + '</div>').join('');
          el.innerHTML = corners + '<div class="rc-pips">' + pipHtml + '</div>';
        }
      }
      if (opts.meldKind) {
        el.classList.add(opts.meldKind === 'set' ? 'melded-set' : 'melded-run');
        const lbl = document.createElement('div');
        lbl.className = 'rc-meld-label';
        lbl.textContent = opts.meldKind === 'set' ? 'SET' : 'URUT';
        el.appendChild(lbl);
      }
      if (opts.selectable) {
        el.classList.add('selectable');
        if (selectedIds.has(card.id)) el.classList.add('selected');
        el.addEventListener('click', () => {
          if (!isMyTurn() || (currentSession && currentSession.winner)) return;
          if (selectedIds.has(card.id)) selectedIds.delete(card.id);
          else selectedIds.add(card.id);
          render();
        });
      }
      return el;
    }

    function makeMeldGroup(meld) {
      const grp = document.createElement('div');
      grp.className = 'remi-meld-group ' + (meld.kind === 'set' ? 'set' : 'run');
      const label = document.createElement('div');
      label.className = 'remi-meld-tag';
      label.textContent = meld.kind === 'set' ? 'SET' : 'URUT';
      grp.appendChild(label);
      const row = document.createElement('div');
      row.className = 'remi-meld-cards';
      for (const c of meld.cards) {
        const w = document.createElement('div');
        w.className = 'remi-card-wrap';
        w.appendChild(makeCard(c, {}));
        row.appendChild(w);
      }
      grp.appendChild(row);
      return grp;
    }

    function isMyTurn() {
      return currentSession && currentSession.status === 'active' && currentSession.turn === me;
    }

    // Local meld validation (matches server logic)
    const RANK_VAL = { A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13 };
    function isValidSet(cards) {
      if (cards.length < 3 || cards.length > 4) return false;
      const nonJ = cards.filter(c => c.rank !== 'JOKER');
      if (nonJ.length === 0) return true;
      const rank = nonJ[0].rank;
      if (!nonJ.every(c => c.rank === rank)) return false;
      const suits = new Set(nonJ.map(c => c.suit));
      return suits.size === nonJ.length;
    }
    function isValidRun(cards) {
      if (cards.length < 3) return false;
      const nonJ = cards.filter(c => c.rank !== 'JOKER');
      const jokers = cards.length - nonJ.length;
      if (nonJ.length === 0) return cards.length >= 3;
      const suit = nonJ[0].suit;
      if (!nonJ.every(c => c.suit === suit)) return false;
      const values = nonJ.map(c => RANK_VAL[c.rank]).sort((a,b) => a-b);
      for (let i = 1; i < values.length; i++) if (values[i] === values[i-1]) return false;
      const span = values[values.length-1] - values[0] + 1;
      if (span > cards.length) return false;
      let gapsInside = 0;
      for (let i = 1; i < values.length; i++) gapsInside += (values[i] - values[i-1] - 1);
      const ext = cards.length - span;
      if (gapsInside + ext > jokers) return false;
      const minStart = Math.max(1, values[values.length-1] - cards.length + 1);
      const maxStart = Math.min(values[0], 13 - cards.length + 1);
      return minStart <= maxStart;
    }
    function meldKindOf(cards) {
      if (isValidSet(cards)) return 'set';
      if (isValidRun(cards)) return 'run';
      return null;
    }

    function selectedCards() {
      const s = currentSession;
      if (!s) return [];
      return (s.myHand || []).filter(c => selectedIds.has(c.id));
    }

    function render() {
      const s = currentSession;

      // Names & points
      if (s) {
        const other = me === s.inviter ? s.opponent : s.inviter;
        const label = other === 'Bot' ? '🤖 Bot' : other;
        oppName.textContent = 'Lawan: ' + label;
        oppPoin.querySelector('span').textContent = s.oppPoints || 0;
        mePoin.querySelector('span').textContent = s.myPoints || 0;
        meLabel.textContent = 'Kartu Kamu (' + me + ')';
      } else {
        oppName.textContent = 'Lawan: —';
        oppPoin.querySelector('span').textContent = '0';
        mePoin.querySelector('span').textContent = '0';
        meLabel.textContent = 'Kartu Kamu';
      }

      // Opponent melds (grouped) + unmelded hand
      oppHandEl.innerHTML = '';
      oppMeldsEl.innerHTML = '';
      if (s) {
        const other = me === s.inviter ? s.opponent : s.inviter;
        const oppMelds = (s.melds && s.melds[other]) || [];
        const oppMeldIds = new Set();
        for (const mld of oppMelds) for (const c of mld.cards) oppMeldIds.add(c.id);
        for (const mld of oppMelds) oppMeldsEl.appendChild(makeMeldGroup(mld));

        const revealed = s.status === 'done' && s.oppHand ? s.oppHand : null;
        const looseCount = revealed
          ? revealed.filter(c => !oppMeldIds.has(c.id)).length
          : Math.max(0, (s.oppCount || 0) - oppMeldIds.size);
        const looseList = revealed ? revealed.filter(c => !oppMeldIds.has(c.id)) : null;
        for (let i = 0; i < looseCount; i++) {
          const w = document.createElement('div');
          w.className = 'remi-card-wrap';
          const mid = (looseCount - 1) / 2;
          const angle = (i - mid) * 4;
          w.style.transform = 'rotate(' + angle + 'deg) translateY(' + Math.abs(i - mid) * 2 + 'px)';
          if (looseList) w.appendChild(makeCard(looseList[i], {}));
          else w.appendChild(makeCardBack());
          oppHandEl.appendChild(w);
        }
      }

      // Stock + discard
      const stockEl = stockBlock.querySelector('[data-role=stock]');
      stockEl.innerHTML = '';
      const stockCount = s ? s.stockCount : 0;
      if (stockCount > 0) {
        const layers = Math.min(3, stockCount);
        for (let i = 0; i < layers; i++) stockEl.appendChild(makeCardBack());
      } else {
        const empty = document.createElement('div');
        empty.className = 'remi-empty-pile';
        empty.textContent = '∅';
        stockEl.appendChild(empty);
      }
      stockBlock.querySelector('[data-role=stock-count]').textContent = stockCount;

      const discardEl = discardBlock.querySelector('[data-role=discard]');
      discardEl.innerHTML = '';
      if (s && s.discardTop) {
        discardEl.appendChild(makeCard(s.discardTop, {}));
      } else {
        const empty = document.createElement('div');
        empty.className = 'remi-empty-pile';
        empty.textContent = '∅';
        discardEl.appendChild(empty);
      }

      // My melds (grouped) + unmelded hand
      meMeldsEl.innerHTML = '';
      meHandEl.innerHTML = '';
      const myHand = s ? (s.myHand || []) : [];
      const myMelds = s ? ((s.melds && s.melds[me]) || []) : [];
      const meldedIds = new Set();
      for (const mld of myMelds) for (const c of mld.cards) meldedIds.add(c.id);
      for (const mld of myMelds) meMeldsEl.appendChild(makeMeldGroup(mld));
      for (const c of myHand) {
        if (meldedIds.has(c.id)) continue;
        const w = document.createElement('div');
        w.className = 'remi-card-wrap';
        w.appendChild(makeCard(c, { selectable: true }));
        meHandEl.appendChild(w);
      }

      // Status text
      if (!s) {
        statusEl.textContent = peer
          ? 'Pilih mode: main lawan bot atau ajak peer.'
          : 'Belum ada peer aktif — kamu bisa main lawan bot.';
      } else if (s.status === 'pending') {
        if (me === s.inviter) statusEl.innerHTML = 'Menunggu <b>' + esc(s.opponent) + '</b> menerima undangan…';
        else if (me === s.opponent) statusEl.innerHTML = '<b>' + esc(s.inviter) + '</b> mengajak main. Terima?';
      } else if (s.status === 'active') {
        if (isMyTurn()) {
          statusEl.textContent = s.phase === 'draw'
            ? 'Giliran kamu — ambil kartu dari dek atau buangan.'
            : 'Pilih kartu buat susun kombinasi, atau buang 1 kartu buat selesai giliran.';
        } else {
          const other = me === s.inviter ? s.opponent : s.inviter;
          statusEl.textContent = 'Giliran ' + other + ', tunggu ya…';
        }
      } else if (s.status === 'done') {
        const winnerLabel = s.winner === 'Bot' ? '🤖 Bot' : esc(s.winner);
        if (s.resigned) {
          statusEl.innerHTML = s.winner === me
            ? 'Kamu menang, lawan menyerah 🏳️'
            : '<b>' + winnerLabel + '</b> menang (kamu menyerah).';
        } else {
          statusEl.innerHTML = s.winner === me
            ? '🎉 Remi! Kamu menang!'
            : '<b>' + winnerLabel + '</b> sudah Remi. Kamu kalah.';
        }
      }

      // Buttons
      actions.innerHTML = '';
      if (!s) {
        addBtn('Main lawan Bot 🤖', 'primary', inviteBot);
        if (peer) addBtn('Undang peer', 'gold', invitePeer);
      } else if (s.status === 'pending') {
        if (me === s.inviter) addBtn('Batalkan', 'secondary', decline);
        else if (me === s.opponent) { addBtn('Terima', 'primary', accept); addBtn('Tolak', 'secondary', decline); }
      } else if (s.status === 'active') {
        addBtn('Susun Kombinasi', 'gold', doMeld, !canMeldNow());
        addBtn('Buang & Selesai Giliran', 'primary', doDiscard, !canDiscardNow());
        addBtn('Urutkan', 'ghost', sortMyHand);
        addBtn('Menyerah', 'secondary', leave);
      } else if (s.status === 'done') {
        addBtn('Main lagi', 'primary', rematch);
        addBtn('Tutup', 'secondary', leave);
      }

      // Draw buttons state
      const canDraw = isMyTurn() && s && s.phase === 'draw' && !s.winner;
      btnDrawStock.disabled = !canDraw || (s && s.stockCount === 0);
      btnDrawDiscard.disabled = !canDraw || !s || !s.discardTop;
    }

    function canMeldNow() {
      const s = currentSession;
      if (!isMyTurn() || !s || s.phase !== 'discard') return false;
      const sel = selectedCards();
      if (sel.length < 3) return false;
      // Filter out already-melded
      const meldedIds = new Set();
      for (const m of (s.melds[me] || [])) for (const c of m.cards) meldedIds.add(c.id);
      if (sel.some(c => meldedIds.has(c.id))) return false;
      return meldKindOf(sel) !== null;
    }
    function canDiscardNow() {
      const s = currentSession;
      if (!isMyTurn() || !s || s.phase !== 'discard') return false;
      if (selectedIds.size !== 1) return false;
      const id = Array.from(selectedIds)[0];
      const meldedIds = new Set();
      for (const m of (s.melds[me] || [])) for (const c of m.cards) meldedIds.add(c.id);
      return !meldedIds.has(id);
    }

    function addBtn(label, variant, handler, disabled) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'remi-btn' + (variant ? ' ' + variant : '');
      b.textContent = label;
      if (disabled) b.disabled = true;
      b.addEventListener('click', handler);
      actions.appendChild(b);
    }

    // Sort local hand view
    const SUIT_ORDER = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    function sortMyHand() {
      const s = currentSession;
      if (!s || !s.myHand) return;
      s.myHand.sort((a, b) => {
        if (a.rank === 'JOKER' && b.rank !== 'JOKER') return 1;
        if (b.rank === 'JOKER' && a.rank !== 'JOKER') return -1;
        if (a.rank === 'JOKER' && b.rank === 'JOKER') return 0;
        if (a.suit !== b.suit) return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
        return RANK_VAL[a.rank] - RANK_VAL[b.rank];
      });
      render();
    }

    // Actions to server
    function invitePeer() {
      if (!peer) { flashHint('Belum ada peer aktif.'); return; }
      activeMode = 'peer';
      sharedSocket.emit('remi:invite', ctxPayload(), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function inviteBot() {
      activeMode = 'bot';
      sharedSocket.emit('remi:invite', ctxPayload(), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function accept() {
      sharedSocket.emit('remi:accept', ctxPayload(), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function decline() {
      sharedSocket.emit('remi:decline', ctxPayload(), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function drawStock() {
      sharedSocket.emit('remi:draw', ctxPayload({ source: 'stock' }), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function drawDiscard() {
      sharedSocket.emit('remi:draw', ctxPayload({ source: 'discard' }), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function doMeld() {
      if (!canMeldNow()) return;
      const ids = Array.from(selectedIds);
      sharedSocket.emit('remi:meld', ctxPayload({ ids }), (resp) => {
        if (resp && resp.error) flashHint(resp.error);
        else selectedIds.clear();
      });
    }
    function doDiscard() {
      if (!canDiscardNow()) return;
      const id = Array.from(selectedIds)[0];
      sharedSocket.emit('remi:discard', ctxPayload({ id }), (resp) => {
        if (resp && resp.error) flashHint(resp.error);
        else selectedIds.clear();
      });
    }
    function rematch() {
      sharedSocket.emit('remi:rematch', ctxPayload(), (resp) => { if (resp && resp.error) flashHint(resp.error); });
    }
    function leave() {
      sharedSocket.emit('remi:leave', ctxPayload(), () => {});
    }

    btnDrawStock.addEventListener('click', drawStock);
    btnDrawDiscard.addEventListener('click', drawDiscard);
    stockBlock.querySelector('[data-role=stock]').addEventListener('click', () => { if (!btnDrawStock.disabled) drawStock(); });
    discardBlock.querySelector('[data-role=discard]').addEventListener('click', () => { if (!btnDrawDiscard.disabled) drawDiscard(); });

    let hintTimer = null;
    function flashHint(msg) {
      hintEl.textContent = msg;
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { hintEl.textContent = 'Susun 7 kartu jadi kombinasi SET / URUT. Joker bebas.'; }, 2500);
    }

    function onState(payload) {
      if (!payload) return;
      const pMode = payload.mode || 'peer';
      // Only accept state that matches our mode context. If no activeMode yet
      // and it's a session for us, adopt that mode.
      if (pMode === 'peer') {
        if (payload.peer !== peer) return;
      } else if (pMode === 'bot') {
        // Bot session state — only care if we're in bot mode or unset and session exists
        if (activeMode && activeMode !== 'bot') return;
      }
      if (payload.session) activeMode = pMode;
      else if (activeMode === pMode) activeMode = null;
      currentSession = payload.session || null;
      if (!currentSession || currentSession.status !== 'active' || currentSession.turn !== me) {
        selectedIds.clear();
      }
      render();
    }
    sharedSocket.on('remi:state', onState);
    // Prefer active bot session; fallback to peer session if any.
    sharedSocket.emit('remi:sync', { mode: 'bot' }, (botResp) => {
      if (botResp && botResp.ok && botResp.session) {
        activeMode = 'bot';
        currentSession = botResp.session;
        render();
        return;
      }
      if (!peer) { render(); return; }
      sharedSocket.emit('remi:sync', { mode: 'peer', peer }, (resp) => {
        if (resp && resp.ok && resp.session) {
          activeMode = 'peer';
          currentSession = resp.session;
        }
        render();
      });
    });

    return function cleanup() {
      sharedSocket.off('remi:state', onState);
      if (hintTimer) clearTimeout(hintTimer);
    };
  }

  window.MiniGames = { open: open, close: close, init: init };
})();
