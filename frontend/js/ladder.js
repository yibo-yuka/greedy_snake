'use strict';
/**
 * Ladder Race v2 — Frontend WebSocket Client + Canvas Renderer
 * ==============================================================
 * New design: 5 vertical tracks, horizontal rungs, fully automatic movement.
 * Players select starting column → program runs them automatically → rank by finish order.
 *
 * Constants MUST match backend/apps/leaderboard/ladder.py
 */

const NUM_COLS      = 5;
const NUM_ROWS      = 20;
const FINISH_ROW    = 0;
const START_ROW     = 19;
const SELECTION_SECS = 15;

// Must match RUNGS in ladder.py: [row, col_left, col_right]
const RUNGS = [
  [3,  0, 1], [5,  3, 4], [7,  1, 2], [9,  2, 3],
  [11, 0, 1], [12, 3, 4], [14, 1, 2], [15, 2, 3],
  [17, 0, 1], [18, 1, 2], [18, 3, 4],
];

const MEDALS = ['🥇', '🥈', '🥉', '🏅', '🏅'];

// ═══════════════════════════════════════════════════════════════════════════════

class LadderGame {
  constructor() {
    this.ws           = null;
    this.playerID     = null;
    this.roomCode     = null;
    this.isHost       = false;
    this.nickname     = '';
    this.state        = 'idle'; // idle|lobby|selecting|playing|finished

    // Lobby
    this.lobbyPlayers = [];       // [{pid, nickname, color, is_host}]

    // Game
    this.gamePlayers  = {};       // {pid → player_state}
    this.selectedCols = {};       // {pid → col}

    // Selection countdown
    this.selTimeLeft  = SELECTION_SECS;
    this._selTimer    = null;

    // Canvas
    this.canvas  = document.getElementById('ladderCanvas');
    this.ctx     = this.canvas?.getContext('2d');
    this.cellSz  = 32;
    this.rafId   = null;

    this._bindEvents();
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  connect(nickname) {
    this.nickname = nickname;
    const api    = window.SNAKE_CONFIG?.apiUrl || '';
    const wsBase = api.replace('/api', '')
                      .replace('https://', 'wss://')
                      .replace('http://',  'ws://');
    const wsUrl  = `${wsBase}/ws/ladder/`;
    console.log('[Ladder] connecting to', wsUrl);

    this.ws            = new WebSocket(wsUrl);
    this.ws.onopen     = ()  => console.log('[Ladder] WS open');
    this.ws.onmessage  = (e) => this._dispatch(JSON.parse(e.data));
    this.ws.onclose    = ()  => this._onClose();
    this.ws.onerror    = (e) => { console.error('[Ladder] WS error', e); };
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(data));
  }

  createRoom()     { this.send({ type: 'create_room', nickname: this.nickname }); }
  joinRoom(code)   { this.send({ type: 'join_room',   room_code: code, nickname: this.nickname }); }
  closeRoom()      { this.send({ type: 'close_room' }); }
  startGame()      { this.send({ type: 'start_game' }); }
  selectStart(col) { this.send({ type: 'select_start', col }); }

  disconnect() {
    this.ws?.close(); this.ws = null;
    cancelAnimationFrame(this.rafId);
    clearInterval(this._selTimer);
    this.state = 'idle';
  }

  _onClose() {
    if (this.state !== 'idle' && this.state !== 'finished')
      this._showErr('與伺服器斷線，請重新整理頁面');
  }

  // ── Message dispatcher ─────────────────────────────────────────────────────

