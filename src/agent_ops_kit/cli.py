from pathlib import Path

import typer
from rich.console import Console

from agent_ops_kit.logging import configure_logging
from agent_ops_kit.sweep import run_readiness_sweep

app = typer.Typer(help="Agent readiness and operations tools.")
console = Console()


@app.callback()
def main() -> None:
    """Agent readiness and operations tools."""
    configure_logging()


@app.command()
def sweep(repo_path: Path) -> None:
    """Run a read-only agent readiness sweep against a repository."""
    result = run_readiness_sweep(repo_path)

    console.print(f"[bold green]Sweep complete[/bold green] {result.repo_path}")
    console.print(f"Findings: {len(result.findings)}")
    console.print(f"Report: {result.report_path}")
