import { readDesktop } from "./reader.js";

process.on("message", (request: unknown) => {
  process.send?.(readDesktop(request));
});
process.on("disconnect", () => {
  process.exit(0);
});
