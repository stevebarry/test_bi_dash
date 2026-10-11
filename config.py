"""Load dashboard settings from an INI file."""

import configparser
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG_PATH = Path(__file__).with_name("config.ini")


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    dbname: str
    user: str
    password: str
    schema: str
    pool_min: int
    pool_max: int
    connect_timeout: int

    def conninfo(self) -> str:
        """Build a libpq connection string with every value safely quoted."""

        def quote(value) -> str:
            text = str(value).replace("\\", "\\\\").replace("'", "\\'")
            return f"'{text}'"

        parts = {
            "host": self.host,
            "port": self.port,
            "dbname": self.dbname,
            "user": self.user,
            "password": self.password,
            "connect_timeout": self.connect_timeout,
        }
        return " ".join(f"{key}={quote(value)}" for key, value in parts.items())


@dataclass(frozen=True)
class AppConfig:
    host: str
    port: int
    debug: bool


@dataclass(frozen=True)
class LoggingConfig:
    # File that receives one line per SQL statement executed; None disables it.
    sql_log: Path | None


@dataclass(frozen=True)
class Settings:
    database: DatabaseConfig
    app: AppConfig
    logging: LoggingConfig


def load_settings(path: str | os.PathLike | None = None) -> Settings:
    """Read settings from `path`, $DASHBOARD_CONFIG, or ./config.ini (in that order)."""
    config_path = Path(path or os.environ.get("DASHBOARD_CONFIG") or DEFAULT_CONFIG_PATH)
    if not config_path.is_file():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    parser = configparser.ConfigParser()
    parser.read(config_path, encoding="utf-8")

    db = parser["database"]
    database = DatabaseConfig(
        host=db.get("host", "localhost"),
        port=db.getint("port", 5432),
        dbname=db.get("dbname", "postgres"),
        user=db.get("user", "postgres"),
        password=os.environ.get("DB_PASSWORD", db.get("password", "")),
        schema=db.get("schema", "sales"),
        pool_min=db.getint("pool_min", 1),
        pool_max=db.getint("pool_max", 5),
        connect_timeout=db.getint("connect_timeout", 5),
    )

    app_section = parser["app"] if parser.has_section("app") else {}
    app = AppConfig(
        host=app_section.get("host", "127.0.0.1"),
        port=int(app_section.get("port", 5000)),
        debug=str(app_section.get("debug", "false")).lower() in ("1", "true", "yes", "on"),
    )

    # [logging] sql_log: path of the SQL log file, relative to the config
    # file's folder. Defaults to sql.log; set it empty to turn logging off.
    log_section = parser["logging"] if parser.has_section("logging") else {}
    sql_log = str(log_section.get("sql_log", "sql.log")).strip()
    logging_cfg = LoggingConfig(sql_log=(config_path.parent / sql_log) if sql_log else None)

    return Settings(database=database, app=app, logging=logging_cfg)
