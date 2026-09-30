import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the Tauri frontend.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
