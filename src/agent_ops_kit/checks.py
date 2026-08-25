import re
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


@dataclass(frozen=True)
class CheckSignal:
    category: str
    title: str
    file_path: str | None = None
    evidence: dict[str, object] | None = None


@dataclass(frozen=True)
class CheckNotice:
    category: str
    title: str
    note: str
    evidence: dict[str, object] | None = None


@dataclass(frozen=True)
class ReadinessAssessment:
    findings: list[CheckFinding]
    passed_signals: list[CheckSignal]
    informational_notices: list[CheckNotice]


def run_readiness_assessment(repo_path: Path) -> ReadinessAssessment:
    repo_path = repo_path.resolve()
    return ReadinessAssessment(
        findings=run_readiness_checks(repo_path),
        passed_signals=_collect_passed_signals(repo_path),
        informational_notices=_collect_informational_notices(repo_path),
    )


def run_readiness_checks(repo_path: Path) -> list[CheckFinding]:
    repo_path = repo_path.resolve()
    findings: list[CheckFinding] = []

    findings.extend(_check_readme(repo_path))
    findings.extend(_check_agent_instructions(repo_path))
    findings.extend(_check_validation_commands(repo_path))
    findings.extend(_check_standards_discoverability(repo_path))
    findings.extend(_check_project_narrative(repo_path))
    findings.extend(_check_quality_evidence(repo_path))

    return findings


def _collect_passed_signals(repo_path: Path) -> list[CheckSignal]:
    signals: list[CheckSignal] = []

    readme = repo_path / "README.md"
    if readme.exists():
        signals.append(
            CheckSignal(
                category="documentation",
                title="README.md is present",
                file_path="README.md",
            )
        )

    agents = repo_path / "AGENTS.md"
    if agents.exists():
        signals.append(
            CheckSignal(
                category="agent-readiness",
                title="Repo-local AGENTS.md is present",
                file_path="AGENTS.md",
            )
        )

    command_files = _validation_command_files(repo_path)
    if command_files:
        signals.append(
            CheckSignal(
                category="validation",
                title="Validation commands are discoverable",
                evidence={"paths": command_files},
            )
        )

    if agents.exists():
        standard_docs = _discover_standard_docs(repo_path, agents)
        domains = _classify_standard_domains(repo_path, standard_docs.files)
        if standard_docs.has_discoverable_hub:
            signals.append(
                CheckSignal(
                    category="standards",
                    title="Standards guidance is discoverable",
                    evidence={
                        "standard_docs": [
                            _repo_relative_path(repo_path, path) for path in standard_docs.files
                        ]
                    },
                )
            )
        if domains:
            signals.append(
                CheckSignal(
                    category="standards",
                    title="Standards domains were detected",
                    evidence={"domains": [_domain_label(domain) for domain in sorted(domains)]},
                )
            )

    safety_docs = [repo_path / "README.md", repo_path / "AGENTS.md"]
    safety_text = "\n".join(_read_text(path) for path in safety_docs if path.exists()).lower()
    if any(term in safety_text for term in ("safe", "approval", "read-only", "no side effects")):
        signals.append(CheckSignal(category="safety", title="Safety boundaries are documented"))

    quality_paths = _quality_evidence_paths(repo_path)
    if quality_paths:
        signals.append(
            CheckSignal(
                category="quality",
                title="Quality proof is visible",
                evidence={"paths": quality_paths},
            )
        )

    return signals


def _collect_informational_notices(repo_path: Path) -> list[CheckNotice]:
    agents = repo_path / "AGENTS.md"
    if not agents.exists():
        return []

    standard_docs = _discover_standard_docs(repo_path, agents)
    domains = _classify_standard_domains(repo_path, standard_docs.files)
    return [
        CheckNotice(
            category="standards",
            title=f"{_domain_label(domain)} standard not found",
            note=f"May not be needed unless {guidance}.",
            evidence={"status": "not_found"},
        )
        for domain, guidance in _OPTIONAL_STANDARD_GUIDANCE.items()
        if domain not in domains
    ]


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
    if _validation_command_files(repo_path):
        return []

    return [
        CheckFinding(
            category="validation",
            severity="medium",
            title="Validation commands are not discoverable",
            recommendation="Document the common test, lint, typecheck, and build commands in README.md or AGENTS.md.",
        )
    ]


