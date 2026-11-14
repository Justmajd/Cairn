import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Emit sw.js (the offline service worker) with a fresh version and the list of built app files,
 * so each deploy replaces the cached copy.  Mission data is cached as it is used, or all at once
 * from About → Use offline; its cache is versioned by the data itself (every site's files.json), so a
 * new build of the app keeps the data a user already saved unless the data changed.
 */
function dataVersion(): string {
  const root = new URL("./public/data/", import.meta.url);
  const hash = createHash("sha1");
  for (const site of readdirSync(root).sort()) {
    const list = new URL(`${site}/files.json`, root);
    if (existsSync(list)) hash.update(site).update(readFileSync(list));
  }
  return hash.digest("hex").slice(0, 10);
}

function serviceWorker(): Plugin {
  return {
    name: "cairn-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const files = new Set<string>(["./", "index.html", "manifest.webmanifest", "data/sites.json", "icons/icon-192.png", "icons/icon-512.png"]);
      // fonts: only the Latin subsets in WOFF2 (what every current browser uses); other subsets and the
      // older WOFF copies are still cached if a browser ever asks for them
      const unused = /\.map$|\.woff$|-(cyrillic|cyrillic-ext|greek|vietnamese)-/;
      for (const name of Object.keys(bundle)) if (!unused.test(name)) files.add(name);
      const source = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8")
        .replace("__VERSION__", Date.now().toString(36))
        .replace("__DATA_VERSION__", dataVersion())
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
  // in development the hab server (npm run hab) answers /api and /hab; Vite forwards them
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
      "/hab": { target: "ws://localhost:8787", ws: true },
    },
  },
});
