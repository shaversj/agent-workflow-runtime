import os
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from agent_ops_kit.checks import ReadinessAssessment
from agent_ops_kit.harness import COMPLETION_MARKER, MiniSweHarnessRun, run_mini_swe_harness
from agent_ops_kit.harness_tools import HarnessToolCall

DEFAULT_HARNESS_PROVIDER = "mini-swe-agent"
DEFAULT_HARNESS_MODEL = "MiniMax-M3"
DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1"
MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY"


@dataclass(frozen=True)
class HarnessUsage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost: Decimal | None = None


@dataclass(frozen=True)
class HarnessResult:
    status: str
    provider: str
    model: str
    final_output: str | None
    usage: HarnessUsage
    tool_calls: list[HarnessToolCall]
    error: str | None = None


class HarnessRunner(Protocol):
    def __call__(
        self,
        repo_path: Path,
        assessment: ReadinessAssessment,
        model: str,
    ) -> HarnessResult: ...


def run_readiness_harness(
    repo_path: Path,
    assessment: ReadinessAssessment,
    model: str = DEFAULT_HARNESS_MODEL,
) -> HarnessResult:
    api_key = os.environ.get(MINIMAX_API_KEY_ENV)
    if not api_key:
        return HarnessResult(
            status="skipped",
            provider=DEFAULT_HARNESS_PROVIDER,
            model=model,
            final_output=None,
            usage=HarnessUsage(),
            tool_calls=[],
            error=f"missing_{MINIMAX_API_KEY_ENV.lower()}",
        )

    try:
        harness_run = run_mini_swe_harness(
            repo_path,
            assessment,
            model=model,
            api_key=api_key,
            api_base=DEFAULT_MINIMAX_BASE_URL,
        )
    except Exception as exc:  # noqa: BLE001
        return HarnessResult(
            status="failed",
            provider=DEFAULT_HARNESS_PROVIDER,
            model=model,
            final_output=None,
            usage=HarnessUsage(),
            tool_calls=[],
            error=f"{type(exc).__name__}: {exc}",
        )

    submission = _clean_submission(harness_run.submission)
    output_text = submission or _last_assistant_output(harness_run.messages)
    submitted = harness_run.exit_status == "Submitted"
    return HarnessResult(
        status="completed" if submitted else "failed",
        provider=DEFAULT_HARNESS_PROVIDER,
        model=model,
        final_output=output_text or None,
        usage=_usage_from_harness_run(harness_run),
        tool_calls=harness_run.tool_calls,
        error=None if submitted else harness_run.exit_status,
    )


def _clean_submission(submission: str) -> str:
    cleaned = submission.strip()
    if cleaned.lower() in {
        "final output above",
        "<repeat your labeled output here>",
    }:
        return ""
    if cleaned == COMPLETION_MARKER:
        return ""
    return cleaned


def _last_assistant_output(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "assistant":
            return _strip_action_block(str(message.get("content") or "")).strip()
    return ""


def _strip_action_block(content: str) -> str:
    import re

    return re.sub(r"```mswea_bash_command\s*\n.*?\n```", "", content, flags=re.DOTALL).strip()


def _usage_from_harness_run(harness_run: MiniSweHarnessRun) -> HarnessUsage:
    input_tokens = 0
    output_tokens = 0

    for message in harness_run.messages:
        response = message.get("extra", {}).get("response", {})
        if not isinstance(response, dict):
            continue
        usage = response.get("usage", {})
        if not isinstance(usage, dict):
            continue
        input_tokens += int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        output_tokens += int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)

    total_tokens = input_tokens + output_tokens
    cost = None if harness_run.cost == 0.0 else Decimal(str(harness_run.cost))
    return HarnessUsage(
        requests=harness_run.request_count,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cost=cost,
    )
