interface AgentOpsPluginManifest {
  name: string;
  displayName: string;
  description: string;
  capabilities: string[];
  authority: {
    filesystem: "read-only" | "read-write";
    network: "none" | "model-provider" | "open";
  };
}

export const readinessPluginManifest: AgentOpsPluginManifest = {
  name: "readiness",
  displayName: "Readiness",
  description:
    "Collect read-only repository evidence and interpret whether the repo is ready for agent-assisted work.",
  capabilities: ["evidence-gathering", "readiness-interpretation", "markdown-reporting"],
  authority: {
    filesystem: "read-only",
    network: "model-provider"
  }
};
