"""Whitelisted SQL builder for dashboard aggregations.

The browser describes a chart as a spec, e.g.::

    {"dimension": "category", "breakdown": "store_state", "measure": "revenue",
     "limit": 10, "series_limit": 6, "include_other": false,
     "filters": {"date_from": "2025-01-01", "categories": ["Toys"]}}

Only registry keys are ever interpolated into SQL text; every user-supplied
value is passed as a bound parameter.
"""

from dataclasses import dataclass
from datetime import date

ORDER_STATUSES = ("pending", "shipped", "delivered", "cancelled")

MAX_LIMIT = 50
DEFAULT_LIMIT = 10
DEFAULT_SERIES_LIMIT = 6
OTHER_LABEL = "Other"


class QueryError(ValueError):
    """Raised for an invalid chart spec; reported to the client as HTTP 400."""


@dataclass(frozen=True)
class Dimension:
    key: str
    label: str
    group: str
    expr: str
    kind: str = "category"  # "category" or "time"


@dataclass(frozen=True)
class Measure:
    key: str
    label: str
    expr: str  # written against the columns of the `base` CTE
    format: str  # "currency", "integer" or "decimal"


def _text(expr: str) -> str:
    return f"coalesce(({expr})::text, '(none)')"


def _trunc(unit: str) -> str:
    return f"date_trunc('{unit}', o.order_date)::date"


DIMENSIONS: dict[str, Dimension] = {
    d.key: d
    for d in [
        Dimension("product", "Product", "Product", _text("p.name")),
        Dimension("sku", "SKU", "Product", _text("p.sku")),
        Dimension("category", "Category", "Product", _text("p.category")),
        Dimension("store_state", "Store state", "Region (store)", _text("s.state")),
        Dimension("store_city", "Store city", "Region (store)", _text("s.city || ', ' || s.state")),
        Dimension("store", "Store", "Region (store)", _text("s.name")),
        Dimension("customer_state", "Customer state", "Region (customer)", _text("c.state")),
        Dimension("customer_city", "Customer city", "Region (customer)", _text("c.city || ', ' || c.state")),
        Dimension("day", "Day", "Time", _trunc("day"), "time"),
        Dimension("week", "Week", "Time", _trunc("week"), "time"),
        Dimension("month", "Month", "Time", _trunc("month"), "time"),
        Dimension("quarter", "Quarter", "Time", _trunc("quarter"), "time"),
        Dimension("year", "Year", "Time", _trunc("year"), "time"),
        Dimension("status", "Order status", "Order", _text("o.status")),
    ]
}

_REVENUE = "sum(qty * price)"

MEASURES: dict[str, Measure] = {
    m.key: m
    for m in [
        Measure("revenue", "Revenue", _REVENUE, "currency"),
        Measure("units", "Units sold", "sum(qty)", "integer"),
        Measure("orders", "Orders", "count(DISTINCT order_id)", "integer"),
        Measure("aov", "Average order value", f"{_REVENUE} / nullif(count(DISTINCT order_id), 0)", "currency"),
        Measure("customers", "Customers", "count(DISTINCT customer_id)", "integer"),
        Measure("avg_price", "Average unit price", f"{_REVENUE} / nullif(sum(qty), 0)", "currency"),
    ]
}

BASE_FROM = """
    FROM order_items oi
    JOIN orders o    ON o.order_id = oi.order_id
    JOIN products p  ON p.product_id = oi.product_id
    JOIN stores s    ON s.store_id = o.store_id
    JOIN customers c ON c.customer_id = o.customer_id"""

# filter key -> (SQL condition, value kind)
_LIST_FILTERS = {
    "statuses": ("o.status = ANY(%(statuses)s::text[])", str),
    "categories": ("p.category = ANY(%(categories)s::text[])", str),
    "store_states": ("s.state::text = ANY(%(store_states)s::text[])", str),
    "customer_states": ("c.state::text = ANY(%(customer_states)s::text[])", str),
    "product_ids": ("p.product_id = ANY(%(product_ids)s::int[])", int),
    "store_ids": ("s.store_id = ANY(%(store_ids)s::int[])", int),
}


def _parse_date(value, name: str) -> date:
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise QueryError(f"Invalid date for {name}: {value!r}") from None


