# Sales Dashboard

A Flask web dashboard for analysing the retail sales data in `schema.sql` by product, region and time.

## Features

- **Headline tiles:** revenue, orders, units, average order value and customers, each compared with the previous period of the same length.
- **Global filters:** period, order status, product category, store state and customer state.
- **Configurable chart panels.** Each chart picks its own settings:
  - **Group by:** product, SKU, category, store state/city/store, customer state/city, day/week/month/quarter/year, or order status.
  - **Breakdown:** an optional second attribute, drawn as one series per value. Only the top 7 values are kept; the rest are grouped as "Other".
  - **Measure:** revenue, units, orders, average order value, customers or average unit price.
  - **Chart type:** bar, horizontal bar, stacked bar, line, area, doughnut or table.
  - **Top N:** how many groups to show.
- **Panel actions:** add, duplicate, remove, widen, rename and download as CSV.
- The panel layout and filters are saved in your browser.

## Setup

```powershell
pip install -r requirements.txt
```

Copy `config.example.ini` to `config.ini` and edit it with your PostgreSQL connection details. You can point to a different file with the `DASHBOARD_CONFIG` environment variable, and you can supply the password in `DB_PASSWORD` instead of storing it in the file.

```ini
[database]
host = localhost
port = 5432
dbname = postgres
user = postgres
password = changeme
schema = sales
```

The dashboard reads the tables defined in `schema.sql`. If you need test data, run:

```powershell
python seed_data.py
```

> **Warning:** this drops and recreates the dashboard tables in the configured schema. It creates the schema if it does not exist.

The default is 20 stores, 60 products, 2,000 customers and 20,000 orders over two years. See `--help` for the options.

## Run

```powershell
python app.py
```

Then open <http://127.0.0.1:5000>. The host, port and debug settings come from the `[app]` section of `config.ini`.

## Tests

```powershell
python -m pytest tests
```

The tests cover the SQL builder and the API routes. They use a fake database, so no PostgreSQL server is needed.

## How it works

| File | Role |
|---|---|
| `config.py` | Loads `config.ini`. |
| `db.py` | psycopg connection pool. Sets `search_path` to the configured schema. |
| `queries.py` | Fixed lists of allowed dimensions, measures and filters, plus the SQL builder. |
| `app.py` | Flask routes: `/`, `/api/meta`, `/api/aggregate`, `/api/aggregate.csv`, `/api/kpis`. |
| `templates/`, `static/` | Dashboard page, built with Chart.js 4. |

The browser sends a chart description to the server:

```json
{"dimension": "category", "breakdown": "store_state", "measure": "revenue", "limit": 10, "filters": {}}
```

- Only names from the fixed lists in `queries.py` are put into SQL text. All filter values are passed as bound parameters.
- Unknown keys are rejected with HTTP 400.
- Small groups are folded into "Other" before the measure is calculated. This keeps measures that can't simply be added together, such as order counts and average order value, correct.
