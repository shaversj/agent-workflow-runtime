from pathlib import Path

import pytest
from typer.testing import CliRunner

from agent_ops_kit.cli import app


def test_sweep_command_shape(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text(
        "# Demo\n\nPurpose, setup, usage, and test commands are documented.\n",
        encoding="utf-8",
    )
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nThis repository is read-only for source sweeps.\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()

    result = CliRunner().invoke(app, ["sweep", str(tmp_path)])

    assert result.exit_code == 0
    assert "Sweep complete" in result.output


def test_sweep_interpret_without_minimax_api_key_records_skipped_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MINIMAX_API_KEY", raising=False)
    (tmp_path / "README.md").write_text(
        "# Demo\n\nPurpose, setup, usage, and test commands are documented.\n",
        encoding="utf-8",
    )
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nThis repository is read-only for source sweeps.\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()

    result = CliRunner().invoke(app, ["sweep", str(tmp_path), "--interpret"])

    assert result.exit_code == 0
    assert "Interpretation: skipped" in result.output
