from pathlib import Path

import pytest
from structlog import contextvars
from structlog.testing import capture_logs

from agent_ops_kit.checks import ReadinessAssessment
from agent_ops_kit.interpretation import (
    InterpretationOutput,
    InterpretationUsage,
    SweepInterpretation,
)
from agent_ops_kit.logging import configure_logging
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
    report = result.report_path.read_text(encoding="utf-8")
    assert "## Passed Signals" in report
    assert "## Standards Not Found" in report
    assert "may not be needed" in report
    assert "README.md is present" in report
    assert "Repo-local AGENTS.md is present" in report
    assert (tmp_path / ".agent-readiness" / "agent-ops.db").exists()


def test_sweep_can_include_injected_interpretation(tmp_path: Path) -> None:
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

    def fake_interpreter(
        repo_path: Path,
        assessment: ReadinessAssessment,
        model: str,
    ) -> SweepInterpretation:
        return SweepInterpretation(
            status="completed",
            provider="test",
            model=model,
            output=InterpretationOutput(
                overall_judgment=f"{repo_path.name} has {len(assessment.findings)} findings.",
                required_fixes=[],
                optional_improvements=["Consider tightening standards over time."],
                next_step="Rerun the sweep after edits.",
            ),
            usage=InterpretationUsage(
                requests=1,
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
            ),
        )

    result = run_readiness_sweep(
        tmp_path,
        interpret=True,
        interpretation_model="test-model",
        interpreter=fake_interpreter,
    )

    report = result.report_path.read_text(encoding="utf-8")
    assert result.interpretation is not None
    assert result.interpretation.usage.total_tokens == 15
    assert "## LLM Interpretation" in report
    assert "Consider tightening standards over time." in report
    assert "| Total tokens | 15 |" in report


def test_sweep_emits_structured_lifecycle_logs(tmp_path: Path) -> None:
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

    with capture_logs(processors=[contextvars.merge_contextvars]) as logs:
        result = run_readiness_sweep(tmp_path)

    started = next(item for item in logs if item["event"] == "readiness_sweep.started")
    completed = next(item for item in logs if item["event"] == "readiness_sweep.completed")

    assert started["repo_path"] == str(tmp_path.resolve())
    assert started["repo_name"] == tmp_path.name
    assert completed["task_id"] == result.task_id
    assert completed["run_id"] == result.run_id
    assert completed["finding_count"] == len(result.findings)
    assert completed["report_path"] == str(result.report_path)


def test_configured_logging_survives_database_migration(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
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

    configure_logging()
    run_readiness_sweep(tmp_path)

    stderr = capsys.readouterr().err
    assert "readiness_sweep.started" in stderr
    assert "readiness_sweep.completed" in stderr
