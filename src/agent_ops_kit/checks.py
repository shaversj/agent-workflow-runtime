from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CheckFinding:
    category: str
    severity: str
    title: str
    recommendation: str
    file_path: str | None = None
    evidence: dict[str, object] | None = None


def run_readiness_checks(repo_path: Path) -> list[CheckFinding]:
    repo_path = repo_path.resolve()
    findings: list[CheckFinding] = []

    findings.extend(_check_readme(repo_path))
    findings.extend(_check_agent_instructions(repo_path))
    findings.extend(_check_validation_commands(repo_path))
    findings.extend(_check_project_narrative(repo_path))
    findings.extend(_check_quality_evidence(repo_path))

    return findings


def _check_readme(repo_path: Path) -> list[CheckFinding]:
    readme = repo_path / "README.md"
    if not readme.exists():
        return [
            CheckFinding(
                category="documentation",
                severity="high",
                title="README.md is missing",
                recommendation="Add a README that explains purpose, setup, usage, validation, and safety boundaries.",
            )
        ]

    text = _read_text(readme)
    missing = [
        label
        for label, terms in {
            "purpose": ("purpose", "what it does", "overview"),
            "setup": ("setup", "install", "getting started"),
            "usage": ("usage", "run", "command"),
            "validation": ("test", "lint", "validate", "check"),
        }.items()
        if not any(term in text.lower() for term in terms)
    ]

    if not missing:
        return []

    return [
        CheckFinding(
            category="documentation",
            severity="medium",
            title="README is missing agent-useful sections",
            recommendation=f"Add or clarify these sections: {', '.join(missing)}.",
            file_path="README.md",
            evidence={"missing_sections": missing},
        )
    ]


def _check_agent_instructions(repo_path: Path) -> list[CheckFinding]:
    if (repo_path / "AGENTS.md").exists():
        return []

    return [
        CheckFinding(
            category="agent-readiness",
            severity="high",
            title="Repo-local AGENTS.md is missing",
            recommendation="Add AGENTS.md with project purpose, validation commands, migration rules, and safety boundaries.",
        )
    ]


def _check_validation_commands(repo_path: Path) -> list[CheckFinding]:
    command_files = [
        "Makefile",
        "package.json",
        "pyproject.toml",
        "justfile",
        "Taskfile.yml",
    ]
    present = [name for name in command_files if (repo_path / name).exists()]
    if present:
        return []

    return [
        CheckFinding(
            category="validation",
            severity="medium",
            title="Validation commands are not discoverable",
            recommendation="Document the common test, lint, typecheck, and build commands in README.md or AGENTS.md.",
        )
    ]


def _check_project_narrative(repo_path: Path) -> list[CheckFinding]:
    docs = [repo_path / "README.md", repo_path / "AGENTS.md"]
    text = "\n".join(_read_text(path) for path in docs if path.exists()).lower()

    if any(term in text for term in ("safe", "approval", "read-only", "no side effects")):
        return []

    return [
        CheckFinding(
            category="safety",
            severity="medium",
            title="Safety boundaries are not obvious",
            recommendation="State what the project may read or change, and where human approval is required.",
        )
    ]


def _check_quality_evidence(repo_path: Path) -> list[CheckFinding]:
    evidence_paths = [
        repo_path / "tests",
        repo_path / ".github" / "workflows",
        repo_path / "pytest.ini",
    ]
    if any(path.exists() for path in evidence_paths):
        return []

    return [
        CheckFinding(
            category="quality",
            severity="medium",
            title="Quality proof is not visible",
            recommendation="Add focused tests, CI, or documented manual checks that prove important behavior works.",
        )
    ]


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ""
