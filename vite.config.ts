import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { electrobunViewSecurity } from "./scripts/electrobun-rpc-security.ts";

export default defineConfig({
  plugins: [electrobunViewSecurity(), react()],
  root: "src/mainview",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/mainview"),
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
