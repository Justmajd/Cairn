import * as THREE from "three";
import { makeCairn, makeRover, marsEnvironment, seedOf } from "./models";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { SiteData } from "../data/loaders";
import type { MeasuredPath, PathSample, Poi, RegionMeta, XY } from "../types";
import { esc } from "../ui/dom";
import { ic } from "../ui/icons";
import { PostFX } from "./post";
import { Rocks } from "./rocks";
import { dustEffect } from "../eva/dust";
import { buildRegion, buildSky, buildTerrain, byteTexture, packedGridTexture, geologyLut, heightTexture, rgbaTexture, LAYER_IDS, LayerId, makeShadowUniforms, ShadowBaker, ShadowUniforms, SKY_HORIZON, Terrain } from "./terrain";

export interface SceneTextures {
  map: THREE.Texture; // HiRISE image of the walk area
  relief: THREE.Texture; // 1 m elevation gradient
  region: { meta: RegionMeta; heights: Float32Array; map: THREE.Texture } | null;
}

export type ViewMode = "plan" | "orbit" | "fly" | "walk" | "roam";
/** How free roam is seen: from above (map), from behind (3D) or through the helmet (visor). */
export type RoamLook = "plan" | "orbit" | "walk";

export interface RouteSet {
  safe: MeasuredPath[];
  straight: MeasuredPath[];
  showStraight: boolean;
  shelter: MeasuredPath | null;
  dimSafe: boolean; // grey out the planned route once it has been abandoned
}

export interface PoiMarkerState {
  poi: Poi;
  active: boolean;
  order: number | null; // visit order on the current plan
  noRadio?: boolean; // a planned stop with no radio contact to the rover
}

type Rgb = [number, number, number];
const CYAN: Rgb = [0.776, 0.957, 0.196]; // the route: fern, the interface accent
const AMBER: Rgb = [0.96, 0.71, 0.27];
const RED: Rgb = [1.0, 0.22, 0.2];
const WHITE: Rgb = [0.96, 0.96, 0.96];
const GREY: Rgb = [0.55, 0.6, 0.62];
const GREEN: Rgb = [0.45, 1.0, 0.55];

const EYE_HEIGHT_M = 1.7;
/** Closest the map and 3D cameras may come to the ground (m). */
const CAMERA_CLEARANCE_M = 3;
const sightDir = new THREE.Vector3();
const labelPos = new THREE.Vector3();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Tween {
  t: number;
  duration: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromFov: number;
  toFov: number;
  done: () => void;
}

/**
 * The 3D view.  One Three.js scene serves every map mode: the "2D" planner is the same terrain
 * seen from straight above, so routes and layers always line up and switching to 3D is a camera move.
 */
