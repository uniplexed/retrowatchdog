import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { pwaOptions } from "./src/pwaOptions";

export default defineConfig({
  plugins: [
    react(),
    // options live in src/pwaOptions.ts so the navigation-fallback denylist
    // is covered by a test (see test/pwaOptions.test.ts)
    VitePWA(pwaOptions),
  ],
  server: {
    // API_PROXY_TARGET points a local dev server at a deployed API (self-signed HTTPS allowed)
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3001", changeOrigin: true, secure: false } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