def _check_standards_discoverability(repo_path: Path) -> list[CheckFinding]:
    agents = repo_path / "AGENTS.md"
    if not agents.exists():
        return []

    standard_docs = _discover_standard_docs(repo_path, agents)
    domains = _classify_standard_domains(repo_path, standard_docs.files)

    findings: list[CheckFinding] = []
    if standard_docs.unresolved_references:
        findings.append(
            CheckFinding(
                category="standards",
                severity="medium",
                title="Standards references do not resolve",
                recommendation="Fix or remove standards links so agents can follow the guidance directly.",
                evidence={"unresolved_references": standard_docs.unresolved_references},
            )
        )

    if not standard_docs.has_discoverable_hub:
        findings.append(
            CheckFinding(
                category="standards",
                severity="medium",
                title="No discoverable standards hub found",
                recommendation=(
                    "Add or link durable standards guidance from AGENTS.md. The location can be "
                    "docs/standards, CONTRIBUTING.md, an engineering guide, or AGENTS.md sections."
                ),
                file_path="AGENTS.md",
                evidence={"searched_paths": standard_docs.searched_paths},
            )
        )

    required_domains = ["testing", "logging", "security_privacy"]
    if _has_dependency_tooling(repo_path):
        required_domains.append("dependency_management")
    if _has_database_tooling(repo_path):
        required_domains.append("database")

    missing_domains = [domain for domain in required_domains if domain not in domains]
    if missing_domains:
        findings.append(
            CheckFinding(
                category="standards",
                severity="medium",
                title="Standards coverage is incomplete",
                recommendation=(
                    "Add or link guidance for these domains: "
                    f"{', '.join(_domain_label(domain) for domain in missing_domains)}."
                ),
                evidence={
                    "missing_domains": missing_domains,
                    "found_domains": sorted(domains),
                    "standard_docs": [
                        _repo_relative_path(repo_path, path) for path in standard_docs.files
                    ],
                },
            )
        )

    return findings


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
    if _quality_evidence_paths(repo_path):
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


def _validation_command_files(repo_path: Path) -> list[str]:
    command_files = [
        "Makefile",
        "package.json",
        "pyproject.toml",
        "justfile",
        "Taskfile.yml",
    ]
    return [name for name in command_files if (repo_path / name).exists()]


def _quality_evidence_paths(repo_path: Path) -> list[str]:
    evidence_paths = [
        repo_path / "tests",
        repo_path / ".github" / "workflows",
        repo_path / "pytest.ini",
    ]
    return [_repo_relative_path(repo_path, path) for path in evidence_paths if path.exists()]


@dataclass(frozen=True)
class StandardDocs:
    files: list[Path]
    unresolved_references: list[str]
    searched_paths: list[str]
    has_discoverable_hub: bool


_IGNORED_MARKDOWN_DIRS = {
    ".agent-readiness",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "node_modules",
}

_STANDARD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_BARE_MARKDOWN_PATH_RE = re.compile(
    r"(?<![\w/.-])((?:\.github|\.agents|docs|documentation|engineering|standards)/[\w./-]+\.md|CONTRIBUTING\.md)"
)

_STANDARD_SIGNAL_TERMS = (
    "standard",
    "standards",
    "contributing",
    "engineering",
    "development workflow",
    "testing",
    "logging",
    "security",
    "privacy",
    "database",
    "dependency",
    "dependencies",
)

