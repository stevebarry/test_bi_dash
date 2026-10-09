/* Sales dashboard front end: filters, KPI tiles and configurable chart panels. */
(() => {
  "use strict";

  const STORAGE_KEY = "dashboard.layout.v1";
  const FILTER_KEY = "dashboard.filters.v1";
  const THEME_KEY = "dashboard.theme";
  const SERIES_SLOTS = 8;     // categorical palette size; extra series fold into "Other"
  const OTHER = "Other";

  const DEFAULT_PANELS = [
    { title: "", dimension: "month", breakdown: "", measure: "revenue", type: "line", limit: 10, wide: true },
    { title: "", dimension: "category", breakdown: "", measure: "revenue", type: "bar", limit: 10 },
    { title: "", dimension: "store_state", breakdown: "", measure: "revenue", type: "hbar", limit: 10 },
    { title: "Top 10 products by units", dimension: "product", breakdown: "", measure: "units", type: "hbar", limit: 10 },
    { title: "", dimension: "store_state", breakdown: "category", measure: "revenue", type: "stacked", limit: 10 },
    { title: "", dimension: "status", breakdown: "", measure: "orders", type: "doughnut", limit: 10 },
  ];

  const state = {
    meta: null,
    filters: {},
    panels: [],
    nextId: 1,
  };

  // ---------- storage (best effort; the page works without it) ----------
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  };
  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const fmt = {
    currency: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }),
    currency2: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    currencyCompact: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }),
    integer: new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    compact: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    decimal: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }),
    pct: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }),
  };

  function formatValue(value, format, compact = false) {
    if (value === null || value === undefined || Number.isNaN(value)) return "–";
    if (format === "currency") {
      if (compact) return fmt.currencyCompact.format(value);
      return Math.abs(value) < 1000 ? fmt.currency2.format(value) : fmt.currency.format(value);
    }
    if (format === "integer") return compact ? fmt.compact.format(value) : fmt.integer.format(value);
    return compact ? fmt.compact.format(value) : fmt.decimal.format(value);
  }

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* non-JSON error */ }
    if (!res.ok) {
      const err = new Error((payload && payload.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  function showBanner(message) {
    const banner = $("#banner");
    banner.textContent = message || "";
    banner.hidden = !message;
  }

  const dimByKey = (key) => state.meta.dimensions.find((d) => d.key === key);
  const measureByKey = (key) => state.meta.measures.find((m) => m.key === key);

  // ---------- theme ----------
  function initTheme() {
    $("#theme-toggle").addEventListener("click", () => {
      const current = document.documentElement.dataset.theme
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      rerenderAll();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderAll);
  }

  function themeColors() {
    const series = [];
    for (let i = 1; i <= SERIES_SLOTS; i++) series.push(css(`--series-${i}`));
    return {
      series,
      other: css("--other"),
      surface: css("--surface-1"),
      text: css("--text-primary"),
      textSecondary: css("--text-secondary"),
      muted: css("--text-muted"),
      grid: css("--grid"),
      axis: css("--axis"),
    };
  }

  // ---------- filters ----------
  const MULTI_OPTIONS = {
    statuses: () => state.meta.options.statuses.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
    categories: () => state.meta.options.categories.map((c) => ({ value: c, label: c })),
    store_states: () => state.meta.options.store_states.map((s) => ({ value: s, label: s })),
    customer_states: () => state.meta.options.customer_states.map((s) => ({ value: s, label: s })),
  };

  function defaultFilters() {
    return {
      preset: "all",
      date_from: state.meta.options.date_min || "",
      date_to: state.meta.options.date_max || "",
      statuses: state.meta.options.statuses.filter((s) => s !== "cancelled"),
      categories: [],
      store_states: [],
      customer_states: [],
    };
  }

  function buildMultiSelect(container) {
    const key = container.dataset.multi;
    const label = container.dataset.label;
    container.innerHTML = "";
    const details = el("details", { class: "multi" });
    const summary = el("summary", { "aria-label": `${label} filter` });
    const menu = el("div", { class: "multi-menu" });
    const tools = el("div", { class: "multi-tools" },
      el("button", { type: "button", class: "link-btn", text: "Select all" }));
    menu.append(tools);

    for (const opt of MULTI_OPTIONS[key]()) {
      const box = el("input", { type: "checkbox", value: opt.value });
      menu.append(el("label", {}, box, opt.label));
    }
    details.append(summary, menu);
    container.append(el("label", { text: label }), details);

    const sync = () => {
      const selected = new Set(state.filters[key]);
      // An empty selection means "no filter", shown as everything ticked.
      menu.querySelectorAll("input").forEach((b) => { b.checked = selected.size === 0 || selected.has(b.value); });
      const total = MULTI_OPTIONS[key]().length;
      summary.textContent = selected.size === 0 || selected.size === total
        ? `All`
        : selected.size === 1 ? [...selected][0] : `${selected.size} selected`;
    };
    container._sync = sync;

    menu.addEventListener("change", () => {
      const all = [...menu.querySelectorAll("input")];
      const checked = all.filter((b) => b.checked).map((b) => b.value);
      // Everything ticked is the same as no filter.
      state.filters[key] = checked.length === all.length ? [] : checked;
      sync();
      onFiltersChanged();
    });
    tools.addEventListener("click", (e) => {
      if (!e.target.closest("button")) return;
      state.filters[key] = [];   // no filter = everything
      sync();
      onFiltersChanged();
    });
    sync();
  }

  function initFilters() {
    const saved = store.get(FILTER_KEY);
    state.filters = { ...defaultFilters(), ...(saved || {}) };

    document.querySelectorAll("[data-multi]").forEach(buildMultiSelect);

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
      onFiltersChanged();
    });
    for (const [input, key] of [[from, "date_from"], [to, "date_to"]]) {
      input.addEventListener("change", () => {
        state.filters[key] = input.value;
        state.filters.preset = "custom";
        preset.value = "custom";
        onFiltersChanged();
      });
    }
    $("#clear-filters").addEventListener("click", () => {
      state.filters = defaultFilters();
      syncFilterControls();
      onFiltersChanged();
    });
    syncFilterControls();
  }

  function applyPreset(value) {
    const { date_min, date_max } = state.meta.options;
    state.filters.preset = value;
    if (!date_max || value === "custom") return syncFilterControls();
    // Presets are anchored on the latest order in the data, not today.
    const end = new Date(date_max + "T00:00:00");
    let start;
    if (value === "all") start = new Date(date_min + "T00:00:00");
    else if (value === "ytd") start = new Date(end.getFullYear(), 0, 1);
    else start = new Date(end.getTime() - (Number(value) - 1) * 86400000);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    state.filters.date_from = iso(start);
    state.filters.date_to = iso(end);
    syncFilterControls();
  }

  function syncFilterControls() {
    $("#preset").value = state.filters.preset || "custom";
    $("#date-from").value = state.filters.date_from || "";
    $("#date-to").value = state.filters.date_to || "";
    document.querySelectorAll("[data-multi]").forEach((c) => c._sync && c._sync());
  }

  function apiFilters() {
    const f = state.filters;
    const out = {};
    if (f.date_from) out.date_from = f.date_from;
    if (f.date_to) out.date_to = f.date_to;
    for (const key of Object.keys(MULTI_OPTIONS)) if (f[key] && f[key].length) out[key] = f[key];
    return out;
  }

  const onFiltersChanged = debounce(() => {
    store.set(FILTER_KEY, state.filters);
    loadKpis();
    state.panels.forEach(loadPanel);
  }, 250);

  // ---------- KPI tiles ----------
  const KPI_ORDER = ["revenue", "orders", "units", "aov", "customers"];

  async function loadKpis() {
    const box = $("#kpis");
    try {
      const data = await api("/api/kpis", { filters: apiFilters() });
      showBanner("");
      box.innerHTML = "";
      for (const key of KPI_ORDER) {
        const m = data.measures.find((x) => x.key === key);
        const cur = data.current[key];
        const prev = data.previous ? data.previous[key] : null;
        const delta = el("div", { class: "kpi-delta" });
        if (prev) {
          const change = (cur - prev) / prev;
          const up = change >= 0;
          delta.append(
            el("span", { class: up ? "up" : "down", text: `${up ? "▲" : "▼"} ${fmt.pct.format(change)}` }),
            ` vs previous period`);
          delta.title = `Previous period ${data.previous_period.from} to ${data.previous_period.to}: ${formatValue(prev, m.format)}`;
        } else {
          delta.textContent = "No prior-period data";
        }
        box.append(el("div", { class: "kpi" },
          el("div", { class: "kpi-label", text: m.label }),
          el("div", { class: "kpi-value", text: formatValue(cur, m.format) }),
          delta));
      }
    } catch (err) {
      if (err.status === 503) showBanner(err.message);
      box.innerHTML = "";
    }
  }

  // ---------- panels ----------
  function persistPanels() {
    store.set(STORAGE_KEY, state.panels.map(({ title, dimension, breakdown, measure, type, limit, wide }) =>
      ({ title, dimension, breakdown, measure, type, limit, wide })));
  }

  function autoTitle(p) {
    const m = measureByKey(p.measure), d = dimByKey(p.dimension), b = p.breakdown && dimByKey(p.breakdown);
    if (!m || !d) return "Chart";
    return `${m.label} by ${d.label.toLowerCase()}${b ? ` and ${b.label.toLowerCase()}` : ""}`;
  }

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

  function addPanel(config, { render = true, after = null } = {}) {
    const panel = {
      title: "", breakdown: "", limit: 10, wide: false, type: "bar", measure: "revenue",
      ...config,
      id: state.nextId++, chart: null, seq: 0, colorMap: {},
    };
    if (!dimByKey(panel.dimension)) panel.dimension = "category";
    if (panel.breakdown && !dimByKey(panel.breakdown)) panel.breakdown = "";
    if (!measureByKey(panel.measure)) panel.measure = "revenue";

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
        if (field === "dimension" && panel.breakdown === panel.dimension) {
          panel.breakdown = "";
          selects.breakdown.value = "";
        }
        if (field === "breakdown" && panel.breakdown === panel.dimension) {
          panel.breakdown = "";
          select.value = "";
        }
        if (field !== "type") panel.colorMap = {};
        syncPanelChrome(panel);
        persistPanels();
        if (field === "type" && panel.data && !needsRefetch(panel)) renderPanel(panel);
        else loadPanel(panel);
      });
    }

    const title = $(".panel-title", node);
    title.addEventListener("input", () => { panel.title = title.value.trim(); persistPanels(); });
    title.addEventListener("blur", () => syncPanelChrome(panel));

    node.querySelector(".panel-actions").addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "remove") {
        panel.chart?.destroy();
        node.remove();
        state.panels = state.panels.filter((p) => p !== panel);
        persistPanels();
      } else if (action === "duplicate") {
        const { title: t, dimension, breakdown, measure, type, limit, wide } = panel;
        addPanel({ dimension, breakdown, measure, type, limit, wide, title: t ? `${t} (copy)` : "" }, { after: panel });
        persistPanels();
      } else if (action === "wide") {
        panel.wide = !panel.wide;
        node.classList.toggle("wide", panel.wide);
        persistPanels();
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
    syncPanelChrome(panel);
    if (render) loadPanel(panel);
    return panel;
  }

  function syncPanelChrome(panel) {
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

  // Doughnuts need every slice accounted for, and their slices are colour-coded,
  // so cap them to the palette with an "Other" slice.
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

  function setMessage(panel, text) {
    const msg = $(".panel-message", panel.el);
    msg.textContent = text || "";
    msg.hidden = !text;
  }

  async function loadPanel(panel) {
    const spec = panelSpec(panel);
    const seq = ++panel.seq;
    panel.el.classList.add("loading");
    syncPanelChrome(panel);
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

  // Colour follows the entity: a series keeps its slot across refreshes
  // and new series take the lowest free slot.
  function colorFor(panel, name, visible, colors) {
    if (name === OTHER) return colors.other;
    const map = panel.colorMap;
    if (!(name in map)) {
      const taken = new Set(visible.filter((n) => n in map && n !== name).map((n) => map[n]));
      let slot = 0;
      while (taken.has(slot) && slot < SERIES_SLOTS) slot++;
      map[name] = slot;
    }
    return colors.series[map[name] % SERIES_SLOTS];
  }

  function renderPanel(panel) {
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
    if (asTable) return renderTable(panel, tableWrap);

    const colors = themeColors();
    const format = data.measure.format;
    const type = panel.type;
    const multi = data.datasets.length > 1;
    const isPie = type === "doughnut";
    const horizontal = type === "hbar";
    const stacked = type === "stacked";
    const lineLike = type === "line" || type === "area";
    const seriesNames = isPie ? data.labels : data.datasets.map((d) => d.label);

    const datasets = data.datasets.map((ds) => {
      if (isPie) {
        const sliceColors = data.labels.map((l) => colorFor(panel, l, seriesNames, colors));
        return { ...ds, backgroundColor: sliceColors, borderColor: colors.surface, borderWidth: 2, hoverOffset: 4 };
      }
      const color = colorFor(panel, ds.label, seriesNames, colors);
      if (lineLike) {
        return {
          ...ds,
          borderColor: color,
          backgroundColor: type === "area" ? color + (multi ? "33" : "40") : color,
          fill: type === "area" ? (multi ? "stack" : "origin") : false,
          borderWidth: 2,
          pointRadius: data.labels.length > 40 ? 0 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: colors.surface,
          pointBorderWidth: 2,
          tension: 0.25,
          spanGaps: true,
        };
      }
      return {
        ...ds,
        backgroundColor: color,
        borderColor: colors.surface,
        borderWidth: stacked ? { top: 2 } : 0,   // 2px surface gap between stacked segments
        borderRadius: stacked ? 0 : 4,
        borderSkipped: "start",
        maxBarThickness: 48,
      };
    });

    const valueAxis = {
      beginAtZero: true,
      stacked: stacked || (type === "area" && multi),
      grid: { color: colors.grid, drawTicks: false },
      border: { display: false },
      ticks: { color: colors.muted, padding: 6, callback: (v) => formatValue(v, format, true) },
    };
    const categoryAxis = {
      stacked: stacked || (type === "area" && multi),
      grid: { display: false },
      border: { color: colors.axis },
      ticks: {
        color: colors.muted,
        autoSkip: true,
        maxRotation: 0,
        callback: function (v) {
          const label = this.getLabelForValue(v);
          return label.length > 22 ? label.slice(0, 21) + "…" : label;
        },
      },
    };

    panel.chart = new Chart($("canvas", panel.el), {
      type: isPie ? "doughnut" : lineLike ? "line" : "bar",
      data: { labels: data.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        indexAxis: horizontal ? "y" : "x",
        interaction: lineLike ? { mode: "index", intersect: false } : { mode: multi ? "index" : "nearest", intersect: !multi },
        cutout: isPie ? "62%" : undefined,
        scales: isPie ? {} : horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
        plugins: {
          legend: {
            display: multi || isPie,
            position: isPie ? "right" : "top",
            align: "start",
            labels: { color: colors.textSecondary, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
          },
          tooltip: {
            backgroundColor: colors.surface,
            titleColor: colors.text,
            bodyColor: colors.textSecondary,
            borderColor: colors.axis,
            borderWidth: 1,
            padding: 10,
            boxPadding: 4,
            usePointStyle: true,
            callbacks: {
              label: (ctx) => {
                const value = isPie ? ctx.parsed : (horizontal ? ctx.parsed.x : ctx.parsed.y);
                let text = `${isPie ? ctx.label : ctx.dataset.label}: ${formatValue(value, format)}`;
                if (isPie) {
                  const total = ctx.dataset.data.reduce((a, b) => a + (b || 0), 0);
                  if (total) text += ` (${(100 * value / total).toFixed(1)}%)`;
                }
                return text;
              },
            },
          },
        },
      },
    });
  }

  function renderTable(panel, wrap) {
    const { labels, datasets, measure, dimension } = panel.data;
    const table = el("table", { class: "data-table" });
    const head = el("tr", {}, el("th", { text: dimension.label }));
    datasets.forEach((d) => head.append(el("th", { class: "num", text: d.label })));
    table.append(el("thead", {}, head));
    const body = el("tbody");
    labels.forEach((label, i) => {
      const row = el("tr", {}, el("td", { text: label }));
      datasets.forEach((d) => row.append(el("td", { class: "num", text: formatValue(d.data[i], measure.format) })));
      body.append(row);
    });
    table.append(body);
    wrap.innerHTML = "";
    wrap.append(table);
  }

  function rerenderAll() {
    // Defer one frame so the new theme's CSS variables are in effect.
    requestAnimationFrame(() => state.panels.forEach(renderPanel));
  }

  function initPanels() {
    const saved = store.get(STORAGE_KEY);
    const configs = Array.isArray(saved) && saved.length ? saved : DEFAULT_PANELS;
    configs.forEach((c) => addPanel(c));

    $("#add-chart").addEventListener("click", () => {
      const p = addPanel({ dimension: "category", measure: "revenue", type: "bar", limit: 10 });
      persistPanels();
      p.el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("#reset-layout").addEventListener("click", () => {
      state.panels.forEach((p) => p.chart?.destroy());
      state.panels = [];
      $("#grid").innerHTML = "";
      store.remove(STORAGE_KEY);
      DEFAULT_PANELS.forEach((c) => addPanel(c));
    });
  }

  // ---------- boot ----------
  async function init() {
    initTheme();
    try {
      state.meta = await api("/api/meta");
    } catch (err) {
      showBanner(`Could not load dashboard metadata: ${err.message}`);
      $("#data-range").textContent = "";
      return;
    }
    const { date_min, date_max } = state.meta.options;
    $("#data-range").textContent = date_min
      ? `Orders from ${date_min} to ${date_max}`
      : "No orders in the database yet";

    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;

    initFilters();
    if (state.filters.preset && state.filters.preset !== "custom") applyPreset(state.filters.preset);
    loadKpis();
    initPanels();
  }

  init();
})();
