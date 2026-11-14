import * as THREE from "three";
import { App } from "./app";
import { loadSite } from "./data/loaders";
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
  return gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
}

async function boot(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const quality = query.get("q") === "low" ? "low" : "high";

  const site = await loadSite(progress);
  // Use the full 25 cm HiRISE image when the GPU can hold an 8192 px texture; otherwise the 50 cm version.
  const hi = site.meta.texture.hi;
  const useHi = !!hi && quality === "high" && query.get("tex") !== "4k" && maxTextureSize() >= hi.px;
  const chosen = useHi ? hi! : site.meta.texture;
  progress(`HiRISE surface image (${Math.round(chosen.mPerPx * 100)} cm per pixel)`, 0.75);
  const grey = (t: THREE.Texture) => {
    t.format = THREE.RedFormat; // one grey band: a quarter of the GPU memory of RGBA
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  };
  const [texture, relief, regionMap] = await Promise.all([
    loadTexture(site.base + chosen.file).then(grey),
    loadTexture(site.base + (site.meta.relief?.file ?? "relief.png")),
    site.region ? loadTexture(site.base + site.region.meta.texture.file).then(grey) : Promise.resolve(null),
  ]);
  relief.generateMipmaps = true;
  relief.minFilter = THREE.LinearMipmapLinearFilter;

  progress("Working out the way home from every point", 0.86);
  const rover = site.pois.find((p) => p.kind === "shelter");
  if (!rover) throw new Error("Site has no shelter");
  const router = new Router();
  const field = await router.init(site.grid, DEFAULT_PARAMS, { x: rover.x, y: rover.y });

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
  const app = new App(site, view, router, field);
  view.start((dt) => app.tick(dt));
  (window as unknown as { cairn: unknown }).cairn = { app, view, site, field, textureMPerPx: chosen.mPerPx };

  progress("Ready", 1);
  $("#loading").hidden = true;
  if (query.get("skip") !== "1") showBriefing(site, () => {});
}

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
