import start, { createServerEntry } from "@tanstack/react-start/server-entry";
import { securityHeaders } from "./security-headers.js";

export default createServerEntry({
  async fetch(...args) {
    const response = await start.fetch(...args);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
});
