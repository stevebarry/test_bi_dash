"""Flask web server for the sales analysis dashboard."""

import atexit
import csv
import io
import json
import logging
from datetime import timedelta

import psycopg
from flask import Flask, Response, jsonify, render_template, request
from psycopg_pool import PoolTimeout

import queries
from config import load_settings
from db import Database, configure_sql_log

log = logging.getLogger(__name__)


def create_app(config_path=None, database=None) -> Flask:
    settings = load_settings(config_path)
    app = Flask(__name__)
    app.config["SETTINGS"] = settings

    # Record every SQL statement the app runs in the configured log file.
    configure_sql_log(settings.logging.sql_log)

    db = database or Database(settings.database)
    if database is None:
        db.open()
        atexit.register(db.close)

    @app.errorhandler(queries.QueryError)
    def bad_request(err):
        return jsonify(error=str(err)), 400

    @app.errorhandler(psycopg.OperationalError)
    @app.errorhandler(PoolTimeout)
    def db_unavailable(err):
        log.exception("Database unavailable")
        return jsonify(error="Database unavailable - check the [database] section of the config file."), 503

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/meta")
    def meta():
        bounds = db.fetch_one("SELECT min(order_date)::date AS min, max(order_date)::date AS max FROM orders")
        options = {
            "categories": [r["v"] for r in db.fetch_all("SELECT DISTINCT category AS v FROM products ORDER BY 1")],
            "store_states": [r["v"] for r in db.fetch_all("SELECT DISTINCT state::text AS v FROM stores ORDER BY 1")],
            "customer_states": [
                r["v"]
                for r in db.fetch_all(
                    "SELECT DISTINCT state::text AS v FROM customers WHERE state IS NOT NULL ORDER BY 1"
                )
            ],
            "statuses": list(queries.ORDER_STATUSES),
            "products": db.fetch_all("SELECT product_id AS id, name, category FROM products ORDER BY name"),
            "stores": db.fetch_all(
                "SELECT store_id AS id, name, city, state::text AS state FROM stores ORDER BY name"
            ),
            "date_min": bounds["min"].isoformat() if bounds and bounds["min"] else None,
            "date_max": bounds["max"].isoformat() if bounds and bounds["max"] else None,
        }
        return jsonify(**queries.registry(), options=options)

    def run_aggregate(raw_spec):
        spec = queries.parse_spec(raw_spec)
        sql, params = queries.build_aggregate_query(spec)
        return spec, db.fetch_all(sql, params)

    @app.post("/api/aggregate")
    def aggregate():
        spec, rows = run_aggregate(request.get_json(silent=True))
        return jsonify(queries.pivot(rows, spec))

    @app.get("/api/aggregate.csv")
    def aggregate_csv():
        try:
            raw = json.loads(request.args.get("spec", ""))
        except json.JSONDecodeError:
            raise queries.QueryError("spec must be URL-encoded JSON") from None
        spec, rows = run_aggregate(raw)

        buf = io.StringIO()
        writer = csv.writer(buf)
        header = [spec.dimension.label]
        if spec.breakdown:
            header.append(spec.breakdown.label)
        writer.writerow(header + [spec.measure.label])
        for row in rows:
            line = [queries.format_label(row["dim"], spec.dimension)]
            if spec.breakdown:
                line.append(queries.format_label(row["series"], spec.breakdown))
            writer.writerow(line + ["" if row["value"] is None else row["value"]])

        filename = f"{spec.measure.key}_by_{spec.dimension.key}"
        if spec.breakdown:
            filename += f"_and_{spec.breakdown.key}"
        return Response(
            buf.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
        )

    def totals(filters):
        sql, params = queries.build_totals_query(filters)
        row = db.fetch_one(sql, params) or {}
        return {key: (None if row.get(key) is None else float(row[key])) for key in queries.MEASURES}

    @app.post("/api/kpis")
    def kpis():
        body = request.get_json(silent=True) or {}
        filters = queries.parse_filters(body.get("filters"))
        current = totals(filters)

        # Compare against the immediately preceding period of equal length.
        start, end = filters.get("date_from"), filters.get("date_to")
        if start is None or end is None:
            bounds = db.fetch_one("SELECT min(order_date)::date AS min, max(order_date)::date AS max FROM orders")
            start = start or (bounds and bounds["min"])
            end = end or (bounds and bounds["max"])
        previous, period = None, None
        if start and end:
            length = (end - start).days + 1
            prev_end = start - timedelta(days=1)
            prev_start = prev_end - timedelta(days=length - 1)
            previous = totals({**filters, "date_from": prev_start, "date_to": prev_end})
            period = {"from": prev_start.isoformat(), "to": prev_end.isoformat()}

        return jsonify(
            current=current,
            previous=previous,
            previous_period=period,
            measures=queries.registry()["measures"],
        )

    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    application = create_app()
    cfg = application.config["SETTINGS"].app
    application.run(host=cfg.host, port=cfg.port, debug=cfg.debug)
