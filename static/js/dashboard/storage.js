/*
 * Best-effort JSON wrapper around localStorage. Every call swallows errors
 * (private mode, blocked storage, bad JSON) so the page works without it.
 */
export const store = {
  /** Return the parsed value for `key`, or null if missing/unreadable. */
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  },
  /** Save `value` as JSON under `key`. */
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
  /** Delete `key`. */
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};
