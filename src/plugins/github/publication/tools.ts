import { Type } from "typebox";

import { defineRegisteredTool, type RegisteredTool } from "../../../tools/registry.js";
import { publishProposal } from "../../../workflows/publish-proposal.js";
import { loadCodingPolicy } from "../../coding/config.js";
import { PublicationSchema } from "../../coding/schemas.js";

const PublicationParameters = Type.Object(
  {
    jobId: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" })
  },
  { additionalProperties: false }
);

export function createGitHubPublicationTools(): RegisteredTool[] {
  return [
    publicationTool(
      "publish_proposal",
      "Publish Approved Draft PR",
      "Publish the exact human-confirmed coding proposal to a new branch and draft PR. Disabled by default.",
      false
    ),
    publicationTool(
      "reconcile_publication",
      "Reconcile Draft PR Publication",
      "Observe and safely resume an uncertain GitHub publication for the exact approved proposal.",
      true
    )
  ];
}

function publicationTool(
  name: "publish_proposal" | "reconcile_publication",
  label: string,
  description: string,
  reconcile: boolean
): RegisteredTool {
  return defineRegisteredTool({
    pluginName: "github",
    name,
    label,
    description,
    parameters: PublicationParameters,
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
        reconcile,
        undefined,
        context.sourceContext?.channelId
          ? `${context.sourceContext.guildId ?? "dm"}:${context.sourceContext.channelId}`
          : undefined
      );
      return { result, text: `Draft PR: ${result.prUrl ?? "none"}` };
    }
  });
}
