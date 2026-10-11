/*
 * Headline KPI tiles: one per measure key in `config.kpis`, each showing the
 * current value and the change versus the preceding period of equal length
 * (both computed server-side by /api/kpis).
 */
import { $, el, showBanner } from "./dom.js";
import { api } from "./api.js";

/**
 * Fetch and render the KPI tiles into #kpis.
 *   keys         measure keys to show, in order
 *   filters      API-shaped filter object
 *   formatValue  / pct  from createFormatter()
 */
export async function loadKpis({ keys, filters, formatValue, pct }) {
  const box = $("#kpis");
  try {
    const data = await api("/api/kpis", { filters });
    showBanner("");
    box.innerHTML = "";
    for (const key of keys) {
      const m = data.measures.find((x) => x.key === key);
      if (!m) continue;   // configured KPI the backend doesn't know about
      const cur = data.current[key];
      const prev = data.previous ? data.previous[key] : null;
      const delta = el("div", { class: "kpi-delta" });
      if (prev) {
        const change = (cur - prev) / prev;
        const up = change >= 0;
        delta.append(
          el("span", { class: up ? "up" : "down", text: `${up ? "▲" : "▼"} ${pct.format(change)}` }),
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
