"""Every test gets its own disposable database; never write user conversations."""
import pytest


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setenv("TRIO_DB", str(tmp_path / "trio-test.db"))
