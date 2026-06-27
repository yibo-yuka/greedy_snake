/**
 * Greedy Snake PWA — Game Engine
 * ================================
 * Architecture:
 *   Particle       — visual effects (eat / death)
 *   SnakeGame      — canvas renderer + game logic
 *   App            — screen manager & event orchestrator
 *
 * Game loop design:
 *   setInterval  → game logic ticks (speed-controlled)
 *   requestAnimationFrame → canvas rendering (60fps)
 */

'use strict';

/* ==========================================================
   Constants
   ========================================================== */
const GRID_SIZE     = 20;
const INIT_SPEED    = 150;   // ms per logic tick
const MIN_SPEED     = 68;    // fastest tick
const SPEED_STEP    = 2;     // ms shaved per apple eaten
const SCORE_APPLE   = 10;

const DIR = Object.freeze({
  UP:    { x:  0, y: -1 },
  DOWN:  { x:  0, y:  1 },
  LEFT:  { x: -1, y:  0 },
  RIGHT: { x:  1, y:  0 },
});

// Nickname random generation (Traditional Chinese)
const NICK_ADJ = ['神秘', '傳說', '無敵', '瘋狂', '超級', '閃電', '暗影', '幻影', '究極', '永恆', '孤獨', '無名'];
const NICK_NON = ['玩家', '蛇神', '勇者', '獵手', '大師', '冠軍', '劍士', '巫師', '蛇王', '英雄', '戰士', '怪客'];

/* ==========================================================
   Utilities
   ========================================================== */
function randomNickname() {
  const a = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
  const n = NICK_NON[Math.floor(Math.random() * NICK_NON.length)];
  const d = String(Math.floor(Math.random() * 9000) + 1000);
  return `${a}${n}#${d}`;
}

/** Cross-browser rounded rectangle (fallback for old Safari) */
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}

/** Linear interpolation */
function lerp(a, b, t) { return a + (b - a) * t; }

/* ==========================================================
   Particle System
   ========================================================== */
class Particle {
  /**
   * @param {number} x - canvas x
   * @param {number} y - canvas y
   * @param {'eat'|'death'} type
   */
  constructor(x, y, type = 'eat') {
    const angle = Math.random() * Math.PI * 2;
    const speed = type === 'death'
      ? 1.5 + Math.random() * 4.5
      : 1.8 + Math.random() * 3.2;

    this.x  = x;
    this.y  = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.gravity = type === 'death' ? 0.11 : 0;
    this.size    = type === 'death' ? 3.5 + Math.random() * 6 : 2 + Math.random() * 3.5;
    this.maxLife = type === 'death' ? 38 + Math.random() * 28 : 18 + Math.random() * 14;
    this.life    = this.maxLife;

    if (type === 'eat') {
      // Green to yellow-green
      const h = 88 + Math.random() * 55;
      this.color = `hsl(${h},100%,62%)`;
    } else {
      // Mix of green and orange/red for dramatic death
      this.color = Math.random() > 0.45
        ? `hsl(${95 + Math.random() * 45},100%,58%)`
        : `hsl(${Math.random() * 30},100%,62%)`;
    }
  }

  /** @returns {boolean} still alive */
  update() {
    this.x  += this.vx;
    this.y  += this.vy;
    this.vy += this.gravity;
    this.vx *= 0.93;
    this.vy *= 0.93;
    this.life--;
    return this.life > 0;
  }

