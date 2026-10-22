from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.engine.url import make_url

from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .storage import async_save_data


def _get_recorder_instance(hass: HomeAssistant):
    """Return the running recorder instance, or None if recorder isn't ready."""
    try:
        from homeassistant.components.recorder import get_instance
        return get_instance(hass)
    except Exception:  # noqa: BLE001 - recorder not loaded yet, etc.
        return None


def _get_recorder_db_url(hass: HomeAssistant) -> str | None:
    """Return the configured recorder db_url, or None if recorder isn't ready."""
    return getattr(_get_recorder_instance(hass), "db_url", None)


def is_recorder_ready(hass: HomeAssistant) -> bool:
    """True once the recorder is loaded and knows which database it uses."""
    return bool(_get_recorder_db_url(hass))


def display_db_url(db_url: str | None) -> str | None:
    """Return db_url safe to show in the panel: the password masked, tags kept as-is."""
    if not isinstance(db_url, str) or not db_url.strip():
        return db_url
    db_url = db_url.strip()
    if db_url.startswith("!"):
        # A YAML tag reference such as "!secret recorder_db_url" holds no secret itself.
        return db_url
    try:
        return make_url(db_url).render_as_string(hide_password=True)
    except Exception:  # noqa: BLE001 - not a URL SQLAlchemy can parse
        return "(unparseable db_url)"


def _sqlite_total_size_bytes(db_path: Path) -> int:
    """Sum the .db, .db-wal and .db-shm sidecar files (WAL mode is the HA default)."""
    total = 0
    for suffix in ("", "-wal", "-shm"):
        sidecar = db_path.with_name(db_path.name + suffix) if suffix else db_path
        try:
            total += sidecar.stat().st_size
        except FileNotFoundError:
            pass
        except Exception:  # noqa: BLE001
            pass
    return total


def _db_size_bytes(engine: Engine, conn) -> int:
    """Return the database size as the backend itself reports it."""
    dialect = engine.dialect.name
    if dialect == "sqlite":
        return _sqlite_total_size_bytes(Path(engine.url.database or ""))
    if dialect == "mysql":
        # Covers MariaDB too. information_schema sizes are estimates for InnoDB,
        # but they are what MariaDB/MySQL tooling reports for a database's size.
        size = conn.execute(
            text(
                "SELECT COALESCE(SUM(data_length + index_length), 0) "
                "FROM information_schema.tables WHERE table_schema = DATABASE()"
            )
        ).scalar()
        return int(size or 0)
    if dialect == "postgresql":
        return int(conn.execute(text("SELECT pg_database_size(current_database())")).scalar() or 0)
    return 0


def _analyze_recorder_db(engine: Engine) -> dict:
    with engine.connect() as conn:
        if inspect(conn).has_table("states_meta"):
            # Count per metadata_id first so the GROUP BY can walk the states
            # index instead of the join; matters on large MariaDB/PostgreSQL tables.
            rows = conn.execute(
                text(
                    """
                    SELECT sm.entity_id, c.cnt
                    FROM (
                        SELECT metadata_id, COUNT(*) AS cnt
                        FROM states
                        GROUP BY metadata_id
                    ) c
                    JOIN states_meta sm ON sm.metadata_id = c.metadata_id
                    ORDER BY c.cnt DESC
                    """
                )
            ).all()
        else:
            rows = conn.execute(
                text(
                    """
                    SELECT entity_id, COUNT(*) AS cnt
                    FROM states
                    GROUP BY entity_id
                    ORDER BY cnt DESC
                    """
                )
            ).all()
        db_size_bytes = _db_size_bytes(engine, conn)

    entity_counts: dict[str, int] = {}
    for entity_id, count in rows:
        if entity_id:
            entity_counts[entity_id] = entity_counts.get(entity_id, 0) + int(count)
    return {
        "entity_counts": entity_counts,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "db_size_bytes": db_size_bytes,
        "total_rows": sum(entity_counts.values()),
        "error": None,
    }


def _db_label(engine: Engine | None, db_url: str | None) -> str:
    """Return what the panel shows as 'Database': the SQLite path, or a masked URL."""
    if engine is not None and engine.dialect.name == "sqlite":
        return engine.url.database or "home-assistant_v2.db"
    return display_db_url(db_url) or "unknown"


async def async_analyze_db(hass: HomeAssistant) -> dict:
    data = hass.data[DOMAIN]["data"]
    instance = _get_recorder_instance(hass)
    engine: Engine | None = getattr(instance, "engine", None)
    db_label = _db_label(engine, getattr(instance, "db_url", None))

    try:
        if engine is None:
            raise RuntimeError("The recorder database is not available yet.")
        # The recorder's own executor: its connection pool expects to be used from there.
        stats = await instance.async_add_executor_job(_analyze_recorder_db, engine)
        stats["db_path"] = db_label
    except Exception as err:  # noqa: BLE001
        stats = {
            "entity_counts": {},
            "generated_at": None,
            "db_path": db_label,
            "db_size_bytes": 0,
            "total_rows": 0,
            "error": str(err),
        }

    data["stats"] = stats
    await async_save_data(hass, data)
    return stats
