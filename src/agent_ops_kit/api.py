from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

from agent_ops_kit.sweep import run_readiness_sweep

app = FastAPI(
    title="Agent Ops Kit",
    summary="Read-only operational checks for agent-friendly repositories.",
)


class SweepRequest(BaseModel):
    repo_path: str


class SweepResponse(BaseModel):
    task_id: int
    run_id: int
    report_path: str
    finding_count: int


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sweeps", response_model=SweepResponse)
def create_sweep(request: SweepRequest) -> SweepResponse:
    result = run_readiness_sweep(Path(request.repo_path))
    return SweepResponse(
        task_id=result.task_id,
        run_id=result.run_id,
        report_path=str(result.report_path),
        finding_count=len(result.findings),
    )
