import { Type, type Static } from "typebox";

import { defineRegisteredTool, type RegisteredTool } from "../../tools/registry.js";
import { definePlugin } from "../manifest.js";
import { discoverRules, readDiscoveredRuleSource } from "./discovery.js";
import { rulesPluginManifest } from "./manifest.js";
import { RuleSourceReadResultSchema, RulesInventorySchema } from "./schemas.js";

const WorkspaceParamsSchema = Type.Object(
  {
    workspace_path: Type.String({ minLength: 1, description: "Prepared local workspace path." })
  },
  { additionalProperties: false }
);

const ReadSourceParamsSchema = Type.Object(
  {
    workspace_path: Type.String({ minLength: 1, description: "Prepared local workspace path." }),
    source_path: Type.String({ minLength: 1, description: "Path returned by rules inventory." })
  },
  { additionalProperties: false }
);

type WorkspaceParams = Static<typeof WorkspaceParamsSchema>;
type ReadSourceParams = Static<typeof ReadSourceParamsSchema>;

export const rulesTools: RegisteredTool[] = definePlugin({
  manifest: rulesPluginManifest,
  tools: [
    defineRegisteredTool({
      pluginName: rulesPluginManifest.name,
      name: "inventory",
      label: "Inventory Repository Rules",
      description: "Return normalized repository agent instructions and standards coverage.",
      parameters: WorkspaceParamsSchema,
      resultSchema: RulesInventorySchema,
      execute(params: WorkspaceParams) {
        const result = discoverRules(params.workspace_path);
        return { result, text: JSON.stringify(result, null, 2) };
      }
    }),
    defineRegisteredTool({
      pluginName: rulesPluginManifest.name,
      name: "read_source",
      label: "Read Repository Rule Source",
      description: "Read one discovered repository rule source with redaction and size limits.",
      parameters: ReadSourceParamsSchema,
      resultSchema: RuleSourceReadResultSchema,
      execute(params: ReadSourceParams) {
        const result = readDiscoveredRuleSource(params.workspace_path, params.source_path);
        return { result, text: result.content };
      }
    })
  ]
}).tools;
