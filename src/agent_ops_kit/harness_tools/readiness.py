import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from agent_ops_kit.checks import CheckFinding, CheckNotice, CheckSignal, ReadinessAssessment
from agent_ops_kit.harness_tools.base import HarnessTool, HarnessToolContext, ToolOutput, tool_error

SWEEP_TOOL_COMMAND = "agent_ops_sweep"


class ReadinessSweepInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repo_path: str | None = Field(
        default=None,
        description="Optional repository path. Must match the current harness repo.",
    )


class FindingPayload(BaseModel):
    category: str
    severity: str
    title: str
    recommendation: str
    file_path: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class SignalPayload(BaseModel):
    category: str
    title: str
    file_path: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class NoticePayload(BaseModel):
    title: str
    note: str
    evidence: dict[str, Any] = Field(default_factory=dict)


class ReadinessSweepOutput(BaseModel):
    repository: str
    finding_count: int
    findings: list[FindingPayload]
    passed_signal_count: int
    passed_signals: list[SignalPayload]
    standards_not_found: list[NoticePayload]
    guidance: str


def tools() -> list[HarnessTool]:
    return [readiness_sweep_tool()]


def readiness_sweep_tool() -> HarnessTool:
    return HarnessTool(
        name=SWEEP_TOOL_COMMAND,
        usage=f"{SWEEP_TOOL_COMMAND} [repo_path]",
        description=(
            "Return deterministic readiness findings, passed signals, and optional "
            "standards notices for the current repository."
        ),
        input_model=ReadinessSweepInput,
        output_model=ReadinessSweepOutput,
        permissions=["read deterministic assessment already collected by Agent Ops Kit"],
        examples=[SWEEP_TOOL_COMMAND, f"{SWEEP_TOOL_COMMAND} /path/to/repo"],
        handler=_execute_readiness_sweep_tool,
    )


def _execute_readiness_sweep_tool(args: list[str], context: HarnessToolContext) -> ToolOutput:
    if len(args) > 2:
        return tool_error(f"Usage: {SWEEP_TOOL_COMMAND} [repo_path]")
    tool_input = ReadinessSweepInput(repo_path=args[1] if len(args) == 2 else None)
    if (
        tool_input.repo_path
        and Path(tool_input.repo_path).expanduser().resolve() != context.repo_path.resolve()
    ):
        return tool_error(f"{SWEEP_TOOL_COMMAND} can only inspect {context.repo_path.resolve()}")

    payload = ReadinessSweepOutput.model_validate(
        build_sweep_tool_payload(context.repo_path, context.assessment)
    )
    return {
        "output": json.dumps(payload.model_dump(mode="json"), indent=2, sort_keys=True),
        "returncode": 0,
        "exception_info": "",
    }


def build_sweep_tool_payload(repo_path: Path, assessment: ReadinessAssessment) -> dict[str, Any]:
    return {
        "repository": str(repo_path.resolve()),
        "finding_count": len(assessment.findings),
        "findings": [_finding_payload(finding) for finding in assessment.findings],
        "passed_signal_count": len(assessment.passed_signals),
        "passed_signals": [_signal_payload(signal) for signal in assessment.passed_signals],
        "standards_not_found": [
            _notice_payload(notice)
            for notice in assessment.informational_notices
            if notice.category == "standards"
        ],
        "guidance": (
            "Reason over these deterministic results only. Standards listed under "
            "standards_not_found are informational and may not be needed for this repo."
        ),
    }


def _finding_payload(finding: CheckFinding) -> dict[str, Any]:
    return {
        "category": finding.category,
        "severity": finding.severity,
        "title": finding.title,
        "recommendation": finding.recommendation,
        "file_path": finding.file_path,
        "evidence": finding.evidence or {},
    }


def _signal_payload(signal: CheckSignal) -> dict[str, Any]:
    return {
        "category": signal.category,
        "title": signal.title,
        "file_path": signal.file_path,
        "evidence": signal.evidence or {},
    }


def _notice_payload(notice: CheckNotice) -> dict[str, Any]:
    return {
        "title": notice.title,
        "note": notice.note,
        "evidence": notice.evidence or {},
    }
