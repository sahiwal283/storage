import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  build: {
    outDir: "../backend/static",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8300",
      "/auth": "http://localhost:8300",
    },
  },
});
