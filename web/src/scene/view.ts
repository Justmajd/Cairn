import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { SiteData } from "../data/loaders";
import type { MeasuredPath, PathSample, Poi, RegionMeta, XY } from "../types";
import { ic } from "../ui/icons";
import { buildRegion, buildSky, buildTerrain, byteTexture, geologyLut, LAYER_IDS, LayerId, SKY_HORIZON, Terrain } from "./terrain";

export interface SceneTextures {
  map: THREE.Texture; // HiRISE image of the walk area
  relief: THREE.Texture; // 1 m elevation gradient
  region: { meta: RegionMeta; heights: Float32Array; map: THREE.Texture } | null;
}

export type ViewMode = "plan" | "orbit" | "fly" | "walk";

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
}

type Rgb = [number, number, number];
const CYAN: Rgb = [0.27, 0.88, 0.81];
const AMBER: Rgb = [0.96, 0.71, 0.27];
const RED: Rgb = [1.0, 0.22, 0.2];
const WHITE: Rgb = [0.96, 0.96, 0.96];
const GREY: Rgb = [0.55, 0.6, 0.62];
const GREEN: Rgb = [0.45, 1.0, 0.55];

const EYE_HEIGHT_M = 1.7;
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
  private readonly regionHalf: number;
  private readonly fog: THREE.FogExp2;
  private readonly half: number;
  private readonly zRef: number;
  private exag = 1;

  private readonly routeGroup = new THREE.Group();
  private readonly trackGroup = new THREE.Group();
  private readonly poiGroup = new THREE.Group();
  private readonly lineMaterials = new Set<LineMaterial>();
  private shelterTex: THREE.DataTexture | null = null;
  /** Objects kept at a readable size: `px` screen pixels per model unit, never smaller than real size. */
  private readonly scaled: { obj: THREE.Object3D; px: number }[] = [];
  private readonly beams: THREE.Mesh[] = [];
  private readonly astronaut: THREE.Group;
  private readonly buddy: THREE.Group;
  private readonly hoverRing: THREE.Mesh;

  private routes: RouteSet | null = null;
  private mode: ViewMode = "plan";
  private tween: Tween | null = null;
  private fly: { curve: THREE.CatmullRomCurve3; look: THREE.CatmullRomCurve3; t: number; duration: number; done: () => void } | null = null;
  private walk = { x: 0, y: 0, heading: 0, smoothHeading: 0, yaw: 0, pitch: -0.06, init: false, bob: 0 };
  private drag: { x: number; y: number } | null = null;
  private last = performance.now();
  private frame: ((dt: number) => void) | null = null;
  private fogTarget = 0;
  /** Screen space covered by the floating panels; the camera centres the view in what is left. */
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };

  onPoiClick: (id: string) => void = () => {};
  onGroundClick: (p: XY, clientX: number, clientY: number) => void = () => {};
  onHover: (p: XY | null, clientX: number, clientY: number) => void = () => {};

  constructor(private readonly host: HTMLElement, private readonly site: SiteData, tex: SceneTextures, quality: "high" | "low") {
    const grid = site.grid;
    this.half = grid.size / 2;
    this.zRef = site.meta.height.zMin;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === "low" ? 1 : 2));
    this.renderer.setClearColor(0x0b0d10, 1);
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "label-layer";
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.3, 60000);
    this.fog = new THREE.FogExp2(SKY_HORIZON, 0);
    this.scene.fog = this.fog;

    this.sky = buildSky();
    this.sky.mesh.scale.setScalar(40000);
    this.scene.add(this.sky.mesh);

    const n = grid.n;
    const layers = {
      slope: byteTexture(grid.slope, n),
      sand: byteTexture(grid.sand, n),
      effort: byteTexture(grid.effort, n),
      risk: byteTexture(grid.risk, n),
      thermal: byteTexture(site.thermalGrid, n),
      geology: byteTexture(site.geologyGrid, n, THREE.NearestFilter),
      geoLut: geologyLut(site.geology.units),
    };
    const reliefRange = site.meta.relief?.range ?? 1.5;
    this.terrain = buildTerrain(grid, this.zRef, tex.map, tex.relief, reliefRange, layers, quality === "low" ? 2 : 1);
    this.scene.add(this.terrain.mesh);
    this.region = tex.region ? buildRegion(tex.region.meta, tex.region.heights, this.zRef, tex.region.map, grid.size, quality === "low" ? 2 : 1) : null;
    if (this.region) this.scene.add(this.region.mesh);
    this.regionHalf = tex.region ? tex.region.meta.sizeM / 2 : this.half;
    this.addAreaOutline();

    this.scene.add(new THREE.HemisphereLight(0xffe2c4, 0x5a3a28, 1.6));
    const sun = new THREE.DirectionalLight(0xfff0dd, 2.2);
    sun.position.set(-720, 620, -120);
    this.scene.add(sun);

    this.scene.add(this.trackGroup, this.routeGroup, this.poiGroup);

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
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private update(dt: number): void {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = ease(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      this.camera.fov = tw.fromFov + (tw.toFov - tw.fromFov) * k;
      this.camera.updateProjectionMatrix();
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
    } else {
      this.controls.update();
    }

    this.fog.density += (this.fogTarget - this.fog.density) * Math.min(1, dt * 3);
    this.sky.mesh.position.copy(this.camera.position);

    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.host.clientHeight);
    for (const s of this.scaled) {
      if (!s.obj.visible) continue;
      const metresPerPixel = this.camera.position.distanceTo(s.obj.position) * perPixel;
      s.obj.scale.setScalar(Math.max(1, metresPerPixel * s.px));
    }
    const walking = this.mode === "walk";
    for (const beam of this.beams) beam.visible = walking;
    // standing at a stop in the visor: hide its marker so the camera is not inside it
    for (const holder of this.poiGroup.children) {
      holder.visible = !(walking && holder.position.distanceTo(this.camera.position) < 9);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
  }

  // ---------------------------------------------------------------- camera modes
  getMode(): ViewMode {
    return this.mode;
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = insets;
    this.applyViewOffset();
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
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
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
    this.sky.setMapMode(map ? 1 : 0);
    this.controls.maxDistance = map ? 52000 : 14000;
    if (this.region) {
      const edge = this.region.uniforms.uEdgeColor.value as THREE.Color;
      edge.setHex(map ? 0x0f0d0c : SKY_HORIZON, THREE.LinearSRGBColorSpace);
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
    if (this.tween || this.fly || this.mode === "walk" || this.mode === "fly") return;
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

  /** Centre the view on a ground point (double-click). */
  focusOn(p: XY): void {
    if (this.tween || this.fly || this.mode === "walk" || this.mode === "fly") return;
    const target = this.ground(p.x, p.y);
    const delta = target.clone().sub(this.controls.target);
    if (this.mode === "plan") delta.y = 0;
    const orbit = this.mode === "orbit";
    this.startTween(this.camera.position.clone().add(delta), this.controls.target.clone().add(delta), this.camera.fov, 0.5, () => {
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
    this.camera.near = 0.2;
    this.camera.updateProjectionMatrix();
    this.walk = { x, y, heading: headingRad, smoothHeading: headingRad, yaw: 0, pitch: -0.06, init: true, bob: 0 };
    this.astronaut.visible = false;
    if (this.routes) this.setRoutes(this.routes);
  }

  private leaveWalk(): void {
    this.mode = "orbit";
    if (this.routes) this.setRoutes(this.routes);
    this.camera.near = 0.3;
    this.camera.updateProjectionMatrix();
    const at = this.ground(this.walk.x, this.walk.y);
    this.controls.target.copy(at);
    this.camera.position.set(at.x - 60, at.y + 160, at.z + 220);
    this.astronaut.visible = this.walk.init;
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
  private makeAstronaut(color: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 12), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    body.position.y = 0.95;
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffb347, metalness: 0.7, roughness: 0.25 }));
    visor.position.set(0, 1.5, -0.2);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, fog: false }),
    );
    ring.position.y = 0.05;
    ring.renderOrder = 30;
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false, fog: false }),
    );
    halo.position.y = 0.04;
    halo.renderOrder = 29;
    g.add(body, visor, ring, halo);
    return g;
  }

  /** Place the astronaut (and the camera, in walk mode).  `null` hides the marker. */
  setAstronaut(pose: { x: number; y: number; headingRad: number; moving: boolean } | null, dt = 0): void {
    if (!pose) {
      this.astronaut.visible = false;
      this.walk.init = false;
      return;
    }
    this.astronaut.position.copy(this.ground(pose.x, pose.y));
    this.astronaut.rotation.y = -pose.headingRad;
    this.astronaut.visible = this.mode !== "walk";
    this.walk.x = pose.x;
    this.walk.y = pose.y;
    this.walk.heading = pose.headingRad;
    this.walk.init = true;
    if (pose.moving) this.walk.bob += dt * 7;
  }

  setBuddy(pose: XY | null): void {
    this.buddy.visible = !!pose && this.mode !== "walk";
    if (pose) this.buddy.position.copy(this.ground(pose.x, pose.y));
  }

  /** Keep the astronaut in view while following an EVA in the map views. */
  follow(x: number, y: number, dt: number): void {
    if (this.mode === "walk" || this.tween || this.fly) return;
    const to = this.ground(x, y);
    const delta = to.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 1.5));
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  // ---------------------------------------------------------------- layers
  setExaggeration(value: number): void {
    this.exag = value;
    this.terrain.uniforms.uExag.value = value;
    if (this.region) this.region.uniforms.uExag.value = value;
    if (this.routes) this.setRoutes(this.routes);
    this.rebuildTrack();
    this.addAreaOutline();
    for (const child of this.poiGroup.children) {
      const p = child.userData.poi as Poi;
      child.position.copy(this.ground(p.x, p.y));
    }
  }

  /** Colour the walk area with a data layer (computed on the GPU from the data grids). */
  setLayer(id: LayerId, opacity: number): void {
    const u = this.terrain.uniforms;
    if (id === "shelter" && this.shelterTex) u.uShelter.value = this.shelterTex;
    u.uLayer.value = LAYER_IDS[id];
    u.uLayerMix.value = opacity;
  }

  setLayerOpacity(opacity: number): void {
    this.terrain.uniforms.uLayerMix.value = opacity;
  }

  /** Minutes of walking back to the shelter per node, from the return-cost field (255 = cut off). */
  setShelterTimes(timeS: Float32Array): void {
    const data = new Uint8Array(timeS.length);
    for (let i = 0; i < timeS.length; i++) {
      const t = timeS[i];
      data[i] = Number.isFinite(t) ? Math.min(254, Math.round((t / 60) * 4)) : 255;
    }
    this.shelterTex = byteTexture(data, this.site.grid.n);
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
    el.innerHTML = "<b>HiRISE</b> 25 cm/px <i></i> <b>CTX</b> 6 m/px outside";
    const tag = new CSS2DObject(el);
    tag.position.copy(this.ground(1, size - 1, 1));
    tag.center.set(-0.03, -0.35); // just inside the north-west corner
    group.add(tag);
    this.outline = group;
    this.scene.add(group);
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
    const h = this.mode === "walk" ? 0.25 + lift * 0.05 : lift;
    return path.samples.map((s) => this.toWorld(s.x, s.y, s.z, h));
  }

  setRoutes(set: RouteSet): void {
    this.routes = set;
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

  // ---------------------------------------------------------------- stops
  private makeCairn(color: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true });
    const stones: [number, number, number, number][] = [[1.0, 0.42, 0.0, 0.2], [0.72, 0.36, 0.72, -0.3], [0.46, 0.3, 1.34, 0.5]];
    for (const [r, squash, y, rot] of stones) {
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
      stone.scale.set(1, squash, 0.86);
      stone.position.y = y + r * squash;
      stone.rotation.y = rot;
      g.add(stone);
    }
    return g;
  }

  private makeRover(): THREE.Group {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x3fb6d8, roughness: 0.2, metalness: 0.5 });
    const cabin = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 2.6, 6, 14).rotateZ(Math.PI / 2), white);
    cabin.position.y = 2.0;
    const window = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10), glass);
    window.position.set(2.0, 2.15, 0);
    window.scale.set(0.7, 0.8, 1);
    g.add(cabin, window);
    for (const x of [-1.6, 0, 1.6]) {
      for (const z of [-1.35, 1.35]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 14).rotateX(Math.PI / 2), dark);
        wheel.position.set(x, 0.62, z);
        g.add(wheel);
      }
    }
    return g;
  }

  setPois(states: PoiMarkerState[]): void {
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

      const color = isShelter ? 0xffffff : st.active ? 0x3fe8ff : 0x9aa3ab;
      const model = isShelter ? this.makeRover() : this.makeCairn(st.active ? 0xf4d9b0 : 0x9a8d80);
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
      el.innerHTML = `${st.order !== null ? `<b>${st.order}</b>` : isShelter ? `<b>${ic.home}</b>` : ""}<span>${p.short}</span>`;
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
    this.hoverRing.visible = !!p && this.mode !== "walk";
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
      const p = this.pick(ev.clientX, ev.clientY);
      if (p) this.focusOn(p);
    });
    el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    window.addEventListener("keydown", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const map: Record<string, Parameters<SceneView["nudge"]>[0]> = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "+": "in", "=": "in", "-": "out", n: "north", N: "north",
      };
      const action = map[ev.key];
      if (action && this.mode !== "walk") {
        ev.preventDefault();
        this.nudge(action);
      }
    });
    el.addEventListener("pointerup", (ev) => {
      this.drag = null;
      if (!down || this.mode === "walk" || this.mode === "fly") return;
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