  _dispatch(msg) {
    const h = {
      room_joined:    () => this._onRoomJoined(msg),
      player_joined:  () => this._onPlayerJoined(msg),
      player_left:    () => this._onPlayerLeft(msg),
      room_closed:    () => this._onRoomClosed(msg),
      selecting:      () => this._onSelecting(msg),
      start_selected: () => this._onStartSelected(msg),
      game_started:   () => this._onGameStarted(msg),
      tick:           () => this._onTick(msg),
      game_over:      () => this._onGameOver(msg),
      error:          () => this._showErr(msg.message),
    };
    h[msg.type]?.();
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  _onRoomJoined(msg) {
    this.playerID     = msg.player_id;
    this.roomCode     = msg.room_code;
    this.isHost       = msg.is_host;
    this.lobbyPlayers = msg.players;
    this.state        = 'lobby';
    this._showLobbyWaiting();
  }

  _onPlayerJoined(msg) {
    this.lobbyPlayers = msg.players;
    this._renderLobbyPlayers();
  }

  _onPlayerLeft(msg) {
    this.lobbyPlayers = msg.players;
    this._renderLobbyPlayers();
  }

  _onRoomClosed(msg) {
    this.disconnect();
    this._resetLobbyUI();
    window.showScreen('home');
    this._showErr(msg.message);
  }

  _onSelecting(msg) {
    this.state        = 'selecting';
    this.selTimeLeft  = msg.countdown;
    this.selectedCols = {};
    window.showScreen('ladder-game');
    this._initCanvas();
    document.getElementById('ladderHUD')?.classList.remove('hidden');
    this._renderHUDSelecting();
    this._startSelTimer();
    this._renderLoop();
  }

  _onStartSelected(msg) {
    this.selectedCols = msg.selected_cols;
  }

  _onGameStarted(msg) {
    this.state        = 'playing';
    this.selectedCols = msg.selected_cols;
    clearInterval(this._selTimer);
    this._applyGameState(msg.state);
    this._updateHUD();
  }

  _onTick(msg) {
    this._applyGameState(msg.state);
    this._updateHUD();
  }

  _onGameOver(msg) {
    this.state = 'finished';
    cancelAnimationFrame(this.rafId);
    this._renderResults(msg.results);
    window.showScreen('ladder-results');
  }

  // ── State helpers ──────────────────────────────────────────────────────────

  _applyGameState(st) {
    this.gamePlayers = {};
    for (const p of st.players) this.gamePlayers[p.pid] = p;
  }

  // ── Canvas ─────────────────────────────────────────────────────────────────

  _initCanvas() {
    if (!this.canvas) return;
    const wrap   = this.canvas.parentElement;
    const availW = Math.max(160, (wrap?.clientWidth  || 320) - 16);
    const availH = Math.max(400, window.innerHeight - 200);
    const byW    = Math.floor(availW / NUM_COLS);
    const byH    = Math.floor(availH / NUM_ROWS);
    this.cellSz          = Math.max(18, Math.min(48, byW, byH));
    this.canvas.width    = NUM_COLS * this.cellSz;
    this.canvas.height   = NUM_ROWS * this.cellSz;
  }

  /** Center x of a track column. */
  _tx(col) { return (col + 0.5) * this.cellSz; }

  /** Center y of a row (row 0 = top). */
  _ry(row) { return (row + 0.5) * this.cellSz; }

  _renderLoop() {
    cancelAnimationFrame(this.rafId);
    const frame = () => {
      this._draw();
      if (this.state === 'selecting' || this.state === 'playing')
        this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  _draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const sz  = this.cellSz;
    const W   = this.canvas.width;
    const H   = this.canvas.height;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, W, H);

    // ── Finish zone ─────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,210,50,0.10)';
    ctx.fillRect(0, 0, W, sz);
    ctx.fillStyle = '#f7dc6f';
    ctx.fillRect(0, 0, W, 3);
    ctx.font         = `bold ${Math.max(10, sz * 0.38)}px Inter,sans-serif`;
    ctx.fillStyle    = '#f7dc6f';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏁  F I N I S H', W / 2, sz * 0.45);

    // ── Start zone label ────────────────────────────────────────────────────
    if (this.state === 'selecting') {
      ctx.font         = `${Math.max(9, sz * 0.30)}px Inter,sans-serif`;
      ctx.fillStyle    = 'rgba(255,255,255,0.45)';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▼ 點選下方格子選擇起始軌道 ▼', W / 2, this._ry(START_ROW) - sz * 0.7);
    }

    // ── Vertical tracks ─────────────────────────────────────────────────────
    for (let col = 0; col < NUM_COLS; col++) {
      const cx   = this._tx(col);
      const barW = sz * 0.20;
      const topY = sz * 0.95;
      const botY = H - sz * 0.05;

      const grad = ctx.createLinearGradient(cx, topY, cx, botY);
      grad.addColorStop(0, 'rgba(80,120,180,0.55)');
      grad.addColorStop(1, 'rgba(40,60,100,0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - barW / 2, topY, barW, botY - topY);
    }

    // ── Rungs + apples ──────────────────────────────────────────────────────
    for (const [row, c1, c2] of RUNGS) {
      const x1 = this._tx(c1);
      const x2 = this._tx(c2);
      const ry  = this._ry(row);

      // Rung bar (golden)
      ctx.shadowColor = '#f7dc6f';
      ctx.shadowBlur  = 5;
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth   = Math.max(3, sz * 0.13);
      ctx.lineCap     = 'round';
      ctx.beginPath(); ctx.moveTo(x1, ry); ctx.lineTo(x2, ry); ctx.stroke();
      ctx.shadowBlur  = 0;

      // Apple (red circle, mid-rung)
      const mx  = (x1 + x2) / 2;
      const ar  = Math.max(4, sz * 0.16);
      const grd = ctx.createRadialGradient(mx - ar * 0.3, ry - ar * 0.3, ar * 0.1, mx, ry, ar);
      grd.addColorStop(0, '#ffbbbb');
      grd.addColorStop(1, '#bb1111');
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur  = 6;
      ctx.fillStyle   = grd;
      ctx.beginPath(); ctx.arc(mx, ry, ar, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur  = 0;
    }

    // ── Selection phase: start squares ──────────────────────────────────────
    if (this.state === 'selecting') {
      this._drawStartSquares(ctx, sz);
    }

    // ── Player tokens (game) ────────────────────────────────────────────────
    if (this.state === 'playing' || this.state === 'finished') {
      this._drawPlayers(ctx, sz);
    }

    // ── Selection phase: show chosen token at their start ───────────────────
    if (this.state === 'selecting') {
      this._drawSelTokens(ctx, sz);
    }

    // ── Countdown overlay ───────────────────────────────────────────────────
    if (this.state === 'selecting') {
      this._drawCountdown(ctx, sz, W);
    }
  }

  _drawStartSquares(ctx, sz) {
    for (let col = 0; col < NUM_COLS; col++) {
      const cx  = this._tx(col);
      const cy  = this._ry(START_ROW);
      const hw  = sz * 0.40;

      const takenPid = Object.entries(this.selectedCols).find(([, c]) => c === col && this.selectedCols[this.playerID] !== col)?.[0];
      const isMe     = this.selectedCols[this.playerID] === col;

      if (isMe) {
        ctx.fillStyle   = 'rgba(0,255,136,0.35)';
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth   = 3;
      } else if (takenPid) {
        const info = this.lobbyPlayers.find(p => p.pid === takenPid);
        ctx.fillStyle   = (info?.color || '#ff6b6b') + '44';
        ctx.strokeStyle = info?.color || '#ff6b6b';
        ctx.lineWidth   = 2;
      } else {
        ctx.fillStyle   = 'rgba(255,255,255,0.08)';
        ctx.strokeStyle = 'rgba(255,255,255,0.40)';
        ctx.lineWidth   = 1.5;
      }
      ctx.fillRect(  cx - hw, cy - hw, hw * 2, hw * 2);
      ctx.strokeRect(cx - hw, cy - hw, hw * 2, hw * 2);

      // Column index label
      if (!this.selectedCols[this.playerID] && !Object.values(this.selectedCols).includes(col)) {
        ctx.fillStyle    = 'rgba(255,255,255,0.50)';
        ctx.font         = `${sz * 0.32}px Inter,sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(col + 1, cx, cy);
      }
    }
  }

  _drawSelTokens(ctx, sz) {
    for (const [pid, col] of Object.entries(this.selectedCols)) {
      const info = this.lobbyPlayers.find(p => p.pid === pid);
      if (!info) continue;
      const cx = this._tx(col);
      const cy = this._ry(START_ROW);
      const r  = sz * 0.27;
      ctx.shadowColor = info.color;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = info.color;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur  = 0;
      ctx.fillStyle    = '#000';
      ctx.font         = `bold ${sz * 0.27}px Inter,sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.nickname[0].toUpperCase(), cx, cy);
    }
  }

  _drawCountdown(ctx, sz, W) {
    const boxW = 220;
    const boxH = 44;
    const boxX = W / 2 - boxW / 2;
    const boxY = sz * 1.15;

    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    this._rr(ctx, boxX, boxY, boxW, boxH, 8); ctx.fill();

    ctx.font         = `bold 16px Inter,sans-serif`;
    ctx.fillStyle    = '#f7dc6f';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`⏱ 選擇起始軌道  ${this.selTimeLeft}s`, W / 2, boxY + boxH / 2);
  }

  _drawPlayers(ctx, sz) {
    for (const player of Object.values(this.gamePlayers)) {
      const px   = this._tx(player.col);
      const py   = this._ry(player.row);
      const r    = sz * 0.30;
      const isMe = player.pid === this.playerID;

      ctx.shadowColor = player.color;
      ctx.shadowBlur  = isMe ? 18 : 8;
      ctx.fillStyle   = player.color;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur  = 0;

      // Initial letter
      ctx.fillStyle    = '#000';
      ctx.font         = `bold ${sz * 0.27}px Inter,sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(player.nickname[0].toUpperCase(), px, py);

      // Finish medal above token
      if (player.finished) {
        ctx.font         = `${sz * 0.45}px sans-serif`;
        ctx.textBaseline = 'bottom';
        ctx.fillText(MEDALS[(player.finish_rank || 1) - 1] ?? '🏅', px, py - r - 2);
        ctx.textBaseline = 'middle';
      }
    }
  }

  // ── Rounded rect path ──────────────────────────────────────────────────────

  _rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── HUD ────────────────────────────────────────────────────────────────────

  _renderHUDSelecting() {
    const sEl = document.getElementById('ladderScores');
    if (!sEl) return;
    sEl.innerHTML = this.lobbyPlayers.map(p => `
      <div class="hud-player" style="border-left:3px solid ${p.color}">
        <span class="hud-name">${p.nickname}</span>
        ${p.is_host ? '<span class="hud-fin">主機</span>' : ''}
      </div>`).join('');
  }

  _updateHUD() {
    const sEl = document.getElementById('ladderScores');
    if (!sEl) return;
    const sorted = Object.values(this.gamePlayers).sort((a, b) => {
      if (a.finished && !b.finished) return -1;
      if (!a.finished && b.finished) return 1;
      if (a.finished && b.finished) return (a.finish_rank || 99) - (b.finish_rank || 99);
      return a.row - b.row;  // closer to row 0 = closer to finish
    });
    sEl.innerHTML = sorted.map((p, i) => `
      <div class="hud-player" style="border-left:3px solid ${p.color}">
        <span class="hud-rank">${p.finished ? MEDALS[(p.finish_rank||1)-1]||'🏅' : `${i+1}`}</span>
        <span class="hud-name">${p.nickname}</span>
        ${p.finished ? '<span class="hud-fin">✓</span>' : ''}
      </div>`).join('');
  }

  // ── Lobby UI ───────────────────────────────────────────────────────────────

  _showLobbyWaiting() {
    document.getElementById('lbCreate')?.classList.add('hidden');
    document.getElementById('lbWaiting')?.classList.remove('hidden');
    const codeEl = document.getElementById('roomCodeDisplay');
    if (codeEl) codeEl.textContent = this.roomCode;

    // Host-only buttons
    document.getElementById('btnStartGame')?.classList.toggle('hidden', !this.isHost);
    document.getElementById('btnCloseRoom')?.classList.toggle('hidden', !this.isHost);

    const hint = document.getElementById('lobbyHint');
    if (hint) hint.textContent = this.isHost
      ? '等待玩家加入…（至少 2 人才能開始，最多 5 人）'
      : '等待主機開始…';

    this._renderLobbyPlayers();
  }

  _renderLobbyPlayers() {
    const el = document.getElementById('lobbyPlayerList');
    if (!el) return;
    el.innerHTML = this.lobbyPlayers.map(p => `
      <div class="lobby-player" style="border-left:4px solid ${p.color}">
        <span class="lp-icon">🧗</span>
        <span class="lp-name">${p.nickname}</span>
        ${p.is_host ? '<span class="lp-host">主機</span>' : ''}
      </div>`).join('');
  }

  _resetLobbyUI() {
    document.getElementById('lbCreate')?.classList.remove('hidden');
    document.getElementById('lbWaiting')?.classList.add('hidden');
  }

  // ── Results UI ─────────────────────────────────────────────────────────────

  _renderResults(results) {
    const el = document.getElementById('ladderResultsList');
    if (!el) return;
    el.innerHTML = results.map(r => `
      <div class="result-row${r.pid === this.playerID ? ' result-me' : ''}"
           style="border-left:4px solid ${r.color}">
        <span class="res-medal">${r.medal}</span>
        <span class="res-name">${r.nickname}</span>
        <span class="res-status">${r.finished ? '🏁 完成' : '未完成'}</span>
      </div>`).join('');
  }

  // ── Selection countdown ────────────────────────────────────────────────────

  _startSelTimer() {
    clearInterval(this._selTimer);
    this._selTimer = setInterval(() => {
      if (--this.selTimeLeft <= 0) clearInterval(this._selTimer);
    }, 1000);
  }

  // ── Error toast ────────────────────────────────────────────────────────────

  _showErr(msg) {
    let el = document.getElementById('ladderErrToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ladderErrToast';
      el.className = 'err-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  // ── Event bindings ─────────────────────────────────────────────────────────

  _bindEvents() {

    // Canvas click → column selection
    this.canvas?.addEventListener('click', e => {
      if (this.state !== 'selecting') return;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top)  * (this.canvas.height / rect.height);
      // Only respond to clicks in the bottom-row area
      const startCy = this._ry(START_ROW);
      if (Math.abs(y - startCy) > this.cellSz * 0.65) return;
      const col = Math.floor(x / this.cellSz);
      if (col >= 0 && col < NUM_COLS) this.selectStart(col);
    });

    // ── Lobby ──────────────────────────────────────────────────────────────

    document.getElementById('btnCreateRoom')?.addEventListener('click', () => {
      const nick = document.getElementById('ladderNickInput')?.value.trim() || this.nickname || '訪客';
      this.nickname = nick;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect(nick);
        this.ws.onopen = () => this.createRoom();
      } else {
        this.createRoom();
      }
    });

    document.getElementById('btnJoinRoom')?.addEventListener('click', () => {
      const nick = document.getElementById('ladderNickInput')?.value.trim() || this.nickname || '訪客';
      this.nickname = nick;
      const code = document.getElementById('joinCodeInput')?.value.trim().toUpperCase();
      if (!code || code.length !== 4) return this._showErr('請輸入 4 位房間碼');
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect(nick);
        this.ws.onopen = () => this.joinRoom(code);
      } else {
        this.joinRoom(code);
      }
    });

    document.getElementById('joinCodeInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btnJoinRoom')?.click();
    });

    document.getElementById('btnStartGame')?.addEventListener('click', () => {
      if (this.isHost) this.startGame();
    });

    document.getElementById('btnCloseRoom')?.addEventListener('click', () => {
      if (this.isHost && confirm('確定要關閉房間？所有玩家將被踢出。')) {
        this.closeRoom();
        this._resetLobbyUI();
        window.showScreen('home');
      }
    });

    document.getElementById('btnLadderBack')?.addEventListener('click', () => {
      this.disconnect();
      this._resetLobbyUI();
      window.showScreen('home');
    });

    // ── Results ─────────────────────────────────────────────────────────────

    document.getElementById('btnPlayAgainLadder')?.addEventListener('click', () => {
      this.disconnect();
      this._resetLobbyUI();
      window.showScreen('ladder-lobby');
    });

    document.getElementById('btnResultsHome')?.addEventListener('click', () => {
      this.disconnect();
      window.showScreen('home');
    });
  }
}

// ── Global instance ────────────────────────────────────────────────────────────
window.LadderGame = LadderGame;
