import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1426,
    strictPort: true,
    // The preserved research/target trees are large and never serve UI code.
    watch: { ignored: ["**/.local/**", "**/src-tauri/**", "**/release/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022" },
});
