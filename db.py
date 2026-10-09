"""PostgreSQL connection pool and query helpers."""

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from config import DatabaseConfig


class Database:
    def __init__(self, cfg: DatabaseConfig):
        self.schema = cfg.schema

        def configure(conn):
            # Unqualified table names in queries resolve to the configured schema.
            conn.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(cfg.schema)))
            conn.commit()

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
        with self.pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                return cur.fetchall()

    def fetch_one(self, query, params=None) -> dict | None:
        rows = self.fetch_all(query, params)
        return rows[0] if rows else None
