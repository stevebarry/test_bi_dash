/*
 * The chart-panel grid: creating panels from #panel-template, their query
 * controls and actions (duplicate, remove, wide, CSV), fetching data from
 * /api/aggregate, persisting the layout and snapshotting panels for the PDF
 * export.
 *
 * Generic: dimensions and measures are whatever /api/meta lists; the default
 * layout and the settings for a new panel come from the data-model config.
 */
import { $, el, showBanner } from "./dom.js";
import { api } from "./api.js";
import { store } from "./storage.js";
import { SERIES_SLOTS, renderChart, renderTable } from "./charts.js";

// The panel settings that are saved/duplicated (everything else is runtime state).
const SAVED_FIELDS = ["title", "dimension", "breakdown", "measure", "type", "limit", "wide"];
const pick = (panel) => Object.fromEntries(SAVED_FIELDS.map((k) => [k, panel[k]]));

/**
 * Create the panel controller.
 *   ctx.state        shared state (uses .meta, .panels, .nextId)
 *   ctx.config       data-model config (defaultPanels, newPanel, storageKeys)
 *   ctx.apiFilters   returns the current API-shaped filters
 *   ctx.formatValue  from createFormatter()
 */
export function createPanels({ state, config, apiFilters, formatValue }) {
  const dimByKey = (key) => state.meta.dimensions.find((d) => d.key === key);
  const measureByKey = (key) => state.meta.measures.find((m) => m.key === key);

  function persist() {
    store.set(config.storageKeys.layout, state.panels.map(pick));
  }

  /** Title used when the user hasn't typed one, e.g. "Revenue by month and category". */
  function autoTitle(p) {
    const m = measureByKey(p.measure), d = dimByKey(p.dimension), b = p.breakdown && dimByKey(p.breakdown);
    if (!m || !d) return "Chart";
    return `${m.label} by ${d.label.toLowerCase()}${b ? ` and ${b.label.toLowerCase()}` : ""}`;
  }

  /** Fill a <select> with all dimensions, grouped by their `group` into <optgroup>s. */
  function fillDimensionSelect(select, includeNone) {
    select.innerHTML = "";
    if (includeNone) select.append(el("option", { value: "", text: "None" }));
    const groups = {};
    for (const d of state.meta.dimensions) (groups[d.group] ||= []).push(d);
    for (const [group, dims] of Object.entries(groups)) {
      const og = el("optgroup", { label: group });
      dims.forEach((d) => og.append(el("option", { value: d.key, text: d.label })));
      select.append(og);
    }
  }

  /**
   * Create a panel from saved settings and add it to the grid (or right after
   * `after`). Unknown dimension/measure keys (e.g. from an old saved layout)
   * fall back to the config's new-panel defaults.
   */
  function addPanel(settings, { render = true, after = null } = {}) {
    const panel = {
      title: "", breakdown: "", limit: 10, wide: false,
      ...config.newPanel,
      ...settings,
      id: state.nextId++, chart: null, seq: 0, colorMap: {},
    };
    if (!dimByKey(panel.dimension)) panel.dimension = config.newPanel.dimension;
    if (panel.breakdown && !dimByKey(panel.breakdown)) panel.breakdown = "";
    if (!measureByKey(panel.measure)) panel.measure = config.newPanel.measure;

    const node = $("#panel-template").content.firstElementChild.cloneNode(true);
    panel.el = node;
    const selects = {
      dimension: $('[data-field="dimension"]', node),
      breakdown: $('[data-field="breakdown"]', node),
      measure: $('[data-field="measure"]', node),
      type: $('[data-field="type"]', node),
      limit: $('[data-field="limit"]', node),
    };
    fillDimensionSelect(selects.dimension, false);
    fillDimensionSelect(selects.breakdown, true);
    state.meta.measures.forEach((m) => selects.measure.append(el("option", { value: m.key, text: m.label })));
    for (const [field, select] of Object.entries(selects)) {
      select.value = String(panel[field]);
      select.addEventListener("change", () => {
        panel[field] = field === "limit" ? Number(select.value) : select.value;
        // Grouping and breakdown by the same dimension is meaningless; drop the breakdown.
        if (field === "dimension" && panel.breakdown === panel.dimension) {
          panel.breakdown = "";
          selects.breakdown.value = "";
        }
        if (field === "breakdown" && panel.breakdown === panel.dimension) {
          panel.breakdown = "";
          select.value = "";
        }
        // New series set: let colours be reassigned from scratch.
        if (field !== "type") panel.colorMap = {};
        syncChrome(panel);
        persist();
        // Switching chart type alone can reuse the fetched data.
        if (field === "type" && panel.data && !needsRefetch(panel)) renderPanel(panel);
        else loadPanel(panel);
      });
    }

    const title = $(".panel-title", node);
    title.addEventListener("input", () => { panel.title = title.value.trim(); persist(); });
    title.addEventListener("blur", () => syncChrome(panel));

    node.querySelector(".panel-actions").addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "remove") {
        panel.chart?.destroy();
        node.remove();
        state.panels = state.panels.filter((p) => p !== panel);
        persist();
      } else if (action === "duplicate") {
        const copy = pick(panel);
        copy.title = panel.title ? `${panel.title} (copy)` : "";
        addPanel(copy, { after: panel });
        persist();
      } else if (action === "wide") {
        panel.wide = !panel.wide;
        node.classList.toggle("wide", panel.wide);
        persist();
        panel.chart?.resize();
      }
    });

    if (after) {
      after.el.after(node);
      state.panels.splice(state.panels.indexOf(after) + 1, 0, panel);
    } else {
      $("#grid").append(node);
      state.panels.push(panel);
    }
    syncChrome(panel);
    if (render) loadPanel(panel);
    return panel;
  }

  /** Update the panel's title, width, Top-N state and CSV link from its settings. */
  function syncChrome(panel) {
    const node = panel.el;
    node.classList.toggle("wide", !!panel.wide);
    const title = $(".panel-title", node);
    if (document.activeElement !== title) title.value = panel.title || autoTitle(panel);
    title.placeholder = autoTitle(panel);
    // "Top N" is meaningless for a time axis.
    const isTime = dimByKey(panel.dimension)?.kind === "time";
    $('[data-field="limit"]', node).disabled = isTime;
    $('[data-field="limit"]', node).title = isTime ? "Time is shown in full" : "";
    $('[data-action="csv"]', node).href = "/api/aggregate.csv?spec=" + encodeURIComponent(JSON.stringify(panelSpec(panel)));
  }

  /**
   * The /api/aggregate request for a panel.
   * Doughnuts need every slice accounted for, and their slices are colour-coded,
   * so cap them to the palette with an "Other" slice.
   */
  function panelSpec(panel) {
    const isPie = panel.type === "doughnut";
    return {
      dimension: panel.dimension,
      breakdown: isPie ? null : (panel.breakdown || null),
      measure: panel.measure,
      limit: isPie ? Math.min(panel.limit, SERIES_SLOTS - 1) : panel.limit,
      series_limit: SERIES_SLOTS - 1,
      include_other: isPie,
      filters: apiFilters(),
    };
  }

  function needsRefetch(panel) {
    return JSON.stringify(panelSpec(panel)) !== panel.fetchedSpec;
  }

  /** Show `text` in the panel's message area, or hide it when empty. */
  function setMessage(panel, text) {
    const msg = $(".panel-message", panel.el);
    msg.textContent = text || "";
    msg.hidden = !text;
  }

  /** Fetch the panel's data and render it, ignoring responses that a newer request superseded. */
  async function loadPanel(panel) {
    const spec = panelSpec(panel);
    const seq = ++panel.seq;
    panel.el.classList.add("loading");
    syncChrome(panel);
    try {
      const data = await api("/api/aggregate", spec);
      if (seq !== panel.seq) return;   // a newer request superseded this one
      panel.data = data;
      panel.fetchedSpec = JSON.stringify(spec);
      renderPanel(panel);
    } catch (err) {
      if (seq !== panel.seq) return;
      panel.chart?.destroy();
      panel.chart = null;
      $(".table-wrap", panel.el).hidden = true;
      setMessage(panel, err.message);
      if (err.status === 503) showBanner(err.message);
    } finally {
      if (seq === panel.seq) panel.el.classList.remove("loading");
    }
  }

  /**
   * Redraw already-fetched data as a chart, a table or a "no data" message.
   * `chartOverrides` is passed through to renderChart (used by the PDF export).
   */
  function renderPanel(panel, chartOverrides) {
    const data = panel.data;
    if (!data) return;
    const chartWrap = $(".chart-wrap", panel.el);
    const tableWrap = $(".table-wrap", panel.el);
    panel.chart?.destroy();
    panel.chart = null;

    const empty = !data.labels.length;
    setMessage(panel, empty ? "No data for the selected filters." : "");
    const asTable = panel.type === "table";
    chartWrap.hidden = asTable;
    tableWrap.hidden = !asTable || empty;
    if (empty) return;
    if (asTable) return renderTable(panel, tableWrap, formatValue);
    renderChart(panel, formatValue, chartOverrides);
  }

  /** Re-fetch every panel (e.g. after a filter change). */
  function reloadAll() {
    state.panels.forEach(loadPanel);
  }

  /** Redraw every panel from cached data (e.g. after a theme change). */
  function rerenderAll() {
    // Defer one frame so the new theme's CSS variables are in effect.
    requestAnimationFrame(() => state.panels.forEach((p) => renderPanel(p)));
  }

  /** The title a panel displays: the user's, or the auto-generated one. */
  function titleOf(panel) {
    return panel.title || autoTitle(panel);
  }

  /**
   * Snapshot every panel for the PDF export, in grid order. Charts are
   * redrawn in the light theme at `scale`× pixel density with animation off,
   * so the image is complete and crisp. Returns one entry per panel:
   *   { kind: "chart", title, wide, image (PNG data URL), ratio (h / w) }
   *   { kind: "table", title, wide, head, body }   (formatted strings)
   *   { kind: "message", title, wide, message }    (no data, error, still loading)
   * Leaves the charts in print form: call rerenderAll() afterwards.
   */
  function renderForExport(scale) {
    const root = document.documentElement;
    const savedTheme = root.dataset.theme;
    root.dataset.theme = "light";   // charts read their colours from the CSS variables
    try {
      return state.panels.map((panel) => {
        const base = { title: titleOf(panel), wide: !!panel.wide };
        const msg = $(".panel-message", panel.el);
        if (!panel.data || !msg.hidden) {
          return { ...base, kind: "message", message: msg.hidden ? "Loading…" : msg.textContent };
        }
        const { labels, datasets, measure, dimension } = panel.data;
        if (panel.type === "table") {
          return {
            ...base,
            kind: "table",
            head: [dimension.label, ...datasets.map((d) => d.label)],
            body: labels.map((label, i) => [label, ...datasets.map((d) => formatValue(d.data[i], measure.format))]),
          };
        }
        // Animation must be off when the chart is *created*: an animated chart
        // only paints on later animation frames, so capturing it straight away
        // gives a blank image. Without animation Chart.js draws synchronously.
        renderPanel(panel, { animation: false, devicePixelRatio: scale });
        const chart = panel.chart;
        chart.draw();   // make sure the canvas is painted before reading it
        return { ...base, kind: "chart", image: chart.toBase64Image("image/png"), ratio: chart.canvas.height / chart.canvas.width };
      });
    } finally {
      if (savedTheme) root.dataset.theme = savedTheme;
      else delete root.dataset.theme;
    }
  }

  /** Restore the saved layout (or the config default) and wire Add chart / Reset layout. */
  function init() {
    const saved = store.get(config.storageKeys.layout);
    const layout = Array.isArray(saved) && saved.length ? saved : config.defaultPanels;
    layout.forEach((s) => addPanel(s));

    $("#add-chart").addEventListener("click", () => {
      const p = addPanel({ ...config.newPanel });
      persist();
      p.el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("#reset-layout").addEventListener("click", () => {
      state.panels.forEach((p) => p.chart?.destroy());
      state.panels = [];
      $("#grid").innerHTML = "";
      store.remove(config.storageKeys.layout);
      config.defaultPanels.forEach((s) => addPanel(s));
    });
  }

  return { init, reloadAll, rerenderAll, titleOf, renderForExport };
}
