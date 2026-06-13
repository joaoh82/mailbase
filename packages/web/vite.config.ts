import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 3000 is reserved locally; keep the SPA on Vite's default range.
    port: 5173,
    // Same-origin /api in dev, mirroring the deployed web worker proxy
    // (worker/index.ts). `make dev` runs the API worker on 8787.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
