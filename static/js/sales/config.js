/*
 * Sales data-model configuration for the generic dashboard framework.
 *
 * Everything the front end knows about the sales schema lives here: which
 * dimension/measure keys exist (as defined by queries.py and served from
 * /api/meta), the default layout, which filters to show and their defaults.
 * To point the framework at a different data model, write another config
 * object with the same fields and pass it to createDashboard().
 */

/** Capitalise the first letter, for display of lowercase codes like "shipped". */
const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

export const salesConfig = {
  /** ISO currency code used for measures whose format is "currency". */
  currency: "USD",

  /** localStorage keys for the saved panel layout and filters. Bump the
   *  version suffix if the saved shape changes incompatibly. */
  storageKeys: {
    layout: "dashboard.layout.v1",
    filters: "dashboard.filters.v1",
  },

  /** Base name of the exported PDF; the export date is appended. */
  pdfFilename: "sales-dashboard",

  /** Subtitle under the page title, describing the data loaded. */
  dataRangeText(meta) {
    const { date_min, date_max } = meta.options;
    return date_min ? `Orders from ${date_min} to ${date_max}` : "No orders in the database yet";
  },

  /** Measure keys shown as KPI tiles, in order. */
  kpis: ["revenue", "orders", "units", "aov", "customers"],

  /**
   * Multi-select filters, in display order.
   *   key      filter key sent to the API (and saved in storage)
   *   label    visible label
   *   options  meta => [{ value, label }] — the choices, from /api/meta
   */
  multiFilters: [
    { key: "statuses", label: "Status",
      options: (meta) => meta.options.statuses.map((s) => ({ value: s, label: capitalise(s) })) },
    { key: "categories", label: "Category",
      options: (meta) => meta.options.categories.map((c) => ({ value: c, label: c })) },
    { key: "store_states", label: "Store state",
      options: (meta) => meta.options.store_states.map((s) => ({ value: s, label: s })) },
    { key: "customer_states", label: "Customer state",
      options: (meta) => meta.options.customer_states.map((s) => ({ value: s, label: s })) },
  ],

  /** Non-empty filter defaults (merged over "everything selected"). Also used by "Clear filters". */
  defaultFilterValues(meta) {
    // Cancelled orders are excluded unless the user asks for them.
    return { statuses: meta.options.statuses.filter((s) => s !== "cancelled") };
  },

  /** Settings for a panel created with "+ Add chart"; also the fallback for unknown keys. */
  newPanel: { dimension: "category", measure: "revenue", type: "bar", limit: 10 },

  /** The panels shown on first visit and after "Reset layout". An empty title means auto-title. */
  defaultPanels: [
    { title: "", dimension: "month", breakdown: "", measure: "revenue", type: "line", limit: 10, wide: true },
    { title: "", dimension: "category", breakdown: "", measure: "revenue", type: "bar", limit: 10 },
    { title: "", dimension: "store_state", breakdown: "", measure: "revenue", type: "hbar", limit: 10 },
    { title: "Top 10 products by units", dimension: "product", breakdown: "", measure: "units", type: "hbar", limit: 10 },
    { title: "", dimension: "store_state", breakdown: "category", measure: "revenue", type: "stacked", limit: 10 },
    { title: "", dimension: "status", breakdown: "", measure: "orders", type: "doughnut", limit: 10 },
  ],
};
