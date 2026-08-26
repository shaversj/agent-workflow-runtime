from agent_ops_kit.harness_tools.base import (
    HarnessTool,
    HarnessToolCall,
    HarnessToolContext,
    HarnessToolRegistry,
    ToolHandler,
    ToolOutput,
    tool_error,
)
from agent_ops_kit.harness_tools.readiness import SWEEP_TOOL_COMMAND
from agent_ops_kit.harness_tools.readiness import tools as readiness_tools

HARNESS_TOOL_PROFILES = {
    "readiness": (readiness_tools,),
}


def harness_tool_registry(profile: str = "readiness") -> HarnessToolRegistry:
    loaders = HARNESS_TOOL_PROFILES.get(profile)
    if loaders is None:
        available = ", ".join(sorted(HARNESS_TOOL_PROFILES))
        raise ValueError(
            f"Unknown harness tool profile: {profile}. Available profiles: {available}"
        )

    tool_list: list[HarnessTool] = []
    for load_tools in loaders:
        tool_list.extend(load_tools())
    return HarnessToolRegistry(tool_list)


def default_harness_tool_registry() -> HarnessToolRegistry:
    return harness_tool_registry("readiness")


__all__ = [
    "HARNESS_TOOL_PROFILES",
    "SWEEP_TOOL_COMMAND",
    "HarnessTool",
    "HarnessToolCall",
    "HarnessToolContext",
    "HarnessToolRegistry",
    "ToolHandler",
    "ToolOutput",
    "default_harness_tool_registry",
    "harness_tool_registry",
    "tool_error",
]
