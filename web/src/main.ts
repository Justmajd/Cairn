import * as THREE from "three";
import { loadTexture } from "./data/texture";
import { App } from "./app";
import { DATA_BASE, dataUrl, loadSite, loadSites } from "./data/loaders";
import { DEFAULT_PARAMS } from "./eva/params";
import { Router } from "./routing/client";
import { SceneView } from "./scene/view";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/tektur/700.css";
import "./styles/main.css";
import "./styles/motion.css";
import "./styles/theme.css";
import { resumeDissolve } from "./ui/dissolve";
import { hideAnimated, markSiteLinks } from "./ui/motion";
import { playOnce } from "./ui/fx";
import { showBriefing } from "./ui/briefing";
import { initOffline } from "./ui/offline";
import { $ } from "./ui/dom";

function progress(label: string, fraction: number): void {
  $("#load-label").textContent = label;
  $("#load-bar").style.width = `${Math.round(fraction * 100)}%`;
}

function maxTextureSize(): number {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return 0;
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  gl.getExtension("WEBGL_lose_context")?.loseContext(); // free it: browsers cap live contexts
  return size;
}

/** Slow first load (old laptop, weak GPU, slow network): offer the lighter version, keeping site and plan. */
function offerLiteIfSlow(): void {
  const q = new URLSearchParams(location.search);
  if (q.get("q") === "low") return;
  q.set("q", "low");
  $<HTMLAnchorElement>("#load-lite").href = `?${q.toString()}${location.hash}`;
  window.setTimeout(() => {
    if (!$("#loading").hidden) $("#load-slow").hidden = false;
  }, 12000);
}

let arrival: (() => void) | null = null;

async function boot(): Promise<void> {
  arrival = resumeDissolve(); // switched from another site: the curtain stays closed until this one is ready
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
        loadTexture(DATA_BASE + meta.texture.file).then(grey).then((t) => (performance.mark("cairn:texture"), t)),
        loadTexture(dataUrl(meta.relief?.file ?? "relief.png")).then((t) => (performance.mark("cairn:relief"), t)),
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
  // the worker computes while the terrain is built and its shaders compile on this thread
  const fieldReady = router.init(site.grid, DEFAULT_PARAMS, { x: rover.x, y: rover.y }).then((f) => (performance.mark("cairn:field"), f));
  const [[texture, relief], regionMap] = await Promise.all([
    early.images!,
    site.region ? loadTexture(site.base + site.region.meta.texture.file).then(grey).then((t) => (performance.mark("cairn:region"), t)) : Promise.resolve(null),
  ]);
  relief.generateMipmaps = true;
  relief.minFilter = THREE.LinearMipmapLinearFilter;
  performance.mark("cairn:images");

  progress("Building the terrain", 0.9);
  $("#app").hidden = false;
  performance.mark("cairn:view-start");
  const view = new SceneView($("#scene"), site, {
    map: texture,
    relief,
    region: site.region && regionMap ? { ...site.region, map: regionMap } : null,
  }, quality);
  // compile the shaders in parallel (KHR_parallel_shader_compile) instead of stalling the first frame
  await view.compileShaders();
  performance.mark("cairn:shaders");
  progress("The way home from every point", 0.95);
  const field = await fieldReady;
  view.setShelterTimes(field.time);
  // a graphics driver reset leaves a black map: say so instead
  view.renderer.domElement.addEventListener("webglcontextlost", (ev) => {
    ev.preventDefault();
    const box = document.createElement("div");
    box.id = "gl-lost";
    box.innerHTML = `<div><p>The graphics card stopped drawing CAIRN (the browser lost its WebGL context). Your plan is kept in the address bar.</p><button class="primary" onclick="location.reload()">Reload</button></div>`;
    document.body.append(box);
  });
  texture.anisotropy = view.renderer.capabilities.getMaxAnisotropy();
  if (regionMap) regionMap.anisotropy = texture.anisotropy;
  performance.mark("cairn:view-built");
  const app = new App(site, view, router, field, sites);
  view.start((dt) => app.tick(dt));
  const debug = { app, view, site, field, textureMPerPx: chosen.mPerPx };
  (window as unknown as { cairn: unknown }).cairn = debug;

  performance.mark("cairn:ready");
  progress("Ready", 1);
  // a shared plan link opens straight on the plan; ?demo=1 plays the guided demo (for a booth screen or recording)
  const sharedPlan = /(^#|&)(stops|add)=/.test(location.hash);
  const briefing = query.get("demo") !== "1" && query.get("skip") !== "1" && !sharedPlan;
  if (briefing) showBriefing(site, () => {}, sites);
  else playOnce($("#app"), "boot", 1700);
  if (arrival) {
    // came through the dust sweep: no loading screen, the curtain opens straight onto the site
    $("#loading").hidden = true;
    arrival();
  } else hideAnimated($("#loading"), 350); // first visit: the loading screen fades out
  if (query.get("demo") === "1") void app.startDemo();
  markSiteLinks();

  // close-up ground materials (CC0 photo scans, shared by all sites): after the planner is up
  void (async () => {
    try {
      const root = `${import.meta.env.BASE_URL}data/`;
      const meta = (await (await fetch(`${root}materials/materials.json`)).json()) as {
        materials: Record<"sand" | "gravel" | "bedrock" | "rock", { sizeM: number; files: Record<string, string> }>;
      };
      const res = quality === "high" && maxTex >= 4096 ? "2k" : "1k";
      const aniso = view.renderer.capabilities.getMaxAnisotropy();
      const entries = await Promise.all(
        (Object.keys(meta.materials) as ("sand" | "gravel" | "bedrock" | "rock")[]).map(async (role) => {
          const t = await loadTexture(root + meta.materials[role].files[res]);
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.anisotropy = aniso;
          // Bright Angel's fracture plates are ~0.5-1 m: the scanned mud-crack ground is shown 3x larger
          const scale = role === "bedrock" ? 3 : 1;
          return [role, { texture: t, sizeM: meta.materials[role].sizeM * scale }] as const;
        }),
      );
      view.setMaterials(Object.fromEntries(entries) as Parameters<typeof view.setMaterials>[0]);
    } catch (err) {
      console.warn("close-up materials not loaded", err);
    }
  })();

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

const missionControl = new URLSearchParams(location.search).get("view") === "mission";
if (!missionControl) {
  initOffline();
  offerLiteIfSlow();
  // Trackpad pinch arrives as ctrl+wheel: keep it for the map instead of zooming the whole page.
  window.addEventListener("wheel", (ev) => ev.ctrlKey && ev.preventDefault(), { passive: false });
  for (const type of ["gesturestart", "gesturechange"]) window.addEventListener(type, (ev) => ev.preventDefault());
}

if (missionControl) {
  // Mission Control: its own page, no 3D terrain to load
  document.documentElement.classList.remove("sweep-boot");
  const site = new URLSearchParams(location.search).get("site") ?? "jezero";
  void import("./mission/dashboard").then(({ startMissionControl }) => startMissionControl(/^[A-Za-z0-9_-]{1,64}$/.test(site) ? site : "jezero"));
} else boot().catch((err: unknown) => {
  arrival?.(); // show the error, not the curtain
  console.error(err);
  const box = $("#loading");
  box.hidden = false;
  box.classList.add("failed");
  $("#load-label").textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
});
