"""Tests for the SQL statement log written by db.Database."""

import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db  # noqa: E402


class FakeCursor:
    """Minimal stand-in for a psycopg cursor; raises if `fail` is set."""

    def __init__(self, rows, fail):
        self.rows, self.fail = rows, fail

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        if self.fail:
            raise RuntimeError("boom")

    def fetchall(self):
        return self.rows


class FakePool:
    """Stand-in for psycopg_pool.ConnectionPool handing out fake cursors."""

    def __init__(self, rows=(), fail=False):
        self.rows, self.fail = list(rows), fail

    @contextmanager
    def connection(self):
        pool = self

        class Conn:
            def cursor(self):
                return FakeCursor(pool.rows, pool.fail)

        yield Conn()


def make_db(pool):
    # Skip __init__ so no real connection pool is created.
    database = db.Database.__new__(db.Database)
    database.pool = pool
    return database


@pytest.fixture
def log_file(tmp_path):
    path = tmp_path / "logs" / "sql.log"
    db.configure_sql_log(path)
    yield path
    db.configure_sql_log(None)   # close the file handler before tmp_path is removed


def read(path):
    for handler in db.sql_log.handlers:
        handler.flush()
    return path.read_text(encoding="utf-8")


def test_successful_query_is_logged(log_file):
    database = make_db(FakePool(rows=[{"v": 1}, {"v": 2}]))
    database.fetch_all("SELECT v\n  FROM t WHERE d >= %(d)s", {"d": date(2025, 1, 1)})
    text = read(log_file)
    assert "rows=2" in text
    assert "SELECT v FROM t WHERE d >= %(d)s" in text   # whitespace collapsed onto one line
    assert '"d": "2025-01-01"' in text


def test_failed_query_is_logged_and_reraised(log_file):
    database = make_db(FakePool(fail=True))
    with pytest.raises(RuntimeError):
        database.fetch_one("SELECT broken")
    text = read(log_file)
    assert "ERROR" in text and "FAILED (RuntimeError: boom)" in text and "SELECT broken" in text


def test_logging_disabled(tmp_path):
    db.configure_sql_log(None)
    make_db(FakePool(rows=[{"v": 1}])).fetch_all("SELECT 1")
    assert not db.sql_log.handlers
