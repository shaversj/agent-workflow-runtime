from pathlib import Path
from subprocess import DEVNULL, CalledProcessError, check_output


def repo_name(repo_path: Path) -> str:
    return repo_path.resolve().name


def remote_url(repo_path: Path) -> str | None:
    return _git_output(repo_path, "config", "--get", "remote.origin.url")


def default_branch(repo_path: Path) -> str | None:
    branch = _git_output(repo_path, "branch", "--show-current")
    if branch:
        return branch
    return _git_output(repo_path, "rev-parse", "--abbrev-ref", "HEAD")


def _git_output(repo_path: Path, *args: str) -> str | None:
    try:
        output = check_output(
            ["git", "-C", str(repo_path), *args],
            stderr=DEVNULL,
            text=True,
        ).strip()
    except (CalledProcessError, OSError):
        return None
    return output or None