def parse_filters(raw) -> dict:
    """Validate and normalise a filters object. Unknown keys are rejected."""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise QueryError("filters must be an object")
    allowed = set(_LIST_FILTERS) | {"date_from", "date_to"}
    unknown = set(raw) - allowed
    if unknown:
        raise QueryError(f"Unknown filter(s): {', '.join(sorted(unknown))}")

    out: dict = {}
    for name in ("date_from", "date_to"):
        if raw.get(name):
            out[name] = _parse_date(raw[name], name)
    if "date_from" in out and "date_to" in out and out["date_from"] > out["date_to"]:
        raise QueryError("date_from must not be after date_to")

    for name, (_, kind) in _LIST_FILTERS.items():
        values = raw.get(name)
        if values in (None, [], ""):
            continue
        if not isinstance(values, list):
            raise QueryError(f"{name} must be a list")
        try:
            out[name] = [kind(v) for v in values]
        except (TypeError, ValueError):
            raise QueryError(f"Invalid value in {name}") from None
    return out


def build_where(filters: dict) -> tuple[str, dict]:
    """Turn parsed filters into a WHERE clause and its bound parameters."""
    clauses, params = [], {}
    if "date_from" in filters:
        clauses.append("o.order_date >= %(date_from)s::date")
        params["date_from"] = filters["date_from"]
    if "date_to" in filters:
        clauses.append("o.order_date < %(date_to)s::date + 1")
        params["date_to"] = filters["date_to"]
    for name, (condition, _) in _LIST_FILTERS.items():
        if name in filters:
            clauses.append(condition)
            params[name] = filters[name]
    return (" AND ".join(clauses) or "TRUE"), params


def _base_cte(dim_expr: str, series_expr: str, where: str) -> str:
    return f"""base AS (
    SELECT {dim_expr} AS dim, {series_expr} AS series,
           oi.quantity AS qty, oi.unit_price AS price,
           o.order_id, o.customer_id{BASE_FROM}
    WHERE {where}
)"""


def _clamp_limit(value, default: int) -> int:
    if value is None:
        return default
    try:
        return max(1, min(MAX_LIMIT, int(value)))
    except (TypeError, ValueError):
        raise QueryError("limit must be an integer") from None


@dataclass(frozen=True)
class AggregateSpec:
    dimension: Dimension
    breakdown: Dimension | None
    measure: Measure
    limit: int
    series_limit: int
    include_other: bool
    filters: dict


def parse_spec(raw) -> AggregateSpec:
    if not isinstance(raw, dict):
        raise QueryError("Request body must be a JSON object")

    dim_key = raw.get("dimension")
    if dim_key not in DIMENSIONS:
        raise QueryError(f"Unknown dimension: {dim_key!r}")
    bd_key = raw.get("breakdown") or None
    if bd_key is not None and bd_key not in DIMENSIONS:
        raise QueryError(f"Unknown breakdown: {bd_key!r}")
    if bd_key == dim_key:
        raise QueryError("breakdown must differ from dimension")
    measure_key = raw.get("measure", "revenue")
    if measure_key not in MEASURES:
        raise QueryError(f"Unknown measure: {measure_key!r}")

    return AggregateSpec(
        dimension=DIMENSIONS[dim_key],
        breakdown=DIMENSIONS[bd_key] if bd_key else None,
        measure=MEASURES[measure_key],
        limit=_clamp_limit(raw.get("limit"), DEFAULT_LIMIT),
        series_limit=_clamp_limit(raw.get("series_limit"), DEFAULT_SERIES_LIMIT),
        include_other=bool(raw.get("include_other", False)),
        filters=parse_filters(raw.get("filters")),
    )


def _rank_cte(name: str, column: str, dim: Dimension, measure: Measure) -> str:
    # Time runs chronologically; categories rank by the measure, largest first.
    order = column if dim.kind == "time" else f"{measure.expr} DESC NULLS LAST, {column}"
    return f"""{name} AS (
    SELECT {column}, row_number() OVER (ORDER BY {order}) AS rnk
    FROM base GROUP BY {column}
)"""


