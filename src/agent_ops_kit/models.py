from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def now_utc() -> datetime:
    return datetime.now(UTC)


class Repository(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    local_path: str = Field(index=True, unique=True)
    remote_url: str | None = None
    default_branch: str | None = None
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Task(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    stable_key: str = Field(index=True, unique=True)
    repository_id: int = Field(foreign_key="repository.id")
    type: str
    title: str
    objective: str
    status: str = "open"
    source: str = "cli"
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Run(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(foreign_key="task.id")
    attempt_number: int = 1
    status: str = "running"
    model: str | None = None
    summary: str | None = None
    context: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON, nullable=False),
    )
    started_at: datetime = Field(default_factory=now_utc)
    finished_at: datetime | None = None


class Finding(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(foreign_key="task.id")
    run_id: int = Field(foreign_key="run.id")
    category: str
    severity: str
    status: str = "open"
    title: str
    evidence: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON, nullable=False),
    )
    recommendation: str
    file_path: str | None = None
    line_number: int | None = None
    created_at: datetime = Field(default_factory=now_utc)


class Artifact(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(foreign_key="task.id")
    run_id: int = Field(foreign_key="run.id")
    type: str
    title: str
    path_or_url: str
    metadata_: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column("metadata", JSON, nullable=False),
    )
    created_at: datetime = Field(default_factory=now_utc)
