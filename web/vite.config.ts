import { defineConfig } from "vite";

// `base: "./"` keeps asset URLs relative, so the build works on GitHub Pages (/cairn-demo/),
// from `vite preview`, and from any static host without changes.
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: false },
});
