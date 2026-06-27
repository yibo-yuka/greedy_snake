/**
 * Greedy Snake — Frontend Configuration
 * ========================================
 * Update `apiUrl` after deploying the Django backend.
 *
 * Steps:
 *  1. Deploy backend to GCP GCE (Phase 5)
 *  2. Set up DuckDNS + Let's Encrypt
 *  3. Replace null below with your full backend URL
 *
 * Example:
 *   apiUrl: 'https://snake.your-name.duckdns.org/api'
 */
window.SNAKE_CONFIG = {
  /** Backend REST API base URL. null = offline / local-score-only mode. */
  apiUrl: null,
};
