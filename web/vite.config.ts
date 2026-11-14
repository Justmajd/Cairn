import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Emit sw.js (the offline service worker) with a fresh version and the list of built app files,
 * so each deploy replaces the cached copy.  Mission data is cached as it is used, or all at once
 * from About → Use offline.
 */
function serviceWorker(): Plugin {
  return {
    name: "cairn-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const files = new Set<string>(["./", "index.html", "manifest.webmanifest", "data/sites.json", "icons/icon-192.png", "icons/icon-512.png"]);
      for (const name of Object.keys(bundle)) if (!name.endsWith(".map")) files.add(name);
      const source = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8")
        .replace("__VERSION__", Date.now().toString(36))
        .replace("__APP_FILES__", JSON.stringify([...files]));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// `base: "./"` keeps asset URLs relative, so the build works on GitHub Pages (/cairn-demo/),
// from `vite preview`, and from any static host without changes.
export default defineConfig({
  base: "./",
  plugins: [serviceWorker()],
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: false },
});
