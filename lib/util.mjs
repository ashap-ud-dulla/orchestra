// Small helpers used across Orchestra.

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st.
export const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

// A ticket key, in any tracker's shape: letters first, then optional parts, then a number (ABC-123, AB2-45, ABC-X-7).
export const TICKET_KEY = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\\d+';
