from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import structlog
from sqlmodel import Session, select

from agent_ops_kit.checks import CheckFinding, run_readiness_assessment
from agent_ops_kit.db import ensure_database, session_scope, sqlite_url_for
from agent_ops_kit.interpretation import (
    DEFAULT_INTERPRETATION_MODEL,
    SweepInterpretation,
    SweepInterpreter,
    run_pydantic_interpretation,
)
from agent_ops_kit.models import Artifact, Finding, Repository, Run, Task
from agent_ops_kit.reports import write_sweep_report
from agent_ops_kit.repository import default_branch, remote_url, repo_name

logger = structlog.stdlib.get_logger(__name__)


@dataclass(frozen=True)
class SweepResult:
    repo_path: Path
    task_id: int
    run_id: int
    report_path: Path
    findings: list[CheckFinding]
    interpretation: SweepInterpretation | None = None


def run_readiness_sweep(
    repo_path: Path,
    *,
    interpret: bool = False,
    interpretation_model: str = DEFAULT_INTERPRETATION_MODEL,
    interpreter: SweepInterpreter | None = None,
) -> SweepResult:
    repo_path = repo_path.resolve()
    structlog.contextvars.clear_contextvars()
    if not repo_path.exists() or not repo_path.is_dir():
        logger.error("readiness_sweep.invalid_repo_path", repo_path=str(repo_path))
        raise ValueError(f"Repository path does not exist: {repo_path}")

    name = repo_name(repo_path)
    structlog.contextvars.bind_contextvars(repo_path=str(repo_path), repo_name=name)
    logger.info("readiness_sweep.started")

    database_url = sqlite_url_for(repo_path)
    ensure_database(database_url)
    assessment = run_readiness_assessment(repo_path)
    findings = assessment.findings
    interpretation = None
    if interpret:
        interpretation_runner = interpreter or run_pydantic_interpretation
        interpretation = interpretation_runner(repo_path, assessment, interpretation_model)

    with session_scope(database_url) as session:
        repository = _upsert_repository(session, repo_path)
        task = _upsert_task(session, repository)
        run = Run(
            task_id=_require_id(task),
            status="running",
            context={"repo_path": str(repo_path)},
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        structlog.contextvars.bind_contextvars(
            repository_id=_require_id(repository),
            task_id=_require_id(task),
            run_id=_require_id(run),
        )

        for item in findings:
            session.add(
                Finding(
                    task_id=_require_id(task),
                    run_id=_require_id(run),
                    category=item.category,
                    severity=item.severity,
                    title=item.title,
                    evidence=item.evidence or {},
                    recommendation=item.recommendation,
                    file_path=item.file_path,
                )
            )

        run.status = "complete"
        run.summary = f"{len(findings)} finding(s)"
        run.finished_at = datetime.now(UTC)
        session.add(run)
        session.commit()
        session.refresh(run)

        report_path = write_sweep_report(
            repo_path,
            _require_id(run),
            findings,
            assessment.passed_signals,
            assessment.informational_notices,
            interpretation,
        )
        session.add(
            Artifact(
                task_id=_require_id(task),
                run_id=_require_id(run),
                type="markdown_report",
                title="Agent Readiness Sweep",
                path_or_url=str(report_path),
            )
        )
        session.commit()
        logger.info(
            "readiness_sweep.completed",
            finding_count=len(findings),
            report_path=str(report_path),
        )

        return SweepResult(
            repo_path=repo_path,
            task_id=_require_id(task),
            run_id=_require_id(run),
            report_path=report_path,
            findings=findings,
            interpretation=interpretation,
        )


def _upsert_repository(session: Session, repo_path: Path) -> Repository:
    statement = select(Repository).where(Repository.local_path == str(repo_path))
    repository = session.exec(statement).first()
    if repository is None:
        repository = Repository(
            name=repo_name(repo_path),
            local_path=str(repo_path),
            remote_url=remote_url(repo_path),
            default_branch=default_branch(repo_path),
        )
    else:
        repository.remote_url = remote_url(repo_path)
        repository.default_branch = default_branch(repo_path)
        repository.updated_at = datetime.now(UTC)

    session.add(repository)
    session.commit()
    session.refresh(repository)
    return repository


def _upsert_task(session: Session, repository: Repository) -> Task:
    repository_id = _require_id(repository)
    stable_key = f"repo-readiness:{repository_id}"
    statement = select(Task).where(Task.stable_key == stable_key)
    task = session.exec(statement).first()
    if task is None:
        task = Task(
            stable_key=stable_key,
            repository_id=repository_id,
            type="repo_readiness_sweep",
            title="Repo readiness sweep",
            objective="Identify missing signals that make a repo easier and safer for agents to work in.",
        )
    else:
        task.updated_at = datetime.now(UTC)

    session.add(task)
    session.commit()
    session.refresh(task)
    return task


def _require_id(model: Repository | Task | Run) -> int:
    if model.id is None:
        raise RuntimeError(f"{type(model).__name__} has not been persisted")
    return model.id
