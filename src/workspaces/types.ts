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

export interface WorkspaceLease {
  id: string;
  target: TargetRef;
  source: TargetRef["kind"];
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  path: string;
  statePath: string;
  cleanupPolicy: "delete";
  cleanup: () => Promise<void>;
}

export interface WorkspaceSummary {
  id: string;
  source: WorkspaceLease["source"];
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  path: string;
  statePath: string;
  cleanupPolicy: WorkspaceLease["cleanupPolicy"];
}

export interface WorkflowTargetSummary {
  source: WorkspaceLease["source"];
  origin: string;
  ref: string;
  commitSha: string;
}
