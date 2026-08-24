from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine
from sqlmodel import Session, create_engine


def sqlite_url_for(repo_path: Path) -> str:
    db_path = repo_path.resolve() / ".agent-readiness" / "agent-ops.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path}"


def ensure_database(database_url: str) -> None:
    command.upgrade(_alembic_config(database_url), "head")


@contextmanager
def session_scope(database_url: str) -> Iterator[Session]:
    engine = _engine(database_url)
    with Session(engine) as session:
        yield session


def _engine(database_url: str) -> Engine:
    return create_engine(database_url)


def _alembic_config(database_url: str) -> Config:
    project_root = Path(__file__).resolve().parents[2]
    config = Config(project_root / "alembic.ini")
    config.set_main_option("script_location", str(project_root / "migrations"))
    config.attributes["database_url"] = database_url
    return config
