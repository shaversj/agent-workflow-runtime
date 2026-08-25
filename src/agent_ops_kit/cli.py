from pathlib import Path

import typer
from rich.console import Console

from agent_ops_kit.interpretation import DEFAULT_INTERPRETATION_MODEL
from agent_ops_kit.logging import configure_logging
from agent_ops_kit.sweep import run_readiness_sweep

app = typer.Typer(help="Agent readiness and operations tools.")
console = Console()


@app.callback()
def main() -> None:
    """Agent readiness and operations tools."""
    configure_logging()


@app.command()
def sweep(
    repo_path: Path,
    interpret: bool = typer.Option(
        False,
        "--interpret",
        help="Add an optional Pydantic AI interpretation section to the report.",
    ),
    interpretation_model: str = typer.Option(
        DEFAULT_INTERPRETATION_MODEL,
        "--interpret-model",
        help="MiniMax model to use when --interpret is enabled.",
    ),
) -> None:
    """Run a read-only agent readiness sweep against a repository."""
    result = run_readiness_sweep(
        repo_path,
        interpret=interpret,
        interpretation_model=interpretation_model,
    )

    console.print(f"[bold green]Sweep complete[/bold green] {result.repo_path}")
    console.print(f"Findings: {len(result.findings)}")
    if result.interpretation:
        console.print(f"Interpretation: {result.interpretation.status}")
    console.print(f"Report: {result.report_path}")
