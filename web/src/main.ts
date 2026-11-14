import * as THREE from "three";
import { App } from "./app";
import { DATA_BASE, dataUrl, loadSite, loadSites } from "./data/loaders";
import { DEFAULT_PARAMS } from "./eva/params";
import { Router } from "./routing/client";
import { SceneView } from "./scene/view";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/main.css";
import { showBriefing } from "./ui/briefing";
import { initOffline } from "./ui/offline";
import { $ } from "./ui/dom";

function progress(label: string, fraction: number): void {
  $("#load-label").textContent = label;
  $("#load-bar").style.width = `${Math.round(fraction * 100)}%`;
}

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`Could not load ${url}`)));
  });
}

function maxTextureSize(): number {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return 0;
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension("WEBGL_lose_context")?.loseContext(); // free it: browsers cap live contexts
  return size;
}

async function boot(): Promise<void> {
  if (!("DecompressionStream" in window)) {
    throw new Error("this browser cannot unpack CAIRN's compressed map data. Use Chrome or Edge 80+, Firefox 113+ or Safari 16.4+.");
  }
  const maxTex = maxTextureSize(); // one throwaway context, not two
  if (!maxTex) {
    throw new Error("this browser has no WebGL 2, which the 3D terrain needs. Try a current Chrome, Edge, Firefox or Safari, and check that hardware acceleration is on.");
  }
  const query = new URLSearchParams(location.search);
  const quality = query.get("q") === "low" ? "low" : "high";

  const grey = (t: THREE.Texture) => {
    t.format = THREE.RedFormat; // one grey band: a quarter of the GPU memory of RGBA
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  };
  // The surface image and relief start downloading as soon as site.json names them, alongside the grids.
  const early: { images?: Promise<[THREE.Texture, THREE.Texture]> } = {};
  const [site, sites] = await Promise.all([
    loadSite(progress, (meta) => {
      early.images = Promise.all([
        loadTexture(DATA_BASE + meta.texture.file).then(grey),
        loadTexture(dataUrl(meta.relief?.file ?? "relief.png")),
      ]);
      early.images.catch(() => {}); // awaited below
    }),
    loadSites(),
  ]);
  performance.mark("cairn:data");
  document.title = `CAIRN — ${site.meta.name.split(" — ")[0]} · Marswalk Route Planner`;
  // Start on the 50 cm HiRISE image; the full 25 cm one streams in after the planner is up,
  // when the GPU can hold an 8192 px texture.
  const hi = site.meta.texture.hi;
  const useHi = !!hi && quality === "high" && query.get("tex") !== "4k" && maxTex >= hi.px;
  const chosen = site.meta.texture;

  // the way home from every point is worked out in the background while the images finish
  progress("Surface images and the way home from every point", 0.8);
  const rover = site.pois.find((p) => p.kind === "shelter");
  if (!rover) throw new Error("Site has no shelter");
  const router = new Router();
  const [[texture, relief], regionMap, field] = await Promise.all([
    early.images!,
    site.region ? loadTexture(site.base + site.region.meta.texture.file).then(grey) : Promise.resolve(null),
    router.init(site.grid, DEFAULT_PARAMS, { x: rover.x, y: rover.y }),
  ]);
  relief.generateMipmaps = true;
  relief.minFilter = THREE.LinearMipmapLinearFilter;
  performance.mark("cairn:images+field");

  progress("Building the terrain", 0.95);
  $("#app").hidden = false;
  const view = new SceneView($("#scene"), site, {
    map: texture,
    relief,
    region: site.region && regionMap ? { ...site.region, map: regionMap } : null,
  }, quality);
  view.setShelterTimes(field.time);
  texture.anisotropy = view.renderer.capabilities.getMaxAnisotropy();
  if (regionMap) regionMap.anisotropy = texture.anisotropy;
  const app = new App(site, view, router, field, sites);
  view.start((dt) => app.tick(dt));
  const debug = { app, view, site, field, textureMPerPx: chosen.mPerPx };
  (window as unknown as { cairn: unknown }).cairn = debug;

  performance.mark("cairn:ready");
  progress("Ready", 1);
  $("#loading").hidden = true;
  // a shared plan link opens straight on the plan
  const sharedPlan = /(^#|&)(stops|add)=/.test(location.hash);
  if (query.get("skip") !== "1" && !sharedPlan) showBriefing(site, () => {}, sites);

  if (useHi) {
    loadTexture(site.base + hi!.file)
      .then((t) => {
        grey(t).anisotropy = texture.anisotropy;
        view.setSurfaceImage(t, hi!.px);
        debug.textureMPerPx = hi!.mPerPx;
      })
      .catch((err) => console.warn("25 cm image not loaded; staying on 50 cm", err));
  }
}

initOffline();

// Trackpad pinch arrives as ctrl+wheel: keep it for the map instead of zooming the whole page.
window.addEventListener("wheel", (ev) => ev.ctrlKey && ev.preventDefault(), { passive: false });
for (const type of ["gesturestart", "gesturechange"]) window.addEventListener(type, (ev) => ev.preventDefault());

boot().catch((err: unknown) => {
  console.error(err);
  const box = $("#loading");
  box.hidden = false;
  box.classList.add("failed");
  $("#load-label").textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
