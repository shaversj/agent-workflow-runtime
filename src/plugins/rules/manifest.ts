import { definePluginManifest } from "../manifest.js";

export const rulesPluginManifest = definePluginManifest({
  name: "rules",
  displayName: "Rules",
  description: "Discover and read repository-authored agent instructions and standards.",
  capabilities: ["rule-discovery", "standards-inventory", "instruction-context"],
  authority: {
    target: "read-only",
    managedState: "none",
    network: "none"
  },
  source: {
    id: "rules",
    label: "Rules",
    description: "Read-only repository rules and standards inspection tools."
  },
  toolDefaults: {
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["cli", "discord"]
  },
  tools: [
    {
      name: "inventory",
      label: "Inventory Repository Rules",
      description: "Return normalized repository agent instructions and standards coverage."
    },
    {
      name: "read_source",
      label: "Read Repository Rule Source",
      description: "Read one discovered repository rule source with redaction and size limits."
    }
  ]
});
