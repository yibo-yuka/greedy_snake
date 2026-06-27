'use strict';
/**
 * Ladder Race — Frontend WebSocket Client + Canvas Engine
 * ========================================================
 * Connects via WebSocket to Django Channels backend.
 * Renders the ladder map, player snakes, and apples on HTML5 Canvas.
 *
 * Constants must match backend/apps/leaderboard/ladder.py
 */

const GRID_COLS      = 10;
const GRID_ROWS      = 15;
const FINISH_ROW     = 14;
const SELECTION_SECS = 10;

// Ladder definitions [col, rowStart, rowEnd] — mirrors ladder.py
const LADDER_DEFS = [[8,0,2],[1,2,5],[8,5,8],[1,8,11],[8,11,14]];

// ═══════════════════════════════════════════════════════════════════════════
class LadderGame {
  constructor() {
    this.ws            = null;
    this.playerID      = null;
    this.roomCode      = null;
    this.isHost        = false;
    this.nickname      = '';
    this.state         = 'idle'; // idle|lobby|selecting|playing|finished
    this.mapSet        = null;   // Set<"col,row">
    this.players       = [];
    this.snakes        = {};     // {player_id → snake object}
    this.apples        = [];
    this.selectedCols  = {};     // {player_id → col}
    this.mySelectedCol = null;
    this.selTimeLeft   = SELECTION_SECS;
    this._selTimer     = null;
    this.gameElapsed   = 0;
    this.rafId         = null;
    this.canvas        = document.getElementById('ladderCanvas');
    this.ctx           = this.canvas?.getContext('2d');
    this.cellSz        = 30;
    this._bindEvents();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  connect(nickname) {
    this.nickname = nickname;
    const api    = window.SNAKE_CONFIG?.apiUrl || '';
    const wsBase = api.replace('/api', '')
                      .replace('https://', 'wss://')
                      .replace('http://',  'ws://');
    const wsUrl  = `${wsBase}/ws/ladder/`;
    console.log('[Ladder] connecting to', wsUrl);

    this.ws            = new WebSocket(wsUrl);
    this.ws.onopen    = ()  => console.log('[Ladder] WS open');
    this.ws.onmessage = (e) => this._dispatch(JSON.parse(e.data));
    this.ws.onclose   = ()  => this._onClose();
    this.ws.onerror   = (e) => this._onWsError(e);
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }
  createRoom()       { this.send({ type: 'create_room',  nickname: this.nickname }); }
  joinRoom(code)     { this.send({ type: 'join_room',    room_code: code, nickname: this.nickname }); }
  startGame()        { this.send({ type: 'start_game'   }); }
  selectStart(col)   { this.mySelectedCol = col; this.send({ type: 'select_start', col }); }
  sendMove(dir)      { this.send({ type: 'move', direction: dir }); }

  disconnect() {
    this.ws?.close(); this.ws = null;
    cancelAnimationFrame(this.rafId);
    clearInterval(this._selTimer);
    this.state = 'idle';
  }

  _onClose() {
    if (this.state !== 'idle') this._showErr('與伺服器斷線，請重新整理頁面');
  }
  _onWsError(e) {
    console.error('[Ladder] WS error', e);
    this._showErr('無法連接伺服器（請確認後端 WebSocket 已啟用）');
  }

  // ── Message dispatcher ───────────────────────────────────────────────────
  _dispatch(msg) {
    const h = {
      room_joined:    () => this._onRoomJoined(msg),
      player_joined:  () => this._onPlayerJoined(msg),
      player_left:    () => this._onPlayerLeft(msg),
      selecting:      () => this._onSelecting(msg),
      start_selected: () => this._onStartSelected(msg),
      game_started:   () => this._onGameStarted(msg),
      tick:           () => this._onTick(msg),
      game_over:      () => this._onGameOver(msg),
      error:          () => this._showErr(msg.message),
    };
    h[msg.type]?.();
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  _onRoomJoined(msg) {
    this.playerID = msg.player_id;
    this.roomCode = msg.room_code;
    this.isHost   = msg.is_host;
    this.players  = msg.players;
    this._buildMap(msg.map);
    this.state    = 'lobby';
    this._uiShowWaiting();
  }

  _onPlayerJoined(msg) {
    this.players = msg.players;
    this._uiRenderPlayers();
  }

  _onPlayerLeft(msg) {
    this.players = msg.players;
    this._uiRenderPlayers();
  }

  _onSelecting(msg) {
    this.state        = 'selecting';
    this.selTimeLeft  = msg.countdown;
    this.selectedCols = {};
    this.mySelectedCol = null;
    window.showScreen('ladder-game');
    this._initCanvas();
    document.getElementById('ladderHUD').classList.add('hidden');
    this._startSelTimer();
    this._renderLoop();
  }

  _onStartSelected(msg) {
    this.selectedCols = msg.selected_cols;
  }

  _onGameStarted(msg) {
    this.state = 'playing';
    clearInterval(this._selTimer);
    this._buildMap(msg.map);
    this._applyState(msg.state);
    document.getElementById('ladderHUD').classList.remove('hidden');
  }

  _onTick(msg) {
    this.gameElapsed = msg.elapsed;
    this._applyState(msg.state);
    this._updateHUD();
  }

  _onGameOver(msg) {
    this.state = 'finished';
    cancelAnimationFrame(this.rafId);
    this._renderResults(msg.results);
    window.showScreen('ladder-results');
  }

  // ── State helpers ─────────────────────────────────────────────────────────
  _buildMap(mapData) {
    this.mapSet = new Set(mapData.map(([c, r]) => `${c},${r}`));
  }
  isPass(c, r) { return this.mapSet?.has(`${c},${r}`) ?? false; }

  _applyState(st) {
    this.snakes = {};
    for (const p of st.players) this.snakes[p.player_id] = p;
    this.apples = st.apples;
  }

  // ── Canvas ────────────────────────────────────────────────────────────────
  _initCanvas() {
    if (!this.canvas) return;
    const wrap = this.canvas.parentElement;
    const maxW = (wrap?.clientWidth  || 360) - 8;
    const maxH = (window.innerHeight - 220);
    const szW  = Math.floor(maxW / GRID_COLS);
    const szH  = Math.floor(maxH / GRID_ROWS);
    this.cellSz        = Math.max(20, Math.min(36, szW, szH));
    this.canvas.width  = GRID_COLS * this.cellSz;
    this.canvas.height = GRID_ROWS * this.cellSz;
  }

  cx(c) { return c * this.cellSz; }
  cy(r) { return (GRID_ROWS - 1 - r) * this.cellSz; }

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

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // Map cells
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (!this.isPass(c, r)) continue;
        const x = this.cx(c), y = this.cy(r);
        const isLadderCol = (c === 1 || c === 8);
        if (r === FINISH_ROW)     ctx.fillStyle = 'rgba(255,210,50,0.18)';
        else if (isLadderCol)     ctx.fillStyle = 'rgba(220,180,0,0.10)';
        else                      ctx.fillStyle = 'rgba(0,180,80,0.09)';
        ctx.fillRect(x + 1, y + 1, sz - 2, sz - 2);
      }
    }

