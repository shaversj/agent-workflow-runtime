import path from "node:path";
import { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { securityHeaders } from "../src/surfaces/web/security-headers.js";

const port = Number(process.env.PORT ?? 3000);
if (!Value.Check(Type.Integer({ minimum: 1, maximum: 65535 }), port))
  throw new Error("Invalid PORT");
const output = path.resolve(import.meta.dirname, "../dist-web");
const { default: start } = (await import(
  pathToFileURL(path.join(output, "server/server.js")).href
)) as {
  default: { fetch(request: Request): Promise<Response> };
};
const app = new Hono();
app.use("*", async (context, next) => {
  const host = context.req.header("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    return context.text("Forbidden", 403);
  await next();
  for (const [name, value] of Object.entries(securityHeaders)) context.header(name, value);
});
app.use("/assets/*", serveStatic({ root: path.join(output, "client") }));
app.all("*", (context) => start.fetch(context.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`History inspector: http://127.0.0.1:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    if (server instanceof Server) server.closeAllConnections();
  });