_DOMAIN_TERMS = {
    "access_control": (
        "access control",
        "authentication",
        "authorization",
        "rbac",
        "permission",
        "permissions",
    ),
    "api_response_format": (
        "api response",
        "response format",
        "pagination",
        "filtering",
        "sorting",
        "crud",
    ),
    "configuration": (
        "configuration",
        "config",
        "settings",
        "environment variables",
        "env vars",
    ),
    "exceptions": (
        "exception",
        "exceptions",
        "error handling",
        "problem types",
        "retry classification",
    ),
    "formatting": (
        "formatting",
        "formatter",
        "pre-commit",
        "ruff format",
        "prettier",
    ),
    "imports_modules": (
        "imports",
        "modules",
        "import ordering",
        "__init__.py",
    ),
    "locks": (
        "lock",
        "locks",
        "thread safety",
        "mutex",
        "state machine",
    ),
    "observability": (
        "observability",
        "metrics",
        "instrumentation",
        "prometheus",
        "telemetry",
    ),
    "openapi_spec_management": (
        "openapi",
        "asyncapi",
        "spec management",
        "contract generation",
        "drift detection",
    ),
    "services": (
        "service layer",
        "services",
        "dependency injection",
        "middleware",
        "periodic workers",
    ),
    "static_analysis": (
        "static analysis",
        "dead code",
        "vulture",
        "import cycle",
        "pyan",
    ),
    "testing": (
        "test",
        "tests",
        "testing",
        "pytest",
        "vitest",
        "playwright",
        "coverage",
        "regression",
    ),
    "logging": (
        "log",
        "logs",
        "logging",
        "logger",
        "structlog",
        "pino",
        "winston",
        "diagnostic logs",
    ),
    "security_privacy": (
        "security",
        "privacy",
        "secret",
        "secrets",
        "credential",
        "credentials",
        "token",
        "approval",
        "read-only",
        "hmac",
        "auth",
        "safe",
    ),
    "dependency_management": (
        "dependency",
        "dependencies",
        "package manager",
        "lockfile",
        "lock file",
        "uv sync",
        "npm install",
        "requirements",
        "version pinning",
    ),
    "database": (
        "database",
        "migration",
        "migrations",
        "alembic",
        "sqlmodel",
        "sqlalchemy",
        "postgres",
        "sqlite",
        "prisma",
        "drizzle",
    ),
    "ui_api_parity": (
        "ui-api parity",
        "ui api parity",
        "typed clients",
        "full-stack pr workflow",
        "contract generation",
    ),
}

_DOMAIN_LABELS = {
    "access_control": "access control",
    "api_response_format": "API response format",
    "configuration": "configuration",
    "testing": "testing",
    "exceptions": "exceptions",
    "formatting": "formatting",
    "imports_modules": "imports/modules",
    "locks": "locks",
    "logging": "logging",
    "observability": "observability",
    "openapi_spec_management": "OpenAPI spec management",
    "services": "services",
    "security_privacy": "security/privacy",
    "static_analysis": "static analysis",
    "dependency_management": "dependency management",
    "database": "database",
    "ui_api_parity": "UI-API parity",
}

_OPTIONAL_STANDARD_GUIDANCE = {
    "access_control": "the repo handles authentication, authorization, RBAC, or permissions",
    "api_response_format": "the repo exposes HTTP APIs with response contracts, pagination, filtering, or CRUD patterns",
    "configuration": "the repo has non-trivial settings, environment variables, or deployment modes",
    "exceptions": "the repo has shared error handling, retries, or public error contracts",
    "formatting": "formatting rules are not fully enforced by existing tools",
    "imports_modules": "module boundaries or import conventions are a recurring source of inconsistency",
    "locks": "the repo has concurrent state, thread safety concerns, or explicit locking",
    "observability": "the system has metrics, traces, telemetry, or production monitoring expectations",
    "openapi_spec_management": "API specs, generated clients, or contract drift matter",
    "services": "the codebase has a service layer, middleware patterns, or dependency injection conventions",
    "static_analysis": "the repo relies on dead-code checks, import-cycle checks, or static-analysis allowlists",
    "ui_api_parity": "the repo spans UI and API contracts that must stay aligned",
}


