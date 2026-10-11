/*
 * Generic checkbox-dropdown widget built on <details>.
 * An empty selection means "no filter", displayed as everything ticked.
 */
import { el } from "./dom.js";

/**
 * Render a multi-select into `container`.
 *   label        visible label above the dropdown
 *   options()    returns [{ value, label }] (called lazily so it sees fresh data)
 *   getSelected  returns the current array of selected values ([] = all)
 *   setSelected  stores a new selection array
 *   onChange     called after the user changes the selection
 * Returns a `sync()` function that redraws ticks/summary from getSelected().
 */
export function buildMultiSelect(container, { label, options, getSelected, setSelected, onChange }) {
  container.innerHTML = "";
  const details = el("details", { class: "multi" });
  const summary = el("summary", { "aria-label": `${label} filter` });
  const menu = el("div", { class: "multi-menu" });
  const tools = el("div", { class: "multi-tools" },
    el("button", { type: "button", class: "link-btn", text: "Select all" }));
  menu.append(tools);

  for (const opt of options()) {
    const box = el("input", { type: "checkbox", value: opt.value });
    menu.append(el("label", {}, box, opt.label));
  }
  details.append(summary, menu);
  container.append(el("label", { text: label }), details);

  const sync = () => {
    const selected = new Set(getSelected());
    // An empty selection means "no filter", shown as everything ticked.
    menu.querySelectorAll("input").forEach((b) => { b.checked = selected.size === 0 || selected.has(b.value); });
    const total = options().length;
    summary.textContent = selected.size === 0 || selected.size === total
      ? `All`
      : selected.size === 1 ? [...selected][0] : `${selected.size} selected`;
  };

  menu.addEventListener("change", () => {
    const all = [...menu.querySelectorAll("input")];
    const checked = all.filter((b) => b.checked).map((b) => b.value);
    // Everything ticked is the same as no filter.
    setSelected(checked.length === all.length ? [] : checked);
    sync();
    onChange();
  });
  tools.addEventListener("click", (e) => {
    if (!e.target.closest("button")) return;
    setSelected([]);   // no filter = everything
    sync();
    onChange();
  });
  sync();
  return sync;
}
