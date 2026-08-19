"""VERSION file is canonical; healthz and package.json must match it."""

import json
import re
from pathlib import Path

from app import __version__

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
VERSION_FILE = REPO_ROOT / "VERSION"
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$")


def test_version_file_exists():
    assert VERSION_FILE.is_file(), "VERSION file not found at repo root"


def test_version_file_semver_format():
    version = VERSION_FILE.read_text().strip()
    assert version, "VERSION file is empty"
    assert SEMVER.match(version), f"VERSION '{version}' is not X.Y.Z"


def test_app_version_matches_version_file():
    assert __version__ == VERSION_FILE.read_text().strip()


def test_frontend_package_json_matches_version_file():
    pkg = json.loads((REPO_ROOT / "frontend" / "package.json").read_text())
    assert pkg["version"] == VERSION_FILE.read_text().strip()
