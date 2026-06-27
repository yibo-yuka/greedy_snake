'use strict';
/**
 * Ladder Race v2.1 — Frontend WebSocket Client + Clean Canvas
 * ============================================================
 * 5 vertical tracks, horizontal rungs, fully automatic movement.
 * Players collect apples scattered on the map; rank by most apples eaten.
 *
 * Constants MUST match backend/apps/leaderboard/ladder.py
 */

const NUM_COLS       = 5;
const NUM_ROWS       = 20;
const FINISH_ROW     = 0;
const START_ROW      = 19;
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
    this.state        = 'idle';

    this.lobbyPlayers = [];
    this.gamePlayers  = {};     // {pid → player_state}
    this.gameApples   = [];     // [[col, row], ...]
    this.selectedCols = {};     // {pid → col}

    this.selTimeLeft  = SELECTION_SECS;
    this._selTimer    = null;

    this.canvas  = document.getElementById('ladderCanvas');
    this.ctx     = this.canvas?.getContext('2d');
    this.colW    = 60;  // pixels per column
    this.rowH    = 30;  // pixels per row
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
    this.ws           = new WebSocket(wsUrl);
    this.ws.onopen    = ()  => console.log('[Ladder] WS open');
    this.ws.onmessage = (e) => this._dispatch(JSON.parse(e.data));
    this.ws.onclose   = ()  => this._onClose();
    this.ws.onerror   = (e) => console.error('[Ladder] WS error', e);
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  createRoom()     { this.send({ type: 'create_room', nickname: this.nickname }); }
  joinRoom(code)   { this.send({ type: 'join_room',   room_code: code, nickname: this.nickname }); }
  closeRoom()      { this.send({ type: 'close_room' }); }
  startGame()      { this.send({ type: 'start_game' }); }
  forceStart()     { this.send({ type: 'force_start' }); }
  selectStart(col) { this.send({ type: 'select_start', col }); }

  disconnect() {
    this.ws?.close(); this.ws = null;
    cancelAnimationFrame(this.rafId);
    clearInterval(this._selTimer);
    this.state = 'idle';
  }

  _onClose() {
    if (this.state !== 'idle' && this.state !== 'finished') {
      this._showErr(
        '與伺服器斷線。如果未使用無痕模式，請嘗試關閉廣告活键或指出 VPN。請重新整理頁面。'
      );
    }
  }

  // ── Message dispatcher ─────────────────────────────────────────────────────

  _dispatch(msg) {
    ({
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
    })[msg.type]?.();
  }

  // ── Message handlers ───────────────────────────────────────────────────────

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
    this.gameApples   = msg.apples || [];   // 蘋果在選位時就顯示
    window.showScreen('ladder-game');
    this._initCanvas();
    // Show HUD with player list
    document.getElementById('ladderHUD')?.classList.remove('hidden');
    this._renderHUDSelecting();
    // Show host early-start button
    document.getElementById('ladderSelHost')?.classList.toggle('hidden', !this.isHost);
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
    document.getElementById('ladderSelHost')?.classList.add('hidden');
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

  _applyGameState(st) {
    this.gamePlayers = {};
    for (const p of st.players) this.gamePlayers[p.pid] = p;
    this.gameApples  = st.apples || [];
  }

  // ── Canvas initialisation ──────────────────────────────────────────────────

  _initCanvas() {
    if (!this.canvas) return;
    const wrap   = this.canvas.parentElement;
    const availW = Math.max(240, (wrap?.clientWidth || 320) - 8);
    const availH = Math.max(400, window.innerHeight - 210);
    // colW: wide gaps between tracks; rowH: enough height per row
    this.colW = Math.max(42, Math.min(76, Math.floor(availW / NUM_COLS)));
    this.rowH = Math.max(22, Math.min(34, Math.floor(availH / NUM_ROWS)));
    this.canvas.width  = NUM_COLS * this.colW;
    this.canvas.height = NUM_ROWS * this.rowH;
  }

  /** Pixel x of the centre of column `col`. */
  _tx(col) { return col * this.colW + this.colW / 2; }
  /** Pixel y of the centre of row `row` (row 0 = top/finish). */
  _ry(row) { return row * this.rowH + this.rowH / 2; }

  _renderLoop() {
    cancelAnimationFrame(this.rafId);
    const frame = () => {
      this._draw();
      if (this.state === 'selecting' || this.state === 'playing')
        this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  // ── Main draw ─────────────────────────────────────────────────────────────

  _draw() {
    if (!this.ctx) return;
    const ctx  = this.ctx;
    const cW   = this.colW;
    const rH   = this.rowH;
    const W    = this.canvas.width;
    const H    = this.canvas.height;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, W, H);

    // ── Alternating column tints ─────────────────────────────────────────────
    for (let c = 0; c < NUM_COLS; c += 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(c * cW, 0, cW, H);
    }

    // ── Subtle row grid lines ────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    for (let r = 1; r < NUM_ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * rH);
      ctx.lineTo(W, r * rH);
      ctx.stroke();
    }

    // ── Finish zone ─────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(34, 197, 94, 0.12)';
    ctx.fillRect(0, 0, W, rH);
    ctx.fillStyle = '#22C55E';
    ctx.fillRect(0, 0, W, 4);
    ctx.font         = `bold ${Math.max(11, rH * 0.44)}px Inter, sans-serif`;
    ctx.fillStyle    = '#22C55E';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏁  FINISH', W / 2, rH / 2);

    // ── Start zone label ────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, START_ROW * rH, W, rH);
    ctx.fillStyle    = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, START_ROW * rH, W, 2);

    // ── Vertical track bars ──────────────────────────────────────────────────
    const barW = Math.max(7, cW * 0.17);
    for (let c = 0; c < NUM_COLS; c++) {
      const cx   = this._tx(c);
      const topY = rH * 0.92;
      const botY = H - rH * 0.08;

      ctx.fillStyle   = 'rgba(148, 163, 184, 0.22)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.50)';
      ctx.lineWidth   = 1;
      ctx.fillRect(  cx - barW / 2, topY, barW, botY - topY);
      ctx.strokeRect(cx - barW / 2, topY, barW, botY - topY);
    }

    // ── Column labels (1-5) at bottom ────────────────────────────────────────
    ctx.font         = `${Math.max(9, rH * 0.32)}px Inter, sans-serif`;
    ctx.fillStyle    = 'rgba(255,255,255,0.30)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < NUM_COLS; c++) {
      ctx.fillText(c + 1, this._tx(c), H - rH * 0.42);
    }

    // ── Rungs (golden horizontal bridges) ────────────────────────────────────
    const rungThick = Math.max(3, rH * 0.20);
    ctx.lineCap = 'round';
    for (const [row, c1, c2] of RUNGS) {
      const x1 = this._tx(c1);
      const x2 = this._tx(c2);
      const ry  = this._ry(row);

      ctx.strokeStyle = '#D4A017';
      ctx.lineWidth   = rungThick;
      ctx.beginPath(); ctx.moveTo(x1, ry); ctx.lineTo(x2, ry); ctx.stroke();

      // End-cap dots where rung meets track
      ctx.fillStyle = '#D4A017';
      const dotR = rungThick / 2 + 1;
      ctx.beginPath(); ctx.arc(x1, ry, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x2, ry, dotR, 0, Math.PI * 2); ctx.fill();
    }

    // ── Apples (選位和遊戲中都顯示) ────────────────────────────────────
    if (this.state === 'selecting' || this.state === 'playing') {
      const appleR = Math.max(4, rH * 0.24);
      for (const [ac, ar] of this.gameApples) {
        const ax = this._tx(ac);
        const ay = this._ry(ar);
        // Body
        ctx.fillStyle = '#DC2626';
        ctx.beginPath(); ctx.arc(ax, ay, appleR, 0, Math.PI * 2); ctx.fill();
        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(ax - appleR * 0.32, ay - appleR * 0.32, appleR * 0.30, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Selection overlays ───────────────────────────────────────────────────
    if (this.state === 'selecting') {
      this._drawStartSquares(ctx, cW, rH);
      this._drawSelTokens(ctx, cW, rH);
      this._drawCountdownBadge(ctx, W, rH);
    }

    // ── Player tokens ────────────────────────────────────────────────────────
    if (this.state === 'playing' || this.state === 'finished') {
      this._drawPlayers(ctx, cW, rH);
    }
  }

  // ── Selection drawing ──────────────────────────────────────────────────────

  _drawStartSquares(ctx, cW, rH) {
    for (let col = 0; col < NUM_COLS; col++) {
      const cx    = this._tx(col);
      const cy    = this._ry(START_ROW);
      const hw    = cW * 0.38;

      const takenBy = Object.entries(this.selectedCols)
        .find(([pid, c]) => c === col && pid !== this.playerID)?.[0];
      const isMe = this.selectedCols[this.playerID] === col;

      if (isMe) {
        ctx.fillStyle   = 'rgba(34,197,94,0.28)';
        ctx.strokeStyle = '#22C55E';
        ctx.lineWidth   = 2.5;
      } else if (takenBy) {
        const info = this.lobbyPlayers.find(p => p.pid === takenBy);
        ctx.fillStyle   = (info?.color || '#aaa') + '28';
        ctx.strokeStyle = info?.color || '#aaa';
        ctx.lineWidth   = 1.5;
      } else {
        ctx.fillStyle   = 'rgba(255,255,255,0.07)';
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth   = 1;
      }
      ctx.fillRect(  cx - hw, cy - hw, hw * 2, hw * 2);
      ctx.strokeRect(cx - hw, cy - hw, hw * 2, hw * 2);

      // Show column number only if not taken
      if (!Object.values(this.selectedCols).includes(col)) {
        ctx.fillStyle    = 'rgba(255,255,255,0.38)';
        ctx.font         = `${Math.max(10, cW * 0.28)}px Inter,sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(col + 1, cx, cy);
      }
    }
  }

  _drawSelTokens(ctx, cW, rH) {
    for (const [pid, col] of Object.entries(this.selectedCols)) {
      const info = this.lobbyPlayers.find(p => p.pid === pid);
      if (!info) continue;
      const cx = this._tx(col);
      const cy = this._ry(START_ROW);
      const r  = cW * 0.25;
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle    = '#fff';
      ctx.font         = `bold ${Math.max(8, cW * 0.23)}px Inter,sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.nickname[0].toUpperCase(), cx, cy);
    }
  }

  _drawCountdownBadge(ctx, W, rH) {
    const bW = 230, bH = 34;
    const bX = (W - bW) / 2, bY = rH * 1.10;
    ctx.fillStyle = 'rgba(17,24,39,0.92)';
    this._rr(ctx, bX, bY, bW, bH, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 1;
    this._rr(ctx, bX, bY, bW, bH, 6); ctx.stroke();
    ctx.font         = `bold 14px Inter,sans-serif`;
    ctx.fillStyle    = '#D4A017';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`⏱  選擇起始軌道  ${this.selTimeLeft}s`, W / 2, bY + bH / 2);
  }

  // ── Player token drawing ───────────────────────────────────────────────────

  _drawPlayers(ctx, cW, rH) {
    for (const player of Object.values(this.gamePlayers)) {
      const px   = this._tx(player.col);
      const py   = this._ry(player.row);
      const r    = Math.max(9, cW * 0.28);
      const isMe = player.pid === this.playerID;

      // "Me" ring
      if (isMe) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(px, py, r + 3.5, 0, Math.PI * 2); ctx.stroke();
      }

      // Token circle
      ctx.fillStyle = player.color;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();

      // Dark inner ring for contrast
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();

      // Initial letter
      ctx.fillStyle    = '#000';
      ctx.font         = `bold ${Math.max(8, cW * 0.24)}px Inter,sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(player.nickname[0].toUpperCase(), px, py);

      // Apple count badge (top-right of token)
      if (player.apples_eaten > 0) {
        const bx = px + r * 0.72;
        const by = py - r * 0.72;
        const br = Math.max(5, cW * 0.17);
        ctx.fillStyle = '#DC2626';
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle    = '#fff';
        ctx.font         = `bold ${Math.max(7, br * 1.2)}px Inter,sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(player.apples_eaten, bx, by);
      }

      // Finish medal above token
      if (player.finished) {
        ctx.font         = `${Math.max(12, rH * 0.55)}px sans-serif`;
        ctx.textBaseline = 'bottom';
        ctx.fillText(MEDALS[(player.finish_rank || 1) - 1] ?? '🏅', px, py - r - 2);
        ctx.textBaseline = 'middle';
      }
    }
  }

  // ── Rounded-rect helper ────────────────────────────────────────────────────

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
    const el = document.getElementById('ladderScores');
    if (!el) return;
    el.innerHTML = this.lobbyPlayers.map(p => `
      <div class="hud-player" style="border-left:3px solid ${p.color}">
        <span class="hud-name">${p.nickname}</span>
        ${p.is_host ? '<span class="hud-fin">主機</span>' : ''}
      </div>`).join('');
  }

  _updateHUD() {
    const el = document.getElementById('ladderScores');
    if (!el) return;
    const sorted = Object.values(this.gamePlayers)
      .sort((a, b) => b.apples_eaten - a.apples_eaten || a.row - b.row);
    el.innerHTML = sorted.map((p, i) => `
      <div class="hud-player" style="border-left:3px solid ${p.color}">
        <span class="hud-rank">${p.finished ? MEDALS[(p.finish_rank||1)-1]||'🏅' : i+1}</span>
        <span class="hud-name">${p.nickname}</span>
        <span class="hud-apple">🍎${p.apples_eaten}</span>
        ${p.finished ? '<span class="hud-fin">✓</span>' : ''}
      </div>`).join('');
  }

  // ── Lobby UI ───────────────────────────────────────────────────────────────

  _showLobbyWaiting() {
    document.getElementById('lbCreate')?.classList.add('hidden');
    document.getElementById('lbWaiting')?.classList.remove('hidden');
    const codeEl = document.getElementById('roomCodeDisplay');
    if (codeEl) codeEl.textContent = this.roomCode;
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
    document.getElementById('ladderSelHost')?.classList.add('hidden');
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
        <span class="res-score">🍎 ${r.apples_eaten}</span>
        <span class="res-status">${r.finished ? '🏁' : ''}</span>
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

    // Canvas click → choose start column
    this.canvas?.addEventListener('click', e => {
      if (this.state !== 'selecting') return;
      const rect  = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width  / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top)  * scaleY;
      // Only respond to bottom-row area
      if (Math.abs(y - this._ry(START_ROW)) > this.rowH * 0.60) return;
      const col = Math.floor(x / this.colW);
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

    // ── Selection ──────────────────────────────────────────────────────────

    document.getElementById('btnForceStart')?.addEventListener('click', () => {
      if (this.isHost && this.state === 'selecting') {
        this.forceStart();
        document.getElementById('ladderSelHost')?.classList.add('hidden');
      }
    });

    // ── Navigation ─────────────────────────────────────────────────────────

    document.getElementById('btnLadderBack')?.addEventListener('click', () => {
      this.disconnect();
      this._resetLobbyUI();
      window.showScreen('home');
    });

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
