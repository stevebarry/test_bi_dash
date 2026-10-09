"""Create the schema from schema.sql and fill it with realistic sample data.

    python seed_data.py            # asks before dropping existing tables
    python seed_data.py --yes      # no prompt

WARNING: schema.sql drops and recreates the dashboard tables.
"""

import argparse
import random
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg import sql

from config import load_settings

SCHEMA_FILE = Path(__file__).with_name("schema.sql")

STORE_LOCATIONS = [
    ("Los Angeles", "CA"), ("San Francisco", "CA"), ("San Diego", "CA"),
    ("Houston", "TX"), ("Austin", "TX"), ("Dallas", "TX"),
    ("New York", "NY"), ("Buffalo", "NY"),
    ("Miami", "FL"), ("Orlando", "FL"), ("Tampa", "FL"),
    ("Chicago", "IL"), ("Seattle", "WA"), ("Atlanta", "GA"),
    ("Boston", "MA"), ("Denver", "CO"), ("Phoenix", "AZ"),
    ("Portland", "OR"), ("Minneapolis", "MN"), ("Nashville", "TN"),
]

# category -> (price range, product nouns)
CATALOG = {
    "Electronics": ((29, 899), ["Headphones", "Speaker", "Tablet", "Smartwatch", "Charger", "Camera",
                                "Keyboard", "Monitor", "Earbuds", "Router"]),
    "Home & Kitchen": ((9, 249), ["Blender", "Kettle", "Pan Set", "Knife Block", "Toaster", "Coffee Maker",
                                  "Storage Jars", "Cutting Board", "Air Fryer", "Mixing Bowls"]),
    "Clothing": ((12, 160), ["Jacket", "Hoodie", "Jeans", "T-Shirt", "Sneakers", "Scarf",
                             "Raincoat", "Polo Shirt", "Chinos", "Beanie"]),
    "Sports & Outdoors": ((8, 320), ["Yoga Mat", "Tent", "Water Bottle", "Backpack", "Dumbbells", "Bike Helmet",
                                     "Running Belt", "Camp Stove", "Hiking Poles", "Jump Rope"]),
    "Beauty": ((5, 95), ["Moisturiser", "Shampoo", "Lip Balm", "Face Serum", "Sunscreen", "Hair Dryer",
                         "Body Wash", "Hand Cream", "Perfume", "Nail Kit"]),
    "Toys & Games": ((6, 120), ["Puzzle", "Board Game", "Building Blocks", "Plush Bear", "RC Car", "Card Game",
                                "Art Set", "Train Set", "Kite", "Science Kit"]),
}
ADJECTIVES = ["Classic", "Pro", "Eco", "Ultra", "Compact", "Deluxe", "Smart", "Essential", "Premium", "Lite"]

FIRST_NAMES = ["James", "Mary", "Wei", "Priya", "Carlos", "Fatima", "Liam", "Olivia", "Noah", "Emma", "Ava",
               "Mateo", "Sofia", "Yuki", "Aisha", "Ethan", "Chloe", "Lucas", "Zara", "Omar", "Grace", "Leo"]
LAST_NAMES = ["Smith", "Garcia", "Chen", "Patel", "Johnson", "Nguyen", "Brown", "Kim", "Lopez", "Williams",
              "Okafor", "Martin", "Silva", "Cohen", "Murphy", "Rossi", "Khan", "Taylor", "Lee", "Walker"]
STREETS = ["Main St", "Oak Ave", "Maple Dr", "Pine St", "Cedar Ln", "Elm St", "Park Ave", "Lake Rd"]


