import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolingDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(toolingDirectory, "../../app"),
  plugins: [react()],
  server: { host: "0.0.0.0" },
  css: { postcss: resolve(toolingDirectory, "postcss.config.mjs") },
  build: { outDir: resolve(toolingDirectory, "../../dist"), emptyOutDir: true },
});
