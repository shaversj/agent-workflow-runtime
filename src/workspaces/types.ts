import type { Static } from "typebox";

import type { WorkflowTargetSummarySchema, WorkspaceSummarySchema } from "./schemas.js";

export type TargetRef =
  | {
      kind: "local-git";
      path: string;
      ref?: string;
    }
  | {
      kind: "git-url";
      url: string;
      ref?: string;
    };

export type WorkspaceSource = Static<typeof WorkflowTargetSummarySchema>["source"];

export interface WorkspaceLease {
  id: string;
  target: TargetRef;
  source: WorkspaceSource;
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  path: string;
  cleanupPolicy: "delete";
  cleanup: () => Promise<void>;
}

export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;
export type WorkflowTargetSummary = Static<typeof WorkflowTargetSummarySchema>;