def _discover_standard_docs(repo_path: Path, agents: Path) -> StandardDocs:
    agents_text = _read_text(agents)
    referenced_files, unresolved_references = _standard_references_from_text(
        repo_path=repo_path,
        source_path=agents,
        text=agents_text,
    )
    conventional_files = _find_conventional_standard_docs(repo_path)

    files = {agents, *referenced_files, *conventional_files}
    initial_files = tuple(files)
    for path in initial_files:
        if path.exists() and path.is_file():
            linked_files, linked_unresolved = _standard_references_from_text(
                repo_path=repo_path,
                source_path=path,
                text=_read_text(path),
            )
            files.update(linked_files)
            unresolved_references.extend(linked_unresolved)

    standard_files = sorted(
        {path.resolve() for path in files if path.exists() and path.is_file()},
        key=lambda path: _repo_relative_path(repo_path, path),
    )
    has_hub = _agents_has_standard_guidance(agents_text) or any(
        _looks_like_standard_hub(repo_path, path) for path in standard_files if path != agents
    )

    return StandardDocs(
        files=standard_files,
        unresolved_references=sorted(set(unresolved_references)),
        searched_paths=sorted(_searched_standard_paths(repo_path)),
        has_discoverable_hub=has_hub,
    )


def _standard_references_from_text(
    repo_path: Path,
    source_path: Path,
    text: str,
) -> tuple[set[Path], list[str]]:
    files: set[Path] = set()
    unresolved: list[str] = []

    references = [
        (label, _clean_reference_target(target))
        for label, target in _STANDARD_LINK_RE.findall(text)
        if _looks_like_standard_reference(f"{label} {target}")
    ]
    references.extend(
        (target, target)
        for target in _BARE_MARKDOWN_PATH_RE.findall(text)
        if _looks_like_bare_standard_path(target)
    )

    for _, target in references:
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, flags=re.IGNORECASE):
            continue
        resolved = _resolve_local_reference(repo_path, source_path, target)
        if resolved is None:
            unresolved.append(f"{_repo_relative_path(repo_path, source_path)}: {target}")
            continue
        if resolved.is_dir():
            files.update(path for path in resolved.glob("*.md") if path.is_file())
            readme = resolved / "README.md"
            if readme.exists():
                files.add(readme)
            continue
        files.add(resolved)

    return files, unresolved


def _resolve_local_reference(repo_path: Path, source_path: Path, target: str) -> Path | None:
    clean_target = target.split("#", 1)[0].split("?", 1)[0]
    if not clean_target:
        return source_path

    candidate = (
        repo_path / clean_target.removeprefix("/")
        if target.startswith("/")
        else source_path.parent / clean_target
    )
    try:
        resolved = candidate.resolve()
        resolved.relative_to(repo_path)
    except ValueError:
        return None

    if resolved.exists():
        return resolved
    return None


def _find_conventional_standard_docs(repo_path: Path) -> set[Path]:
    docs: set[Path] = set()
    for path in repo_path.rglob("*.md"):
        if _is_ignored_markdown_path(repo_path, path):
            continue
        if path.name == "README.md" and path.parent == repo_path:
            continue
        if _is_conventional_standard_path(repo_path, path) or _looks_like_standard_hub(
            repo_path, path
        ):
            docs.add(path)
    return docs


def _classify_standard_domains(repo_path: Path, paths: list[Path]) -> set[str]:
    domains: set[str] = set()
    for path in paths:
        domains.update(
            _classify_text_domains(_repo_relative_path(repo_path, path), _read_text(path))
        )
    return domains


def _classify_text_domains(relative_path: str, text: str) -> set[str]:
    searchable = f"{relative_path}\n{text}".lower()
    return {
        domain
        for domain, terms in _DOMAIN_TERMS.items()
        if any(_contains_term(searchable, term) for term in terms)
    }


