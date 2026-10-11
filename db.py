"""PostgreSQL connection pool and query helpers.

Every SQL statement executed through this module is also written to the
"dashboard.sql" logger (see configure_sql_log), giving an audit trail of the
queries the dashboard runs.
"""

import json
import logging
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from config import DatabaseConfig

# Dedicated logger for executed SQL, kept separate from the app's own logging.
sql_log = logging.getLogger("dashboard.sql")


def configure_sql_log(path: Path | None) -> None:
    """Send the SQL logger's records to `path` (rotating), or disable it when None.

    Safe to call more than once (e.g. one Flask app per test): handlers from a
    previous call are replaced rather than duplicated.
    """
    for handler in list(sql_log.handlers):
        sql_log.removeHandler(handler)
        handler.close()
    sql_log.propagate = False   # don't echo SQL into the console/root logger
    if path is None:
        sql_log.disabled = True
        return
    sql_log.disabled = False
    sql_log.setLevel(logging.INFO)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    # delay=True: the file is only created once the first statement is logged.
    handler = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=3, encoding="utf-8", delay=True)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    sql_log.addHandler(handler)


def _log_statement(query, params, started: float, rows: int | None = None, error: Exception | None = None) -> None:
    """Write one line describing an executed statement: outcome, timing, SQL and parameters."""
    if not sql_log.isEnabledFor(logging.INFO):
        return
    text = query.as_string(None) if isinstance(query, sql.Composable) else str(query)
    text = " ".join(text.split())   # one line per statement, so the log is easy to grep
    elapsed_ms = (time.perf_counter() - started) * 1000
    # default=str covers dates, Decimals and other values json can't encode.
    param_text = json.dumps(params, default=str) if params else "{}"
    if error is None:
        sql_log.info("%.1fms rows=%s | %s | params=%s", elapsed_ms, rows, text, param_text)
    else:
        sql_log.error("%.1fms FAILED (%s: %s) | %s | params=%s",
                      elapsed_ms, type(error).__name__, error, text, param_text)


class Database:
    def __init__(self, cfg: DatabaseConfig):
        self.schema = cfg.schema

        def configure(conn):
            # Unqualified table names in queries resolve to the configured schema.
            stmt = sql.SQL("SET search_path TO {}").format(sql.Identifier(cfg.schema))
            started = time.perf_counter()
            conn.execute(stmt)
            conn.commit()
            # Render with the live connection so the identifier is quoted correctly.
            _log_statement(stmt.as_string(conn), None, started)

        self.pool = ConnectionPool(
            conninfo=cfg.conninfo(),
            min_size=cfg.pool_min,
            max_size=cfg.pool_max,
            kwargs={"row_factory": dict_row},
            configure=configure,
            open=False,
        )

    def open(self):
        self.pool.open(wait=False)

    def close(self):
        self.pool.close()

    def fetch_all(self, query, params=None) -> list[dict]:
        """Run `query` with `params` and return every row; the statement is logged either way."""
        started = time.perf_counter()
        try:
            with self.pool.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(query, params)
                    rows = cur.fetchall()
        except Exception as err:
            _log_statement(query, params, started, error=err)
            raise
        _log_statement(query, params, started, rows=len(rows))
        return rows

    def fetch_one(self, query, params=None) -> dict | None:
        rows = self.fetch_all(query, params)
        return rows[0] if rows else None