  draw(ctx) {
    const alpha = this.life / this.maxLife;
    const r     = Math.max(0.4, this.size * alpha);
    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.fillStyle    = this.color;
    ctx.shadowColor  = this.color;
    ctx.shadowBlur   = 7;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/* ==========================================================
   SnakeGame — Canvas Engine
   ========================================================== */
class SnakeGame {
  constructor() {
    this.canvas   = document.getElementById('gameCanvas');
    this.ctx      = this.canvas.getContext('2d');

    // State
    this.snake    = [];
    this.dir      = { ...DIR.RIGHT };
    this.nextDir  = { ...DIR.RIGHT };
    this.apple    = null;
    this.score    = 0;
    this.applesEaten = 0;
    this.speed    = INIT_SPEED;
    this.prevHighScore = parseInt(localStorage.getItem('snake_highscore') || '0');

    // Loop handles
    this.tickId   = null;
    this.rafId    = null;

    // Visual
    this.particles  = [];
    this.deathParts = [];
    this.applePhase = 0;   // pulsing timer

    // Flags
    this.running  = false;
    this.paused   = false;
    this.dying    = false;
  }

  /* ── Lifecycle ─────────────────────────────── */
  init() {
    this.resize();
    this.reset();
    this.startRender();
  }

  /** Fit canvas to container */
  resize() {
    const container = document.getElementById('gameContainer');
    const r         = container.getBoundingClientRect();
    const isMobile  = window.matchMedia('(pointer: coarse)').matches;
    const maxH      = isMobile ? r.height - 4 : r.height - 12;
    const size      = Math.floor(Math.min(r.width - 8, maxH, 524));
    this.canvas.width  = size;
    this.canvas.height = size;
    this.cellSize      = size / GRID_SIZE;
  }

  /** Initialize snake and apple to starting state */
  reset() {
    const mid = Math.floor(GRID_SIZE / 2);
    this.snake = [
      { x: mid + 2, y: mid },
      { x: mid + 1, y: mid },
      { x: mid,     y: mid },
    ];
    this.dir      = { ...DIR.RIGHT };
    this.nextDir  = { ...DIR.RIGHT };
    this.score    = 0;
    this.applesEaten = 0;
    this.speed    = INIT_SPEED;
    this.particles  = [];
    this.deathParts = [];
    this.dying    = false;
    this.spawnApple();
  }

  spawnApple() {
    const occupied = new Set(this.snake.map(s => `${s.x},${s.y}`));
    let pos;
    do {
      pos = {
        x: Math.floor(Math.random() * GRID_SIZE),
        y: Math.floor(Math.random() * GRID_SIZE),
      };
    } while (occupied.has(`${pos.x},${pos.y}`));
    this.apple = pos;
  }

  start() {
    this.running = true;
    this.paused  = false;
    this._tick();
  }

  _tick() {
    if (this.tickId) clearInterval(this.tickId);
    this.tickId = setInterval(() => this.update(), this.speed);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    clearInterval(this.tickId);
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this._tick();
  }

  /** Full stop — called when leaving game screen */
  stop() {
    this.running = false;
    clearInterval(this.tickId);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /* ── Game Logic ────────────────────────────── */
  update() {
    if (!this.running || this.paused || this.dying) return;

    // Apply buffered direction (prevents 180° reversal)
    this.dir = { ...this.nextDir };

    const head = this.snake[0];
    const next = {
      x: (head.x + this.dir.x + GRID_SIZE) % GRID_SIZE,
      y: (head.y + this.dir.y + GRID_SIZE) % GRID_SIZE,
    };

    // Self collision check
    if (this.snake.some(s => s.x === next.x && s.y === next.y)) {
      this.triggerDeath();
      return;
    }

    this.snake.unshift(next);

    if (next.x === this.apple.x && next.y === this.apple.y) {
      this.eatApple(next);
    } else {
      this.snake.pop();
    }
  }

  /** Queue a direction change — ignores 180° reversal */
  setDirection(dir) {
    if (dir.x !== 0 && dir.x === -this.dir.x) return;
    if (dir.y !== 0 && dir.y === -this.dir.y) return;
    this.nextDir = { ...dir };
  }

  eatApple(pos) {
    this.applesEaten++;
    this.score += SCORE_APPLE;

    // Particle burst at apple position
    const cx = (pos.x + 0.5) * this.cellSize;
    const cy = (pos.y + 0.5) * this.cellSize;
    for (let i = 0; i < 14; i++) {
      this.particles.push(new Particle(cx, cy, 'eat'));
    }

    // Accelerate game tick
    if (this.speed > MIN_SPEED) {
      this.speed = Math.max(MIN_SPEED, this.speed - SPEED_STEP);
      this._tick();
    }

    this.spawnApple();
    this._syncHUD();
  }

  triggerDeath() {
    this.dying = true;
    clearInterval(this.tickId);

    // Explode snake into particles
    this.snake.forEach(seg => {
      const cx = (seg.x + 0.5) * this.cellSize;
      const cy = (seg.y + 0.5) * this.cellSize;
      for (let i = 0; i < 3; i++) {
        this.deathParts.push(new Particle(cx, cy, 'death'));
      }
    });

    // Transition to game over screen after explosion settles
    setTimeout(() => {
      this.running = false;
      window.snakeApp?.showGameOver(this.score, this.applesEaten, this.prevHighScore);
    }, 950);
  }

  _syncHUD() {
    const el = document.getElementById('scoreDisplay');
    if (!el) return;
    el.textContent = this.score;
    el.classList.remove('score-pop');
    void el.offsetWidth; // Trigger reflow to restart animation
    el.classList.add('score-pop');

    const hi = parseInt(localStorage.getItem('snake_highscore') || '0');
    if (this.score > hi) {
      localStorage.setItem('snake_highscore', String(this.score));
      const bestEl = document.getElementById('bestDisplay');
      if (bestEl) bestEl.textContent = this.score;
    }
  }

  getHighScore() {
    return parseInt(localStorage.getItem('snake_highscore') || '0');
  }

  /* ── Rendering ─────────────────────────────── */
  startRender() {
    const frame = () => {
      if (this.rafId !== null) { // Still active
        this.draw();
        this.rafId = requestAnimationFrame(frame);
      }
    };
    this.rafId = requestAnimationFrame(frame);
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const c = this.cellSize;

    // Background
    ctx.fillStyle = '#050510';
    ctx.fillRect(0, 0, W, W);

    // Subtle grid
    ctx.save();
    ctx.strokeStyle = 'rgba(57,255,20,0.05)';
    ctx.lineWidth   = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
      const p = i * c;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, W); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
    }
    ctx.restore();

    // Apple (with pulsing scale)
    this.applePhase += 0.045;
    if (this.apple) {
      const pulse = 1 + Math.sin(this.applePhase) * 0.075;
      this.drawApple(pulse);
    }

    // Particles
    this.particles  = this.particles.filter(p => p.update());
    this.deathParts = this.deathParts.filter(p => p.update());
    [...this.particles, ...this.deathParts].forEach(p => p.draw(ctx));

    // Snake (fade out during death)
    if (!this.dying || this.deathParts.length > 0) {
      this.drawSnake();
    }
  }

  drawApple(scale) {
    const { ctx, cellSize: c, apple } = this;
    const cx = (apple.x + 0.5) * c;
    const cy = (apple.y + 0.5) * c;
    const r  = c * 0.36 * scale;

    ctx.save();

    // Outer glow
    ctx.shadowColor = 'rgba(255,34,68,0.85)';
    ctx.shadowBlur  = 14;

    // Body gradient
    const g = ctx.createRadialGradient(cx - r * .28, cy - r * .32, r * .04, cx, cy, r);
    g.addColorStop(0,   '#ff7a99');
    g.addColorStop(0.6, '#ff2244');
    g.addColorStop(1,   '#aa001c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Shine highlight
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.52;
    const sh = ctx.createRadialGradient(cx - r*.32, cy - r*.36, 0, cx - r*.15, cy - r*.17, r*.56);
    sh.addColorStop(0, 'rgba(255,255,255,0.92)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Stem
    ctx.strokeStyle = '#6b4423';
    ctx.lineWidth   = Math.max(1.5, c * 0.056);
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r + 1);
    ctx.quadraticCurveTo(cx + r * .48, cy - r * 1.22, cx + r * .12, cy - r * 1.62);
    ctx.stroke();

    // Leaf
    ctx.fillStyle   = '#2ecc40';
    ctx.shadowColor = '#39ff14';
    ctx.shadowBlur  = 6;
    ctx.save();
    ctx.translate(cx + r * .32, cy - r * 1.22);
    ctx.rotate(-0.65);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * .28, r * .12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  drawSnake() {
    const { ctx, cellSize: c, snake, dir } = this;
    const len = snake.length;

    // Draw from tail to head so head renders on top
    for (let i = len - 1; i >= 0; i--) {
      const seg    = snake[i];
      const t      = i / Math.max(len - 1, 1); // 0=head, 1=tail
      const isHead = i === 0;

      ctx.save();

      // Death fade-out
      if (this.dying) {
        const progress = 1 - (this.deathParts.length / Math.max(len * 3, 1));
        ctx.globalAlpha = Math.max(0, 1 - progress * 1.6);
      }

      // Color: neon green at head → dark green at tail
      if (isHead) {
        ctx.fillStyle   = '#39ff14';
        ctx.shadowColor = '#39ff14';
        ctx.shadowBlur  = 16;
      } else {
        const g = Math.round(lerp(255, 90, t * 0.72));
        const r = Math.round(lerp(22, 5, t));
        ctx.fillStyle   = `rgb(${r},${g},12)`;
        ctx.shadowColor = 'rgba(57,200,14,0.2)';
        ctx.shadowBlur  = 4;
      }

      // Draw segment (inset slightly for visual gap)
      const inset = c * 0.09;
      const x     = seg.x * c + inset;
      const y     = seg.y * c + inset;
      const w     = c - inset * 2;
      const rad   = w * 0.28;

      roundRect(ctx, x, y, w, w, rad);
      ctx.fill();

      // ─── Head details ───────────────────────────
      if (isHead) {
        ctx.shadowBlur = 0;
        const eyeR   = c * 0.09;
        const eyeOff = c * 0.22;
        const hx     = seg.x * c + c * .5;
        const hy     = seg.y * c + c * .5;
        let ex1, ey1, ex2, ey2;

        if      (dir.x ===  1) { ex1=hx+c*.07; ey1=hy-eyeOff; ex2=hx+c*.07; ey2=hy+eyeOff; }
        else if (dir.x === -1) { ex1=hx-c*.07; ey1=hy-eyeOff; ex2=hx-c*.07; ey2=hy+eyeOff; }
        else if (dir.y === -1) { ex1=hx-eyeOff; ey1=hy-c*.07; ex2=hx+eyeOff; ey2=hy-c*.07; }
        else                   { ex1=hx-eyeOff; ey1=hy+c*.07; ex2=hx+eyeOff; ey2=hy+c*.07; }

        // Sclera
        ctx.fillStyle = '#e8f5e9';
        ctx.beginPath(); ctx.arc(ex1, ey1, eyeR,       0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex2, ey2, eyeR,       0, Math.PI * 2); ctx.fill();
        // Pupil
        ctx.fillStyle = '#071a07';
        const pR = eyeR * .52;
        ctx.beginPath(); ctx.arc(ex1 + pR*.1, ey1 + pR*.1, pR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex2 + pR*.1, ey2 + pR*.1, pR, 0, Math.PI * 2); ctx.fill();
        // Gleam
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        const gR = pR * .38;
        ctx.beginPath(); ctx.arc(ex1 - pR*.22, ey1 - pR*.22, gR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex2 - pR*.22, ey2 - pR*.22, gR, 0, Math.PI * 2); ctx.fill();
      }

      ctx.restore();
    }
  }
}

/* ==========================================================
   App — Screen Manager & Event Orchestrator
   ========================================================== */
class App {
  constructor() {
    this.game          = null;
    this.currentScreen = 'home';
    this.nickname      = localStorage.getItem('snake_nickname');
    this.pendingMode   = null;

    this._bindAll();
    this._refreshHome();
    this.showScreen('home');
  }

  /* ── Screen Management ─────────────────────── */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => {
      el.classList.remove('active');
      el.setAttribute('aria-hidden', 'true');
    });
    const target = document.getElementById(`screen-${id}`);
    if (target) {
      target.classList.add('active');
      target.setAttribute('aria-hidden', 'false');
    }
    this.currentScreen = id;
  }

  /* ── Nickname helpers ──────────────────────── */
  _setNick(name, isGuest = false) {
    this.nickname = name;
    localStorage.setItem('snake_nickname', name);
    localStorage.setItem('snake_is_guest', isGuest ? '1' : '0');
  }

  _refreshHome() {
    const nick = document.getElementById('displayNickname');
    const hi   = document.getElementById('displayHighScore');
    if (nick) nick.textContent = this.nickname || '訪客';
    if (hi)   hi.textContent  = localStorage.getItem('snake_highscore') || '0';
  }

  _openNickScreen() {
    const input   = document.getElementById('nicknameInput');
    const counter = document.getElementById('nicknameCounter');
    if (input) {
      input.value = this.nickname || '';
      if (counter) counter.textContent = `${input.value.length} / 16`;
    }
    this.showScreen('nickname');
    // Focus after transition
    setTimeout(() => input?.focus(), 350);
  }

  _confirmNick() {
    const input = document.getElementById('nicknameInput');
    const val   = (input?.value || '').trim();
    if (val.length < 2) {
      input?.classList.add('shake');
      setTimeout(() => input?.classList.remove('shake'), 480);
      return;
    }
    this._setNick(val, false);
    this._afterNick();
  }

  _afterNick() {
    if (this.pendingMode) {
      this.startGame();
    } else {
      this._refreshHome();
      this.showScreen('home');
    }
  }

  /* ── Game Flow ─────────────────────────────── */
  startGame() {
    this.showScreen('game');

    // HUD reset
    const score = document.getElementById('scoreDisplay');
    const best  = document.getElementById('bestDisplay');
    if (score) score.textContent = '0';
    if (best)  best.textContent  = localStorage.getItem('snake_highscore') || '0';

    // Mobile controls
    const mobileCtrl = document.getElementById('mobileControls');
    const isMobile   = window.matchMedia('(pointer: coarse)').matches;
    if (mobileCtrl) mobileCtrl.style.display = isMobile ? 'flex' : 'none';

    // Pause overlay reset
    const pause = document.getElementById('pauseOverlay');
    if (pause) pause.style.display = 'none';

    // Stop previous game
    if (this.game) this.game.stop();

    // Create & initialize new game
    this.game = new SnakeGame();
    this.game.init();

    // Small delay lets screen transition complete and layout settle
    setTimeout(() => {
      if (this.game) this.game.start();
    }, 220);
  }

  showGameOver(score, apples, prevHighScore) {
    const currentHi = parseInt(localStorage.getItem('snake_highscore') || '0');
    const isNewRec  = score > 0 && score > (prevHighScore ?? -1) && score >= currentHi;

    const el = (id) => document.getElementById(id);
    el('gameoverNickname').textContent = this.nickname || '玩家';
    el('finalScore').textContent       = score;
    el('finalBest').textContent        = Math.max(score, currentHi);
    el('finalApples').textContent      = apples;

    const badge = el('newRecordBadge');
    if (badge) badge.style.display = isNewRec ? 'block' : 'none';

    this.showScreen('gameover');
    this._refreshHome();
  }

  /* ── Event Binding ─────────────────────────── */
  _bindAll() {
    // ── Home ──────────────────────────────────────────
    document.getElementById('btnInfiniteMode')?.addEventListener('click', () => {
      this.pendingMode = 'infinite';
      if (!this.nickname) {
        this._openNickScreen();
      } else {
        this.startGame();
      }
    });

    // Allow Enter/Space on mode card for keyboard users
    document.getElementById('btnInfiniteMode')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.currentTarget.click();
      }
    });

    document.getElementById('btnChangeNickname')?.addEventListener('click', () => {
      this.pendingMode = null;
      this._openNickScreen();
    });

    // ── Nickname ──────────────────────────────────────
    const nickInput = document.getElementById('nicknameInput');
    nickInput?.addEventListener('input', () => {
      const counter = document.getElementById('nicknameCounter');
      if (counter) counter.textContent = `${nickInput.value.length} / 16`;
    });

    nickInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._confirmNick();
    });

    document.getElementById('btnConfirmNickname')?.addEventListener('click', () => {
      this._confirmNick();
    });

    document.getElementById('btnSkipNickname')?.addEventListener('click', () => {
      this._setNick(randomNickname(), true);
      this._afterNick();
    });

    // ── Pause / Resume ────────────────────────────────
    document.getElementById('btnPause')?.addEventListener('click', () => {
      if (!this.game?.running) return;
      this.game.pause();
      document.getElementById('pauseOverlay').style.display = 'flex';
    });

    document.getElementById('btnResume')?.addEventListener('click', () => {
      if (!this.game?.paused) return;
      this.game.resume();
      document.getElementById('pauseOverlay').style.display = 'none';
    });

    document.getElementById('btnQuit')?.addEventListener('click', () => {
      if (this.game) { this.game.stop(); this.game = null; }
      document.getElementById('pauseOverlay').style.display = 'none';
      this._refreshHome();
      this.showScreen('home');
    });

    // ── Game Over ─────────────────────────────────────
    document.getElementById('btnPlayAgain')?.addEventListener('click', () => {
      this.startGame();
    });

    document.getElementById('btnHome')?.addEventListener('click', () => {
      this._refreshHome();
      this.showScreen('home');
    });

    // ── Keyboard Controls ─────────────────────────────
    const KEY_DIR = {
      ArrowUp:    DIR.UP,    w: DIR.UP,    W: DIR.UP,
      ArrowDown:  DIR.DOWN,  s: DIR.DOWN,  S: DIR.DOWN,
      ArrowLeft:  DIR.LEFT,  a: DIR.LEFT,  A: DIR.LEFT,
      ArrowRight: DIR.RIGHT, d: DIR.RIGHT, D: DIR.RIGHT,
    };

    document.addEventListener('keydown', (e) => {
      // Pause / unpause
      if (e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        if (this.currentScreen !== 'game' || !this.game) return;
        const overlay = document.getElementById('pauseOverlay');
        if (this.game.paused) {
          this.game.resume();
          overlay.style.display = 'none';
        } else if (this.game.running) {
          this.game.pause();
          overlay.style.display = 'flex';
        }
        return;
      }

      // Direction
      if (this.currentScreen !== 'game' || !this.game?.running) return;
      const dir = KEY_DIR[e.key];
      if (dir) {
        e.preventDefault();
        this.game.setDirection(dir);
      }
    });

    // ── Touch / Swipe on Canvas ───────────────────────
    let touchX = 0, touchY = 0;
    const canvas = document.getElementById('gameCanvas');

    canvas?.addEventListener('touchstart', (e) => {
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
      e.preventDefault();
    }, { passive: false });

    canvas?.addEventListener('touchend', (e) => {
      if (this.currentScreen !== 'game' || !this.game?.running) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      const minSwipe = 22;
      if (Math.abs(dx) < minSwipe && Math.abs(dy) < minSwipe) return;
      e.preventDefault();
      if (Math.abs(dx) >= Math.abs(dy)) {
        this.game.setDirection(dx > 0 ? DIR.RIGHT : DIR.LEFT);
      } else {
        this.game.setDirection(dy > 0 ? DIR.DOWN : DIR.UP);
      }
    }, { passive: false });

    // ── D-pad Buttons ─────────────────────────────────
    const DPAD_MAP = {
      up:    DIR.UP,
      down:  DIR.DOWN,
      left:  DIR.LEFT,
      right: DIR.RIGHT,
    };

    document.querySelectorAll('.dp[data-dir]').forEach(btn => {
      const dir = DPAD_MAP[btn.dataset.dir];
      if (!dir) return;

      // touchstart for immediate response
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (this.game?.running && !this.game.paused) {
          this.game.setDirection(dir);
          btn.classList.add('pressed');
          setTimeout(() => btn.classList.remove('pressed'), 100);
        }
      }, { passive: false });

      // mousedown fallback for desktop testing
      btn.addEventListener('mousedown', () => {
        if (this.game?.running && !this.game.paused) {
          this.game.setDirection(dir);
        }
      });
    });

    // ── Window Resize ─────────────────────────────────
    window.addEventListener('resize', () => {
      if (this.currentScreen === 'game' && this.game) {
        this.game.resize();
      }
    });

    // ── PWA install prompt ────────────────────────────
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      // Could show a subtle install banner here in future
      console.log('[PWA] Install prompt available');
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      console.log('[PWA] App installed successfully');
    });
  }
}

/* ==========================================================
   Boot
   ========================================================== */
document.addEventListener('DOMContentLoaded', () => {
  // Mount global app instance
  window.snakeApp = new App();

  // Register Service Worker for PWA offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./service-worker.js', { scope: './' })
      .then(reg => {
        console.log('[SW] Registered. Scope:', reg.scope);
        // Notify SW of new version if waiting
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      })
      .catch(err => {
        console.warn('[SW] Registration failed:', err);
      });
  }

  // Screen Wake Lock — keeps display on during gameplay
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      console.log('[WakeLock] Acquired');
    } catch (err) {
      // Silently ignore — wake lock is optional
    }
  }

  // Re-acquire wake lock when page becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) {
      acquireWakeLock();
    }
  });

  // Acquire on first game start
  document.getElementById('btnInfiniteMode')?.addEventListener(
    'click', acquireWakeLock, { once: true }
  );
});
