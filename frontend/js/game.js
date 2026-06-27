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

import { getLeaderboard, submitScore, isBackendOnline } from './api.js';

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
  constructor(gridSize = GRID_SIZE) {
    this.gridSize = gridSize;   // dynamic grid (10/15/20)
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
    this.cellSize      = size / this.gridSize;
  }

  /** Initialize snake and apple to starting state */
  reset() {
    const mid = Math.floor(this.gridSize / 2);
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
    this.turnsSinceApple = 0;   // turns since last apple (combo counter)
    this.comboStreak     = 0;   // consecutive combo apples
    this.comboLabels     = [];  // floating score text
    this.spawnApple();
  }

  spawnApple() {
    const occupied = new Set(this.snake.map(s => `${s.x},${s.y}`));
    let pos;
    do {
      pos = {
        x: Math.floor(Math.random() * this.gridSize),
        y: Math.floor(Math.random() * this.gridSize),
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

    // Track actual direction changes here (not in setDirection) to avoid
    // VirtualJoystick calling setDirection many times per tick double-counting.
    const prevX = this.dir.x, prevY = this.dir.y;
    this.dir = { ...this.nextDir };
    if (this.dir.x !== prevX || this.dir.y !== prevY) {
      this.turnsSinceApple++;
    }

    const head = this.snake[0];
    const next = {
      x: (head.x + this.dir.x + this.gridSize) % this.gridSize,
      y: (head.y + this.dir.y + this.gridSize) % this.gridSize,
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

  /** Queue a direction change — ignores 180° reversal (turn counted in update()) */
  setDirection(dir) {
    if (dir.x !== 0 && dir.x === -this.dir.x) return;
    if (dir.y !== 0 && dir.y === -this.dir.y) return;
    this.nextDir = { ...dir };
  }

  /** Base score for one apple — override in subclasses for mode-specific scaling */
  _getAppleScore() { return SCORE_APPLE; }

  eatApple(pos) {
    this.applesEaten++;

    // ── Combo streak ──────────────────────────────────────────
    // activeStreak=0 → base pts; 1 → ×2; 2 → ×4 …
    const base         = this._getAppleScore();
    const withinOne    = this.turnsSinceApple <= 1;
    const activeStreak = withinOne ? this.comboStreak : 0;
    const pts          = base * Math.pow(2, activeStreak);
    this.score        += pts;

    // Update streak for NEXT apple
    this.comboStreak     = withinOne ? this.comboStreak + 1 : 0;
    this.turnsSinceApple = 0;

    // Particle burst at apple position
    const cx = (pos.x + 0.5) * this.cellSize;
    const cy = (pos.y + 0.5) * this.cellSize;
    for (let i = 0; i < 14; i++) {
      this.particles.push(new Particle(cx, cy, 'eat'));
    }

    // Floating score label (golden, only when > base score)
    if (pts > base) {
      this.comboLabels.push({
        x:       cx,
        y:       cy - this.cellSize * 0.3,
        text:    `+${pts}`,
        opacity: 1.0,
        vy:      -1.6,
        size:    Math.min(activeStreak, 4),   // visual weight by streak depth
      });
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

    // Cell grid — clear rounded-rect border for every cell
    ctx.save();
    const gridCols = this.gridSize;
    const gridRows = this.gridSize;
    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const bx  = col * c;
        const by  = row * c;
        const pad = c * 0.06;
        const r   = c * 0.20;
        ctx.fillStyle   = 'rgba(57, 255, 20, 0.03)';
        ctx.strokeStyle = 'rgba(57, 255, 20, 0.30)';
        ctx.lineWidth   = 1.5;
        roundRect(ctx, bx + pad, by + pad, c - pad * 2, c - pad * 2, r);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Apple (with pulsing scale)
    this.applePhase += 0.045;
    if (this.apple) {
      const pulse = 1 + Math.sin(this.applePhase) * 0.075;
      this.drawApple(pulse);
    }

    // Hook for subclass extras (obstacles, etc.) — drawn before particles & snake
    this.drawExtras();

    // Particles
    this.particles  = this.particles.filter(p => p.update());
    this.deathParts = this.deathParts.filter(p => p.update());
    [...this.particles, ...this.deathParts].forEach(p => p.draw(ctx));

    // Snake (fade out during death)
    if (!this.dying || this.deathParts.length > 0) {
      this.drawSnake();
    }

    // Floating combo labels
    this.comboLabels = this.comboLabels.filter(lbl => lbl.opacity > 0);
    if (this.comboLabels.length) {
      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur   = 14;
      for (const lbl of this.comboLabels) {
        const scale = 0.80 + lbl.size * 0.12;  // bigger font for deeper streaks
        const fs    = Math.max(13, Math.round(this.cellSize * scale));
        ctx.font         = `bold ${fs}px 'Orbitron', 'Rajdhani', monospace`;
        ctx.globalAlpha  = lbl.opacity;
        ctx.shadowColor  = '#ffd700';
        ctx.fillStyle    = '#ffd700';
        ctx.fillText(lbl.text, lbl.x, lbl.y);
        lbl.y       += lbl.vy;
        lbl.opacity -= 0.022;
      }
      ctx.restore();
    }
  }

  /** Override in subclasses to draw mode-specific elements */
  drawExtras() {}

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
   Level Snake Game — Phase 3
   Extends SnakeGame with level progression + obstacles
   ========================================================== */
class LevelSnakeGame extends SnakeGame {
  constructor(gridSize = GRID_SIZE) {
    super(gridSize);
    this.currentLevel    = 1;
    this.applesNeeded    = this._calcApplesNeeded(1);
    this.applesThisLevel = 0;
    this.obstacles       = [];
    this.levelBonus      = 0;
    this.transitioning   = false;
  }

  // ── Override spawnApple: also exclude obstacle cells ──────
  spawnApple() {
    const occupiedSnake = new Set(this.snake.map(s => `${s.x},${s.y}`));
    const occupiedObs   = new Set((this.obstacles || []).map(o => `${o.x},${o.y}`));
    let pos;
    let tries = 0;
    do {
      pos = {
        x: Math.floor(Math.random() * this.gridSize),
        y: Math.floor(Math.random() * this.gridSize),
      };
      tries++;
    } while (
      (occupiedSnake.has(`${pos.x},${pos.y}`) || occupiedObs.has(`${pos.x},${pos.y}`)) &&
      tries < 400
    );
    this.apple = pos;
  }

  // ── Config ─────────────────────────────────────
  _calcApplesNeeded(level) {
    return Math.min(3 + level * 2, 15); // 5,7,9,11,13,15,15...
  }

  _calcBaseSpeed(level) {
    return Math.max(108, INIT_SPEED - (level - 1) * 8); // 150,142,134...
  }

  _genObstacles(level) {
    if (level < 3) return [];
    const count   = Math.min((level - 2) * 2, 14);
    const mid     = Math.floor(this.gridSize / 2);
    const blocked = new Set([
      ...this.snake.map(s => `${s.x},${s.y}`),
      `${this.apple.x},${this.apple.y}`,
    ]);
    const obs = [];
    let attempts = 0;
    while (obs.length < count && attempts < 300) {
      attempts++;
      const x = Math.floor(Math.random() * this.gridSize);
      const y = Math.floor(Math.random() * this.gridSize);
      if (Math.abs(x - mid) <= 2 && Math.abs(y - mid) <= 2) continue; // keep spawn clear
      const k = `${x},${y}`;
      if (!blocked.has(k)) { blocked.add(k); obs.push({ x, y }); }
    }
    return obs;
  }

  // ── Lifecycle ──────────────────────────────────
  reset() {
    super.reset();
    this.currentLevel    = 1;
    this.applesNeeded    = this._calcApplesNeeded(1);
    this.applesThisLevel = 0;
    this.obstacles       = [];
    this.levelBonus      = 0;
    this.transitioning   = false;
    this.speed           = INIT_SPEED;
    this.turnsSinceApple = 0;
    this._updateLevelHUD();
  }

  start() {
    super.start();
    this._updateLevelHUD();
  }

  // ── Override update: obstacle collision + turn tracking ────
  update() {
    if (!this.running || this.paused || this.dying || this.transitioning) return;
    const prevX = this.dir.x, prevY = this.dir.y;
    this.dir = { ...this.nextDir };
    if (this.dir.x !== prevX || this.dir.y !== prevY) {
      this.turnsSinceApple++;
    }
    const head = this.snake[0];
    const next = {
      x: (head.x + this.dir.x + this.gridSize) % this.gridSize,
      y: (head.y + this.dir.y + this.gridSize) % this.gridSize,
    };
    if (this.snake.some(s => s.x === next.x && s.y === next.y)) { this.triggerDeath(); return; }
    if (this.obstacles.some(o => o.x === next.x && o.y === next.y)) { this.triggerDeath(); return; }
    this.snake.unshift(next);
    if (next.x === this.apple.x && next.y === this.apple.y) {
      this.eatApple(next);
    } else {
      this.snake.pop();
    }
  }

  // ── Override eatApple: level progression ───────
  eatApple(pos) {
    if (this.transitioning) return;
    super.eatApple(pos); // score, particles, speed, respawn apple
    this.applesThisLevel++;
    this._updateLevelHUD();
    if (this.applesThisLevel >= this.applesNeeded) this._onLevelComplete();
  }

  // ── Override _syncHUD: use level high score ────
  _syncHUD() {
    const el = document.getElementById('scoreDisplay');
    if (el) {
      el.textContent = this.score;
      el.classList.remove('score-pop');
      void el.offsetWidth;
      el.classList.add('score-pop');
    }
    const hi = parseInt(localStorage.getItem('snake_hs_level') || '0');
    if (this.score > hi) {
      localStorage.setItem('snake_hs_level', String(this.score));
    }
    const bestEl = document.getElementById('bestDisplay');
    if (bestEl) bestEl.textContent = Math.max(this.score, hi);
  }

  getHighScore() {
    return parseInt(localStorage.getItem('snake_hs_level') || '0');
  }

  _onLevelComplete() {
    this.transitioning = true;
    clearInterval(this.tickId);

    const bonus = this.currentLevel * 20;
    this.levelBonus += bonus;
    this.score      += bonus;

    // Store high score after bonus
    const hi = parseInt(localStorage.getItem('snake_hs_level') || '0');
    if (this.score > hi) localStorage.setItem('snake_hs_level', String(this.score));
    const scoreEl = document.getElementById('scoreDisplay');
    if (scoreEl) scoreEl.textContent = this.score;
    const bestEl = document.getElementById('bestDisplay');
    if (bestEl) bestEl.textContent = Math.max(this.score, hi);

    // Confetti burst
    const W = this.canvas.width;
    for (let i = 0; i < 40; i++) {
      this.particles.push(new Particle(
        20 + Math.random() * (W - 40),
        20 + Math.random() * (W - 40),
        'eat'
      ));
    }

    window.snakeApp?.showLevelComplete(this.currentLevel, this.score, bonus);
  }

  advanceLevel() {
    this.currentLevel++;
    this.applesNeeded    = this._calcApplesNeeded(this.currentLevel);
    this.applesThisLevel = 0;
    this.speed           = this._calcBaseSpeed(this.currentLevel);

    // Reset snake to centre
    const mid = Math.floor(this.gridSize / 2);
    this.snake   = [
      { x: mid + 2, y: mid }, { x: mid + 1, y: mid }, { x: mid, y: mid },
    ];
    this.dir     = { ...DIR.RIGHT };
    this.nextDir = { ...DIR.RIGHT };

    this.spawnApple();
    this.obstacles   = this._genObstacles(this.currentLevel);
    this.transitioning = false;
    this._tick();
    this._updateLevelHUD();
  }

  // ── Override drawExtras: obstacles ─────────────
  drawExtras() {
    if (!this.obstacles.length) return;
    const { ctx, cellSize: c } = this;
    ctx.save();
    this.obstacles.forEach(obs => {
      const inset = c * 0.09;
      const x = obs.x * c + inset;
      const y = obs.y * c + inset;
      const w = c - inset * 2;
      ctx.shadowColor = 'rgba(100,116,139,0.5)';
      ctx.shadowBlur  = 5;
      const g = ctx.createLinearGradient(x, y, x + w, y + w);
      g.addColorStop(0, '#2d3748');
      g.addColorStop(1, '#1a202c');
      ctx.fillStyle = g;
      roundRect(ctx, x, y, w, w, w * 0.22);
      ctx.fill();
      // ✕ cross
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = 'rgba(148,163,184,0.45)';
      ctx.lineWidth   = Math.max(1, c * 0.07);
      ctx.lineCap     = 'round';
      const p = w * 0.27;
      ctx.beginPath(); ctx.moveTo(x+p, y+p); ctx.lineTo(x+w-p, y+w-p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x+w-p, y+p); ctx.lineTo(x+p, y+w-p); ctx.stroke();
    });
    ctx.restore();
  }

  // ── HUD helpers ────────────────────────────────
  _updateLevelHUD() {
    const lv = document.getElementById('levelDisplay');
    const pr = document.getElementById('appleProgress');
    if (lv) lv.textContent = `Lv.${this.currentLevel}`;
    if (pr) pr.textContent = `🍎 ${this.applesThisLevel} / ${this.applesNeeded}`;
  }

  // ── Capture level on death ─────────────────────
  triggerDeath() {
    window.snakeApp?._setCurrentLevel(this.currentLevel);
    super.triggerDeath();
  }
}

/** XSS-safe HTML entity escaper */
function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    this.currentMode   = 'infinite';
    this._gameOverLevel = null;
    this.gridSize      = parseInt(localStorage.getItem('snake_grid_size') || '20');
    this.lbMode        = 'infinite';   // active leaderboard mode tab
    this.lbSortBy      = 'score';      // active leaderboard sort tab

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
    // Show best across all modes
    const infHi   = parseInt(localStorage.getItem('snake_highscore') || '0');
    const levelHi = parseInt(localStorage.getItem('snake_hs_level')   || '0');
    if (hi) hi.textContent = Math.max(infHi, levelHi);
    this.refreshLeaderboard();
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
      this.startGame(this.pendingMode);
    } else {
      this._refreshHome();
      this.showScreen('home');
    }
  }

  /* ── Game Flow ─────────────────────────────── */
  startGame(mode = 'infinite') {
    this.currentMode   = mode;
    this._gameOverLevel = null;
    this.showScreen('game');

    // HUD: mode indicator vs level HUD
    const modeEl   = document.getElementById('modeIndicator');
    const levelHUD = document.getElementById('levelHUD');
    if (mode === 'level') {
      if (modeEl)   modeEl.style.display   = 'none';
      if (levelHUD) levelHUD.style.display = 'flex';
    } else {
      if (modeEl)   modeEl.style.display   = '';
      if (levelHUD) levelHUD.style.display = 'none';
    }

    // Score / Best reset
    const hiKey = mode === 'level' ? 'snake_hs_level' : 'snake_highscore';
    const score = document.getElementById('scoreDisplay');
    const best  = document.getElementById('bestDisplay');
    if (score) score.textContent = '0';
    if (best)  best.textContent  = localStorage.getItem(hiKey) || '0';

    // Mobile controls
    const mobileCtrl = document.getElementById('mobileControls');
    const isMobile   = window.matchMedia('(pointer: coarse)').matches;
    if (mobileCtrl) mobileCtrl.style.display = isMobile ? 'flex' : 'none';

    // Pause overlay + level complete overlay reset
    const overlayIds = ['pauseOverlay', 'levelCompleteOverlay'];
    overlayIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // Stop previous game
    if (this.game) this.game.stop();

    // Create appropriate game instance
    this.game = mode === 'level' ? new LevelSnakeGame(this.gridSize) : new SnakeGame(this.gridSize);
    this.game.init();

    setTimeout(() => {
      if (this.game) this.game.start();
    }, 220);
  }

  showLevelComplete(level, score, bonus) {
    const el = (id) => document.getElementById(id);
    if (el('lcLevel')) el('lcLevel').textContent = `LEVEL  ${level}`;
    if (el('lcBonus')) el('lcBonus').textContent = `+${bonus} 關卡獎勵`;
    if (el('lcScore')) el('lcScore').textContent = score;
    const ov = el('levelCompleteOverlay');
    if (ov) ov.style.display = 'flex';

    // Auto-advance after 2.6s
    setTimeout(() => {
      if (ov) ov.style.display = 'none';
      if (this.game instanceof LevelSnakeGame) this.game.advanceLevel();
    }, 2600);
  }

  _setCurrentLevel(level) {
    this._gameOverLevel = level;
  }

  showGameOver(score, apples, prevHighScore) {
    const isLevel  = this.currentMode === 'level';
    const hiKey    = isLevel ? 'snake_hs_level' : 'snake_highscore';
    const currentHi = parseInt(localStorage.getItem(hiKey) || '0');
    const isNewRec  = score > 0 && score > (prevHighScore ?? -1) && score >= currentHi;

    const el = (id) => document.getElementById(id);
    el('gameoverNickname').textContent = this.nickname || '玩家';
    el('finalScore').textContent       = score;
    el('finalBest').textContent        = Math.max(score, currentHi);

    if (isLevel && this._gameOverLevel) {
      el('finalApples').textContent = `${apples}顆 · Lv.${this._gameOverLevel}`;
    } else {
      el('finalApples').textContent = apples;
    }

    const badge = el('newRecordBadge');
    if (badge) badge.style.display = isNewRec ? 'block' : 'none';

    // Show submit button only if backend online AND this is a new personal record
    const submitRow = el('submitRow');
    const submitBtn = el('btnSubmitScore');
    const submitHint = el('submitHint');
    if (submitRow) {
      const isOffline = !window.SNAKE_CONFIG?.apiUrl;
      // Only show if score > 0, online, AND it's a new personal best
      submitRow.style.display = (score > 0 && !isOffline && isNewRec) ? 'flex' : 'none';
      if (submitBtn) submitBtn.disabled = false;
      if (submitHint) submitHint.textContent = '';
    }

    // Cache game-over data for submit handler
    this._lastGameResult = { score, apples, level: this._gameOverLevel };

    this.showScreen('gameover');
    this._refreshHome();
  }

  /** Submit last game result to global leaderboard */
  async handleSubmitScore() {
    const btn  = document.getElementById('btnSubmitScore');
    const hint = document.getElementById('submitHint');
    if (!btn || !this._lastGameResult || !this.nickname) return;

    btn.disabled   = true;
    btn.textContent = '提交中…';
    if (hint) hint.textContent = '';

    const result = await submitScore({
      nickname:      this.nickname,
      mode:          this.currentMode,
      score:         this._lastGameResult.score,
      apples_eaten:  this._lastGameResult.apples,
      level_reached: this._lastGameResult.level ?? null,
    });

    if (result) {
      btn.textContent = '✅ 已提交';
      if (hint) hint.textContent = `全球第 ${result.rank} 名`;
      // Switch lb to current mode and refresh
      this.lbMode = this.currentMode;
      this.refreshLeaderboard();
    } else {
      btn.disabled   = false;
      btn.textContent = '🌍 提交到全球排行榜';
      if (hint) hint.textContent = '提交失敗，請稍後再試';
    }
  }

  /** Load and render leaderboard on home screen */
  async refreshLeaderboard() {
    const mode   = this.lbMode;
    const sortBy = this.lbSortBy;

    // Sync tab active states
    document.querySelectorAll('.lb-tab').forEach(btn => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.lb-sort').forEach(btn => {
      const on = btn.dataset.sort === sortBy;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });

    const list    = document.getElementById('lbList');
    const loading = document.getElementById('lbLoading');
    const offline = document.getElementById('lbOffline');
    if (!list) return;

    if (loading) loading.style.display = 'flex';
    if (list)    list.style.display    = 'none';
    if (offline) offline.style.display = 'none';

    const entries = await getLeaderboard(mode, 10, this.nickname || '', sortBy);

    if (!entries || entries.length === 0) {
      if (loading) loading.style.display = 'none';
      if (offline) offline.style.display = 'flex';
      return;
    }

    const _val = (e) => {
      if (sortBy === 'apples') return `${e.apples_eaten}顆`;
      if (sortBy === 'ratio')  return `${(e.ratio ?? 0).toFixed(1)}分/顆`;
      return e.score.toLocaleString();
    };

    list.innerHTML = entries.map(entry => `
      <li class="lb-entry${entry.is_me ? ' lb-me' : ''}">
        <span class="lb-rank rank-${entry.rank <= 3 ? entry.rank : 'other'}">
          ${entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : entry.rank}
        </span>
        <span class="lb-nick">${_escHtml(entry.nickname)}</span>
        <span class="lb-score">${_val(entry)}</span>
      </li>
    `).join('');

    if (loading) loading.style.display = 'none';
    if (list)    list.style.display    = 'block';
  }

  /* ── Event Binding ─────────────────────────── */
  _bindAll() {
    // ── Home ──────────────────────────────────────────
    const _startOrNick = (mode) => {
      this.pendingMode = mode;
      if (!this.nickname) this._openNickScreen();
      else this.startGame(mode);
    };

    document.getElementById('btnInfiniteMode')?.addEventListener('click', () => _startOrNick('infinite'));
    document.getElementById('btnLevelMode')?.addEventListener('click',    () => _startOrNick('level'));

    // Keyboard shortcut for mode cards
    ['btnInfiniteMode', 'btnLevelMode', 'btnLadderMode'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
      });
    });

    // ── Ladder Mode ────────────────────────────────
    document.getElementById('btnLadderMode')?.addEventListener('click', () => {
      this.showScreen('ladder-lobby');
      // Pre-fill lobby nickname from the game nickname
      const nickInput = document.getElementById('ladderNickInput');
      if (nickInput && this.nickname) nickInput.value = this.nickname;
      // Create & connect ladder instance (one per session)
      if (!window.ladderGame) {
        window.ladderGame = new window.LadderGame();
      } else {
        // Reset UI for re-entry
        document.getElementById('lbCreate')?.classList.remove('hidden');
        document.getElementById('lbWaiting')?.classList.add('hidden');
      }
    });

    document.getElementById('btnChangeNickname')?.addEventListener('click', () => {
      this.pendingMode = null;
      this._openNickScreen();
    });

    // ── Play Again: keep same mode ────────────────────
    document.getElementById('btnPlayAgain')?.addEventListener('click', () => {
      this.startGame(this.currentMode);
    });

    // ── Grid Size Selector ─────────────────────────────────
    const _applyGridSize = (size) => {
      this.gridSize = size;
      localStorage.setItem('snake_grid_size', String(size));
      document.querySelectorAll('.grid-sel-btn').forEach(btn => {
        const active = parseInt(btn.dataset.size) === size;
        btn.classList.toggle('grid-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    };
    _applyGridSize(this.gridSize);  // restore saved preference on boot
    document.querySelectorAll('.grid-sel-btn').forEach(btn => {
      btn.addEventListener('click', () => _applyGridSize(parseInt(btn.dataset.size)));
    });

    // ── Leaderboard tabs ──────────────────────────────────────────
    document.querySelectorAll('.lb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.lbMode = btn.dataset.mode;
        this.refreshLeaderboard();
      });
    });
    document.querySelectorAll('.lb-sort').forEach(btn => {
      btn.addEventListener('click', () => {
        this.lbSortBy = btn.dataset.sort;
        this.refreshLeaderboard();
      });
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
      this.startGame(this.currentMode);
    });

    document.getElementById('btnSubmitScore')?.addEventListener('click', () => {
      this.handleSubmitScore();
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

    // ── Touch / Swipe ── handled by VirtualJoystick on #screen-game ──────────
    // (canvas-only swipe removed; full-screen drag now handled in VirtualJoystick._bind)

    // ── D-pad replaced by VirtualJoystick (see VirtualJoystick class) ────
    // Joystick is initialised in App constructor after DOM ready.

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
   Virtual Joystick
   ========================================================== */
class VirtualJoystick {
  /**
   * @param {App} app
   */
  constructor(app) {
    this.app       = app;
    this.container = document.getElementById('joystickContainer');
    this.base      = document.getElementById('joystickBase');
    this.knob      = document.getElementById('joystickKnob');
    this.active    = false;
    this.centerX   = 0;
    this.centerY   = 0;
    this.maxTravel = 38;  // max knob displacement from centre (px)
    this.threshold = 15;  // min drag distance to register a direction
    if (this.base) {
      this._bind();
      this._loadSide();
    }
  }

  _loadSide() {
    const side = localStorage.getItem('joystick_side') || 'right';
    this.container?.classList.remove('joy-left', 'joy-right');
    this.container?.classList.add(`joy-${side}`);
    document.getElementById('joySetLeft') ?.classList.toggle('joy-active', side === 'left');
    document.getElementById('joySetRight')?.classList.toggle('joy-active', side === 'right');
  }

  _setSide(side) {
    localStorage.setItem('joystick_side', side);
    this._loadSide();
  }

  _bind() {
    // ── Full-screen touch on #screen-game ────────────────────
    // The joystick knob is a visual indicator; the whole game screen is the control area.
    const screen = document.getElementById('screen-game');

    const _onStart = (e) => {
      // Only when game is running and not paused
      if (!window.snakeApp?.game?.running || window.snakeApp?.game?.paused) return;
      // Ignore touches on UI overlays and settings
      if (e.target.closest('.game-hud, #pauseOverlay, #levelCompleteOverlay, .joy-cfg-btn, .joy-settings-panel')) return;
      e.preventDefault();
      this._startDrag(e.touches[0]);
    };

    const _onMove = (e) => {
      if (!this.active) return;
      e.preventDefault();
      this._moveDrag(e.touches[0]);
    };

    const _onEnd = () => { if (this.active) this._endDrag(); };

    screen?.addEventListener('touchstart',  _onStart, { passive: false });
    screen?.addEventListener('touchmove',   _onMove,  { passive: false });
    screen?.addEventListener('touchend',    _onEnd);
    screen?.addEventListener('touchcancel', _onEnd);

    // ── Mouse fallback for desktop testing ──────────────────
    document.addEventListener('mousedown', (e) => {
      if (window.snakeApp?.currentScreen !== 'game') return;
      if (!window.snakeApp?.game?.running || window.snakeApp?.game?.paused) return;
      if (e.target.closest('.game-hud, #pauseOverlay, button')) return;
      this._startDrag(e);
    });
    window.addEventListener('mousemove', (e) => { if (this.active) this._moveDrag(e); });
    window.addEventListener('mouseup',   ()  => { if (this.active) this._endDrag(); });

    // ── Settings cog ────────────────────────────────────────
    document.getElementById('btnJoySettings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('joySettingsPanel')?.classList.toggle('hidden');
    });

    document.getElementById('joySetLeft')?.addEventListener('click', () => {
      this._setSide('left');
      document.getElementById('joySettingsPanel')?.classList.add('hidden');
    });

    document.getElementById('joySetRight')?.addEventListener('click', () => {
      this._setSide('right');
      document.getElementById('joySettingsPanel')?.classList.add('hidden');
    });

    // Dismiss settings panel on outside click
    document.addEventListener('pointerdown', (e) => {
      const panel = document.getElementById('joySettingsPanel');
      const cog   = document.getElementById('btnJoySettings');
      if (panel && !panel.classList.contains('hidden') &&
          !panel.contains(e.target) && e.target !== cog) {
        panel.classList.add('hidden');
      }
    });
  }

  _startDrag(pt) {
    this.active = true;
    // Use the touch/click point as the drag origin (full-screen mode)
    this.centerX = pt.clientX;
    this.centerY = pt.clientY;
    this.knob?.classList.add('dragging');
    document.getElementById('joySettingsPanel')?.classList.add('hidden');
  }

  _moveDrag(pt) {
    if (!this.active || !this.knob) return;
    const dx   = pt.clientX - this.centerX;
    const dy   = pt.clientY - this.centerY;
    const dist = Math.hypot(dx, dy);

    // Clamp knob within base
    const travel = Math.min(dist, this.maxTravel);
    const angle  = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * travel;
    const ky = Math.sin(angle) * travel;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

    // Register direction only past threshold
    if (dist < this.threshold) return;
    const deg = angle * (180 / Math.PI);
    let dir;
    if      (deg > -45  && deg <=  45)  dir = DIR.RIGHT;
    else if (deg >  45  && deg <= 135)  dir = DIR.DOWN;
    else if (deg > 135  || deg <= -135) dir = DIR.LEFT;
    else                                 dir = DIR.UP;

    if (this.app.game?.running && !this.app.game.paused) {
      this.app.game.setDirection(dir);
    }
  }

  _endDrag() {
    this.active = false;
    if (this.knob) {
      this.knob.classList.remove('dragging');
      this.knob.style.transform = 'translate(-50%, -50%)';
    }
  }
}

/* ==========================================================
   Boot
   ========================================================== */
document.addEventListener('DOMContentLoaded', () => {
  // Mount global app instance
  window.snakeApp = new App();
  // Expose showScreen globally for ladder.js (non-module) to call
  window.showScreen = (id) => window.snakeApp.showScreen(id);

  // Virtual joystick (shows on mobile game screen)
  window.snakeApp.joystick = new VirtualJoystick(window.snakeApp);

  // Check backend & load leaderboard on home screen
  window.snakeApp.refreshLeaderboard('infinite');

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
