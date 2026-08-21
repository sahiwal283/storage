"""Who created a WorkDrive resource through this app. SQLite; never sent to Zoho."""

import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_RESOURCE_KEYS = ("item", "file", "folder", "teamfolder")

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS attribution (
  resource_id TEXT PRIMARY KEY,
  actor_sub   TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  created_at  TEXT NOT NULL
)
"""


def db_path() -> Path:
    raw = os.environ.get("ATTRIBUTION_DB")
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent.parent / "data" / "attribution.db"


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(_CREATE_TABLE)
    return conn


def init_db() -> None:
    conn = _connect()
    conn.close()


def _actor(session: dict) -> tuple[str, str, str]:
    email = str(session.get("email") or "")
    name = str(session.get("name") or "").strip() or email
    sub = str(session.get("sub") or "")
    return sub, name, email


def record(resource_id: str, session: dict) -> None:
    if not resource_id:
        return
    try:
        sub, name, email = _actor(session)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO attribution "
                "(resource_id, actor_sub, actor_name, actor_email, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (resource_id, sub, name, email, now),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        logger.exception("attribution record failed for %s", resource_id)


def lookup(resource_ids: list[str]) -> dict[str, tuple[str, str]]:
    ids = [i for i in resource_ids if i]
    if not ids:
        return {}
    try:
        conn = _connect()
        try:
            placeholders = ",".join("?" * len(ids))
            rows = conn.execute(
                "SELECT resource_id, actor_name, actor_email FROM attribution "
                f"WHERE resource_id IN ({placeholders})",
                ids,
            ).fetchall()
        finally:
            conn.close()
        return {rid: (name, email) for rid, name, email in rows}
    except Exception:
        logger.exception("attribution lookup failed")
        return {}


def _overlay_obj(obj: dict, mapping: dict[str, tuple[str, str]]) -> None:
    rid = obj.get("id")
    if not isinstance(rid, str) or rid not in mapping:
        return
    name, email = mapping[rid]
    obj["created_by"] = name
    obj["created_by_email"] = email


def overlay_payload(body: dict) -> None:
    try:
        ids: list[str] = []
        items = body.get("items")
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict) and isinstance(it.get("id"), str):
                    ids.append(it["id"])
        for key in _RESOURCE_KEYS:
            obj = body.get(key)
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                ids.append(obj["id"])
        mapping = lookup(ids)
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict):
                    _overlay_obj(it, mapping)
        for key in _RESOURCE_KEYS:
            obj = body.get(key)
            if isinstance(obj, dict):
                _overlay_obj(obj, mapping)
    except Exception:
        logger.exception("attribution overlay failed")


def record_from_payload(body: dict, session: dict) -> None:
    resource_id = None
    for key in _RESOURCE_KEYS:
        obj = body.get(key)
        if isinstance(obj, dict) and obj.get("id"):
            resource_id = str(obj["id"])
            break
    if resource_id:
        record(resource_id, session)
