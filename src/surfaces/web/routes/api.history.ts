import { createFileRoute } from "@tanstack/react-router";
import { inspectHistoryRequest } from "../http.server";

export const Route = createFileRoute("/api/history")({
  server: { handlers: { POST: ({ request }) => inspectHistoryRequest(request) } }
});