def _looks_like_standard_reference(text: str) -> bool:
    lowered = text.lower()
    return any(_contains_term(lowered, term) for term in _STANDARD_SIGNAL_TERMS)


def _clean_reference_target(target: str) -> str:
    target = target.strip()
    if target.startswith("<") and ">" in target:
        return target[1 : target.index(">")]
    return target.split(maxsplit=1)[0]


def _contains_term(text: str, term: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text) is not None


def _looks_like_bare_standard_path(path: str) -> bool:
    lowered = path.lower()
    parts = Path(lowered).parts
    stem = Path(lowered).stem
    return (
        "standards" in parts
        or "engineering" in parts
        or stem
        in {
            "contributing",
            "database",
            "dependency-management",
            "dependencies",
            "engineering",
            "logging",
            "practices",
            "security",
            "security-and-privacy",
            "standards",
            "testing",
        }
    )


def _looks_like_standard_hub(repo_path: Path, path: Path) -> bool:
    relative_path = _repo_relative_path(repo_path, path).lower()
    text = _read_text(path).lower()
    if "standard" in relative_path or "contributing.md" == relative_path:
        return True
    headings = re.findall(r"^#{1,3}\s+(.+)$", text, flags=re.MULTILINE)
    return any("standard" in heading or "contributing" in heading for heading in headings)


def _is_conventional_standard_path(repo_path: Path, path: Path) -> bool:
    relative = Path(_repo_relative_path(repo_path, path).lower())
    parts = relative.parts
    path_text = relative.as_posix()
    return (
        path_text
        in {
            ".github/copilot-instructions.md",
            "contributing.md",
            "docs/development/standards.md",
        }
        or parts[:2]
        in {
            ("docs", "standards"),
            ("docs", "engineering"),
            ("documentation", "standards"),
        }
        or parts[:1]
        in {
            ("standards",),
            ("engineering",),
        }
    )


def _agents_has_standard_guidance(text: str) -> bool:
    lowered = text.lower()
    return any(
        heading in lowered
        for heading in (
            "## standards",
            "## testing convention",
            "## testing conventions",
            "## hard constraints",
            "## safety boundaries",
        )
    )


def _has_dependency_tooling(repo_path: Path) -> bool:
    return any(
        (repo_path / path).exists()
        for path in (
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "uv.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
        )
    )


def _has_database_tooling(repo_path: Path) -> bool:
    if any(
        (repo_path / path).exists()
        for path in (
            "alembic.ini",
            "prisma/schema.prisma",
            "drizzle.config.ts",
            "drizzle.config.js",
            "supabase/migrations",
        )
    ):
        return True

    manifests = [
        repo_path / "pyproject.toml",
        repo_path / "requirements.txt",
        repo_path / "package.json",
    ]
    text = "\n".join(_read_text(path).lower() for path in manifests if path.exists())
    return any(
        term in text
        for term in (
            "sqlmodel",
            "sqlalchemy",
            "alembic",
            "psycopg",
            "asyncpg",
            "pg",
            "prisma",
            "drizzle",
            "sqlite",
            "postgres",
        )
    )


def _is_ignored_markdown_path(repo_path: Path, path: Path) -> bool:
    relative_parts = path.resolve().relative_to(repo_path).parts
    return any(part in _IGNORED_MARKDOWN_DIRS for part in relative_parts)


def _searched_standard_paths(repo_path: Path) -> list[str]:
    paths = [
        repo_path / "AGENTS.md",
        repo_path / "CONTRIBUTING.md",
        repo_path / "docs" / "standards",
        repo_path / "docs" / "engineering",
        repo_path / "docs" / "development" / "standards.md",
        repo_path / ".github" / "copilot-instructions.md",
    ]
    return [_repo_relative_path(repo_path, path) for path in paths]


def _repo_relative_path(repo_path: Path, path: Path) -> str:
    return path.resolve().relative_to(repo_path).as_posix()


def _domain_label(domain: str) -> str:
    return _DOMAIN_LABELS.get(domain, domain.replace("_", " "))
