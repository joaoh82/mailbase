import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 3000 is reserved locally; keep the SPA on Vite's default range.
    port: 5173,
  },
});
