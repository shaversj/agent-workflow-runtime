from pathlib import Path

from agent_ops_kit.sweep import run_readiness_sweep


def test_sweep_persists_report_and_database(tmp_path: Path) -> None:
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

    result = run_readiness_sweep(tmp_path)

    assert result.report_path.exists()
    assert (tmp_path / ".agent-readiness" / "agent-ops.db").exists()
