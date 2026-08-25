from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

from agent_ops_kit.interpretation import DEFAULT_INTERPRETATION_MODEL
from agent_ops_kit.logging import configure_logging
from agent_ops_kit.sweep import run_readiness_sweep

configure_logging()

app = FastAPI(
    title="Agent Ops Kit",
    summary="Read-only operational checks for agent-friendly repositories.",
)


class SweepRequest(BaseModel):
    repo_path: str
    interpret: bool = False
    interpretation_model: str = DEFAULT_INTERPRETATION_MODEL


class SweepResponse(BaseModel):
    task_id: int
    run_id: int
    report_path: str
    finding_count: int
    interpretation_status: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sweeps", response_model=SweepResponse)
def create_sweep(request: SweepRequest) -> SweepResponse:
    result = run_readiness_sweep(
        Path(request.repo_path),
        interpret=request.interpret,
        interpretation_model=request.interpretation_model,
    )
    return SweepResponse(
        task_id=result.task_id,
        run_id=result.run_id,
        report_path=str(result.report_path),
        finding_count=len(result.findings),
        interpretation_status=result.interpretation.status if result.interpretation else None,
    )
