import { definePluginManifest } from "../manifest.js";

export const rulesBenchmarkPluginManifest = definePluginManifest({
  name: "rules-benchmark",
  displayName: "Rules Benchmark",
  description: "Compare repository rules with bounded public OSS rules evidence.",
  capabilities: ["rules-benchmark", "oss-patterns", "provenance"],
  authority: {
    target: "none",
    managedState: "read-write",
    network: "open"
  },
  source: {
    id: "rules-benchmark",
    label: "Rules Benchmark",
    description: "Hidden readiness-only tools for the public ossrules corpus."
  },
  toolDefaults: {
    exposure: "hidden",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["cli", "discord"]
  },
  tools: [
    {
      name: "list_corpus",
      label: "List OSS Rules Corpus",
      description: "List bounded metadata from the validated public ossrules corpus."
    },
    {
      name: "read_corpus_entry",
      label: "Read OSS Rules Corpus Entry",
      description: "Read one bounded corpus entry previously returned during this sweep."
    }
  ]
});
