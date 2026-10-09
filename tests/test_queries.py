import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import queries  # noqa: E402
from app import create_app  # noqa: E402


def spec(**overrides):
    raw = {"dimension": "category", "measure": "revenue"}
    raw.update(overrides)
    return queries.parse_spec(raw)


# ---------- spec validation ----------

@pytest.mark.parametrize("raw", [
    {"dimension": "nope"},
    {"dimension": "category; DROP TABLE orders"},
    {"dimension": "category", "measure": "sum(1)"},
    {"dimension": "category", "breakdown": "bogus"},
    {"dimension": "category", "breakdown": "category"},
    {"dimension": "category", "filters": {"evil": [1]}},
    {"dimension": "category", "filters": {"date_from": "not-a-date"}},
    {"dimension": "category", "filters": {"date_from": "2025-02-01", "date_to": "2025-01-01"}},
    {"dimension": "category", "filters": {"product_ids": ["x"]}},
    {"dimension": "category", "filters": {"categories": "Toys"}},
    {"dimension": "category", "limit": "ten"},
    "not an object",
])
def test_invalid_specs_rejected(raw):
    with pytest.raises(queries.QueryError):
        queries.parse_spec(raw)


def test_limit_is_clamped():
    assert spec(limit=500).limit == queries.MAX_LIMIT
    assert spec(limit=0).limit == 1
    assert spec().limit == queries.DEFAULT_LIMIT


# ---------- SQL generation ----------

def test_values_are_bound_not_interpolated():
    s = spec(filters={"categories": ["Toys'; DROP TABLE orders; --"], "date_from": "2025-01-01"})
    sql, params = queries.build_aggregate_query(s)
    assert "DROP TABLE" not in sql
    assert params["categories"] == ["Toys'; DROP TABLE orders; --"]
    assert params["date_from"] == date(2025, 1, 1)
    assert "%(categories)s" in sql


def test_category_dimension_limits_without_other():
    sql, params = queries.build_aggregate_query(spec(limit=5))
    assert params["limit"] == 5
    assert "dr.rnk <= %(limit)s" in sql
    assert "'Other'" not in sql


def test_include_other_folds_tail():
    sql, _ = queries.build_aggregate_query(spec(include_other=True))
    assert "ELSE 'Other'" in sql
    assert "WHERE TRUE" in sql


def test_time_dimension_is_not_limited():
    sql, params = queries.build_aggregate_query(spec(dimension="month", limit=3))
    assert "limit" not in params
    assert "date_trunc('month'" in sql


def test_breakdown_folds_series_into_other():
    sql, params = queries.build_aggregate_query(spec(breakdown="store_state", series_limit=4))
    assert params["series_limit"] == 4
    assert "JOIN series_rank" in sql


def test_every_dimension_and_measure_builds():
    for d in queries.DIMENSIONS:
        for m in queries.MEASURES:
            sql, _ = queries.build_aggregate_query(spec(dimension=d, measure=m))
            assert sql.startswith("WITH base AS")


def test_totals_query_has_all_measures():
    sql, _ = queries.build_totals_query({})
    for key in queries.MEASURES:
        assert f"AS {key}" in sql


# ---------- pivot / labels ----------

def test_pivot_with_breakdown():
    s = spec(breakdown="store_state")
    rows = [
        {"dim": "Toys", "dim_sort": 1, "series": "CA", "series_sort": 1, "value": 10},
        {"dim": "Toys", "dim_sort": 1, "series": "TX", "series_sort": 2, "value": 5},
        {"dim": "Beauty", "dim_sort": 2, "series": "CA", "series_sort": 1, "value": 3},
    ]
    out = queries.pivot(rows, s)
    assert out["labels"] == ["Toys", "Beauty"]
    assert out["datasets"] == [
        {"label": "CA", "data": [10.0, 3.0]},
        {"label": "TX", "data": [5.0, None]},
    ]


def test_time_labels():
    q = queries.DIMENSIONS["quarter"]
    assert queries.format_label(date(2025, 8, 1), q) == "2025 Q3"
    assert queries.format_label(date(2025, 8, 1), queries.DIMENSIONS["month"]) == "2025-08"


# ---------- Flask routes (fake database) ----------

class FakeDB:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.calls = []

    def fetch_all(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rows

    def fetch_one(self, sql, params=None):
        return self.rows[0] if self.rows else None


@pytest.fixture
def client():
    db = FakeDB(rows=[{"dim": "Toys", "dim_sort": 1, "series": None, "series_sort": 0, "value": 42}])
    app = create_app(database=db)
    return app.test_client()


def test_aggregate_endpoint(client):
    res = client.post("/api/aggregate", json={"dimension": "category", "measure": "revenue"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["labels"] == ["Toys"]
    assert body["datasets"][0]["data"] == [42.0]


def test_aggregate_rejects_unknown_dimension(client):
    res = client.post("/api/aggregate", json={"dimension": "password"})
    assert res.status_code == 400
    assert "Unknown dimension" in res.get_json()["error"]


def test_csv_export(client):
    res = client.get('/api/aggregate.csv?spec={"dimension":"category","measure":"revenue"}')
    assert res.status_code == 200
    assert res.mimetype == "text/csv"
    assert res.data.decode().splitlines() == ["Category,Revenue", "Toys,42"]
