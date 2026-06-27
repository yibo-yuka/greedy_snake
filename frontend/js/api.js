/**
 * Greedy Snake — API Client
 * ==========================
 * Wraps all backend REST calls.
 * Falls back gracefully (returns null) when offline or backend unreachable.
 *
 * Backend endpoints:
 *   GET  /api/leaderboard/<mode>/?limit=N&nickname=X
 *   POST /api/scores/
 *   GET  /api/modes/
 *   GET  /api/health/
 */

'use strict';

/** @returns {string|null} */
function _apiBase() {
  return window.SNAKE_CONFIG?.apiUrl ?? null;
}

/** Shared fetch wrapper with timeout & error swallowing */
async function _apiFetch(path, options = {}) {
  const base = _apiBase();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000); // 6s timeout

  try {
    const res = await fetch(`${base}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[API] ${options.method ?? 'GET'} ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name !== 'AbortError') {
      console.warn(`[API] fetch error for ${path}:`, err.message);
    }
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Check whether the backend is reachable.
 * @returns {Promise<boolean>}
 */
export async function isBackendOnline() {
  const result = await _apiFetch('/health/');
  return result?.status === 'ok';
}

/**
 * Fetch the top leaderboard entries for a game mode.
 * @param {'infinite'|'level'|'ladder'} mode
 * @param {number} [limit=10]
 * @param {string} [myNickname=''] - Highlight this player in results
 * @returns {Promise<Array|null>}  null = offline
 */
export async function getLeaderboard(mode, limit = 10, myNickname = '') {
  const params = new URLSearchParams({ limit });
  if (myNickname) params.set('nickname', myNickname);
  return _apiFetch(`/leaderboard/${mode}/?${params}`);
}

/**
 * Submit a score to the global leaderboard.
 * @param {{
 *   nickname:      string,
 *   mode:          'infinite'|'level'|'ladder',
 *   score:         number,
 *   apples_eaten:  number,
 *   level_reached: number|null,
 * }} payload
 * @returns {Promise<{id:number, rank:number, score:number, is_best:boolean}|null>}
 */
export async function submitScore({ nickname, mode, score, apples_eaten, level_reached = null }) {
  return _apiFetch('/scores/', {
    method: 'POST',
    body: JSON.stringify({ nickname, mode, score, apples_eaten, level_reached }),
  });
}

/**
 * Fetch active game modes from the backend.
 * @returns {Promise<Array|null>}
 */
export async function getGameModes() {
  return _apiFetch('/modes/');
}
