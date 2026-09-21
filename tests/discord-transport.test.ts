import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

it("uploads multipart replies after the real coding SDK loads in the bot process", async () => {
  // A fresh process preserves production import order and the SDK's global dispatcher side effect.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import http from "node:http";
      import { once } from "node:events";
      import { createDiscordClient } from "./src/surfaces/chat/discord/bot.ts";
      import { loadDiscordBotConfig } from "./src/surfaces/chat/discord/config.ts";
      const bodies = [];
      const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        bodies.push(Buffer.concat(chunks).toString());
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: String(bodies.length) }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const client = createDiscordClient(
        loadDiscordBotConfig({
          DISCORD_BOT_TOKEN: "local-test",
          DISCORD_ALLOWED_USER_IDS: "10000000000000001",
          DISCORD_ALLOWED_GUILD_IDS: "20000000000000001"
        })
      );
      client.rest.setToken("local-test");
      client.rest.options.api = "http://127.0.0.1:" + server.address().port;
      client.rest.options.timeout = 1000;
      const send = () => client.rest.post("/channels/1/messages", {
        body: { content: "Saved proposal", allowed_mentions: { parse: [] } },
        files: [{ data: Buffer.from("# Proposal\\nVerified source diff"), name: "coding-proposal.md" }]
      });
      try {
        await send();
        await import("./src/harness/coding-runtime.ts");
        await send();
        console.log(JSON.stringify({
          count: bodies.length,
          valid: bodies.every(body => body.includes("coding-proposal.md") && body.includes("Verified source diff"))
        }));
      } finally {
        await client.destroy();
        await client.rest.agent?.destroy();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      `
    ],
    { cwd: process.cwd(), timeout: 15000 }
  );
  expect(JSON.parse(stdout.trim())).toEqual({ count: 2, valid: true });
}, 20000);
