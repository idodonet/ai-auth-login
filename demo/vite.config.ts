import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4318", changeOrigin: true },
    },
  },
  build: { outDir: "dist/client", emptyOutDir: false },
});
