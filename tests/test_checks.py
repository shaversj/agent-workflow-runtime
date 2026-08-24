from pathlib import Path

from agent_ops_kit.checks import run_readiness_checks


def test_missing_agent_instructions_are_reported(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text(
        "# Demo\n\nPurpose, setup, usage, and test commands are documented.\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")

    findings = run_readiness_checks(tmp_path)

    assert any(finding.title == "Repo-local AGENTS.md is missing" for finding in findings)
