import { Value } from "typebox/value";
import type { TSchema } from "typebox";

import { rulesTools } from "../plugins/rules/tools.js";
import {
  RuleSourceReadResultSchema,
  RulesInventorySchema,
  type RuleSourceReadResult,
  type RulesInventory
} from "../plugins/rules/schemas.js";
import type { ToolSurface } from "../tools/registry.js";
import { registeredToolName, ToolRegistry } from "../tools/registry.js";
import { prepareWorkspace, workspaceSummary } from "../workspaces/index.js";
import type { TargetRef, WorkspaceSummary } from "../workspaces/types.js";

interface RulesWorkflowOptions {
  ref?: string;
  signal?: AbortSignal;
  surface?: ToolSurface;
}

interface RulesWorkflowResult<TResult> {
  target: TargetRef;
  workspace: WorkspaceSummary;
  result: TResult;
}

export async function runRulesInventoryWorkflow(
  target: string,
  options: RulesWorkflowOptions = {}
): Promise<RulesWorkflowResult<RulesInventory>> {
  return runRulesTool(target, "rules_inventory", {}, RulesInventorySchema, options);
}

export async function runRulesReadWorkflow(
  target: string,
  sourcePath: string,
  options: RulesWorkflowOptions = {}
): Promise<RulesWorkflowResult<RuleSourceReadResult>> {
  return runRulesTool(
    target,
    "rules_read_source",
    { source_path: sourcePath },
    RuleSourceReadResultSchema,
    options
  );
}

async function runRulesTool<TResult>(
  target: string,
  toolName: string,
  params: Record<string, unknown>,
  schema: TSchema,
  options: RulesWorkflowOptions
): Promise<RulesWorkflowResult<TResult>> {
  const lease = await prepareWorkspace(target, options.ref, { signal: options.signal });
  try {
    const registry = new ToolRegistry();
    registry.registerMany(rulesTools);
    const tool = registry.get(toolName);
    if (!tool) throw new Error(`rules_tool_not_registered:${toolName}`);
    const output = await tool.execute(
      { workspace_path: lease.path, ...params },
      { surface: options.surface ?? "cli" },
      options.signal
    );
    if (!Value.Check(schema, output.result)) {
      throw new Error(`rules_workflow_result_invalid:${registeredToolName(tool)}`);
    }
    return {
      target: lease.target,
      workspace: workspaceSummary(lease),
      result: output.result as TResult
    };
  } finally {
    await lease.cleanup();
  }
}