export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly terrain: Terrain;
  private readonly region: Terrain | null;
  private readonly sky: ReturnType<typeof buildSky>;
  /** Labels for Earth, Phobos and Deimos in the visor view (they follow the camera, like the sky). */
  private readonly skyLabels = new THREE.Group();
  private readonly skyTags = new Map<string, { obj: CSS2DObject; text: HTMLElement; up: boolean }>();
  private readonly regionHalf: number;
  private readonly shared: ShadowUniforms = makeShadowUniforms();
  private readonly fog: THREE.FogExp2;
  private readonly half: number;
  private readonly zRef: number;
  private exag = 1;
  private readonly baker: ShadowBaker;
  private readonly regionHeights: { n: number; cell: number; heights: Float32Array } | null;

  // ---- render on demand: draw only when the camera, the scene or the light changed
  private dirty = true;
  private shadowDirty = true;
  private bakedFast = false;
  private readonly rocks: Rocks;
  private readonly rocksOn: boolean;
  private readonly post: PostFX | null;
  private postSuspended = false;
  private fogBase = new THREE.Color();
  private dayK = 1;
  private sunChangedAt = 0;
  private lastBake = -1e9;
  private readonly bakedSun = new THREE.Vector3(0, -1, 0);
  private readonly lastCam = new Float64Array(32);
  // ---- adaptive resolution: lower the pixel ratio while frames are slow
  private dpr = 1;
  private dprMax = 1;
  private readonly perf = { lastT: 0, sum: 0, n: 0, good: 0, raisedAt: -1e9, rendered: false };

  private readonly routeGroup = new THREE.Group();
  private readonly trackGroup = new THREE.Group();
  private readonly poiGroup = new THREE.Group();
  private readonly relayGroup = new THREE.Group();
  private readonly spotGroup = new THREE.Group();
  /** The real rover's drive replayed as a translucent ghost (built on first use). */
  private ghost: { group: THREE.Group; label: HTMLElement } | null = null;
  private readonly lineMaterials = new Set<LineMaterial>();
  private shelterTex: THREE.DataTexture | null = null;
  /** Objects kept at a readable size: `px` screen pixels per model unit, never smaller than real size. */
  private readonly scaled: { obj: THREE.Object3D; px: number }[] = [];
  private readonly beams: THREE.Mesh[] = [];
  private readonly astronaut: THREE.Group;
  private readonly buddy: THREE.Group;
  private readonly hoverRing: THREE.Mesh;
  /** Light on the models (rover, cairns, astronauts): from the real Sun's direction, plus the dusty sky. */
  private readonly sunLight = new THREE.DirectionalLight(0xfff0dd, 2.2);
  private readonly skyLight = new THREE.HemisphereLight(0xffe2c4, 0x5a3a28, 1.6);

  private routes: RouteSet | null = null;
  private mode: ViewMode = "plan";
  private roamLook: RoamLook = "walk";
  /** The look that decides how the frame is drawn: free roam borrows the map, 3D or visor look. */
  private get look(): ViewMode {
    return this.mode === "roam" ? this.roamLook : this.mode;
  }
  private tween: Tween | null = null;
  private fly: { curve: THREE.CatmullRomCurve3; look: THREE.CatmullRomCurve3; t: number; duration: number; done: () => void } | null = null;
  private walk = { x: 0, y: 0, heading: 0, smoothHeading: 0, yaw: 0, pitch: -0.06, init: false, bob: 0 };
  private drag: { x: number; y: number } | null = null;
  private last = performance.now();
  private frame: ((dt: number) => void) | null = null;
  private fogTarget = 0;
  /** Screen space covered by the floating panels; the camera centres the view in what is left. */
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Uncrowded on-screen size of each stop label (see declutterLabels). */
  private labelSize = new WeakMap<HTMLElement, [number, number]>();
  /** True when the map was last framed while the page had no size. */
  private framedBlind = false;

  onPoiClick: (id: string) => void = () => {};
  onGroundClick: (p: XY, clientX: number, clientY: number) => void = () => {};
  onNoteClick: (id: string) => void = () => {};
  private readonly noteGroup = new THREE.Group();
  onHover: (p: XY | null, clientX: number, clientY: number) => void = () => {};

  constructor(private readonly host: HTMLElement, private readonly site: SiteData, tex: SceneTextures, quality: "high" | "low") {
    const grid = site.grid;
    this.half = grid.size / 2;
    this.zRef = site.meta.height.zMin;

    // standard depth buffer (a logarithmic one writes depth per pixel and disables early depth rejection);
    // the near plane follows the camera's height instead, see updateClip()
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.dprMax = Math.min(window.devicePixelRatio || 1, quality === "low" ? 1 : 2);
    this.dpr = this.dprMax;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x0b0d10, 1);
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "label-layer";
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.3, 60000);
    this.fog = new THREE.FogExp2(SKY_HORIZON, 0);
    this.fogBase = this.fog.color.clone();
    this.scene.fog = this.fog;

    this.sky = buildSky(this.shared.uSunDir, this.shared.uLinearOut);
    this.sky.mesh.scale.setScalar(40000);
    this.scene.add(this.sky.mesh);
    for (const [id, name] of [["earth", "Earth"], ["phobos", "Phobos"], ["deimos", "Deimos"]]) {
      const el = document.createElement("div");
      el.className = `sky-tag ${id}`;
      el.setAttribute("aria-hidden", "true"); // drawn over the 3D sky; the HUD and panels say the same in text
      el.innerHTML = `<i></i><span><b>${name}</b><small></small></span>`;
      const obj = new CSS2DObject(el);
      obj.center.set(-0.02, 0.5);
      obj.visible = false;
      this.skyLabels.add(obj);
      this.skyTags.set(id, { obj, text: el.querySelector("small")!, up: false });
    }
    this.scene.add(this.skyLabels);

    const n = grid.n;
    const layers = {
      terrain4: packedGridTexture(grid.slope, grid.sand, grid.effort, grid.risk, n),
      thermal: byteTexture(site.thermalGrid ?? new Uint8Array(n * n), n),
      geology: byteTexture(site.geologyGrid ?? new Uint8Array(n * n), n, THREE.NearestFilter),
      geoLut: geologyLut(site.geology?.units ?? []),
      minerals: rgbaTexture(site.mineralGrid, n),
      shield: byteTexture(grid.shield ?? new Uint8Array(n * n).fill(255), n),
    };
    // elevation textures for cast shadows
    const sh = this.shared;
    sh.uAoiHeight.value = heightTexture(grid.height, n, this.zRef);
    sh.uAoiN.value = n;
    sh.uAoiCell.value = grid.cell;
    sh.uAoiHalf.value = this.half;
    if (tex.region) {
      const r = tex.region.meta;
      sh.uRegHeight.value = heightTexture(tex.region.heights, r.n, this.zRef);
      sh.uRegN.value = r.n;
      sh.uRegCell.value = r.cellM;
      sh.uRegOrigin.value.set(r.originLocal.x - this.half, this.half - (r.originLocal.y + r.sizeM));
      sh.uHasRegion.value = 1;
    }
    this.regionHeights = tex.region ? { n: tex.region.meta.n, cell: tex.region.meta.cellM, heights: tex.region.heights } : null;
    this.baker = new ShadowBaker(sh);
    const reliefRange = site.meta.relief?.range ?? 1.5;
    this.terrain = buildTerrain(grid, this.zRef, tex.map, tex.relief, reliefRange, layers, quality === "low" ? 2 : 1, sh);
    this.scene.add(this.terrain.mesh);
    this.rocks = new Rocks(grid, this.half, (x, y) => (grid.heightAt(x, y) - this.zRef) * this.exag, this.terrain.uniforms.uMap as THREE.IUniform<THREE.Texture>, sh);
    this.rocksOn = quality === "high";
    this.post = quality === "high" ? new PostFX() : null;
    this.scene.add(this.rocks.group);
    this.region = tex.region ? buildRegion(tex.region.meta, tex.region.heights, this.zRef, tex.region.map, grid.size, quality === "low" ? 2 : 1, sh) : null;
    if (this.region) this.scene.add(this.region.mesh);
    this.regionHalf = tex.region ? tex.region.meta.sizeM / 2 : this.half;
    this.addAreaOutline();

    this.sunLight.position.set(-720, 620, -120);
    this.scene.add(this.sunLight, this.skyLight);
    // reflections for the models (the terrain and rocks have their own shaders and ignore it)
    this.scene.environment = marsEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.55;

    this.scene.add(this.trackGroup, this.routeGroup, this.poiGroup, this.relayGroup, this.spotGroup, this.noteGroup);

    this.astronaut = this.makeAstronaut(0x3fe8ff);
    this.buddy = this.makeAstronaut(0xffc247);
    this.astronaut.visible = false;
    this.buddy.visible = false;
    this.scene.add(this.astronaut, this.buddy);
    this.scaled.push({ obj: this.astronaut, px: 13 }, { obj: this.buddy, px: 13 });

    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, fog: false }),
    );
    this.hoverRing.visible = false;
    this.hoverRing.renderOrder = 20;
    this.scene.add(this.hoverRing);
    this.scaled.push({ obj: this.hoverRing, px: 11 });

    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 14000;
    this.controls.addEventListener("change", () => this.clampTarget());
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 1.2;
    this.applyPlanPose(false);

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  /** Photo-scanned close-up materials for the ground and the rocks (loaded after the planner is up). */
  setMaterials(m: Record<"sand" | "gravel" | "bedrock" | "rock", { texture: THREE.Texture; sizeM: number }>): void {
    const u = this.terrain.uniforms;
    u.uMatSand.value = m.sand.texture;
    u.uMatGravel.value = m.gravel.texture;
    u.uMatBed.value = m.bedrock.texture;
    (u.uMatSize.value as THREE.Vector3).set(m.sand.sizeM, m.gravel.sizeM, m.bedrock.sizeM);
    u.uMatOn.value = 1;
    this.rocks.setMaterial(m.rock.texture, m.rock.sizeM);
    this.dirty = true;
  }

  /** Draw the 3D views through the post-processing pipeline (AO, glare); the flat map directly. */
  drawScene(): void {
    const post = this.post && !this.postSuspended && this.look !== "plan" ? this.post : null;
    this.shared.uLinearOut.value = post ? 1 : 0;
    if (post) post.render(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Compile every shader without blocking (KHR_parallel_shader_compile where available). */
  async compileShaders(): Promise<void> {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      // the first frame compiles them instead
    }
  }

  // ---------------------------------------------------------------- coordinates
  /** Local (x east, y north, z elevation) → world position. */
  toWorld(x: number, y: number, z: number, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(x - this.half, (z - this.zRef) * this.exag + lift, this.half - y);
  }

  private ground(x: number, y: number, lift = 0): THREE.Vector3 {
    return this.toWorld(x, y, this.site.grid.heightAt(x, y), lift);
  }

  // ---------------------------------------------------------------- frame loop
  start(frame: (dt: number) => void): void {
    this.frame = frame;
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame?.(dt);
      this.update(dt);
      const drew = this.renderIfNeeded(now);
      this.adaptResolution(now, drew);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** Ask for a new frame (something in the scene changed). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Bake shadows if the light changed, then draw the frame if anything visible changed. */
  renderIfNeeded(now = performance.now()): boolean {
    // re-bake at most ~10 times a second while the Sun is moving, at a quarter of the cost; once it has
    // been still for a moment the full-resolution shadows are baked again, so a still image is unchanged
    if (this.shadowDirty && now - this.lastBake > 90) {
      const moving = this.lastBake > 0 && now - this.sunChangedAt < 250;
      this.baker.bake(this.renderer, moving);
      this.bakedFast = moving;
      this.bakedSun.copy(this.shared.uSunDir.value);
      this.lastBake = now;
      this.shadowDirty = false;
      this.dirty = true;
    } else if (!this.shadowDirty && this.bakedFast && now - this.sunChangedAt > 250) {
      this.baker.bake(this.renderer);
      this.bakedFast = false;
      this.dirty = true;
    }
    this.camera.updateMatrixWorld();
    const moved = this.cameraMoved();
    const fading = Math.abs(this.fogGoal() - this.fog.density) > 1e-7;
    if (!moved && !fading && !this.dirty) return false;
    this.dirty = false;
    this.drawScene();
    this.labels.render(this.scene, this.camera);
    this.declutterLabels();
    return true;
  }

  /**
   * Stop labels that land on top of each other: the rover's label wins, then the stops on the route
   * (which shrink to their number), then the optional places (which hide).  Sizes are measured once,
   * uncrowded, so a label never flickers between its two states.
   */
  private declutterLabels(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const items: { el: HTMLElement; rank: number; x: number; y: number; size: [number, number] }[] = [];
    for (const holder of [...this.poiGroup.children, ...this.relayGroup.children]) {
      const label = holder.children.find((c): c is CSS2DObject => c instanceof CSS2DObject);
      if (!label) continue;
      const el = label.element;
      if (el.style.display === "none") continue;
      let size = this.labelSize.get(el);
      if (!size) {
        if (!el.isConnected || !el.offsetWidth) continue;
        size = [el.offsetWidth, el.offsetHeight];
        this.labelSize.set(el, size);
      }
      labelPos.setFromMatrixPosition(label.matrixWorld).project(this.camera);
      const rank = el.classList.contains("shelter") ? 0 : el.classList.contains("active") || el.classList.contains("relay") ? 1 : 2;
      items.push({ el, rank, x: (labelPos.x * 0.5 + 0.5) * w, y: (-labelPos.y * 0.5 + 0.5) * h, size });
    }
    items.sort((a, b) => a.rank - b.rank || a.y - b.y);
    const kept: [number, number, number, number][] = [];
    for (const it of items) {
      const [fw, fh] = it.size;
      const box: [number, number, number, number] = [it.x - fw / 2, it.y - fh, it.x + fw / 2, it.y];
      const crowded = kept.some((k) => box[0] < k[2] - 3 && box[2] > k[0] + 3 && box[1] < k[3] - 3 && box[3] > k[1] + 3);
      it.el.classList.toggle("crowded", crowded);
      // a crowded route stop keeps its number badge, which still takes room
      if (!crowded) kept.push(box);
      else if (it.rank === 1) kept.push([it.x - fh / 2, it.y - fh, it.x + fh / 2, it.y]);
    }
  }

  private cameraMoved(): boolean {
    const w = this.camera.matrixWorld.elements;
    const p = this.camera.projectionMatrix.elements;
    const s = this.lastCam;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      // translation in metres, rotation and projection terms are unitless
      if (Math.abs(w[i] - s[i]) > (i >= 12 ? 1e-3 : 1e-6) || Math.abs(p[i] - s[16 + i]) > 1e-7 * Math.max(1, Math.abs(p[i]))) {
        moved = true;
        break;
      }
    }
    if (moved) {
      for (let i = 0; i < 16; i++) {
        s[i] = w[i];
        s[16 + i] = p[i];
      }
    }
    return moved;
  }

  /**
   * While the view is moving, watch the frame interval: if frames are slow, render fewer pixels
   * (pixel ratio steps down to 1); once they are fast again for a while, step back up.
   */
  private adaptResolution(now: number, drew: boolean): void {
    const p = this.perf;
    const gap = now - p.lastT;
    const continuous = drew && p.rendered && gap < 70 && !document.hidden;
    p.rendered = drew;
    p.lastT = now;
    if (!continuous) return;
    p.sum += gap;
    if (++p.n < 30) return;
    const avg = p.sum / p.n;
    p.sum = 0;
    p.n = 0;
    if (avg > 21 && this.post && !this.postSuspended && this.look !== "plan") {
      this.postSuspended = true; // slow GPU: drop the post effects (AO, glare) before dropping resolution
      p.good = 0;
    } else if (avg > 21 && this.dpr > 1) {
      if (now - p.raisedAt < 3000) {
        this.dprMax = this.dpr - 0.25; // the last step up was too much: stay below it
        p.raisedAt = -1e9;
      }
      this.setPixelRatio(Math.max(1, this.dpr - 0.25));
      p.good = 0;
    } else if (avg < 18 && this.dpr < this.dprMax) {
      if (++p.good >= 5) {
        this.setPixelRatio(Math.min(this.dprMax, this.dpr + 0.25));
        p.raisedAt = now;
        p.good = 0;
      }
    } else p.good = 0;
  }

  private setPixelRatio(v: number): void {
    this.dpr = v;
    this.renderer.setPixelRatio(v);
    this.resize();
  }

  /** Current pixel ratio and its upper limit (for diagnostics). */
  pixelRatio(): { now: number; max: number } {
    return { now: this.dpr, max: this.dprMax };
  }

  /** Height of the ground below a world point (world units), interpolated like the mesh. */
  private groundYBelow(x: number, z: number): number {
    const gx = x + this.half;
    const gy = this.half - z;
    const grid = this.site.grid;
    if (grid.inside(gx, gy)) return (grid.heightAt(gx, gy) - this.zRef) * this.exag;
    const r = this.regionHeights;
    if (r) {
      const o = this.shared.uRegOrigin.value;
      const fc = (x - o.x) / r.cell;
      const fr = (z - o.y) / r.cell;
      const c = Math.floor(fc);
      const row = Math.floor(fr);
      if (c >= 0 && row >= 0 && c < r.n - 1 && row < r.n - 1) {
        const h = r.heights;
        const i = row * r.n + c;
        const tx = fc - c;
        const top = h[i] + (h[i + 1] - h[i]) * tx;
        const bottom = h[i + r.n] + (h[i + r.n + 1] - h[i + r.n]) * tx;
        return (top + (bottom - top) * (fr - row) - this.zRef) * this.exag;
      }
    }
    return 0;
  }

  /** Highest ground at and around a point: the camera must clear all of it, not just one sample. */
  private groundAround(x: number, z: number, r: number): number {
    return Math.max(
      this.groundYBelow(x, z),
      this.groundYBelow(x + r, z),
      this.groundYBelow(x - r, z),
      this.groundYBelow(x, z + r),
      this.groundYBelow(x, z - r),
    );
  }

  /**
   * Where a ray first meets the ground (walk area or surroundings), marched over the height grids:
   * each step is a fraction of the height above the ground, so it is fine near the surface and fast above it.
   */
  private marchRay(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): THREE.Vector3 | null {
    const above = (t: number) => o.y + d.y * t - this.groundYBelow(o.x + d.x * t, o.z + d.z * t);
    let h = above(0);
    if (h <= 0) return null;
    let prev = 0;
    let t = 0;
    for (let i = 0; i < 700 && t < maxDist; i++) {
      t += Math.max(0.5, h * 0.45);
      h = above(t);
      if (h <= 0) {
        let a = prev;
        let b = t;
        for (let k = 0; k < 14; k++) {
          const m = (a + b) / 2;
          if (above(m) > 0) a = m;
          else b = m;
        }
        return o.clone().addScaledVector(d, b);
      }
      prev = t;
    }
    return null;
  }

  /** Where the camera's line of sight meets the ground. */
  private sightOnGround(maxDist: number): THREE.Vector3 | null {
    return this.marchRay(this.camera.position, this.camera.getWorldDirection(sightDir), maxDist);
  }

  /**
   * Keep the camera out of the ground.  In the 3D view the point it turns around is pinned to the
   * surface it is looking at, so dragging over hills or zooming towards them never leaves the pivot
   * buried; then the camera itself is held a few metres above the ground below it.
   * Returns true when the camera or its target moved.
   */
  private keepAboveGround(): boolean {
    const cam = this.camera.position;
    const t = this.controls.target;
    let moved = false;
    if (this.mode === "orbit" && !this.tween) {
      const gap = t.y - this.groundYBelow(t.x, t.z);
      const dist = cam.distanceTo(t);
      if (Math.abs(gap) > Math.max(1.5, dist * 0.02)) {
        const hit = this.sightOnGround(Math.max(3000, dist * 3));
        if (hit) t.copy(hit);
        else if (gap < 0) {
          t.y -= gap;
          cam.y -= gap;
        }
        moved = true;
      }
    }
    const floor = this.groundAround(cam.x, cam.z, 6) + CAMERA_CLEARANCE_M;
    if (cam.y < floor) {
      cam.y = floor;
      moved = true;
    }
    return moved;
  }

  /**
   * Mesh detail for the walk area, tile by tile, from the on-screen size of a 2 m cell.  The image,
   * relief shading and shadows come from textures, so a coarser mesh only changes the outline of the
   * ground: invisible in the top-down map, and only far away in the 3D views.
   */
  private updateDetail(): void {
    const thresholds: [number, number] = this.look === "plan" ? [8, 4] : this.look === "walk" || this.mode === "roam" ? [10, 4] : [6, 2.5];
    this.terrain.updateLod?.(this.camera, Math.max(1, this.host.clientHeight) * this.dpr, thresholds);
  }

  /** Near plane at a fraction of the camera's height above the ground: depth precision where it is needed. */
  private updateClip(): void {
    const cam = this.camera;
    const near = this.mode === "roam" && this.roamNear > 0 ? this.roamNear : this.look === "walk" ? 0.15 : this.mode === "roam" && this.look === "orbit" ? 0.3 : THREE.MathUtils.clamp((cam.position.y - this.groundYBelow(cam.position.x, cam.position.z)) * 0.35, 0.3, 4000);
    const far = Math.max(42000, cam.position.length() + this.regionHalf * 1.5);
    if (Math.abs(near - cam.near) > cam.near * 0.1 || Math.abs(far - cam.far) > cam.far * 0.1) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /** Seconds into the "To shelter" flood animation, or null when it is not running. */
  private revealT: number | null = null;

  private update(dt: number): void {
    if (this.revealT !== null) {
      this.revealT += dt;
      const minutes = (this.revealT / 2.2) * 40; // 40 minutes of walking in 2.2 s
      this.terrain.uniforms.uReveal.value = minutes >= 40 ? 1000 : minutes;
      if (minutes >= 40) this.revealT = null;
      this.dirty = true;
    }
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = ease(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      this.camera.fov = tw.fromFov + (tw.toFov - tw.fromFov) * k;
      this.camera.updateProjectionMatrix();
      this.keepAboveGround();
      this.camera.lookAt(this.controls.target);
      if (tw.t >= 1) {
        this.tween = null;
        tw.done();
      }
    } else if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.duration);
      const u = ease(f.t);
      this.camera.position.copy(f.curve.getPointAt(u));
      this.camera.lookAt(f.look.getPointAt(Math.min(1, u + 0.04)));
      if (f.t >= 1) {
        this.fly = null;
        f.done();
      }
    } else if (this.mode === "walk") {
      this.updateWalkCamera(dt);
    } else if (this.mode === "roam") {
      // free roam places the camera itself (setRoamCamera), every frame
    } else {
      this.controls.update();
      if (this.keepAboveGround()) this.camera.lookAt(this.controls.target);
    }

    this.updateClip();
    this.updateDetail();
    const cp = this.camera.position;
    this.rocks.update(this.camera, cp.y - this.groundYBelow(cp.x, cp.z), this.rocksOn && this.look !== "plan" && this.exag === 1);
    // a dust storm thickens the haze in the 3D views (never on the flat map)
    const fogGoal = this.fogGoal();
    this.fog.density += (fogGoal - this.fog.density) * Math.min(1, dt * 3);
    if (Math.abs(fogGoal - this.fog.density) < 1e-7) this.fog.density = fogGoal;
    this.sky.mesh.position.copy(this.camera.position);
    this.skyLabels.position.copy(this.camera.position);
    for (const t of this.skyTags.values()) t.obj.visible = t.up && this.look === "walk";

    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.host.clientHeight);
    for (const s of this.scaled) {
      if (!s.obj.visible) continue;
      const metresPerPixel = this.camera.position.distanceTo(s.obj.position) * perPixel;
      s.obj.scale.setScalar(Math.max(1, metresPerPixel * s.px));
    }
    const walking = this.look === "walk";
    for (const beam of this.beams) beam.visible = walking;
    // the resolution note sits at the walk area's corner: hide it while that corner is under a panel
    if (this.outline) {
      const tag = this.outline.children.find((c) => c instanceof CSS2DObject) as CSS2DObject | undefined;
      if (tag) {
        const p = tag.position.clone().project(this.camera);
        const h = this.host.clientHeight;
        const w = this.host.clientWidth;
        const sx = ((p.x + 1) / 2) * w;
        const sy = ((1 - p.y) / 2) * h;
        const free = sy > this.insets.top + 8 && sy < h - this.insets.bottom - 30 && sx > this.insets.left + 8 && sx < w - this.insets.right - 200;
        tag.visible = free && p.z < 1;
      }
    }
    // standing at a stop in the visor: hide its marker so the camera is not inside it
    for (const holder of this.poiGroup.children) {
      holder.visible = !(walking && holder.position.distanceTo(this.camera.position) < 9);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    // The map was framed while the page had no size (a hidden tab or panel): frame it again now.
    const reframe = this.framedBlind && w > 50 && h > 50 && this.mode === "plan" && !this.tween;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    this.dirty = true;
    if (reframe) this.applyPlanPose(false);
  }

  // ---------------------------------------------------------------- camera modes
  getMode(): ViewMode {
    return this.mode;
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = insets;
    this.applyViewOffset();
    this.dirty = true;
  }

  private applyViewOffset(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const i = this.insets;
    const dx = (i.left - i.right) / 2;
    const dy = (i.top - i.bottom) / 2;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -dx, -dy, w, h);
    this.camera.updateProjectionMatrix();
  }

  private planPose(target: THREE.Vector3) {
    // A narrow lens from far away is close to a true map projection: relief barely distorts the picture.
    const fov = 12;
    this.framedBlind = this.host.clientWidth < 50 || this.host.clientHeight < 50;
    const w = Math.max(1, this.host.clientWidth || window.innerWidth);
    const h = Math.max(1, this.host.clientHeight || window.innerHeight);
    const fw = Math.max(200, w - this.insets.left - this.insets.right);
    const fh = Math.max(200, h - this.insets.top - this.insets.bottom);
    const fit = Math.max(h / fh, (w / fw) * (h / w)); // walk area must fit the free space in both directions
    const height = (this.half / Math.tan(THREE.MathUtils.degToRad(fov / 2))) * 1.06 * fit;
    return { pos: new THREE.Vector3(target.x, target.y + height, target.z + height * 0.0015), fov };
  }

  private orbitPose(target: THREE.Vector3) {
    const r = Math.min(1500, Math.max(500, this.camera.position.distanceTo(this.controls.target) * 0.42));
    const polar = THREE.MathUtils.degToRad(58);
    const az = THREE.MathUtils.degToRad(-28);
    return {
      pos: new THREE.Vector3(target.x + r * Math.sin(polar) * Math.sin(az), target.y + r * Math.cos(polar), target.z + r * Math.sin(polar) * Math.cos(az)),
      fov: 42,
    };
  }

  /** Map view: dark flat backdrop, no haze, wide zoom range.  3D views: sky, haze, region fades into the horizon. */
  private styleFor(mode: ViewMode): void {
    const map = mode === "plan";
    this.dirty = true;
    this.sky.setMapMode(map ? 1 : 0);
    this.controls.maxDistance = map ? 52000 : 14000;
    if (this.region) {
      const edge = this.region.uniforms.uEdgeColor.value as THREE.Color;
      edge.setHex(map ? 0x0f0d0c : SKY_HORIZON, THREE.LinearSRGBColorSpace);
      if (!map) edge.multiplyScalar(this.dayK);
    }
  }

  /** Keep the camera over the mapped area. */
  private clampTarget(): void {
    const lim = this.regionHalf - 1200;
    const t = this.controls.target;
    const dx = THREE.MathUtils.clamp(t.x, -lim, lim) - t.x;
    const dz = THREE.MathUtils.clamp(t.z, -lim, lim) - t.z;
    if (dx || dz) {
      t.x += dx;
      t.z += dz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  private applyPlanPose(animate: boolean): void {
    const target = new THREE.Vector3(0, (this.site.meta.height.zMax - this.zRef) * 0.35 * this.exag, 0);
    const pose = this.planPose(target);
    this.fogTarget = 0;
    this.styleFor("plan");
    const finish = () => {
      this.controls.enabled = true;
      this.controls.enableRotate = false;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = 0.002;
      this.useMapGestures();
      this.controls.update();
    };
    if (!animate) {
      this.camera.position.copy(pose.pos);
      this.controls.target.copy(target);
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(target);
      finish();
    } else this.startTween(pose.pos, target, pose.fov, 1.5, finish);
  }

  private startTween(toPos: THREE.Vector3, toTarget: THREE.Vector3, toFov: number, duration: number, done: () => void): void {
    if (reducedMotion.matches) duration = Math.min(duration, 0.25); // still a cue to where the view went, not a ride
    this.controls.enabled = false;
    this.fly = null;
    this.tween = {
      t: 0, duration,
      fromPos: this.camera.position.clone(), toPos,
      fromTarget: this.controls.target.clone(), toTarget,
      fromFov: this.camera.fov, toFov, done,
    };
  }

  /** Switch between the top-down planner and the tilted 3D view. */
  setMode(mode: "plan" | "orbit", focus?: XY): void {
    if (this.mode === "walk") this.leaveWalk();
    this.mode = mode;
    this.host.dataset.mode = mode;
    if (mode === "plan") {
      this.applyPlanPose(true);
      return;
    }
    const target = focus ? this.ground(focus.x, focus.y) : this.controls.target.clone().setY(this.ground(this.controls.target.x + this.half, this.half - this.controls.target.z).y);
    const pose = this.orbitPose(target);
    this.fogTarget = 0.00011;
    this.styleFor("orbit");
    this.startTween(pose.pos, target, pose.fov, 1.6, () => this.releaseOrbit());
  }

  /** Map view: drag moves the map, scroll zooms.  The map stays north-up and flat. */
  private useMapGestures(): void {
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  /** 3D view: drag rotates and tilts, Shift-drag or right-drag moves, scroll zooms. */
  private releaseOrbit(): void {
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
    this.controls.enabled = true;
    this.controls.enableRotate = true;
    this.controls.update();
  }

  /**
   * One step of the on-screen / keyboard camera controls.
   * Zoom works in both map views; rotate, tilt and "north" only in the 3D view.
   */
  nudge(action: "in" | "out" | "left" | "right" | "up" | "down" | "north"): void {
    if (this.tween || this.fly || this.mode === "walk" || this.mode === "fly" || this.mode === "roam") return;
    const target = this.controls.target.clone();
    const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
    if (action === "in" || action === "out") {
      sph.radius = THREE.MathUtils.clamp(sph.radius * (action === "in" ? 0.7 : 1 / 0.7), this.controls.minDistance, this.controls.maxDistance);
    } else if (this.mode !== "orbit") {
      return;
    } else if (action === "left" || action === "right") {
      sph.theta += THREE.MathUtils.degToRad(action === "left" ? -30 : 30);
    } else if (action === "up" || action === "down") {
      sph.phi = THREE.MathUtils.clamp(sph.phi + THREE.MathUtils.degToRad(action === "up" ? -12 : 12), THREE.MathUtils.degToRad(4), this.controls.maxPolarAngle);
    } else {
      sph.theta = 0;
    }
    const toPos = new THREE.Vector3().setFromSpherical(sph).add(target);
    const orbit = this.mode === "orbit";
    this.startTween(toPos, target, this.camera.fov, 0.35, () => {
      if (orbit) this.releaseOrbit();
      else {
        this.controls.enabled = true;
        this.controls.update();
      }
    });
  }

  /** Slow turntable rotation in the 3D view (used by the guided demo). */
  setAutoRotate(on: boolean, speed = 0.5): void {
    this.controls.autoRotate = on && this.mode === "orbit";
    this.controls.autoRotateSpeed = speed;
  }

  /** Start far above the region, then descend to the planning view of the walk area. */
  overview(): Promise<void> {
    if (this.mode === "walk") this.leaveWalk();
    this.mode = "plan";
    this.host.dataset.mode = "plan";
    this.styleFor("plan");
    const target = new THREE.Vector3(0, (this.site.meta.height.zMax - this.zRef) * 0.35 * this.exag, 0);
    const pose = this.planPose(target);
    this.tween = null;
    this.fly = null;
    this.camera.position.set(target.x, target.y + (pose.pos.y - target.y) * 4.2, target.z + 1);
    this.controls.target.copy(target);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    return new Promise((resolve) => {
      this.startTween(pose.pos, target, pose.fov, 4.5, () => {
        this.controls.enabled = true;
        this.controls.enableRotate = false;
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = 0.002;
        this.useMapGestures();
        this.controls.update();
        resolve();
      });
    });
  }

  isAnimating(): boolean {
    return !!this.tween || !!this.fly || this.mode === "fly";
  }

  /** Glide to a ground point in the walk area. */
  focusOn(p: XY): void {
    this.glideTo(this.ground(p.x, p.y));
  }

  /**
   * Double-click: glide to a world point on the ground — walk area or surroundings — keeping the
   * viewing angle and moving in closer (to 50 % of the distance in 3D, 60 % on the map).
   */
  private glideTo(target: THREE.Vector3): void {
    if (this.tween || this.fly || this.mode === "walk" || this.mode === "fly" || this.mode === "roam") return;
    const plan = this.mode === "plan";
    const to = target.clone();
    if (plan) to.y = this.controls.target.y; // the map keeps its pivot height
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = offset.length();
    offset.setLength(Math.min(dist, plan ? Math.max(300, dist * 0.6) : Math.max(140, dist * 0.5)));
    const orbit = this.mode === "orbit";
    this.startTween(to.clone().add(offset), to, this.camera.fov, 0.9, () => {
      if (orbit) this.releaseOrbit();
      else {
        this.controls.enabled = true;
        this.controls.update();
      }
    });
  }

  /** Cinematic fly-through along a route, then settle into the 3D view at its end. */
  flyAlong(samples: PathSample[], duration: number): Promise<void> {
    if (this.mode === "walk") this.leaveWalk();
    return new Promise((resolve) => {
      const stride = Math.max(1, Math.floor(samples.length / 70));
      const cam: THREE.Vector3[] = [];
      const look: THREE.Vector3[] = [];
      for (let i = 0; i < samples.length; i += stride) {
        const s = samples[i];
        look.push(this.toWorld(s.x, s.y, s.z, 2));
        cam.push(this.toWorld(s.x, s.y, s.z, 70 + 25 * Math.sin(i * 0.02)));
      }
      if (cam.length < 4) return resolve();
      // camera trails the look point, offset to the south so the route stays in frame
      const camCurve = new THREE.CatmullRomCurve3(cam.map((p) => p.clone().add(new THREE.Vector3(-40, 0, 120))), false, "centripetal");
      const lookCurve = new THREE.CatmullRomCurve3(look, false, "centripetal");
      this.mode = "fly";
      this.host.dataset.mode = "fly";
      this.fogTarget = 0.00022;
      this.styleFor("fly");
      this.controls.enabled = false;
      const begin = () => {
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();
        this.fly = {
          curve: camCurve, look: lookCurve, t: 0, duration,
          done: () => {
            const end = samples[samples.length - 1];
            this.mode = "orbit";
            this.setMode("orbit", { x: end.x, y: end.y });
            resolve();
          },
        };
      };
      this.startTween(camCurve.getPointAt(0), lookCurve.getPointAt(0.04), 50, 1.4, begin);
    });
  }

  enterWalk(x: number, y: number, headingRad: number): void {
    this.mode = "walk";
    this.host.dataset.mode = "walk";
    this.tween = null;
    this.fly = null;
    this.controls.enabled = false;
    this.fogTarget = 0.00032;
    this.styleFor("walk");
    this.camera.fov = 68;
    this.camera.updateProjectionMatrix();
    this.walk = { x, y, heading: headingRad, smoothHeading: headingRad, yaw: 0, pitch: -0.06, init: true, bob: 0 };
    this.dirty = true;
    this.astronaut.visible = false;
    if (this.routes) this.setRoutes(this.routes);
  }

  private leaveWalk(): void {
    this.mode = "orbit";
    if (this.routes) this.setRoutes(this.routes);
    const at = this.ground(this.walk.x, this.walk.y);
    this.controls.target.copy(at);
    this.camera.position.set(at.x - 60, at.y + 160, at.z + 220);
    this.astronaut.visible = this.walk.init;
  }

  // ---------------------------------------------------------------- free roam
  /** Free roam: the camera belongs to the roam controller; `look` picks how the frame is drawn. */
  enterRoam(look: RoamLook): void {
    this.mode = "roam";
    this.tween = null;
    this.fly = null;
    this.controls.enabled = false;
    this.astronaut.visible = false;
    this.buddy.visible = false;
    this.setRoamLook(look);
  }

  setRoamLook(look: RoamLook): void {
    this.roamLook = look;
    this.host.dataset.mode = `roam-${look}`;
    this.fogTarget = look === "plan" ? 0 : look === "walk" ? 0.00032 : 0.00018;
    this.styleFor(look);
    if (this.routes) this.setRoutes(this.routes);
    this.dirty = true;
  }

  private roamNear = 0;
  /** Near clipping plane for free roam's visor (the gloves are a few tens of cm from the eyes); 0 = default. */
  setRoamNear(m: number): void {
    this.roamNear = m;
  }

  /** Put the camera at `pos` looking at `target` (world coordinates), with a vertical field of view in degrees. */
  setRoamCamera(pos: THREE.Vector3, target: THREE.Vector3, fov: number): void {
    this.camera.position.copy(pos);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(target);
  }

  /** Add an object to the scene (free roam's astronaut, footprints, dust). */
  add(obj: THREE.Object3D, keepReadablePx = 0): void {
    this.scene.add(obj);
    if (keepReadablePx) this.scaled.push({ obj, px: keepReadablePx });
  }

  /** The camera, for projecting points on screen and listening positions. */
  get cam(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Ground height in world units below a world point (walk area or the region around it). */
  groundAt(x: number, z: number): number {
    return this.groundYBelow(x, z);
  }

  private updateWalkCamera(dt: number): void {
    const w = this.walk;
    let diff = w.heading - w.smoothHeading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    w.smoothHeading += diff * Math.min(1, dt * 2.2);
    if (!this.drag) w.yaw *= Math.max(0, 1 - dt * 0.6); // drift back to the walking direction
    const pos = this.ground(w.x, w.y, EYE_HEIGHT_M + Math.sin(w.bob) * 0.03);
    this.camera.position.copy(pos);
    const h = w.smoothHeading + w.yaw;
    const cp = Math.cos(w.pitch);
    this.camera.lookAt(pos.x + Math.sin(h) * cp * 10, pos.y + Math.sin(w.pitch) * 10, pos.z - Math.cos(h) * cp * 10);
  }

  /** Compass heading (deg, 0 = north) the camera is looking toward. */
  cameraHeadingDeg(): number {
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    return (THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z)) + 360) % 360;
  }

  /** Metres per CSS pixel at the controls target — for the scale bar. */
  metresPerPixel(): number {
    const dist = this.camera.position.distanceTo(this.controls.target);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.host.clientHeight);
  }

  // ---------------------------------------------------------------- astronaut
  /**
   * An astronaut in a suit (about 1.85 m), plus a coloured ring and halo that find it on the map.  Simple
   * shapes, but a person at visor distance: legs, torso, arms, helmet with a gold visor, life-support pack.
   */
  private makeAstronaut(color: number): THREE.Group {
    const g = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: 0xeeeae4, roughness: 0.75 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x8d8780, roughness: 0.8 });
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      g.add(m);
      return m;
    };
    const leg = new THREE.CapsuleGeometry(0.11, 0.55, 4, 10);
    part(leg, suit, -0.12, 0.42, 0);
    part(leg, suit, 0.12, 0.42, 0);
    const boot = new THREE.BoxGeometry(0.16, 0.1, 0.3);
    part(boot, dark, -0.12, 0.05, -0.04);
    part(boot, dark, 0.12, 0.05, -0.04);
    part(new THREE.CapsuleGeometry(0.24, 0.36, 4, 12), suit, 0, 1.12, 0);
    const arm = new THREE.CapsuleGeometry(0.08, 0.46, 4, 8);
    part(arm, suit, -0.34, 1.08, -0.02, -0.18);
    part(arm, suit, 0.34, 1.08, -0.02, 0.18);
    part(new THREE.BoxGeometry(0.44, 0.52, 0.22), suit, 0, 1.18, 0.24); // life-support pack (behind)
    part(new THREE.SphereGeometry(0.18, 16, 12), suit, 0, 1.6, 0);
    const visor = part(new THREE.SphereGeometry(0.15, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: 0xffb347, metalness: 0.8, roughness: 0.2 }), 0, 1.6, -0.06);
    visor.rotation.x = -Math.PI / 2; // facing forward (−Z)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, fog: false }),
    );
    ring.position.y = 0.05;
    ring.renderOrder = 30;
    ring.name = "marker";
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false, fog: false }),
    );
    halo.position.y = 0.04;
    halo.renderOrder = 29;
    halo.name = "marker";
    g.add(ring, halo);
    return g;
  }

  /** Place the astronaut (and the camera, in walk mode).  `null` hides the marker. */
  setAstronaut(pose: { x: number; y: number; headingRad: number; moving: boolean } | null, dt = 0): void {
    if (!pose) {
      if (this.astronaut.visible) this.dirty = true;
      this.astronaut.visible = false;
      this.walk.init = false;
      return;
    }
    const at = this.ground(pose.x, pose.y);
    const visible = this.mode !== "walk";
    if (!at.equals(this.astronaut.position) || this.astronaut.rotation.y !== -pose.headingRad || this.astronaut.visible !== visible) this.dirty = true;
    this.astronaut.position.copy(at);
    this.astronaut.rotation.y = -pose.headingRad;
    this.astronaut.visible = visible;
    this.walk.x = pose.x;
    this.walk.y = pose.y;
    this.walk.heading = pose.headingRad;
    this.walk.init = true;
    if (pose.moving) this.walk.bob += dt * 7;
  }

  private buddyLast: XY | null = null;
  /** The other astronaut.  `inVisor`: also in the first-person view (two devices: each sees the other suit). */
  setBuddy(pose: XY | null, inVisor = false): void {
    const near = !!pose && this.mode === "walk" && Math.hypot(pose.x - this.walk.x, pose.y - this.walk.y) < 2;
    const visible = !!pose && (this.mode !== "walk" || (inVisor && !near));
    // seen through the visor it is a person standing there, not a map marker
    for (const c of this.buddy.children) if (c.name === "marker") c.visible = this.mode !== "walk";
    const at = pose ? this.ground(pose.x, pose.y) : this.buddy.position;
    // face the way they walk (heading clockwise from north, as for the astronaut)
    if (pose && this.buddyLast && Math.hypot(pose.x - this.buddyLast.x, pose.y - this.buddyLast.y) > 0.05) {
      this.buddy.rotation.y = -Math.atan2(pose.x - this.buddyLast.x, pose.y - this.buddyLast.y);
    }
    if (pose) this.buddyLast = { x: pose.x, y: pose.y };
    if (visible !== this.buddy.visible || !at.equals(this.buddy.position)) this.dirty = true;
    this.buddy.visible = visible;
    this.buddy.position.copy(at);
  }

  /** Keep the astronaut in view while following an EVA in the map views. */
  follow(x: number, y: number, dt: number): void {
    if (this.mode === "walk" || this.mode === "roam" || this.tween || this.fly) return;
    const to = this.ground(x, y);
    const delta = to.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 1.5));
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  // ---------------------------------------------------------------- layers
  setExaggeration(value: number): void {
    this.exag = value;
    this.shared.uExag.value = value;
    this.shadowDirty = true;
    this.dirty = true;
    if (this.routes) this.setRoutes(this.routes);
    this.rebuildTrack();
    this.addAreaOutline();
    for (const child of this.poiGroup.children) {
      const p = child.userData.poi as Poi;
      child.position.copy(this.ground(p.x, p.y));
    }
  }

  /** Light the terrain with the Sun at this elevation / azimuth (degrees, azimuth clockwise from north). */
  /** Field notebook pins: a flag per note or sample, its label clickable to open it. */
  setNotes(notes: { id: string; label: string; x: number; y: number; sample: boolean; text: string }[]): void {
    for (const child of [...this.noteGroup.children]) {
      this.noteGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
    for (const n of notes) {
      const el = document.createElement("button");
      el.className = `note-pin${n.sample ? " sample" : ""}`;
      el.title = n.text || (n.sample ? "Sample" : "Note");
      el.dataset.noteId = n.id;
      el.setAttribute("aria-label", `${n.sample ? "Sample" : "Field note"} ${n.label}${n.text ? `: ${n.text.replace(/[.\s]+$/, "")}` : ""}. Open`);
      el.innerHTML = `<b>${esc(n.label)}</b>`;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.onNoteClick(n.id);
      });
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      const tag = new CSS2DObject(el);
      tag.position.copy(this.ground(n.x, n.y, 0.4));
      tag.center.set(0.5, 1);
      this.noteGroup.add(tag);
    }
    this.dirty = true;
  }

  /** Place the ghost of the real rover (local metres, heading in radians from east, counter-clockwise), or hide it. */
  setGhost(pose: { x: number; y: number; heading: number; label: string } | null): void {
    if (!pose) {
      if (this.ghost?.group.visible) {
        this.ghost.group.visible = false;
        this.dirty = true;
      }
      return;
    }
    if (!this.ghost) this.ghost = this.buildGhost();
    const g = this.ghost;
    g.group.visible = true;
    g.group.position.copy(this.ground(pose.x, pose.y));
    g.group.rotation.y = pose.heading;
    if (g.label.textContent !== pose.label) g.label.textContent = pose.label;
    this.dirty = true;
  }

  /** A rover the size of Perseverance / Curiosity (3 m long, 2.7 m wide, 2.2 m to the mast top), as a glowing ghost. */
  private buildGhost(): { group: THREE.Group; label: HTMLElement } {
    const mat = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.5, depthWrite: false, fog: false });
    const body = new THREE.Group();
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      body.add(m);
    };
    box(2.6, 0.55, 1.6, 0, 1.0, 0); // body
    box(0.18, 1.1, 0.18, 0.95, 1.8, 0.45); // mast
    box(0.5, 0.3, 0.35, 1.0, 2.35, 0.45); // mast head
    box(0.9, 0.12, 0.9, -0.95, 1.4, 0); // power source
    const wheel = new THREE.CylinderGeometry(0.26, 0.26, 0.4, 14).rotateX(Math.PI / 2);
    for (const x of [-1.1, 0, 1.1]) for (const z of [-1.15, 1.15]) {
      const w = new THREE.Mesh(wheel, mat);
      w.position.set(x, 0.26, z);
      body.add(w);
    }
    const group = new THREE.Group();
    group.add(body);
    group.renderOrder = 22;
    const el = document.createElement("div");
    el.className = "poi-label ghost";
    el.setAttribute("aria-hidden", "true"); // moves every frame; the toast and the menu describe it
    const label = document.createElement("span");
    el.appendChild(label);
    const tag = new CSS2DObject(el);
    tag.position.set(0, 3.2, 0);
    tag.center.set(0.5, 1);
    group.add(tag);
    this.scene.add(group);
    this.scaled.push({ obj: group, px: 10 });
    return { group, label };
  }

  /** Dust optical depth τ in the air (eva/dust.ts): dims and flattens the light, hazes the sky and the distance. */
  private dustTau = 0.5;
  private dustFog = 0;
  private sunEl = 30;
  setDust(tau: number): void {
    this.dustTau = tau;
    this.applyDust();
  }

  private fogGoal(): number {
    return this.look === "plan" ? this.fogTarget : Math.max(this.fogTarget, this.dustFog);
  }

  private applyDust(): void {
    const d = dustEffect(this.dustTau, this.sunEl);
    // eyes and cameras adapt: show about √ of the real drop in light (the panel gives the real numbers)
    const adapt = 1 / Math.sqrt(Math.max(0.02, d.sunlight));
    this.shared.uDust.value.set(d.direct * adapt, Math.min(1.2, d.diffuse * adapt));
    const ex = Math.max(0, this.dustTau - 0.5);
    this.sky.setDust(1 - Math.exp(-0.45 * ex), 0.3 + 0.7 * Math.exp(-0.16 * ex), Math.sqrt(d.direct));
    // exponential-squared fog that is ~63% thick at one extinction length (1 / k)
    this.dustFog = ex > 0 ? d.extinction * 0.8 : 0;
    this.fog.color.copy(this.fogBase).multiplyScalar(this.dayK * (0.35 + 0.65 * d.diffuse));
    this.dirty = true;
  }

  setSun(elevationDeg: number, azimuthDeg: number): void {
    this.sunEl = elevationDeg;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const dir = this.shared.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    // the models are lit like the ground: warmer and dimmer near the horizon, off below it
    const up = THREE.MathUtils.clamp((elevationDeg + 1) / 12, 0, 1);
    this.sunLight.position.copy(dir).multiplyScalar(1000);
    this.sunLight.intensity = 2.6 * up;
    this.sunLight.color.setHSL(0.08, 0.6, THREE.MathUtils.lerp(0.62, 0.9, up));
    this.skyLight.intensity = THREE.MathUtils.lerp(0.2, 0.8, up);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.12, 0.55, up);
    this.sky.setSunElevation(elevationDeg);
    // the haze dims with the sky at dusk (it stayed daylight-bright before, so far hills glowed at sunset)
    this.dayK = THREE.MathUtils.lerp(0.22, 1, THREE.MathUtils.clamp((elevationDeg + 2) / 14, 0, 1));
    this.applyDust();
    if (this.region && this.look !== "plan") (this.region.uniforms.uEdgeColor.value as THREE.Color).setHex(SKY_HORIZON, THREE.LinearSRGBColorSpace).multiplyScalar(this.dayK);
    this.dirty = true;
    // shadows move with the Sun: re-bake once it has moved by more than ~0.1 degrees
    if (dir.dot(this.bakedSun) < Math.cos(THREE.MathUtils.degToRad(0.1)) || Math.sign(dir.y) !== Math.sign(this.bakedSun.y)) {
      this.shadowDirty = true;
      this.sunChangedAt = performance.now();
    }
  }

  /**
   * Earth, Phobos and Deimos: world directions (X east, Y up, Z south), angular diameters (deg) and the
   * caption under each label in the visor view.
   */
  setSkyBodies(bodies: Record<"earth" | "phobos" | "deimos", { dir: [number, number, number]; sizeDeg: number; caption: string }>): void {
    const r = (b: { sizeDeg: number }) => THREE.MathUtils.degToRad(b.sizeDeg / 2);
    this.sky.setBodies({ dir: bodies.earth.dir, radius: r(bodies.earth) }, { dir: bodies.phobos.dir, radius: r(bodies.phobos) }, { dir: bodies.deimos.dir, radius: r(bodies.deimos) });
    for (const [id, b] of Object.entries(bodies)) {
      const t = this.skyTags.get(id)!;
      t.up = b.dir[1] > 0.005;
      t.obj.position.set(b.dir[0], b.dir[1], b.dir[2]).multiplyScalar(500);
      if (t.text.textContent !== b.caption) t.text.textContent = b.caption;
    }
    this.dirty = true;
  }

  setShadows(on: boolean): void {
    if (this.shared.uShadows.value === (on ? 1 : 0)) return;
    this.shared.uShadows.value = on ? 1 : 0;
    this.shadowDirty = true;
  }

  /** Swap in a sharper HiRISE image of the walk area (the 25 cm one, once it has downloaded). */
  setSurfaceImage(map: THREE.Texture, px: number): void {
    const u = this.terrain.uniforms;
    const old = u.uMap.value as THREE.Texture;
    u.uMap.value = map;
    (u.uMapSize.value as THREE.Vector2).set(px, px);
    if (old !== map) old.dispose();
    this.dirty = true;
  }

  /** Colour the walk area with a data layer (computed on the GPU from the data grids). */
  setLayer(id: LayerId, opacity: number): void {
    const u = this.terrain.uniforms;
    if (id === "shelter" && this.shelterTex) u.uShelter.value = this.shelterTex;
    // the way home floods outward from the rover when the layer opens: every point, worked out at start-up
    if (id === "shelter" && u.uLayer.value !== LAYER_IDS.shelter && !reducedMotion.matches) this.revealT = 0;
    else if (id !== "shelter") this.revealT = null;
    if (id === "radio" && this.radioTex) u.uRadio.value = this.radioTex;
    if (id === "hab" && this.habTex) u.uRadio.value = this.habTex;
    u.uLayer.value = LAYER_IDS[id];
    u.uLayerMix.value = opacity;
    this.dirty = true;
  }

  setLayerOpacity(opacity: number): void {
    this.terrain.uniforms.uLayerMix.value = opacity;
    this.dirty = true;
  }

  /** Radio shadow per node (depth below the rover's line of sight, see eva/radio). */
  private radioTex: THREE.DataTexture | null = null;
  setRadioShadow(depth: Uint8Array): void {
    this.radioTex?.dispose();
    this.radioTex = byteTexture(depth, this.site.grid.n);
    if (this.terrain.uniforms.uLayer.value === LAYER_IDS.radio) {
      this.terrain.uniforms.uRadio.value = this.radioTex;
      this.dirty = true;
    }
  }

  /** Hab site score per coarse node (eva/hab.ts), drawn by the "hab" layer. */
  private habTex: THREE.DataTexture | null = null;
  setHabMap(score: Uint8Array, n: number): void {
    this.habTex?.dispose();
    this.habTex = byteTexture(score, n);
    if (this.terrain.uniforms.uLayer.value === LAYER_IDS.hab) {
      this.terrain.uniforms.uRadio.value = this.habTex;
      this.dirty = true;
    }
  }

  /** Minutes of walking back to the shelter per node, from the return-cost field (255 = cut off). */
  setShelterTimes(timeS: Float32Array): void {
    const data = new Uint8Array(timeS.length);
    for (let i = 0; i < timeS.length; i++) {
      const t = timeS[i];
      data[i] = Number.isFinite(t) ? Math.min(254, Math.round((t / 60) * 4)) : 255;
    }
    this.shelterTex?.dispose();
    this.shelterTex = byteTexture(data, this.site.grid.n);
    // the rover moved while the layer is on screen: show the new field (it floods out again)
    const u = this.terrain.uniforms;
    if (u.uLayer.value === LAYER_IDS.shelter) {
      u.uShelter.value = this.shelterTex;
      if (!reducedMotion.matches) this.revealT = 0;
      this.dirty = true;
    }
  }

  /** Thin line around the HiRISE walk area, with a note on where the 25 cm data ends. */
  private outline: THREE.Group | null = null;
  private addAreaOutline(): void {
    if (this.outline) {
      this.scene.remove(this.outline);
      this.clearGroup(this.outline);
    }
    if (!this.region) return;
    const size = this.site.grid.size;
    const pts: THREE.Vector3[] = [];
    const corners: XY[] = [{ x: 0, y: size }, { x: size, y: size }, { x: size, y: 0 }, { x: 0, y: 0 }, { x: 0, y: size }];
    for (let k = 1; k < corners.length; k++) {
      const a = corners[k - 1];
      const b = corners[k];
      for (let s = 0; s < 256; s++) {
        const t = s / 256;
        const x = Math.min(size - 0.01, Math.max(0.01, a.x + (b.x - a.x) * t));
        const y = Math.min(size - 0.01, Math.max(0.01, a.y + (b.y - a.y) * t));
        pts.push(this.ground(x, y, 0.8));
      }
    }
    pts.push(pts[0].clone());
    const group = new THREE.Group();
    group.add(this.makeLine(pts, [1, 0.94, 0.86], 1.4, 0.5, 3));
    const el = document.createElement("div");
    el.className = "area-tag";
    const reg = this.site.region?.meta;
    const outside = reg ? `<i></i> <b>${/CTX/.test(reg.source) ? "CTX" : "HiRISE"}</b> ${reg.texture.mPerPx < 3 ? reg.texture.mPerPx.toFixed(1) : Math.round(reg.texture.mPerPx)} m/px outside` : "";
    el.innerHTML = `<b>HiRISE</b> ${Math.round(this.site.meta.texture.hi?.mPerPx ? this.site.meta.texture.hi.mPerPx * 100 : this.site.meta.texture.mPerPx * 100)} cm/px ${outside}`;
    const tag = new CSS2DObject(el);
    tag.position.copy(this.ground(1, size - 1, 1));
    tag.center.set(-0.03, -0.35); // just inside the north-west corner
    group.add(tag);
    this.outline = group;
    this.scene.add(group);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- lines
  private makeLine(points: THREE.Vector3[], colors: Rgb[] | Rgb, width: number, opacity: number, order: number, dashed = false): Line2 {
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      const c = Array.isArray(colors[0]) ? (colors as Rgb[])[i] : (colors as Rgb);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    });
    const geometry = new LineGeometry();
    geometry.setPositions(pos);
    geometry.setColors(col);
    const material = new LineMaterial({
      linewidth: width, vertexColors: true, transparent: true, opacity, dashed, dashSize: 6, gapSize: 5,
      depthTest: true, depthWrite: false, fog: false,
    });
    material.resolution.set(this.host.clientWidth || 1, this.host.clientHeight || 1);
    this.lineMaterials.add(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    line.renderOrder = order;
    line.frustumCulled = false;
    return line;
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      const line = child as Line2;
      if (line.geometry) line.geometry.dispose();
      if (line.material instanceof LineMaterial) {
        this.lineMaterials.delete(line.material);
        line.material.dispose();
      }
    }
  }

  /** Lines hover above the ground in the map views; in the visor they lie on it, like paint. */
  private pathPoints(path: MeasuredPath, lift: number): THREE.Vector3[] {
    const h = this.look === "walk" ? 0.25 + lift * 0.05 : lift;
    return path.samples.map((s) => this.toWorld(s.x, s.y, s.z, h));
  }

  setRoutes(set: RouteSet): void {
    this.routes = set;
    this.dirty = true;
    this.clearGroup(this.routeGroup);
    if (set.showStraight) {
      for (const path of set.straight) {
        if (path.samples.length < 2) continue;
        const colors = path.samples.map<Rgb>((s) => (s.blocked ? RED : s.sand > 0.5 ? AMBER : WHITE));
        this.routeGroup.add(this.makeLine(this.pathPoints(path, 1.4), colors, 3, 0.95, 5, false));
      }
    }
    for (const path of set.safe) {
      if (path.samples.length < 2) continue;
      const pts = this.pathPoints(path, 1.0);
      const c = set.dimSafe ? GREY : CYAN;
      this.routeGroup.add(this.makeLine(pts, c, set.dimSafe ? 5 : 8, set.dimSafe ? 0.25 : 0.2, 6));
      this.routeGroup.add(this.makeLine(pts, c, set.dimSafe ? 2 : 3, set.dimSafe ? 0.7 : 1, 7, set.dimSafe));
    }
    if (set.shelter && set.shelter.samples.length > 1) {
      const pts = this.pathPoints(set.shelter, 1.2);
      this.routeGroup.add(this.makeLine(pts, AMBER, 12, 0.3, 8));
      this.routeGroup.add(this.makeLine(pts, AMBER, 4.5, 1, 9));
    }
  }

  private trackVisible = false;
  setTrackVisible(visible: boolean): void {
    this.trackVisible = visible;
    this.rebuildTrack();
  }

  private rebuildTrack(): void {
    this.dirty = true;
    this.clearGroup(this.trackGroup);
    if (!this.trackVisible) return;
    let run: THREE.Vector3[] = [];
    const flush = () => {
      if (run.length > 1) this.trackGroup.add(this.makeLine(run, GREEN, 2, 0.85, 4, true));
      run = [];
    };
    let prev: [number, number, number] | null = null;
    for (const p of this.site.rover.traverse) {
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 260) flush(); // the rover left the AOI and came back
      if (prev && run.length) {
        const steps = Math.ceil(Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 6);
        for (let s = 1; s < steps; s++) run.push(this.ground(prev[0] + ((p[0] - prev[0]) * s) / steps, prev[1] + ((p[1] - prev[1]) * s) / steps, 0.8));
      }
      run.push(this.ground(p[0], p[1], 0.8));
      prev = p;
    }
    flush();
  }

  // ---------------------------------------------------------------- spot
  /** Highlight one point of the route (e.g. the farthest from the rover) with a ring and a label. */
  setSpot(at: XY | null, text = ""): void {
    this.dirty = true;
    for (const child of [...this.spotGroup.children]) {
      this.spotGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      const i = this.scaled.findIndex((s) => s.obj === child);
      if (i >= 0) this.scaled.splice(i, 1);
    }
    if (!at) return;
    const holder = new THREE.Group();
    holder.position.copy(this.ground(at.x, at.y, 0.3));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, fog: false }),
    );
    ring.renderOrder = 21;
    holder.add(ring);
    this.scaled.push({ obj: holder, px: 16 });
    const el = document.createElement("div");
    el.className = "poi-label spot";
    el.innerHTML = `<span>${esc(text)}</span>`;
    const label = new CSS2DObject(el);
    label.center.set(0.5, -0.6); // below the point: a stop's own label sits above it
    holder.add(label);
    this.spotGroup.add(holder);
  }

  // ---------------------------------------------------------------- relay
  /** Portable radio relays on the route: planned (outlined) or up (filled); none clears them. */
  setRelays(list: { at: XY; up: boolean }[]): void {
    this.setRelay(null);
    list.forEach((r, i) => this.setRelay(r.at, r.up, list.length > 1 ? i + 1 : null, false));
  }

  /** One relay marker (`clear`: remove the others first). */
  setRelay(at: XY | null, up = false, n: number | null = null, clear = true): void {
    this.dirty = true;
    for (const child of clear ? [...this.relayGroup.children] : []) {
      this.relayGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      const i = this.scaled.findIndex((s) => s.obj === child);
      if (i >= 0) this.scaled.splice(i, 1);
    }
    if (!at) return;
    const holder = new THREE.Group();
    holder.position.copy(this.ground(at.x, at.y));
    const metal = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.5 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.5, 8), metal);
    mast.position.y = 1.25;
    const dish = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.08), new THREE.MeshStandardMaterial({ color: up ? 0xb9a6ff : 0x8a86a0, roughness: 0.4 }));
    dish.position.y = 2.45;
    const legs = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.5, 3, 1, true), metal);
    legs.position.y = 0.25;
    holder.add(mast, dish, legs);
    this.scaled.push({ obj: holder, px: 9 });
    const el = document.createElement("div");
    el.className = `poi-label relay${up ? " up" : ""}`;
    el.innerHTML = `<b>${ic.radio}</b><span>${up ? "Relay up" : "Relay"}${n ? ` ${n}` : ""}</span>`;
    const label = new CSS2DObject(el);
    label.position.set(0, 3.4, 0);
    label.center.set(0.5, 1);
    holder.add(label);
    this.relayGroup.add(holder);
  }

  // ---------------------------------------------------------------- stops
  setPois(states: PoiMarkerState[]): void {
    this.dirty = true;
    for (const child of [...this.poiGroup.children]) {
      this.poiGroup.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
    this.beams.length = 0;
    for (let i = this.scaled.length - 1; i >= 0; i--) if (this.scaled[i].obj.userData.poiMarker) this.scaled.splice(i, 1);

    for (const st of states) {
      const p = st.poi;
      const isShelter = p.kind === "shelter";
      const holder = new THREE.Group();
      holder.userData.poi = p;
      holder.position.copy(this.ground(p.x, p.y));
      if (isShelter) {
        // the rover stands on all six wheels: tilt it to the slope under its 6 × 3 m footprint
        const h = (x: number, y: number) => this.site.grid.heightAt(x, y);
        const dzdx = (h(p.x + 2.5, p.y) - h(p.x - 2.5, p.y)) / 5;
        const dzdy = (h(p.x, p.y + 1.3) - h(p.x, p.y - 1.3)) / 2.6;
        const n = new THREE.Vector3(-dzdx, 1, dzdy).normalize(); // world: X east, Y up, Z south
        holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        holder.position.y -= 0.05;
      }

      const color = isShelter ? 0xffffff : st.active ? 0xc6f432 : 0x9aa3ab;
      const model = isShelter ? makeRover() : makeCairn(st.active, seedOf(p.id));
      model.userData.poiMarker = true;
      holder.add(model);
      // markers keep a readable size on screen: scale grows with camera distance (real size up close)
      this.scaled.push({ obj: holder, px: isShelter ? 7 : 11 });
      holder.userData.poiMarker = true;

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 90, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: isShelter ? 0xffc247 : color, transparent: true, opacity: st.active || isShelter ? 0.42 : 0.12, depthWrite: false, fog: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 45;
      beam.visible = false;
      holder.add(beam);
      this.beams.push(beam);

      const el = document.createElement("button");
      el.className = `poi-label ${p.kind}${st.active ? " active" : ""}`;
      el.innerHTML = `${st.order !== null ? `<b>${st.order}</b>` : isShelter ? `<b>${ic.home}</b>` : ""}<span>${p.short}</span>${st.noRadio ? `<i class="noradio" title="No radio contact with the rover here">${ic.noRadio}</i>` : ""}`;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.onPoiClick(p.id);
      });
      const label = new CSS2DObject(el);
      label.position.set(0, isShelter ? 4.4 : 3.2, 0);
      label.center.set(0.5, 1);
      holder.add(label);
      this.poiGroup.add(holder);
    }
  }

  // ---------------------------------------------------------------- picking
  /** Intersect a screen position with the terrain by marching along the view ray. */
  pick(clientX: number, clientY: number): XY | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    const grid = this.site.grid;
    const top = (this.site.meta.height.zMax - this.zRef) * this.exag + 5;
    let t = d.y < 0 && o.y > top ? (top - o.y) / d.y : 0; // jump to the top of the terrain volume
    let prevT = t;
    for (let i = 0; i < 900 && t < 40000; i++) {
      const x = o.x + d.x * t + this.half;
      const y = this.half - (o.z + d.z * t);
      const py = o.y + d.y * t;
      if (grid.inside(x, y)) {
        const gy = (grid.heightAt(x, y) - this.zRef) * this.exag;
        if (py <= gy) {
          let lo = prevT;
          let hi = t;
          for (let k = 0; k < 12; k++) {
            const mid = (lo + hi) / 2;
            const mx = o.x + d.x * mid + this.half;
            const my = this.half - (o.z + d.z * mid);
            if (o.y + d.y * mid <= (grid.heightAt(mx, my) - this.zRef) * this.exag) hi = mid;
            else lo = mid;
          }
          return { x: o.x + d.x * hi + this.half, y: this.half - (o.z + d.z * hi) };
        }
        prevT = t;
        t += Math.max(0.8, (py - gy) * 0.45);
      } else {
        if (py < -50) return null;
        prevT = t;
        t += 12;
      }
    }
    return null;
  }

  setHoverMarker(p: XY | null): void {
    const visible = !!p && this.mode !== "walk";
    if (visible !== this.hoverRing.visible || visible) this.dirty = true;
    this.hoverRing.visible = visible;
    if (p) this.hoverRing.position.copy(this.ground(p.x, p.y, 0.6));
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    let pending = false;
    let clickTimer = 0;
    el.addEventListener("pointerdown", (ev) => {
      down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
      if (this.mode === "walk") {
        this.drag = { x: ev.clientX, y: ev.clientY };
        el.setPointerCapture(ev.pointerId);
      }
    });
    el.addEventListener("pointermove", (ev) => {
      if (this.mode === "roam") return; // free roam reads the pointer itself
      if (this.mode === "walk") {
        if (this.drag) {
          this.walk.yaw -= (ev.clientX - this.drag.x) * 0.004;
          this.walk.pitch = Math.max(-0.9, Math.min(0.6, this.walk.pitch + (ev.clientY - this.drag.y) * 0.003));
          this.drag = { x: ev.clientX, y: ev.clientY };
        }
        return;
      }
      if (pending || ev.buttons !== 0) return;
      pending = true;
      const { clientX, clientY } = ev;
      requestAnimationFrame(() => {
        pending = false;
        this.onHover(this.tween || this.fly ? null : this.pick(clientX, clientY), clientX, clientY);
      });
    });
    el.addEventListener("pointerleave", () => this.onHover(null, 0, 0));
    el.addEventListener("dblclick", (ev) => {
      window.clearTimeout(clickTimer);
      if (this.mode === "roam") return;
      const p = this.pick(ev.clientX, ev.clientY);
      if (p) return this.focusOn(p);
      // outside the walk area: find the spot on the surrounding terrain
      const rect = el.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
      const hit = this.marchRay(ray.ray.origin, ray.ray.direction, this.camera.far);
      if (hit) this.glideTo(hit);
    });
    el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    window.addEventListener("keydown", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const map: Record<string, Parameters<SceneView["nudge"]>[0]> = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "+": "in", "=": "in", "-": "out", n: "north", N: "north",
      };
      const action = map[ev.key];
      if (action && this.mode !== "walk" && this.mode !== "roam") {
        ev.preventDefault();
        this.nudge(action);
      }
    });
    el.addEventListener("pointerup", (ev) => {
      this.drag = null;
      if (!down || this.mode === "walk" || this.mode === "fly" || this.mode === "roam") return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      if (moved < 5 && performance.now() - down.t < 450) {
        // wait a moment so a double-click (centre the view) is not also treated as a click
        const { clientX, clientY } = ev;
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => {
          const p = this.pick(clientX, clientY);
          if (p) this.onGroundClick(p, clientX, clientY);
        }, 240);
      }
      down = null;
    });
  }
}
