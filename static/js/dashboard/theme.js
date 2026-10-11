/*
 * Light/dark theme toggle and the colour tokens charts draw with.
 * Colours come from CSS custom properties so charts follow the active theme.
 */
import { $, cssVar } from "./dom.js";

// Must match the key read by the inline bootstrap script in index.html <head>.
const THEME_KEY = "dashboard.theme";

/**
 * Wire the #theme-toggle button and OS preference changes.
 * `onChange` runs after the theme flips so charts can redraw in new colours.
 */
export function initTheme(onChange) {
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    onChange();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onChange);
}

/** Snapshot the current theme's chart colours, with `slots` categorical series colours. */
export function themeColors(slots) {
  const series = [];
  for (let i = 1; i <= slots; i++) series.push(cssVar(`--series-${i}`));
  return {
    series,
    other: cssVar("--other"),
    surface: cssVar("--surface-1"),
    text: cssVar("--text-primary"),
    textSecondary: cssVar("--text-secondary"),
    muted: cssVar("--text-muted"),
    grid: cssVar("--grid"),
    axis: cssVar("--axis"),
  };
}
