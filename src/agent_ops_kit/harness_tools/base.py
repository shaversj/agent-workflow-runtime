import shlex
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from agent_ops_kit.checks import ReadinessAssessment

ToolOutput = dict[str, Any]
ToolHandler = Callable[[list[str], "HarnessToolContext"], ToolOutput]


@dataclass(frozen=True)
class HarnessToolContext:
    repo_path: Path
    assessment: ReadinessAssessment


@dataclass(frozen=True)
class HarnessTool:
    name: str
    usage: str
    description: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    permissions: list[str]
    examples: list[str]
    handler: ToolHandler

    @property
    def input_schema(self) -> dict[str, Any]:
        return self.input_model.model_json_schema()

    @property
    def output_schema(self) -> dict[str, Any]:
        return self.output_model.model_json_schema()

    def instruction(self) -> str:
        examples = ", ".join(f"`{example}`" for example in self.examples) or "-"
        permissions = ", ".join(self.permissions) or "none"
        return "\n".join(
            [
                f"- `{self.usage}`: {self.description}",
                f"  Permissions: {permissions}",
                f"  Input schema: {self.input_schema}",
                f"  Output schema: {self.output_schema}",
                f"  Examples: {examples}",
            ]
        )


@dataclass(frozen=True)
class HarnessToolCall:
    name: str
    command: str
    returncode: int
    error: str | None = None


class HarnessToolRegistry:
    def __init__(self, tools: list[HarnessTool]) -> None:
        self._tools = {tool.name: tool for tool in tools}

    def instructions(self) -> str:
        return "\n".join(tool.instruction() for tool in self._tools.values())

    def execute(self, command: str, context: HarnessToolContext) -> ToolOutput:
        try:
            args = shlex.split(command)
        except ValueError as exc:
            return tool_error(f"Could not parse harness tool command: {exc}")

        if not args:
            return tool_error("No harness tool command was provided.")

        tool = self._tools.get(args[0])
        if tool is None:
            return tool_error(
                f"Unknown harness tool: {args[0]}. Available tools: {', '.join(self._tools)}"
            )

        return tool.handler(args, context)

    def command_name(self, command: str) -> str:
        try:
            args = shlex.split(command)
        except ValueError:
            return ""
        return args[0] if args else ""


def tool_error(message: str) -> ToolOutput:
    return {"output": message, "returncode": 2, "exception_info": message}
