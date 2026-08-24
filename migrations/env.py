from logging.config import fileConfig
from pathlib import Path
from urllib.parse import unquote, urlparse

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlmodel import SQLModel

from agent_ops_kit import models  # noqa: F401

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = SQLModel.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def _database_url() -> str:
    return config.attributes.get("database_url") or config.get_main_option("sqlalchemy.url")


def _ensure_sqlite_parent(database_url: str) -> None:
    parsed = urlparse(database_url)
    if parsed.scheme != "sqlite":
        return

    if database_url == "sqlite:///:memory:":
        return

    if database_url.startswith("sqlite:////"):
        db_path = Path(unquote(database_url.removeprefix("sqlite:///")))
    else:
        db_path = Path(unquote(database_url.removeprefix("sqlite:///")))
        if not db_path.is_absolute():
            db_path = Path.cwd() / db_path

    db_path.parent.mkdir(parents=True, exist_ok=True)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = _database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    section = config.get_section(config.config_ini_section, {})
    if section is None:
        section = {}
    database_url = _database_url()
    _ensure_sqlite_parent(database_url)
    section["sqlalchemy.url"] = database_url

    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
