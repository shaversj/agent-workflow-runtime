import { definePluginManifest } from "../manifest.js";

export const readinessPluginManifest = definePluginManifest({
  name: "readiness",
  displayName: "Readiness",
  description:
    "Collect read-only repository evidence and interpret whether the repo is ready for agent-assisted work.",
  capabilities: [
    "evidence-gathering",
    "readiness-interpretation",
    "markdown-reporting",
    "run-inspection",
    "report-inspection"
  ],
  authority: {
    target: "read-only",
    managedState: "read-write",
    network: "open"
  },
  source: {
    id: "readiness",
    label: "Readiness",
    description: "Repository readiness workflows and report inspection tools."
  },
  toolDefaults: {
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord"]
  },
  tools: [
    {
      name: "list_runs",
      label: "List Readiness Runs",
      description:
        "List recent readiness sweep runs from managed Agent Workflow Runtime state without reading repository files.",
      authority: { target: "none", managedState: "read-only", network: "none" }
    },
    {
      name: "show_run",
      label: "Show Readiness Run",
      description:
        "Show one readiness sweep run from managed Agent Workflow Runtime state without reading repository files.",
      authority: { target: "none", managedState: "read-only", network: "none" }
    },
    {
      name: "run_sweep",
      label: "Run Readiness Sweep",
      description:
        "Run the readiness sweep for a repository, gather evidence, ask the model to interpret it, and write the Markdown report.",
      readOnly: false,
      allowedSurfaces: ["cli", "discord"],
      authority: { target: "read-only", managedState: "read-write", network: "model-provider" }
    },
    {
      name: "get_latest_report",
      label: "Get Latest Readiness Report",
      description:
        "Return metadata for the newest readiness report in the repository without reading the full report body.",
      authority: { target: "none", managedState: "read-only", network: "none" }
    },
    {
      name: "read_report",
      label: "Read Readiness Report",
      description:
        "Read a readiness report body. Use this when the user asks to show, summarize, or inspect an existing report.",
      authority: { target: "none", managedState: "read-only", network: "none" }
    },
    {
      name: "list_corpus",
      label: "List OSS Rules Corpus",
      description: "List bounded metadata from the validated public ossrules corpus.",
      exposure: "hidden",
      readOnly: true,
      requiresApproval: false,
      allowedSurfaces: ["cli", "discord"],
      authority: { target: "none", managedState: "read-write", network: "open" }
    },
    {
      name: "read_corpus_entry",
      label: "Read OSS Rules Corpus Entry",
      description: "Read one bounded corpus entry previously returned during this sweep.",
      exposure: "hidden",
      readOnly: true,
      requiresApproval: false,
      allowedSurfaces: ["cli", "discord"],
      authority: { target: "none", managedState: "read-write", network: "open" }
    }
  ]
});
