/*
 * Generic DOM helpers used throughout the dashboard framework.
 * No data-model knowledge lives here.
 */

/** Shorthand for querySelector, optionally scoped to a root element. */
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Create an element in one call.
 * `attrs.class` sets className, `attrs.text` sets textContent, anything else
 * becomes an attribute. Children (nodes or strings) are appended in order.
 */
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};

/** Return a wrapper that runs `fn` only after `ms` of quiet. */
export const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/** Read a CSS custom property from the root element (e.g. "--grid"). */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Show a message in the page-level #banner, or hide it when `message` is empty. */
export function showBanner(message) {
  const banner = $("#banner");
  banner.textContent = message || "";
  banner.hidden = !message;
}