def build_aggregate_query(spec: AggregateSpec) -> tuple[str, dict]:
    """Return SQL yielding rows of (dim, dim_sort, series, series_sort, value).

    Category dimensions keep their top `limit` values; the rest are either
    dropped or folded into an "Other" bucket (`include_other`). A breakdown
    keeps its top `series_limit` values and always folds the rest into
    "Other", so stacked totals stay honest. Folding happens before
    aggregation, so non-additive measures (orders, AOV, ...) stay correct.
    """
    where, params = build_where(spec.filters)
    m = spec.measure
    ctes = [_base_cte(spec.dimension.expr, spec.breakdown.expr if spec.breakdown else "NULL::text", where)]
    conditions = []

    ctes.append(_rank_cte("dim_rank", "dim", spec.dimension, m))
    if spec.dimension.kind == "time":
        dim_label = "b.dim"
    else:
        params["limit"] = spec.limit
        if spec.include_other:
            dim_label = f"CASE WHEN dr.rnk <= %(limit)s THEN b.dim ELSE '{OTHER_LABEL}' END"
        else:
            dim_label = "b.dim"
            conditions.append("dr.rnk <= %(limit)s")
    joins = "JOIN dim_rank dr ON dr.dim = b.dim"

    if spec.breakdown:
        ctes.append(_rank_cte("series_rank", "series", spec.breakdown, m))
        joins += "\n    JOIN series_rank sr ON sr.series = b.series"
        series_sort = "min(sr.rnk)"
        if spec.breakdown.kind == "time":
            series_label = "b.series"
        else:
            params["series_limit"] = spec.series_limit
            series_label = f"CASE WHEN sr.rnk <= %(series_limit)s THEN b.series ELSE '{OTHER_LABEL}' END"
    else:
        series_label, series_sort = "NULL::text", "0"

    with_clause = ",\n".join(ctes)
    query = f"""WITH {with_clause}
SELECT {dim_label} AS dim, min(dr.rnk) AS dim_sort,
       {series_label} AS series, {series_sort} AS series_sort,
       {m.expr} AS value
FROM base b
    {joins}
WHERE {" AND ".join(conditions) or "TRUE"}
GROUP BY 1, 3
ORDER BY 2, 4"""
    return query, params


def build_totals_query(filters: dict) -> tuple[str, dict]:
    """Return SQL computing every measure once over the filtered rows."""
    where, params = build_where(filters)
    columns = ",\n       ".join(f"{m.expr} AS {key}" for key, m in MEASURES.items())
    query = f"""WITH {_base_cte("NULL", "NULL", where)}
SELECT {columns}
FROM base"""
    return query, params


def format_label(value, dim: Dimension | None) -> str:
    """Render a dimension value for display (time buckets become readable periods)."""
    if value is None:
        return ""
    if dim is None or dim.kind != "time" or not isinstance(value, date):
        return str(value)
    if dim.key == "year":
        return f"{value.year}"
    if dim.key == "quarter":
        return f"{value.year} Q{(value.month - 1) // 3 + 1}"
    if dim.key == "month":
        return value.strftime("%Y-%m")
    return value.isoformat()


def _number(value):
    return None if value is None else float(value)


def pivot(rows: list[dict], spec: AggregateSpec) -> dict:
    """Shape (dim, series, value) rows into Chart.js-style labels + datasets."""
    labels: list[str] = []
    label_index: dict[str, int] = {}
    series_order: list[str] = []
    cells: dict[tuple[str, str], float | None] = {}

    for row in rows:  # rows arrive ordered by dim_sort, series_sort
        label = format_label(row["dim"], spec.dimension)
        if label not in label_index:
            label_index[label] = len(labels)
            labels.append(label)
        series = format_label(row["series"], spec.breakdown) if spec.breakdown else spec.measure.label
        cells[(label, series)] = _number(row["value"])

    if spec.breakdown:
        ranked = {}
        for row in rows:
            name = format_label(row["series"], spec.breakdown)
            ranked[name] = min(ranked.get(name, row["series_sort"]), row["series_sort"])
        series_order = sorted(ranked, key=lambda s: ranked[s])
    else:
        series_order = [spec.measure.label]

    datasets = [
        {"label": name, "data": [cells.get((label, name)) for label in labels]}
        for name in series_order
    ]
    return {
        "labels": labels,
        "datasets": datasets,
        "dimension": {"key": spec.dimension.key, "label": spec.dimension.label, "kind": spec.dimension.kind},
        "breakdown": (
            {"key": spec.breakdown.key, "label": spec.breakdown.label, "kind": spec.breakdown.kind}
            if spec.breakdown else None
        ),
        "measure": {"key": spec.measure.key, "label": spec.measure.label, "format": spec.measure.format},
    }


def registry() -> dict:
    """Dimension and measure catalogue for the front end."""
    return {
        "dimensions": [
            {"key": d.key, "label": d.label, "group": d.group, "kind": d.kind} for d in DIMENSIONS.values()
        ],
        "measures": [{"key": m.key, "label": m.label, "format": m.format} for m in MEASURES.values()],
    }
