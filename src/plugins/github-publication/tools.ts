import { Type } from "typebox";

import { defineRegisteredTool } from "../../tools/registry.js";
import { publishProposal } from "../../workflows/publish-proposal.js";
import { loadCodingPolicy } from "../coding/config.js";
import { PublicationSchema } from "../coding/schemas.js";
import { definePlugin } from "../manifest.js";

const name = "publish_proposal",
  label = "Publish Approved Draft PR";
const description =
  "Publish the exact human-confirmed coding proposal to a new branch and draft PR. Disabled by default.";
export const githubPublicationPlugin = definePlugin({
  manifest: {
    name: "github-publication",
    displayName: "GitHub Publication",
    description,
    capabilities: ["approved-draft-pr"],
    authority: { target: "read-write", managedState: "read-write", network: "open" },
    toolDefaults: {
      exposure: "hidden",
      requiresApproval: true,
      readOnly: false,
      allowedSurfaces: ["cli", "discord"]
    },
    tools: [{ name, label, description }]
  },
  tools: [
    defineRegisteredTool({
      pluginName: "github-publication",
      name,
      label,
      description,
      parameters: Type.Object(
        {
          jobId: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
          digest: Type.String({ pattern: "^[a-f0-9]{64}$" })
        },
        { additionalProperties: false }
      ),
      resultSchema: PublicationSchema,
      async execute(params, context) {
        if (!context.executionAuthority || !context.recording)
          throw new Error("coding_human_authority_required");
        const result = await publishProposal(
          params.jobId,
          params.digest,
          context.executionAuthority.principal,
          loadCodingPolicy(),
          context.recording,
          false,
          undefined,
          context.sourceContext?.channelId
            ? `${context.sourceContext.guildId ?? "dm"}:${context.sourceContext.channelId}`
            : undefined
        );
        return { result, text: `Draft PR: ${result.prUrl ?? "none"}` };
      }
    })
  ]
});
