import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DockerWorker } from "../src/workspaces/docker.js";

const image = process.env.CODING_TEST_IMAGE;
describe.skipIf(!image)("real coding worker containment", () => {
  it("force-cleans only workers owned by this process", async () => {
    const worker = await DockerWorker.start(
      { image: image!, requiredChecks: ["true"], ignore: [], principal: "cli:test" },
      undefined,
      `shutdown-${Date.now()}`
    );
    try {
      await DockerWorker.forceCleanupOwnedWorkers();
      expect((await worker.command("echo should-not-run")).exitCode).not.toBe(0);
    } finally {
      await worker.close();
    }
  }, 30000);

  it("cleans owned containers after an unavailable pinned image fails startup", async () => {
    const jobId = `missing-image-${Date.now()}`;
    await expect(
      DockerWorker.start(
        {
          image: `node@sha256:${"0".repeat(64)}`,
          requiredChecks: ["node --test"],
          ignore: [],
          principal: "cli:test"
        },
        undefined,
        jobId
      )
    ).rejects.toThrow();
    await DockerWorker.cleanupJob(jobId);
  }, 30000);
  it("contains files, denies networking/host secrets, and kills descendants on cancellation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-host-"));
    const sentinel = path.join(dir, "host-only");
    fs.writeFileSync(sentinel, "private sentinel");
    const worker = await DockerWorker.start({
      image: image!,
      requiredChecks: ["node --test"],
      ignore: [".git", "node_modules"],
      principal: "cli:test"
    });
    try {
      await worker.importFiles([{ path: "app.js", content: "hello", mode: "100644" }]);
      expect((await worker.snapshot())[0]?.content).toBe("hello");
      expect(
        (
          await worker.command(
            `test ! -e '${sentinel}' && test -z "$MINIMAX_API_KEY" && test ! -S /var/run/docker.sock`
          )
        ).exitCode
      ).toBe(0);
      expect(
        (await worker.command("node -e 'fetch(\"https://github.com\").catch(()=>process.exit(7))'"))
          .exitCode
      ).toBe(7);
      await worker.command("ln -s /etc/passwd /workspace/link");
      await expect(worker.snapshot()).rejects.toThrow();
      await worker.command("rm /workspace/link");
      const controller = new AbortController();
      const running = worker.command("sleep 600 & wait", controller.signal);
      setTimeout(() => controller.abort(), 100);
      await expect(running).rejects.toThrow(/aborted/);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("private sentinel");
      await expect(worker.command("echo should-not-run")).rejects.toThrow();
    } finally {
      await worker.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
  it("runs required checks against a fresh immutable snapshot", async () => {
    const worker = await DockerWorker.start(
      { image: image!, requiredChecks: ["node --test"], ignore: [".git"], principal: "cli:test" },
      undefined,
      "verification-fixture",
      true
    );
    try {
      await worker.importFiles([{ path: "app.js", content: "original", mode: "100644" }]);
      await worker.freeze();
      expect((await worker.command("echo changed > /workspace/app.js")).exitCode).not.toBe(0);
      expect((await worker.command("rm /workspace/app.js")).exitCode).not.toBe(0);
      expect((await worker.command("touch /workspace/new-file")).exitCode).not.toBe(0);
      expect((await worker.snapshot())[0]?.content).toBe("original");
    } finally {
      await worker.close();
    }
  }, 30000);
});
