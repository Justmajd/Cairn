import * as THREE from "three";
import type { Poi } from "../types";
import { $, esc } from "./dom";
import { ic } from "./icons";

export interface PanoramaInfo {
  file: string;
  azMin: number;
  azMax: number;
  elMin: number;
  elMax: number;
  frames: number;
  coverage: number;
  horizonCoverage?: number;
  sols: number[];
  camera: string;
  rmc: string;
}

export interface PanoramaSet {
  source: string;
  pxPerDeg: number;
  panoramas: Record<string, PanoramaInfo>;
}

/** One WebGL renderer reused by every panorama (creating and dropping contexts gets a page blocked). */
let shared: THREE.WebGLRenderer | null = null;

const NAMES: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
const PX_PER_DEG = 4;

/**
 * Full-screen 360° viewer for a stitched rover panorama.  Drag to look around, scroll to zoom.
 * `targets` are other stops drawn as bearings on the compass strip.
 */
export function openPanorama(
  base: string,
  poi: Poi,
  info: PanoramaInfo,
  rover: string,
  targets: { name: string; bearing: number; distM: number }[],
  opts: { autoRotate?: boolean; onClose?: () => void } = {},
): () => void {
  const host = $("#pano");
  const sols = info.sols.length > 1 ? `sols ${info.sols[0]}–${info.sols[info.sols.length - 1]}` : `sol ${info.sols[0]}`;
  const marks: string[] = [];
  for (let deg = -180; deg <= 540; deg += 15) {
    const norm = ((deg % 360) + 360) % 360;
    marks.push(`<span class="${NAMES[norm] ? "card" : ""}" style="left:${(deg + 180) * PX_PER_DEG}px">${NAMES[norm] ?? norm}</span>`);
  }
  for (const t of targets) {
    for (const off of [-360, 0, 360]) {
      marks.push(`<em style="left:${(t.bearing + off + 180) * PX_PER_DEG}px" title="${esc(t.name)}">${esc(t.name)} · ${Math.round(t.distM)} m</em>`);
    }
  }
  host.innerHTML = `
    <div class="pano-stage"></div>
    <div class="pano-top">
      <div class="tape"><div class="strip">${marks.join("")}</div><i></i></div>
      <b class="pano-head">000°</b>
    </div>
    <header class="pano-bar">
      <div><span class="kicker">360° · ${esc(rover)} Navcam</span><h3>${esc(poi.name)}</h3></div>
      <button class="close icon" aria-label="Close panorama">${ic.close}</button>
    </header>
    <footer class="pano-foot">
      <span>${ic.info}Stitched by CAIRN from ${info.frames} ${esc(rover)} ${esc(info.camera)} frames, ${sols}, using each frame's camera model.
      ${Math.round(info.coverage * 100)}% of the view was imaged; the high sky and the ground under the rover are filled.</span>
      <span class="hint-k"><b>Drag</b> look around · <b>Scroll</b> zoom · <b>Esc</b> close</span>
    </footer>`;
  host.hidden = false;

  const stage = $(".pano-stage", host);
  const renderer = (shared ??= new THREE.WebGLRenderer({ antialias: true }));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0d0c);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  const theta0 = THREE.MathUtils.degToRad(90 - info.elMax);
  const thetaLen = THREE.MathUtils.degToRad(info.elMax - info.elMin);
  // phiStart = -90°: texture column u (azimuth from north, clockwise) lands at bearing u x 360°
  const geometry = new THREE.SphereGeometry(10, 192, 64, -Math.PI / 2, Math.PI * 2, theta0, thetaLen);
  const texture = new THREE.TextureLoader().load(base + info.file);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const sphere = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
  sphere.scale.x = -1;
  scene.add(sphere);

  let yaw = targets.length ? targets[0].bearing : 0; // degrees, 0 = north
  let pitch = -8;
  let fov = 70;
  let drag: { x: number; y: number } | null = null;
  let idle = 0;
  let raf = 0;
  let last = performance.now();
  const tape = $(".strip", host);
  const head = $(".pano-head", host);

  const resize = () => {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    idle += dt;
    if (opts.autoRotate || idle > 6) yaw += dt * 6;
    pitch = Math.max(info.elMin + fov / 3, Math.min(info.elMax - 4, pitch));
    camera.fov = fov;
    camera.updateProjectionMatrix();
    const y = THREE.MathUtils.degToRad(yaw);
    const p = THREE.MathUtils.degToRad(pitch);
    camera.lookAt(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
    renderer.render(scene, camera);
    const hdg = ((yaw % 360) + 360) % 360;
    const half = tape.parentElement!.clientWidth / 2;
    tape.style.transform = `translateX(${(half - (hdg + 180) * PX_PER_DEG).toFixed(1)}px)`;
    head.textContent = `${String(Math.round(hdg) % 360).padStart(3, "0")}°`;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const el = renderer.domElement;
  const ac = new AbortController(); // the renderer is shared: drop this panorama's listeners on close
  const sig = { signal: ac.signal };
  el.addEventListener("pointerdown", (ev) => {
    drag = { x: ev.clientX, y: ev.clientY };
    el.setPointerCapture(ev.pointerId);
    opts.autoRotate = false;
    idle = 0;
  }, sig);
  el.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const k = fov / (stage.clientHeight || 600);
    yaw -= (ev.clientX - drag.x) * k;
    pitch += (ev.clientY - drag.y) * k;
    drag = { x: ev.clientX, y: ev.clientY };
    idle = 0;
  }, sig);
  el.addEventListener("pointerup", () => (drag = null), sig);
  el.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      fov = Math.max(25, Math.min(95, fov * (ev.deltaY > 0 ? 1.08 : 1 / 1.08)));
      idle = 0;
    },
    { passive: false, signal: ac.signal },
  );

  const close = () => {
    cancelAnimationFrame(raf);
    ac.abort();
    ro.disconnect();
    window.removeEventListener("keydown", onKey);
    renderer.domElement.remove(); // the renderer is kept for the next panorama
    geometry.dispose();
    (sphere.material as THREE.Material).dispose();
    texture.dispose();
    host.hidden = true;
    host.innerHTML = "";
    opts.onClose?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);
  $(".close", host).addEventListener("click", close);
  return close;
}