    // Grid outlines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 0.5;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (this.isPass(c, r)) ctx.strokeRect(this.cx(c) + .5, this.cy(r) + .5, sz - 1, sz - 1);
      }
    }

    // Finish line
    ctx.fillStyle = 'rgba(255,210,50,0.7)';
    ctx.fillRect(0, this.cy(FINISH_ROW), W, 3);
    ctx.font      = `bold ${Math.max(10, sz * 0.35)}px Inter,sans-serif`;
    ctx.fillStyle = 'rgba(255,210,50,0.9)';
    ctx.textAlign = 'right';
    ctx.fillText('FINISH', W - 4, this.cy(FINISH_ROW) - 4);

    // Ladder bars + rungs
    for (const [col, rs, re] of LADDER_DEFS) {
      const lx  = this.cx(col);
      const yT  = this.cy(re);
      const yB  = this.cy(rs) + sz;
      const barX = lx + sz * 0.3;
      const barW = sz * 0.4;

      const grad = ctx.createLinearGradient(barX, yT, barX, yB);
      grad.addColorStop(0, 'rgba(255,200,0,0.65)');
      grad.addColorStop(1, 'rgba(160,110,0,0.65)');
      ctx.fillStyle = grad;
      ctx.fillRect(barX, yT, barW, yB - yT);

      ctx.strokeStyle = 'rgba(255,200,0,0.35)';
      ctx.lineWidth   = 1;
      for (let r = rs; r <= re; r++) {
        const ry = this.cy(r) + sz / 2;
        ctx.beginPath(); ctx.moveTo(lx, ry); ctx.lineTo(lx + sz, ry); ctx.stroke();
      }
    }

    // Selection phase overlay
    if (this.state === 'selecting') this._drawSelectOverlay(ctx, sz, W);

    // Apples
    for (const [ac, ar] of this.apples) {
      const ax = this.cx(ac) + sz / 2;
      const ay = this.cy(ar) + sz / 2;
      const ar2 = sz * 0.3;
      const grd = ctx.createRadialGradient(ax - ar2 * .3, ay - ar2 * .3, ar2 * .1, ax, ay, ar2);
      grd.addColorStop(0, '#ff8080'); grd.addColorStop(1, '#c0392b');
      ctx.beginPath(); ctx.arc(ax, ay, ar2, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.shadowColor = '#ff4444'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
    }

    // Snakes
    for (const snake of Object.values(this.snakes)) {
      const body = snake.body; if (!body?.length) continue;
      const isMe = snake.player_id === this.playerID;
      body.forEach(([bc, br], i) => {
        const bx = this.cx(bc) + 2, by = this.cy(br) + 2, bs = sz - 4;
        if (i === 0) {
          ctx.fillStyle  = snake.color;
          ctx.shadowColor = snake.color; ctx.shadowBlur = isMe ? 14 : 5;
          this._rr(ctx, bx, by, bs, bs, 4); ctx.fill(); ctx.shadowBlur = 0;
          ctx.fillStyle = '#000';
          const er = Math.max(1.5, sz * .1);
          ctx.beginPath(); ctx.arc(bx + bs * .3, by + bs * .3, er, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(bx + bs * .7, by + bs * .3, er, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = snake.color + 'bb';
          this._rr(ctx, bx + 1, by + 1, bs - 2, bs - 2, 3); ctx.fill();
        }
      });
      if (snake.finished) {
        ctx.font = `${sz * .75}px sans-serif`; ctx.textAlign = 'center';
        ctx.fillText('🏁', this.cx(body[0][0]) + sz / 2, this.cy(body[0][1]) + sz * .82);
      }
    }

    // Selection: player markers on row 0
    if (this.state === 'selecting') {
      ctx.textAlign = 'center';
      for (const [pid, col] of Object.entries(this.selectedCols)) {
        const info = this.players.find(p => p.player_id === pid); if (!info) continue;
        const mx   = this.cx(col) + sz / 2, my = this.cy(0) + sz / 2;
        ctx.beginPath(); ctx.arc(mx, my, sz * .35, 0, Math.PI * 2);
        ctx.fillStyle = info.color; ctx.fill();
        ctx.font = `bold ${sz * .42}px Inter,sans-serif`;
        ctx.fillStyle = '#000';
        ctx.fillText(info.nickname[0].toUpperCase(), mx, my + sz * .16);
      }
    }
  }

  _drawSelectOverlay(ctx, sz, W) {
    // Darken non-start rows
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let r = 1; r < GRID_ROWS; r++) {
      if (this.isPass(0, r) || this.isPass(1, r) || this.isPass(8, r)) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (this.isPass(c, r)) ctx.fillRect(this.cx(c), this.cy(r), sz, sz);
        }
      }
    }
    // Highlight start row options
    for (let c = 0; c < GRID_COLS; c++) {
      if (!this.isPass(c, 0)) continue;
      const taken = Object.entries(this.selectedCols).some(([pid, v]) => v === c && pid !== this.playerID);
      const isMe  = this.selectedCols[this.playerID] === c;
      ctx.fillStyle = isMe ? 'rgba(0,255,136,.4)' : taken ? 'rgba(255,80,80,.2)' : 'rgba(255,255,255,.13)';
      ctx.fillRect(this.cx(c) + 2, this.cy(0) + 2, sz - 4, sz - 4);
    }
    // Countdown box
    const cx2 = W / 2;
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    this._rr(ctx, cx2 - 120, 6, 240, 44, 8); ctx.fill();
    ctx.font = `bold 17px Inter,sans-serif`; ctx.fillStyle = '#f7dc6f'; ctx.textAlign = 'center';
    ctx.fillText(`⏱ 選擇起點  ${this.selTimeLeft}s`, cx2, 32);
    ctx.font = '12px Inter,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.65)';
    ctx.fillText('點擊下方格子選擇起始欄位', cx2, 60);
  }

  // Rounded rect path helper
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

  // ── HUD ──────────────────────────────────────────────────────────────────
  _updateHUD() {
    const tEl = document.getElementById('ladderTimer');
    const sEl = document.getElementById('ladderScores');
    if (!tEl || !sEl) return;
    const rem = Math.max(0, 120 - Math.floor(this.gameElapsed));
    const m = String(Math.floor(rem / 60)).padStart(2, '0');
    const s = String(rem % 60).padStart(2, '0');
    tEl.textContent = `${m}:${s}`;
    tEl.style.color = rem < 30 ? '#ff6b6b' : '#f7dc6f';
    sEl.innerHTML = Object.values(this.snakes)
      .sort((a, b) => b.apples_eaten - a.apples_eaten)
      .map(p => `
        <div class="hud-player" style="border-left:3px solid ${p.color}">
          <span class="hud-name">${p.nickname}</span>
          <span class="hud-apple">🍎${p.apples_eaten}</span>
          ${p.finished ? '<span class="hud-fin">🏁</span>' : ''}
        </div>`).join('');
  }

  // ── Lobby UI ──────────────────────────────────────────────────────────────
  _uiShowWaiting() {
    document.getElementById('lbCreate')?.classList.add('hidden');
    document.getElementById('lbWaiting')?.classList.remove('hidden');
    const code = document.getElementById('roomCodeDisplay');
    if (code) code.textContent = this.roomCode;
    const startBtn = document.getElementById('btnStartGame');
    const hint     = document.getElementById('lobbyHint');
    if (startBtn) startBtn.classList.toggle('hidden', !this.isHost);
    if (hint) hint.textContent = this.isHost ? '等待玩家加入…（需要 2 人）' : '等待主機開始…';
    this._uiRenderPlayers();
  }

  _uiRenderPlayers() {
    const el = document.getElementById('lobbyPlayerList');
    if (!el) return;
    el.innerHTML = this.players.map(p => `
      <div class="lobby-player" style="border-left:4px solid ${p.color}">
        <span>🐍</span>
        <span class="lp-name">${p.nickname}</span>
        ${p.is_host ? '<span class="lp-host">主機</span>' : ''}
      </div>`).join('');
  }

  // ── Results UI ────────────────────────────────────────────────────────────
  _renderResults(results) {
    const el = document.getElementById('ladderResultsList');
    if (!el) return;
    const medals = ['🥇','🥈','🥉','🏅'];
    el.innerHTML = results.map((r, i) => `
      <div class="result-row${r.player_id === this.playerID ? ' result-me' : ''}"
           style="border-left:4px solid ${r.color}">
        <span class="res-medal">${medals[i] ?? `#${r.rank}`}</span>
        <span class="res-name">${r.nickname}</span>
        <span class="res-score">🍎 ${r.apples_eaten}</span>
        ${r.finished ? '<span class="res-fin">✓ 到頂</span>' : ''}
      </div>`).join('');
  }

  // ── Selection timer ───────────────────────────────────────────────────────
  _startSelTimer() {
    clearInterval(this._selTimer);
    this._selTimer = setInterval(() => {
      if (--this.selTimeLeft <= 0) clearInterval(this._selTimer);
    }, 1000);
  }

  // ── Error toast ───────────────────────────────────────────────────────────
  _showErr(msg) {
    let el = document.getElementById('ladderErrToast');
    if (!el) { el = document.createElement('div'); el.id = 'ladderErrToast'; el.className = 'err-toast'; document.body.appendChild(el); }
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  // ── Input events ─────────────────────────────────────────────────────────
  _bindEvents() {
    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (this.state !== 'playing') return;
      const DIR = { ArrowUp:'up', w:'up', W:'up', ArrowDown:'down', s:'down', S:'down',
                    ArrowLeft:'left', a:'left', A:'left', ArrowRight:'right', d:'right', D:'right' };
      const dir = DIR[e.key];
      if (dir) { e.preventDefault(); this.sendMove(dir); }
    });

    // D-pad buttons
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.dpad-btn');
      if (btn && this.state === 'playing') this.sendMove(btn.dataset.dir);
    });
    document.addEventListener('touchstart', (e) => {
      const btn = e.target.closest('.dpad-btn');
      if (btn && this.state === 'playing') { e.preventDefault(); this.sendMove(btn.dataset.dir); }
    }, { passive: false });

    // Canvas click → start selection
    document.addEventListener('click', (e) => {
      if (this.state !== 'selecting' || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      const col = Math.floor((e.clientX - rect.left) / this.cellSz);
      if (col >= 0 && col < GRID_COLS && this.isPass(col, 0)) this.selectStart(col);
    });

    // Lobby buttons
    document.getElementById('btnCreateRoom')?.addEventListener('click', () => {
      const nick = document.getElementById('ladderNickInput')?.value.trim() || this.nickname || '訪客';
      this.nickname = nick;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect(nick);
        // Wait for connection then create room
        const orig = this.ws.onopen;
        this.ws.onopen = () => { orig?.call(this.ws); this.createRoom(); };
      } else {
        this.createRoom();
      }
    });
    document.getElementById('btnJoinRoom')?.addEventListener('click', () => {
      const nick = document.getElementById('ladderNickInput')?.value.trim() || this.nickname || '訪客';
      this.nickname = nick;
      const code = document.getElementById('joinCodeInput')?.value.trim().toUpperCase();
      if (!code || code.length !== 4) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect(nick);
        const orig = this.ws.onopen;
        this.ws.onopen = () => { orig?.call(this.ws); this.joinRoom(code); };
      } else {
        this.joinRoom(code);
      }
    });
    document.getElementById('joinCodeInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnJoinRoom')?.click();
    });
    document.getElementById('btnStartGame')?.addEventListener('click', () => {
      if (this.isHost) this.startGame();
    });
    document.getElementById('btnLadderBack')?.addEventListener('click', () => {
      this.disconnect();
      document.getElementById('lbCreate')?.classList.remove('hidden');
      document.getElementById('lbWaiting')?.classList.add('hidden');
      window.showScreen('home');
    });
    document.getElementById('btnPlayAgainLadder')?.addEventListener('click', () => {
      this.disconnect();
      document.getElementById('lbCreate')?.classList.remove('hidden');
      document.getElementById('lbWaiting')?.classList.add('hidden');
      window.showScreen('ladder-lobby');
    });
    document.getElementById('btnResultsHome')?.addEventListener('click', () => {
      this.disconnect();
      window.showScreen('home');
    });
  }
}

// ── Global instance ──────────────────────────────────────────────────────────
window.LadderGame = LadderGame;
