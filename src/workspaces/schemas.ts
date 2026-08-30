import { Type } from "typebox";

const WorkspaceSourceSchema = Type.Union([Type.Literal("local-git"), Type.Literal("git-url")]);

export const WorkspaceSummarySchema = Type.Object({
  id: Type.String(),
  source: WorkspaceSourceSchema,
  origin: Type.String(),
  displayOrigin: Type.String(),
  ref: Type.String(),
  commitSha: Type.String(),
  path: Type.String(),
  statePath: Type.String(),
  cleanupPolicy: Type.Literal("delete")
});

export const WorkflowTargetSummarySchema = Type.Object({
  source: WorkspaceSourceSchema,
  origin: Type.String(),
  ref: Type.String(),
  commitSha: Type.String()
});
