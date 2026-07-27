(function () {
  const canvas = document.getElementById('weather-canvas');
  const toggleBtn = document.getElementById('weather-toggle');
  const menuEl = document.getElementById('weather-menu');
  if (!canvas || !toggleBtn || !menuEl) return;
  const iconEl = toggleBtn.querySelector('.weather-toggle-icon') || toggleBtn;
  const ctx = canvas.getContext('2d');

  const MODES = [
    { id: 'off',  label: 'Off',   icon: '🌤' },
    { id: 'rain', label: 'Hujan', icon: '🌧' },
    { id: 'snow', label: 'Salju', icon: '❄️' },
  ];
  const STORAGE_KEY = 'weather';

  let mode = 'off';
  let raf = null;
  let particles = [];
  let lastTs = 0;
  let W = 0, H = 0, dpr = 1;

  function currentMode() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && MODES.some((m) => m.id === v)) return v;
    } catch (_) {}
    return 'off';
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    particles = [];
    if (mode === 'rain') {
      const count = Math.min(180, Math.floor(W * H / 6000));
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          l: 10 + Math.random() * 14,
          vy: 480 + Math.random() * 260,
          vx: -80 - Math.random() * 60,
        });
      }
    } else if (mode === 'snow') {
      const count = Math.min(120, Math.floor(W * H / 9000));
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: 1 + Math.random() * 2.6,
          vy: 25 + Math.random() * 55,
          drift: Math.random() * Math.PI * 2,
          driftSpeed: 0.4 + Math.random() * 0.8,
          alpha: 0.55 + Math.random() * 0.4,
        });
      }
    }
  }

  function stepRain(dt) {
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx;
      p.y = ny;
      if (p.y > H + 20 || p.x < -30) {
        p.x = Math.random() * (W + 100);
        p.y = -20;
      }
    }
    ctx.strokeStyle = 'rgba(20, 30, 55, 0.55)';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(210, 230, 255, 0.95)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  function stepSnow(dt) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.drift += p.driftSpeed * dt;
      p.x += Math.sin(p.drift) * 14 * dt;
      p.y += p.vy * dt;
      if (p.y > H + 10) {
        p.y = -10;
        p.x = Math.random() * W;
      }
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function tick(ts) {
    if (mode === 'off') return;
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
    lastTs = ts;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'rain') stepRain(dt);
    else if (mode === 'snow') stepSnow(dt);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    stop();
    if (mode === 'off') return;
    resize();
    seed();
    canvas.classList.add('active');
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    ctx.clearRect(0, 0, W, H);
    canvas.classList.remove('active');
  }

  function apply(newMode) {
    mode = MODES.some((m) => m.id === newMode) ? newMode : 'off';
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    const m = MODES.find((x) => x.id === mode) || MODES[0];
    iconEl.textContent = m.icon;
    renderMenu();
    start();
  }

  function renderMenu() {
    menuEl.innerHTML = '';
    MODES.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'weather-menu-item' + (m.id === mode ? ' active' : '');
      btn.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.className = 'weather-menu-icon';
      icon.textContent = m.icon;
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(m.label));
      btn.addEventListener('click', () => {
        closeMenu();
        apply(m.id);
      });
      menuEl.appendChild(btn);
    });
  }
  function openMenu() {
    renderMenu();
    menuEl.classList.remove('hidden');
    toggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menuEl.classList.add('hidden');
    toggleBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    if (menuEl.classList.contains('hidden')) openMenu();
    else closeMenu();
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('click', (e) => {
    if (menuEl.classList.contains('hidden')) return;
    if (!menuEl.contains(e.target) && e.target !== toggleBtn) closeMenu();
  });
  window.addEventListener('resize', () => {
    if (mode === 'off') return;
    resize();
    seed();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (mode !== 'off') {
      lastTs = 0;
      raf = requestAnimationFrame(tick);
    }
  });

  apply(currentMode());
})();
