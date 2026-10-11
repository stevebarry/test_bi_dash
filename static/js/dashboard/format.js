/*
 * Number formatting for measure values. Measures declare a `format`
 * ("currency", "integer" or anything else for plain decimals) in /api/meta;
 * the currency code comes from the data-model config.
 */

/**
 * Build formatters for a given ISO currency code.
 * Returns { formatValue(value, format, compact), pct } where `pct` is an
 * Intl.NumberFormat for signed percentage changes.
 */
export function createFormatter({ currency }) {
  const fmt = {
    currency: new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }),
    currency2: new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    currencyCompact: new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }),
    integer: new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    compact: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    decimal: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }),
    pct: new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }),
  };

  /** Format `value` per the measure's `format`; `compact` is for axis ticks. */
  function formatValue(value, format, compact = false) {
    if (value === null || value === undefined || Number.isNaN(value)) return "–";
    if (format === "currency") {
      if (compact) return fmt.currencyCompact.format(value);
      // Show cents only for small amounts, where they matter.
      return Math.abs(value) < 1000 ? fmt.currency2.format(value) : fmt.currency.format(value);
    }
    if (format === "integer") return compact ? fmt.compact.format(value) : fmt.integer.format(value);
    return compact ? fmt.compact.format(value) : fmt.decimal.format(value);
  }

  return { formatValue, pct: fmt.pct };
}
