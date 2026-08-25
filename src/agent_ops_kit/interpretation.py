import os
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field
from pydantic_ai import (
    Agent,
    AgentRunError,
    ModelAPIError,
    ModelHTTPError,
    UnexpectedModelBehavior,
    UsageLimitExceeded,
    UsageLimits,
    UserError,
)
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from agent_ops_kit.checks import ReadinessAssessment

DEFAULT_INTERPRETATION_PROVIDER = "minimax"
DEFAULT_INTERPRETATION_MODEL = "MiniMax-M3"
DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1"
MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY"


class InterpretationOutput(BaseModel):
    overall_judgment: str = Field(
        description="A concise judgment of how ready this repo is for agent work."
    )
    required_fixes: list[str] = Field(
        default_factory=list,
        description="Concrete fixes implied by deterministic findings.",
    )
    optional_improvements: list[str] = Field(
        default_factory=list,
        description="Useful but non-blocking improvements, including optional standards.",
    )
    next_step: str = Field(description="The smallest useful next action.")


@dataclass(frozen=True)
class InterpretationUsage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost: Decimal | None = None


@dataclass(frozen=True)
class SweepInterpretation:
    status: str
    provider: str
    model: str
    output: InterpretationOutput | None
    usage: InterpretationUsage
    error: str | None = None


class SweepInterpreter(Protocol):
    def __call__(
        self,
        repo_path: Path,
        assessment: ReadinessAssessment,
        model: str,
    ) -> SweepInterpretation: ...


def run_pydantic_interpretation(
    repo_path: Path,
    assessment: ReadinessAssessment,
    model: str = DEFAULT_INTERPRETATION_MODEL,
) -> SweepInterpretation:
    api_key = os.environ.get(MINIMAX_API_KEY_ENV)
    if not api_key:
        return SweepInterpretation(
            status="skipped",
            provider=DEFAULT_INTERPRETATION_PROVIDER,
            model=model,
            output=None,
            usage=InterpretationUsage(),
            error=f"missing_{MINIMAX_API_KEY_ENV.lower()}",
        )

    try:
        pydantic_model = OpenAIChatModel(
            model,
            provider=OpenAIProvider(base_url=DEFAULT_MINIMAX_BASE_URL, api_key=api_key),
        )
        agent = Agent(
            pydantic_model,
            output_type=InterpretationOutput,
            instructions=(
                "Interpret deterministic agent-readiness sweep results. "
                "Do not invent new findings. Treat 'Standards Not Found' entries as "
                "informational and possibly irrelevant. Separate required fixes from "
                "optional improvements. Keep the answer concise and actionable."
            ),
        )
        result = agent.run_sync(
            _build_interpretation_prompt(repo_path, assessment),
            usage_limits=UsageLimits(request_limit=1, output_tokens_limit=1200),
        )
    except (
        AgentRunError,
        ModelAPIError,
        ModelHTTPError,
        UnexpectedModelBehavior,
        UsageLimitExceeded,
        UserError,
    ) as exc:
        return SweepInterpretation(
            status="failed",
            provider=DEFAULT_INTERPRETATION_PROVIDER,
            model=model,
            output=None,
            usage=InterpretationUsage(),
            error=f"{type(exc).__name__}: {exc}",
        )

    usage = result.usage
    return SweepInterpretation(
        status="completed",
        provider=DEFAULT_INTERPRETATION_PROVIDER,
        model=model,
        output=result.output,
        usage=InterpretationUsage(
            requests=usage.requests,
            input_tokens=usage.input_tokens or 0,
            output_tokens=usage.output_tokens or 0,
            total_tokens=usage.total_tokens or 0,
            cost=usage.cost,
        ),
    )


def _build_interpretation_prompt(repo_path: Path, assessment: ReadinessAssessment) -> str:
    finding_lines = [
        f"- {finding.severity} / {finding.category}: {finding.title}. "
        f"Recommendation: {finding.recommendation} Evidence: {finding.evidence or {}}"
        for finding in assessment.findings
    ] or ["- None"]
    passed_lines = [
        f"- {signal.category}: {signal.title}. Evidence: {signal.evidence or signal.file_path or '-'}"
        for signal in assessment.passed_signals
    ] or ["- None recorded"]
    notice_lines = [
        f"- {notice.title}: {notice.note}"
        for notice in assessment.informational_notices
        if notice.category == "standards"
    ] or ["- None recorded"]

    return "\n".join(
        [
            f"Repository path: {repo_path}",
            "",
            "Deterministic findings:",
            *finding_lines,
            "",
            "Passed signals:",
            *passed_lines,
            "",
            "Optional standards not found:",
            *notice_lines,
            "",
            "Return an interpretation for a developer deciding what to improve next.",
        ]
    )
