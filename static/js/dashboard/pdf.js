/*
 * "Export PDF": builds a PDF report of what the dashboard currently shows —
 * page title and data range, the active filters, the KPI tiles and every
 * chart panel in grid order (charts as images, table panels as real tables).
 *
 * The PDF is generated entirely in the browser with jsPDF and its AutoTable
 * plugin. Both are loaded from the CDN on the first export only, so they
 * cost nothing for users who never export.
 *
 * Generic: everything model-specific (filter labels and options) comes from
 * the data-model config; titles and data come from the panel controller.
 */
import { $, showBanner } from "./dom.js";

// Pinned versions, loaded lazily (see loadScript).
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

// Page geometry in millimetres (A4 landscape suits the dashboard's wide grid).
const MARGIN = 12;
const GAP = 6;               // space between panels, horizontally and vertically
const CHART_MAX_H = 85;      // tallest a chart image may be drawn
const CHART_SCALE = 3;       // canvas pixel ratio used for crisp chart images

// Print colours (the PDF is always light, whatever the screen theme).
const INK = [11, 11, 11];
const INK_SECONDARY = [82, 81, 78];
const RULE = [225, 224, 217];
const GOOD = [0, 99, 0];
const BAD = [208, 59, 59];

/** Inject a <script> once and resolve when it has loaded. */
const loaded = {};
function loadScript(src) {
  return (loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete loaded[src]; reject(new Error(`Could not load ${src}`)); };
    document.head.append(s);
  }));
}

/**
 * jsPDF's built-in Helvetica only covers Latin-1, so map the few non-Latin-1
 * characters the dashboard uses and drop anything else that would otherwise
 * print as garbage (e.g. the narrow no-break space some locales put in
 * currency amounts).
 */
function pdfText(text) {
  return String(text ?? "")
    .replace(/[   ]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[▲▼]\s*/g, "")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "");
}

/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create the PDF exporter and wire the #export-pdf button.
 *   ctx.state      shared dashboard state (uses .meta, .filters, .panels)
 *   ctx.config     data-model config (multiFilters, pdfFilename)
 *   ctx.panels     panel controller (titleOf, renderForExport, rerenderAll)
 *   ctx.formatValue from createFormatter()
 */
