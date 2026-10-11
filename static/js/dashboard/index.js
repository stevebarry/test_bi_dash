/*
 * Generic dashboard framework entry point.
 *
 * createDashboard(config) boots the page: theme, metadata from /api/meta,
 * filters, KPI tiles and the chart-panel grid. Nothing under
 * static/js/dashboard/ knows about any particular data model; everything
 * model-specific is supplied through `config` (see static/js/sales/config.js
 * for the fields and an example).
 */
import { $, debounce, showBanner } from "./dom.js";
import { api } from "./api.js";
import { createFormatter } from "./format.js";
import { initTheme } from "./theme.js";
import { createFilters } from "./filters.js";
import { loadKpis } from "./kpis.js";
import { createPanels } from "./panels.js";
import { createPdfExport } from "./pdf.js";

export async function createDashboard(config) {
  // Shared mutable state, passed to each controller.
  const state = {
    meta: null,     // /api/meta response: dimensions, measures, options
    filters: {},    // current filter values (UI shape)
    panels: [],     // live panel objects, in grid order
    nextId: 1,
  };
  const { formatValue, pct } = createFormatter({ currency: config.currency });

  // The theme toggle works even if metadata fails to load; it redraws
  // panels only once they exist.
  let panels = null;
  initTheme(() => panels?.rerenderAll());

  try {
    state.meta = await api("/api/meta");
  } catch (err) {
    showBanner(`Could not load dashboard metadata: ${err.message}`);
    $("#data-range").textContent = "";
    return;
  }
  $("#data-range").textContent = config.dataRangeText(state.meta);

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;

  const refreshKpis = () => loadKpis({ keys: config.kpis, filters: filters.apiFilters(), formatValue, pct });

  // Any filter edit: save, then recompute KPIs and every panel (debounced
  // so rapid clicks in a multi-select cause one round of requests).
  const onFiltersChanged = debounce(() => {
    filters.persist();
    refreshKpis();
    panels.reloadAll();
  }, 250);

  const filters = createFilters({ state, config, onChange: onFiltersChanged });
  panels = createPanels({ state, config, apiFilters: filters.apiFilters, formatValue });

  createPdfExport({ state, config, panels, formatValue });

  filters.init();
  // Re-anchor a saved relative preset (e.g. "last 30 days") on the current data.
  if (state.filters.preset && state.filters.preset !== "custom") filters.applyPreset(state.filters.preset);
  refreshKpis();
  panels.init();
}
