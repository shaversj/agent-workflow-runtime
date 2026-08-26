import contextlib
import io
import platform
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent_ops_kit.checks import ReadinessAssessment
from agent_ops_kit.harness_tools import (
    SWEEP_TOOL_COMMAND,
    HarnessToolCall,
    HarnessToolContext,
    HarnessToolRegistry,
    harness_tool_registry,
)

COMPLETION_MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"


@dataclass(frozen=True)
class MiniSweHarnessRun:
    exit_status: str
    submission: str
    messages: list[dict[str, Any]]
    request_count: int
    cost: float
    tool_calls: list[HarnessToolCall]


def run_mini_swe_harness(
    repo_path: Path,
    assessment: ReadinessAssessment,
    *,
    model: str,
    api_key: str,
    api_base: str,
    tool_profile: str = "readiness",
    tool_registry: HarnessToolRegistry | None = None,
) -> MiniSweHarnessRun:
    DefaultAgent, Submitted, get_model = _load_mini_swe_agent()
    registry = tool_registry or harness_tool_registry(tool_profile)
    tool_context = HarnessToolContext(repo_path=repo_path.resolve(), assessment=assessment)
    environment = AgentOpsHarnessEnvironment(registry, tool_context, Submitted)

    mini_model = get_model(
        input_model_name=_litellm_model_name(model),
        config={
            "model_class": "litellm_textbased",
            "model_kwargs": {
                "api_key": api_key,
                "api_base": api_base,
                "drop_params": True,
                "temperature": 0,
                "max_tokens": 1200,
            },
            "cost_tracking": "ignore_errors",
        },
    )
    agent = DefaultAgent(
        mini_model,
        environment,
        system_template=_HARNESS_SYSTEM_TEMPLATE,
        instance_template=_HARNESS_INSTANCE_TEMPLATE,
        step_limit=4,
        cost_limit=1.0,
        wall_time_limit_seconds=90,
        max_consecutive_format_errors=2,
    )
    result = agent.run(
        task=_build_harness_task(repo_path),
        tool_instructions=registry.instructions(),
    )

    return MiniSweHarnessRun(
        exit_status=str(result.get("exit_status") or ""),
        submission=str(result.get("submission", "")).strip(),
        messages=agent.messages,
        request_count=int(getattr(agent, "n_calls", 0) or 0),
        cost=float(getattr(agent, "cost", 0.0) or 0.0),
        tool_calls=environment.tool_calls,
    )


class AgentOpsHarnessEnvironment:
    def __init__(
        self,
        registry: HarnessToolRegistry,
        context: HarnessToolContext,
        submitted_exception: type[Exception],
    ) -> None:
        self.registry = registry
        self.context = context
        self.submitted_exception = submitted_exception
        self.tool_calls: list[HarnessToolCall] = []

    def execute(
        self,
        action: dict[str, Any],
        cwd: str = "",
        *,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        del cwd, timeout
        command = str(action.get("command", "")).strip()
        if _is_completion_command(command):
            self._raise_submitted(command)

        output = self.registry.execute(command, self.context)
        self.tool_calls.append(
            HarnessToolCall(
                name=self.registry.command_name(command),
                command=command,
                returncode=int(output.get("returncode") or 0),
                error=str(output.get("exception_info") or "") or None,
            )
        )
        return output

    def get_template_vars(self, **kwargs: Any) -> dict[str, Any]:
        return platform.uname()._asdict() | kwargs

    def serialize(self) -> dict[str, Any]:
        return {
            "info": {
                "config": {
                    "environment_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
                    "tool_count": len(self.registry.instructions().splitlines()),
                }
            }
        }

    def _raise_submitted(self, command: str) -> None:
        submission = _completion_submission(command)
        raise self.submitted_exception(
            {
                "role": "exit",
                "content": submission,
                "extra": {"exit_status": "Submitted", "submission": submission},
            }
        )


def _load_mini_swe_agent() -> tuple[type[Any], type[Exception], Any]:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from minisweagent.agents.default import DefaultAgent
        from minisweagent.exceptions import Submitted
        from minisweagent.models import get_model

    return DefaultAgent, Submitted, get_model


def _is_completion_command(command: str) -> bool:
    return (
        command == f"echo {COMPLETION_MARKER}"
        or command.startswith(f"echo {COMPLETION_MARKER}\n")
        or (command.startswith("printf ") and COMPLETION_MARKER in command)
    )


def _completion_submission(command: str) -> str:
    if command.startswith("printf ") and COMPLETION_MARKER in command:
        return command.rsplit(COMPLETION_MARKER, 1)[-1].strip().strip("'\"")
    lines = command.splitlines()
    if len(lines) > 1:
        return "\n".join(lines[1:]).strip()
    return ""


def _build_harness_task(repo_path: Path) -> str:
    return (
        "Assess the agent readiness of this repository. First call the sweep tool "
        f"with `{SWEEP_TOOL_COMMAND} {shlex.quote(str(repo_path.resolve()))}`. Then provide "
        "concise output using exactly these labels: Overall judgment, "
        "Required fixes, Optional improvements, Next step. Do not invent findings."
    )


def _litellm_model_name(model: str) -> str:
    if "/" in model:
        return model
    return f"openai/{model}"


_HARNESS_SYSTEM_TEMPLATE = f"""You are Agent Ops Kit's mini-swe-agent harness.

You can use these read-only harness tools:

{{{{ tool_instructions }}}}

Treat tool output as the only evidence. Do not run shell inspection commands,
edit files, commit, push, or open pull requests.

Every response must include exactly one action block:

```mswea_bash_command
command
```

After you receive the needed tool result, write the final output in your
reasoning text with these labels: Overall judgment, Required fixes, Optional
improvements, Next step. Then finish with exactly this command:

```mswea_bash_command
printf '%s\\n%s\\n' {COMPLETION_MARKER} '<repeat your labeled output here>'
```
"""

_HARNESS_INSTANCE_TEMPLATE = """Task: {{task}}

Start by calling the sweep tool. Finish only after the tool result is observed.
"""
