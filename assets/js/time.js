/**
 * time.js - Database Clock Synchronization & Countdown Utilities
 * ==============================================================================
 * Enforces rule: All expiry is controlled strictly by database time.
 * Calculates clock skew offset between client and database server so that
 * countdowns, checks, and expiration triggers are independent of the local device clock.
 * ==============================================================================
 */

let serverSkewMs = 0; // serverTime - clientLocalTime
let isInitialized = false;

/**
 * Synchronize with database server time
 * @param {string|Date} serverTimestampIso
 */
export function syncServerTime(serverTimestampIso) {
  if (!serverTimestampIso) return;
  const serverTime = new Date(serverTimestampIso).getTime();
  const localTime = Date.now();
  serverSkewMs = serverTime - localTime;
  isInitialized = true;
}

/**
 * Get current time synchronized to database server time
 * @returns {Date}
 */
export function getServerNow() {
  return new Date(Date.now() + serverSkewMs);
}

/**
 * Check whether a break expiration timestamp is in the past according to database time.
 * Enforces rule: Treat any expiry timestamp <= server_now as BLANK immediately.
 * @param {string|Date|null} expiresAt
 * @returns {boolean}
 */
export function isBreakExpired(expiresAt) {
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  const serverNowTime = getServerNow().getTime();
  return expiryTime <= serverNowTime;
}

/**
 * Calculate remaining time until break expiry
 * @param {string|Date|null} expiresAt
 * @returns {{ mm: string, ss: string, totalSeconds: number, isExpired: boolean }}
 */
export function getRemainingTime(expiresAt) {
  if (!expiresAt) {
    return { mm: '00', ss: '00', totalSeconds: 0, isExpired: true };
  }

  const expiryTime = new Date(expiresAt).getTime();
  const serverNowTime = getServerNow().getTime();
  const diffMs = expiryTime - serverNowTime;

  if (diffMs <= 0) {
    return { mm: '00', ss: '00', totalSeconds: 0, isExpired: true };
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return { mm, ss, totalSeconds, isExpired: false };
}

/**
 * Format a timestamp into a 12/24h local time string (HH:MM)
 * @param {string|Date} timestamp
 * @returns {string}
 */
export function formatLocalTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Format duration into words (e.g. "15 minutes")
 * @param {number} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
