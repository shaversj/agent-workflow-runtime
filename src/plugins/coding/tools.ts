import { defineRegisteredTool } from "../../tools/registry.js";
import { definePlugin } from "../manifest.js";
import { prepareCoding } from "../../workflows/code.js";
import { loadCodingPolicy } from "./config.js";
import { CodingTaskSchema, CodingJobSchema } from "./schemas.js";

const name = "prepare_change",
  label = "Prepare Coding Proposal";
const description =
  "Prepare an isolated, verified change proposal for an explicitly authorized GitHub target. Never publish.";
export const codingPlugin = definePlugin({
  manifest: {
    name: "coding",
    displayName: "Coding",
    description,
    capabilities: ["isolated-coding", "change-proposal"],
    authority: { target: "read-write", managedState: "read-write", network: "open" },
    toolDefaults: {
      exposure: "hidden",
      readOnly: false,
      requiresApproval: true,
      allowedSurfaces: ["cli", "discord"]
    },
    tools: [{ name, label, description }]
  },
  tools: [
    defineRegisteredTool({
      pluginName: "coding",
      name,
      label,
      description,
      parameters: CodingTaskSchema,
      resultSchema: CodingJobSchema,
      async execute(task, context) {
        if (!context.recording || !context.executionAuthority)
          throw new Error("coding_authorized_recording_required");
        const job = await prepareCoding(
          task,
          context.executionAuthority.principal,
          loadCodingPolicy(),
          context.recording,
          {
            conversationKey: context.sourceContext?.channelId
              ? `${context.sourceContext.guildId ?? "dm"}:${context.sourceContext.channelId}`
              : undefined
          }
        );
        return {
          result: job,
          text: `Coding job ${job.id}: ${job.status}. Inspect before approving publication.`
        };
      }
    })
  ]
});
