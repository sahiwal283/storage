"""Attribution store: SQLite record + overlay. Isolated db via ATTRIBUTION_DB."""

import os

import pytest

from app import attribution


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "attribution.db"
    monkeypatch.setenv("ATTRIBUTION_DB", str(path))
    attribution.init_db()
    return path


def _session(**overrides):
    base = {"sub": "u1", "email": "u@test", "name": "U", "iat": 0}
    base.update(overrides)
    return base


def test_record_then_lookup_returns_name_and_email(db):
    attribution.record("wd-1", _session())
    assert attribution.lookup(["wd-1"]) == {"wd-1": ("U", "u@test")}


def test_blank_name_falls_back_to_email(db):
    attribution.record("wd-2", _session(name="  ", email="pat@booute.com"))
    assert attribution.lookup(["wd-2"])["wd-2"][0] == "pat@booute.com"


def test_duplicate_resource_id_is_ignored(db):
    attribution.record("wd-1", _session(name="First"))
    attribution.record("wd-1", _session(name="Second", email="other@test", sub="u2"))
    assert attribution.lookup(["wd-1"]) == {"wd-1": ("First", "u@test")}


def test_lookup_miss_is_omitted(db):
    attribution.record("wd-1", _session())
    assert attribution.lookup(["wd-1", "missing"]) == {"wd-1": ("U", "u@test")}


def test_overlay_items_hit_and_miss(db):
    attribution.record("hit", _session(name="Sahil", email="sahil@booute.com"))
    body = {
        "ok": True,
        "items": [
            {"id": "hit", "created_by": "Nabeel", "name": "a.pdf"},
            {"id": "miss", "created_by": "Nabeel", "name": "b.pdf"},
        ],
    }
    attribution.overlay_payload(body)
    assert body["items"][0]["created_by"] == "Sahil"
    assert body["items"][0]["created_by_email"] == "sahil@booute.com"
    assert body["items"][1]["created_by"] == "Nabeel"
    assert "created_by_email" not in body["items"][1]


def test_overlay_create_aliases(db):
    attribution.record("f1", _session())
    item = {"id": "f1", "created_by": "Nabeel", "name": "a.bin"}
    body = {"ok": True, "item": item, "file": item}
    attribution.overlay_payload(body)
    assert body["item"]["created_by"] == "U"
    assert body["file"]["created_by"] == "U"
    assert body["item"]["created_by_email"] == "u@test"


def test_record_from_payload_uses_item_id(db):
    body = {"ok": True, "item": {"id": "new-1", "name": "Legal"}}
    attribution.record_from_payload(body, _session())
    assert "new-1" in attribution.lookup(["new-1"])


def test_record_from_payload_skips_when_no_id(db):
    attribution.record_from_payload({"ok": True, "item": {"name": "x"}}, _session())
    assert attribution.lookup(["x"]) == {}


def test_record_swallows_sqlite_errors(db, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(attribution, "_connect", boom)
    attribution.record("wd-1", _session())  # must not raise
