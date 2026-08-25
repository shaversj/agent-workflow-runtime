from pathlib import Path

from agent_ops_kit.checks import (
    CheckFinding,
    CheckNotice,
    CheckSignal,
    run_readiness_assessment,
    run_readiness_checks,
)
from agent_ops_kit.reports import _render_report


def test_missing_agent_instructions_are_reported(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text(
        "# Demo\n\nPurpose, setup, usage, and test commands are documented.\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")

    findings = run_readiness_checks(tmp_path)

    assert any(finding.title == "Repo-local AGENTS.md is missing" for finding in findings)


def test_docs_standards_directory_satisfies_standards_coverage(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        '# Agent Instructions\n\nConsult [Standards](docs/standards/README.md "standards guide").\n',
        encoding="utf-8",
    )
    standards = tmp_path / "docs" / "standards"
    standards.mkdir(parents=True)
    (standards / "README.md").write_text(
        "# Standards\n\n"
        "- [Testing](testing.md)\n"
        "- [Logging](logging.md)\n"
        "- [Security and Privacy](security-and-privacy.md)\n"
        "- [Dependency Management](dependency-management.md)\n",
        encoding="utf-8",
    )
    (standards / "testing.md").write_text(
        "# Testing\n\nUse pytest for regression tests.\n", encoding="utf-8"
    )
    (standards / "logging.md").write_text(
        "# Logging\n\nUse structured logging.\n", encoding="utf-8"
    )
    (standards / "security-and-privacy.md").write_text(
        "# Security and Privacy\n\nKeep secrets and credentials out of logs.\n",
        encoding="utf-8",
    )
    (standards / "dependency-management.md").write_text(
        "# Dependency Management\n\nUse uv sync and keep the lockfile current.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert findings == []


def test_linked_custom_standards_location_is_accepted(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path, manifest="package.json")
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nFollow [Engineering Standards](engineering/practices.md).\n",
        encoding="utf-8",
    )
    (tmp_path / "engineering").mkdir()
    (tmp_path / "engineering" / "practices.md").write_text(
        "# Engineering Standards\n\n"
        "## Testing\nUse npm test for coverage.\n\n"
        "## Logging\nKeep diagnostic logs structured.\n\n"
        "## Security and Privacy\nDo not expose secrets or credentials.\n\n"
        "## Dependency Management\nUse npm install and commit lockfile changes.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert findings == []


def test_unresolved_standards_link_is_reported(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nFollow [Testing Standard](docs/missing/testing.md).\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert any(
        finding.title == "Standards references do not resolve"
        and finding.evidence == {"unresolved_references": ["AGENTS.md: docs/missing/testing.md"]}
        for finding in findings
    )


def test_non_standard_topic_docs_are_not_reported_as_broken_standards_links(
    tmp_path: Path,
) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\n"
        "## Standards\n"
        "## Testing Convention\nUse pytest.\n\n"
        "## Hard Constraints\nKeep secrets private.\n\n"
        "Useful topic docs:\n"
        "- docs/plans/2026-01-01-test-outcome-plan.md\n"
        "- docs/learnings.md\n"
        "- .agents/skills/incident-triage/SKILL.md\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert not any(finding.title == "Standards references do not resolve" for finding in findings)


def test_conventional_discovery_ignores_unlinked_topic_docs_with_domain_words(
    tmp_path: Path,
) -> None:
    _write_repo_baseline(tmp_path, manifest="package.json")
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\n## Standards\nUse repo-local guidance.\n",
        encoding="utf-8",
    )
    runbooks = tmp_path / "fixtures" / "runbooks"
    runbooks.mkdir(parents=True)
    (runbooks / "dependency-outage.md").write_text(
        "# Dependency Outage\n\nA runbook, not an engineering standard.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    coverage = next(
        finding for finding in findings if finding.title == "Standards coverage is incomplete"
    )
    assert coverage.evidence is not None
    assert coverage.evidence["missing_domains"] == [
        "testing",
        "logging",
        "security_privacy",
        "dependency_management",
    ]


def test_broken_standard_hub_link_reports_source_document(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nFollow [Standards](docs/standards/README.md).\n",
        encoding="utf-8",
    )
    standards = tmp_path / "docs" / "standards"
    standards.mkdir(parents=True)
    (standards / "README.md").write_text(
        "# Standards\n\n- [Testing](missing-testing.md)\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert any(
        finding.title == "Standards references do not resolve"
        and finding.evidence
        == {"unresolved_references": ["docs/standards/README.md: missing-testing.md"]}
        for finding in findings
    )


def test_domain_terms_do_not_match_inside_unrelated_words(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path, manifest="package.json")
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\n## Standards\nUse the latest catalog authored guidance.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    coverage = next(
        finding for finding in findings if finding.title == "Standards coverage is incomplete"
    )
    assert coverage.evidence is not None
    assert coverage.evidence["missing_domains"] == [
        "testing",
        "logging",
        "security_privacy",
        "dependency_management",
    ]


def test_missing_standards_surface_is_reported_for_package_repo(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path, manifest="package.json")
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nRun npm test before handoff.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    assert any(finding.title == "No discoverable standards hub found" for finding in findings)
    coverage = next(
        finding for finding in findings if finding.title == "Standards coverage is incomplete"
    )
    assert coverage.evidence is not None
    assert coverage.evidence["missing_domains"] == [
        "logging",
        "security_privacy",
        "dependency_management",
    ]


def test_database_standard_is_required_when_database_tooling_is_detected(tmp_path: Path) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\nFollow [Engineering Standards](docs/engineering.md).\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = 'demo'\ndependencies = ['sqlmodel', 'alembic']\n",
        encoding="utf-8",
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "engineering.md").write_text(
        "# Engineering Standards\n\n"
        "## Testing\nUse pytest.\n\n"
        "## Logging\nUse structured logging.\n\n"
        "## Security and Privacy\nKeep secrets private.\n\n"
        "## Dependency Management\nUse uv sync.\n",
        encoding="utf-8",
    )

    findings = _standards_findings(tmp_path)

    coverage = next(
        finding for finding in findings if finding.title == "Standards coverage is incomplete"
    )
    assert coverage.evidence is not None
    assert coverage.evidence["missing_domains"] == ["database"]


