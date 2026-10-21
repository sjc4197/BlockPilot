import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 백엔드 포트는 서버와 같은 BLOCKPILOT_PORT 를 따른다 (기본 4800)
const apiPort = process.env.BLOCKPILOT_PORT ?? "4800";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4801,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