export function createPdfExport({ state, config, panels, formatValue }) {
  const button = $("#export-pdf");

  /** One "Label: value" line per filter, describing what the report covers. */
  function filterSummary() {
    const f = state.filters;
    const lines = [`Period: ${f.date_from || "start"} to ${f.date_to || "end"}`];
    for (const mf of config.multiFilters) {
      const selected = f[mf.key] || [];
      const options = mf.options(state.meta);
      // An empty selection, or every option ticked, means "no restriction".
      const value = !selected.length || selected.length === options.length
        ? "All"
        : options.filter((o) => selected.includes(o.value)).map((o) => o.label).join(", ");
      lines.push(`${mf.label}: ${value}`);
    }
    return lines;
  }

  /** Wait (up to `timeoutMs`) for in-flight KPI/panel requests to finish so the PDF isn't stale. */
  async function waitForIdle(timeoutMs = 10000) {
    const start = Date.now();
    while (document.querySelector(".panel.loading") && Date.now() - start < timeoutMs) await sleep(100);
  }

  /** Read the KPI tiles as rendered (label, value, change text and its direction). */
  function kpiTiles() {
    return [...document.querySelectorAll("#kpis .kpi")].map((tile) => {
      const delta = $(".kpi-delta", tile);
      return {
        label: $(".kpi-label", tile)?.textContent || "",
        value: $(".kpi-value", tile)?.textContent || "",
        delta: delta?.textContent || "",
        trend: $(".up", delta) ? "up" : $(".down", delta) ? "down" : null,
      };
    });
  }

  /** Draw the KPI tiles as a row of outlined boxes starting at `y`; returns the y below them. */
  function drawKpis(doc, tiles, y, contentW) {
    if (!tiles.length) return y;
    const w = (contentW - GAP * (tiles.length - 1)) / tiles.length;
    const h = 20;
    tiles.forEach((t, i) => {
      const x = MARGIN + i * (w + GAP);
      doc.setDrawColor(...RULE);
      doc.roundedRect(x, y, w, h, 2, 2, "S");
      doc.setFontSize(8).setTextColor(...INK_SECONDARY).text(pdfText(t.label), x + 3, y + 5);
      doc.setFontSize(14).setFont("helvetica", "bold").setTextColor(...INK).text(pdfText(t.value), x + 3, y + 12);
      doc.setFont("helvetica", "normal").setFontSize(7)
        .setTextColor(...(t.trend === "up" ? GOOD : t.trend === "down" ? BAD : INK_SECONDARY))
        .text(pdfText(t.delta), x + 3, y + 17, { maxWidth: w - 6 });
    });
    return y + h + GAP;
  }

  /**
   * Lay the panels out like the screen grid: two per row, "wide" panels
   * spanning the full row. Each panel is a title plus either a chart image,
   * an AutoTable, or its message ("No data…", an error).
   */
  function drawPanels(doc, snapshots, startY, pageW, pageH, contentW) {
    const colW = (contentW - GAP) / 2;
    const bottom = pageH - MARGIN;
    let y = startY;
    let col = 0;            // 0 = left column free, 1 = right column free
    let rowBottom = y;      // lowest point drawn in the current row

    const newPage = () => { doc.addPage(); y = MARGIN; rowBottom = y; col = 0; };
    const endRow = () => { if (col) { y = rowBottom + GAP; rowBottom = y; col = 0; } };

    for (const snap of snapshots) {
      // Tables can run for pages, so give them the full width on their own row.
      const full = snap.wide || snap.kind === "table";
      if (full) endRow();
      const w = full ? contentW : colW;

      // Height this panel will need (tables manage their own page breaks).
      const imgH = snap.kind === "chart" ? Math.min(CHART_MAX_H, w * snap.ratio) : 0;
      const needed = 7 + (snap.kind === "chart" ? imgH : snap.kind === "table" ? 25 : 12);
      if (y + needed > bottom) {
        if (col) endRow();
        if (y + needed > bottom) newPage();
      }
      const x = MARGIN + (col ? colW + GAP : 0);

      doc.setFontSize(11).setFont("helvetica", "bold").setTextColor(...INK)
        .text(pdfText(snap.title), x, y + 4, { maxWidth: w });
      doc.setFont("helvetica", "normal");
      let panelBottom = y + 7;

      if (snap.kind === "chart") {
        // Keep the chart's aspect ratio inside the slot.
        const imgW = Math.min(w, imgH / snap.ratio);
        doc.addImage(snap.image, "PNG", x, y + 7, imgW, imgH, undefined, "FAST");
        panelBottom = y + 7 + imgH;
      } else if (snap.kind === "table") {
        doc.autoTable({
          head: [snap.head.map(pdfText)],
          body: snap.body.map((r) => r.map(pdfText)),
          startY: y + 7,
          margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN },
          styles: { fontSize: 8, cellPadding: 1.5, textColor: INK, lineColor: RULE },
          headStyles: { fillColor: [240, 239, 236], textColor: INK_SECONDARY, fontStyle: "bold" },
          // Every column after the first holds numbers: right-align them.
          columnStyles: Object.fromEntries(snap.head.slice(1).map((_, i) => [i + 1, { halign: "right" }])),
          theme: "plain",
        });
        panelBottom = doc.lastAutoTable.finalY;
      } else {
        doc.setFontSize(9).setTextColor(...INK_SECONDARY).text(pdfText(snap.message), x, y + 12, { maxWidth: w });
        panelBottom = y + 14;
      }

      // AutoTable may have continued onto later pages, so a table's end
      // replaces the row bottom rather than being compared with it.
      rowBottom = snap.kind === "table" ? panelBottom : Math.max(rowBottom, panelBottom);
      if (full || col) { y = rowBottom + GAP; rowBottom = y; col = 0; }
      else col = 1;
    }
  }

  /** Stamp "page n of N" in the footer of every page. */
  function drawFooters(doc, pageW, pageH, generated) {
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8).setTextColor(...INK_SECONDARY);
      doc.text(pdfText(generated), MARGIN, pageH - 5);
      doc.text(`Page ${i} of ${pages}`, pageW - MARGIN, pageH - 5, { align: "right" });
    }
  }

  /** Build the PDF from the current dashboard and hand it to the browser as a download. */
  async function exportPdf() {
    await loadScript(JSPDF_URL);
    await loadScript(AUTOTABLE_URL);   // the plugin must load after jsPDF itself
    await waitForIdle();

    // Snapshot every panel in print colours, then put the screen back as it was.
    let snapshots;
    try {
      snapshots = panels.renderForExport(CHART_SCALE);
    } finally {
      panels.rerenderAll();
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const contentW = pageW - 2 * MARGIN;
    const now = new Date();

    // Header: page title, data range and the filters in effect.
    let y = MARGIN + 6;
    doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(...INK).text(pdfText(document.title), MARGIN, y);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...INK_SECONDARY);
    y += 5;
    doc.text(pdfText($("#data-range").textContent), MARGIN, y);
    y += 5;
    const filterLines = doc.splitTextToSize(pdfText(filterSummary().join("   |   ")), contentW);
    doc.text(filterLines, MARGIN, y);
    y += filterLines.length * 4 + 3;
    doc.setDrawColor(...RULE).line(MARGIN, y, pageW - MARGIN, y);
    y += GAP;

    y = drawKpis(doc, kpiTiles(), y, contentW);
    drawPanels(doc, snapshots, y, pageW, pageH, contentW);
    drawFooters(doc, pageW, pageH, `Generated ${now.toLocaleString()}`);

    const stamp = now.toISOString().slice(0, 10);
    doc.save(`${config.pdfFilename || "dashboard"}-${stamp}.pdf`);
  }

  button.addEventListener("click", async () => {
    // Guard against double clicks while a (possibly slow) export runs.
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Exporting…";
    try {
      await exportPdf();
    } catch (err) {
      showBanner(`Could not create the PDF: ${err.message}`);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}
