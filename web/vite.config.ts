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

/** HTTPS with the local certificate (scripts/cert.mjs), when CAIRN_HTTPS=1: phones need it for the mic. */
function httpsOptions(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env.CAIRN_HTTPS !== "1") return undefined;
  const dir = new URL("./.cert/", import.meta.url);
  return { key: readFileSync(new URL("key.pem", dir)), cert: readFileSync(new URL("cert.pem", dir)) };
}

const HAB = process.env.CAIRN_HAB ?? "localhost:8787";

// `base: "./"` keeps asset URLs relative, so the build works on GitHub Pages (/cairn-demo/),
// from `vite preview`, and from any static host without changes.
export default defineConfig({
  base: "./",
  plugins: [serviceWorker()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Three.js in a file of its own: it downloads in parallel with the app, and an app update does
        // not make returning visitors fetch the 3D engine again
        manualChunks: (id) => (id.includes("/node_modules/three/") ? "three" : undefined),
      },
    },
  },
  // in development the hab server (npm run hab) answers /api and /hab; Vite forwards them
  // (CAIRN_HAB=host:port points at another hab, e.g. a scratch one for testing)
  server: {
    port: 5173,
    strictPort: false,
    https: httpsOptions(),
    proxy: {
      "/api": { target: `http://${HAB}`, changeOrigin: false },
      "/hab": { target: `ws://${HAB}`, ws: true },
    },
  },
});
