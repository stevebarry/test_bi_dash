/*
 * Global filter bar: a date-range preset, explicit From/To dates, and one
 * multi-select per entry in `config.multiFilters`. Every KPI and panel is
 * recomputed when a filter changes.
 *
 * Generic: which multi-select filters exist, their options and their default
 * values all come from the data-model config.
 */
import { $, el } from "./dom.js";
import { store } from "./storage.js";
import { buildMultiSelect } from "./multiselect.js";

/**
 * Create the filter controller.
 *   ctx.state      shared dashboard state (uses .meta and .filters)
 *   ctx.config     data-model config (multiFilters, defaultFilterValues, storageKeys)
 *   ctx.onChange   called (already debounced by the caller) after any filter edit
 */
export function createFilters({ state, config, onChange }) {
  const syncers = [];   // one redraw function per multi-select

  /** Defaults: whole date range, no multi-select restriction, plus model overrides. */
  function defaultFilters() {
    const opts = state.meta.options;
    const filters = { preset: "all", date_from: opts.date_min || "", date_to: opts.date_max || "" };
    for (const f of config.multiFilters) filters[f.key] = [];
    return { ...filters, ...config.defaultFilterValues(state.meta) };
  }

  /** Create one .filter-group per configured multi-select, just before "Clear filters". */
  function buildMultiFilters() {
    const anchor = $(".filter-clear");
    for (const f of config.multiFilters) {
      const container = el("div", { class: "filter-group", "data-multi": f.key });
      anchor.before(container);
      syncers.push(buildMultiSelect(container, {
        label: f.label,
        options: () => f.options(state.meta),
        getSelected: () => state.filters[f.key],
        setSelected: (values) => { state.filters[f.key] = values; },
        onChange,
      }));
    }
  }

  function init() {
    const saved = store.get(config.storageKeys.filters);
    state.filters = { ...defaultFilters(), ...(saved || {}) };

    buildMultiFilters();

    // Close an open multi-select when clicking elsewhere.
    document.addEventListener("click", (e) => {
      document.querySelectorAll("details.multi[open]").forEach((d) => {
        if (!d.contains(e.target)) d.open = false;
      });
    });

    const preset = $("#preset"), from = $("#date-from"), to = $("#date-to");
    const { date_min, date_max } = state.meta.options;
    for (const input of [from, to]) {
      if (date_min) input.min = date_min;
      if (date_max) input.max = date_max;
    }

    preset.addEventListener("change", () => {
      applyPreset(preset.value);
      onChange();
    });
    for (const [input, key] of [[from, "date_from"], [to, "date_to"]]) {
      input.addEventListener("change", () => {
        state.filters[key] = input.value;
        state.filters.preset = "custom";
        preset.value = "custom";
        onChange();
      });
    }
    $("#clear-filters").addEventListener("click", () => {
      state.filters = defaultFilters();
      sync();
      onChange();
    });
    sync();
  }

  /** Set date_from/date_to from a preset ("all", "ytd", "custom" or a day count). */
  function applyPreset(value) {
    const { date_min, date_max } = state.meta.options;
    state.filters.preset = value;
    if (!date_max || value === "custom") return sync();
    // Presets are anchored on the latest record in the data, not today.
    const end = new Date(date_max + "T00:00:00");
    let start;
    if (value === "all") start = new Date(date_min + "T00:00:00");
    else if (value === "ytd") start = new Date(end.getFullYear(), 0, 1);
    else start = new Date(end.getTime() - (Number(value) - 1) * 86400000);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    state.filters.date_from = iso(start);
    state.filters.date_to = iso(end);
    sync();
  }

  /** Push state.filters into every control. */
  function sync() {
    $("#preset").value = state.filters.preset || "custom";
    $("#date-from").value = state.filters.date_from || "";
    $("#date-to").value = state.filters.date_to || "";
    syncers.forEach((s) => s());
  }

  /** The filters in the shape the API expects: only non-empty values. */
  function apiFilters() {
    const f = state.filters;
    const out = {};
    if (f.date_from) out.date_from = f.date_from;
    if (f.date_to) out.date_to = f.date_to;
    for (const { key } of config.multiFilters) if (f[key] && f[key].length) out[key] = f[key];
    return out;
  }

  /** Save the current filters so they survive a reload. */
  function persist() {
    store.set(config.storageKeys.filters, state.filters);
  }

  return { init, applyPreset, apiFilters, persist };
}
