import readline from "node:readline/promises";

import { Type } from "typebox";

import { beginInteraction } from "../../harness/interaction.js";
import { authorizeExecution } from "../../harness/execution-policy.js";
import { redactApplicationText } from "../../harness/redaction.js";
import { loadCodingPolicy, codingProfile } from "../../plugins/coding/config.js";
import { codingPlugin } from "../../plugins/coding/tools.js";
import { CodingTaskSchema, parseCoding } from "../../plugins/coding/schemas.js";
import { codingDecision, inspectCoding, recoverCoding } from "../../workflows/coding-approval.js";
import { publishProposal } from "../../workflows/publish-proposal.js";
import { normalizeCliArgs } from "./args.js";

const SelectorSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("show"),
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("cancel"),
      Type.Literal("expire"),
      Type.Literal("recover"),
      Type.Literal("reconcile")
    ]),
    jobId: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
    digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    json: Type.Boolean()
  },
  { additionalProperties: false }
);

export function parseCodingCli(args: string[]) {
  const clean = normalizeCliArgs(args);
  const [action, first, second, ...remaining] = clean;
  if (action === "prepare") {
    if (remaining.some((arg) => arg.startsWith("--")))
      throw new Error("code prepare expects: owner/repo base-branch task");
    return {
      action: "prepare" as const,
      task: parseCoding(CodingTaskSchema, {
        repository: first,
        baseBranch: second,
        task: remaining.join(" ")
      })
    };
  }
  const options = [second, ...remaining].filter((value): value is string => value !== undefined);
  const publishing = action === "approve" || action === "reconcile";
  const valid = publishing
    ? options.length === 2 && options[0] === "--digest"
    : options.length === 0 ||
      (action === "show" && options.length === 1 && options[0] === "--json");
  if (!valid) throw new Error("coding_cli_arguments_invalid");
  const digest = publishing ? options[1] : undefined;
  const parsed = parseCoding(SelectorSchema, {
    action,
    jobId: first,
    json: options.includes("--json"),
    ...(digest ? { digest } : {})
  });
  if (["approve", "reconcile"].includes(parsed.action) && !parsed.digest)
    throw new Error("coding_digest_required");
  return parsed;
}

export async function runCodingCli(args: string[]): Promise<void> {
  const request = parseCodingCli(args);
  const principal = `cli:${process.getuid?.() ?? "unsupported"}`;
  const policy = loadCodingPolicy();
  const controller = new AbortController();
  const recording = beginInteraction(
    {
      source: "cli",
      kind: `coding_${request.action}`,
      userMessage: ["code", ...args],
      metadata: { principal },
      ...(request.action === "prepare" ? { target: request.task.repository } : {})
    },
    { signal: controller.signal }
  );
  const interrupt = () => controller.abort(new Error("coding_cancelled"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    let output: string;
    if (request.action === "prepare") {
      codingProfile(policy, principal, request.task.repository);
      const authority = authorizeExecution({
        principal,
        allowedPrincipals: policy.principals,
        allowedRepositories: Object.keys(policy.profiles),
        repository: request.task.repository,
        surface: "cli",
        toolName: "coding.prepare_change",
        parameters: request.task
      });
      const result = await codingPlugin.tools[0]!.execute(
        request.task,
        { surface: "cli", executionAuthority: authority, recording },
        controller.signal
      );
      output = result.text;
    } else if (request.action === "recover") {
      output = await recoverCoding(request.jobId, principal, policy, recording);
    } else if (request.action === "approve" || request.action === "reconcile") {
      const details = inspectCoding(request.jobId, principal, policy, recording);
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("coding_human_terminal_required");
      console.log(details.display);
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      let answer: string;
      try {
        answer = await terminal.question(
          `Publish/reconcile this exact digest to a draft PR? Type ${request.digest}: `,
          { signal: controller.signal }
        );
      } finally {
        terminal.close();
      }
      if (answer !== request.digest) throw new Error("coding_confirmation_denied");
      const operation = await publishProposal(
        request.jobId,
        request.digest,
        principal,
        policy,
        recording,
        request.action === "reconcile"
      );
      output = `Job ${request.jobId}: ${operation.status}\nDraft PR: ${operation.prUrl ?? "none"}`;
    } else {
      const details = inspectCoding(request.jobId, principal, policy, recording);
      output =
        request.action === "show"
          ? request.json
            ? redactApplicationText(JSON.stringify(details, null, 2))
            : details.display
          : codingDecision(
              { action: request.action, jobId: request.jobId },
              principal,
              policy,
              recording
            );
    }
    recording.assertHealthy();
    const messageId = recording.appendMessage({ role: "assistant", content: output });
    recording.finishRun({ status: "completed" });
    recording.finishInteraction({ status: "completed" });
    const delivery = recording.deliveryStart({ messageId, part: 1, attempt: 1 });
    try {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(output + "\n", (error) => (error ? reject(error) : resolve()))
      );
      recording.deliveryFinish({
        id: delivery,
        status: "acknowledged",
        surfaceMessageId: "stdout"
      });
    } catch {
      recording.deliveryFinish({ id: delivery, status: "failed", error: "coding_stdout_failed" });
      throw new Error("coding_stdout_failed");
    }
  } catch (error) {
    recording.assertHealthy();
    recording.finishRun({
      status: controller.signal.aborted ? "cancelled" : "failed",
      error: "coding_command_failed"
    });
    recording.finishInteraction({
      status: controller.signal.aborted ? "cancelled" : "failed",
      error: "coding_command_failed"
    });
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    recording.close();
  }
}