def build_data(rng: random.Random, n_customers: int, n_orders: int, days: int):
    stores = []
    for i, (city, state) in enumerate(STORE_LOCATIONS, start=1):
        stores.append((
            i, f"{city} Store", f"{rng.randint(10, 9999)} {rng.choice(STREETS)}", city, state,
            f"{rng.randint(10000, 99999)}", f"555-{rng.randint(1000, 9999)}",
            (datetime.now() - timedelta(days=rng.randint(days, days + 2000))).date(),
        ))
    # Some stores sell more than others.
    store_weights = [rng.uniform(0.4, 2.0) for _ in stores]

    products, pid = [], 1
    for category, ((lo, hi), nouns) in CATALOG.items():
        for noun in nouns:
            price = Decimal(str(round(rng.uniform(lo, hi), 2)))
            name = f"{rng.choice(ADJECTIVES)} {noun}"
            sku = f"{category[:3].upper()}-{pid:04d}"
            products.append((pid, sku, name, category, price, rng.random() > 0.05))
            pid += 1
    product_weights = [rng.paretovariate(1.6) for _ in products]

    states = sorted({s for _, s in STORE_LOCATIONS})
    customers = []
    for cid in range(1, n_customers + 1):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        home = rng.choice(STORE_LOCATIONS)
        has_address = rng.random() > 0.04
        customers.append((
            cid, first, last, f"{first.lower()}.{last.lower()}{cid}@example.com",
            f"555-{rng.randint(1000, 9999)}" if rng.random() > 0.2 else None,
            f"{rng.randint(1, 999)} {rng.choice(STREETS)}" if has_address else None,
            home[0] if has_address else None,
            (home[1] if rng.random() > 0.15 else rng.choice(states)) if has_address else None,
            f"{rng.randint(10000, 99999)}" if has_address else None,
            datetime.now(timezone.utc) - timedelta(days=rng.randint(0, days + 365)),
        ))

    # Orders: upward trend plus a Nov/Dec seasonal peak.
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days)
    day_weights = []
    for d in range(days):
        day = start + timedelta(days=d)
        seasonal = {11: 1.5, 12: 1.9, 1: 0.8, 2: 0.85}.get(day.month, 1.0)
        weekend = 1.25 if day.weekday() >= 5 else 1.0
        day_weights.append((1 + 0.6 * d / days) * seasonal * weekend)

    orders, items = [], []
    order_days = rng.choices(range(days), weights=day_weights, k=n_orders)
    order_days.sort()
    for oid, d in enumerate(order_days, start=1):
        when = datetime.combine((start + timedelta(days=d)).date(), time(rng.randint(8, 21), rng.randint(0, 59)),
                                tzinfo=timezone.utc)
        age = days - d
        if age < 3:
            status = rng.choices(["pending", "shipped", "cancelled"], [6, 3, 1])[0]
        elif age < 10:
            status = rng.choices(["pending", "shipped", "delivered", "cancelled"], [1, 5, 3, 1])[0]
        else:
            status = rng.choices(["delivered", "cancelled"], [94, 6])[0]
        store_id = rng.choices(stores, weights=store_weights)[0][0]
        orders.append((oid, rng.randint(1, n_customers), store_id, when, status))

        n_lines = rng.choices([1, 2, 3, 4], [50, 28, 15, 7])[0]
        chosen = set()
        while len(chosen) < n_lines:
            chosen.add(rng.choices(range(len(products)), weights=product_weights)[0])
        for idx in chosen:
            product = products[idx]
            discount = Decimal("0.85") if rng.random() < 0.12 else Decimal("1")
            price = max(Decimal("0.01"), (product[4] * discount).quantize(Decimal("0.01")))
            items.append((oid, product[0], rng.choices([1, 2, 3, 5], [70, 20, 7, 3])[0], price))

    return stores, customers, products, orders, items


def copy_rows(cur, table: str, columns: list[str], rows):
    stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, columns)))
    with cur.copy(stmt) as copy:
        for row in rows:
            copy.write_row(row)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", help="path to config.ini (default: $DASHBOARD_CONFIG or ./config.ini)")
    parser.add_argument("--customers", type=int, default=2000)
    parser.add_argument("--orders", type=int, default=20000)
    parser.add_argument("--days", type=int, default=730, help="history length in days")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--yes", action="store_true", help="do not ask before dropping tables")
    args = parser.parse_args()

    cfg = load_settings(args.config).database
    if not args.yes:
        answer = input(f"This drops and recreates the tables in schema '{cfg.schema}' "
                       f"on {cfg.host}/{cfg.dbname}. Continue? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return

    # schema.sql hard-codes the "sales" schema; point it at the configured one.
    schema_ident = sql.Identifier(cfg.schema)
    ddl = SCHEMA_FILE.read_text(encoding="utf-8")
    stores, customers, products, orders, items = build_data(
        random.Random(args.seed), args.customers, args.orders, args.days)

    with psycopg.connect(cfg.conninfo()) as conn:
        quoted = schema_ident.as_string(conn)
        with conn.cursor() as cur:
            cur.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(schema_ident))
            cur.execute(ddl.replace("sales.", f"{quoted}."))
            cur.execute(sql.SQL("SET search_path TO {}").format(schema_ident))

            copy_rows(cur, "stores", ["store_id", "name", "address", "city", "state", "postal_code", "phone",
                                      "opened_date"], stores)
            copy_rows(cur, "customers", ["customer_id", "first_name", "last_name", "email", "phone", "address",
                                         "city", "state", "postal_code", "created_at"], customers)
            copy_rows(cur, "products", ["product_id", "sku", "name", "category", "unit_price", "active"], products)
            copy_rows(cur, "orders", ["order_id", "customer_id", "store_id", "order_date", "status"], orders)
            copy_rows(cur, "order_items", ["order_id", "product_id", "quantity", "unit_price"], items)

            # Explicit ids were inserted; move the identity sequences past them.
            for table, column in [("stores", "store_id"), ("customers", "customer_id"),
                                  ("products", "product_id"), ("orders", "order_id")]:
                cur.execute(
                    sql.SQL("SELECT setval(pg_get_serial_sequence(%s, %s), (SELECT max({}) FROM {}))").format(
                        sql.Identifier(column), sql.Identifier(table)),
                    (f"{quoted}.{table}", column),
                )
            cur.execute("ANALYZE")

    print(f"Loaded {len(stores)} stores, {len(products)} products, {len(customers)} customers, "
          f"{len(orders)} orders and {len(items)} order lines into schema '{cfg.schema}'.")


if __name__ == "__main__":
    main()