def test_report_renders_evidence_column_and_escapes_table_cells(tmp_path: Path) -> None:
    report = _render_report(
        tmp_path,
        [
            CheckFinding(
                category="standards",
                severity="medium",
                title="Standards coverage is incomplete",
                recommendation="Add logging guidance.",
                file_path="AGENTS.md",
                evidence={"missing_domains": ["logging|observability"]},
            )
        ],
    )

    assert "| Severity | Category | Finding | Recommendation | Evidence |" in report
    assert "path=AGENTS.md; missing_domains=logging\\|observability" in report


def test_report_renders_passed_signals(tmp_path: Path) -> None:
    report = _render_report(
        tmp_path,
        [],
        [
            CheckSignal(
                category="standards",
                title="Standards guidance is discoverable",
                evidence={"standard_docs": ["docs/standards/README.md"]},
            )
        ],
    )

    assert "## Passed Signals" in report
    assert "| standards | Standards guidance is discoverable |" in report
    assert "standard_docs=docs/standards/README.md" in report


def test_assessment_records_optional_standards_not_found_as_information(
    tmp_path: Path,
) -> None:
    _write_repo_baseline(tmp_path)
    (tmp_path / "AGENTS.md").write_text(
        "# Agent Instructions\n\n"
        "## Standards\n"
        "## Testing Convention\nUse pytest.\n\n"
        "## Logging\nUse structured logging.\n\n"
        "## Hard Constraints\nKeep secrets private.\n\n"
        "## Dependency Management\nUse uv sync.\n",
        encoding="utf-8",
    )

    assessment = run_readiness_assessment(tmp_path)

    assert not any(
        finding.title == "access control standard not found" for finding in assessment.findings
    )
    assert any(
        notice.title == "access control standard not found"
        and notice.note
        == "May not be needed unless the repo handles authentication, authorization, RBAC, or permissions."
        for notice in assessment.informational_notices
    )


def test_report_renders_standards_not_found_as_informational(tmp_path: Path) -> None:
    report = _render_report(
        tmp_path,
        [],
        [],
        [
            CheckNotice(
                category="standards",
                title="access control standard not found",
                note="May not be needed unless the repo handles permissions.",
                evidence={"status": "not_found"},
            )
        ],
    )

    assert "## Standards Not Found" in report
    assert "These are informational." in report
    assert "| access control standard not found |" in report
    assert "status=not_found" in report


def _standards_findings(repo_path: Path) -> list[CheckFinding]:
    return [
        finding for finding in run_readiness_checks(repo_path) if finding.category == "standards"
    ]


def _write_repo_baseline(tmp_path: Path, manifest: str = "pyproject.toml") -> None:
    (tmp_path / "README.md").write_text(
        "# Demo\n\nPurpose, setup, usage, and test commands are documented.\n",
        encoding="utf-8",
    )
    if manifest == "package.json":
        (tmp_path / "package.json").write_text('{"scripts":{"test":"vitest"}}\n', encoding="utf-8")
    else:
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
