import { defineConfig } from "vite";
export default defineConfig({
  base: "/stellar-milestone-escrow/",
  define: { global: "globalThis" },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
});
