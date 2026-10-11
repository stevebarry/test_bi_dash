/*
 * Drawing a panel's aggregated data: Chart.js charts (bar, hbar, stacked,
 * line, area, doughnut) and a plain HTML table. Works on the generic
 * /api/aggregate response shape: { labels, datasets, measure, dimension }.
 * Relies on the global `Chart` loaded from the CDN.
 */
import { $, el } from "./dom.js";
import { themeColors } from "./theme.js";

export const SERIES_SLOTS = 8;     // categorical palette size; extra series fold into "Other"
export const OTHER = "Other";      // label the backend uses for the folded series/slice

/**
 * Colour follows the entity: a series keeps its slot across refreshes
 * and new series take the lowest free slot. Slots are remembered in
 * `panel.colorMap`.
 */
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

/**
 * Draw `panel.data` as a Chart.js chart on the panel's canvas; sets `panel.chart`.
 * `overrides` is merged over the top-level chart options (the PDF export
 * uses it to turn animation off and raise the pixel ratio).
 */
export function renderChart(panel, formatValue, overrides = {}) {
  const data = panel.data;
  const colors = themeColors(SERIES_SLOTS);
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
      // Truncate long category labels so they don't crowd the axis.
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
              // Doughnut tooltips also show each slice's share of the total.
              if (isPie) {
                const total = ctx.dataset.data.reduce((a, b) => a + (b || 0), 0);
                if (total) text += ` (${(100 * value / total).toFixed(1)}%)`;
              }
              return text;
            },
          },
        },
      },
      ...overrides,
    },
  });
}

/** Render `panel.data` as an HTML table (one row per label, one column per series) into `wrap`. */
export function renderTable(panel, wrap, formatValue) {
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
