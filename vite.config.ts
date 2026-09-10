import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  envDir: false,
  envPrefix: [],
  plugins: [tanstackStart({ srcDirectory: "src/surfaces/web" }), react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 3000 },
  build: { outDir: "dist-web" },
  ssr: { external: ["better-sqlite3"] }
});
