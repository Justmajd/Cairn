import * as THREE from "three";
import type { TerrainGrid } from "../data/grid";
import { COMMON, LIGHT, NEUTRAL_MATERIAL, type ShadowUniforms } from "./terrain";

/**
 * Rocks smaller than the HiRISE resolution (5–70 cm), scattered around the camera so the ground has
 * relief and silhouettes at eye level.  Rendering detail, not data: boulders larger than ~1 m are already
 * in the HiRISE elevation model and image.  Density follows the terrain grids — more on rough ground,
 * none on loose sand, few on steep slopes — and the same place always gets the same rocks.
 *
 * Three rock shapes, each one instanced draw call; the instances are rebuilt only when the camera has
 * moved ~12 m.  Lit like the ground: the HiRISE image under the rock for colour, the baked shadow
 * texture, the same regolith light, filmic response and haze.
 */
const RADIUS_M = 60;
const CELL_M = 0.7;
const MAX_PER_SHAPE = 6000;
const SHOW_BELOW_M = 140; // camera height above the ground under which rocks are drawn

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vN;
  varying vec3 vW;
  varying float vTone;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(m) * normal);
    vTone = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 0.22 - 0.13;
    vec4 mvPosition = viewMatrix * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  ${COMMON}
  ${LIGHT}
  uniform sampler2D uMap;
  uniform sampler2D uShadowAoi;
  uniform float uShadowAoiN;
  uniform float uHalf;
  uniform sampler2D uMatRock; // photo-scanned rock (CC0): R = brightness ratio x0.5, GB = normal xy
  uniform float uMatRockSize;
  varying vec3 vN;
  varying vec3 vW;
  varying float vTone;
  // triplanar: rocks have no texture coordinates, so project the material along the three world axes
  float rockMat(vec3 p, vec3 n, out vec3 bump) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= w.x + w.y + w.z;
    float s = 1.0 / uMatRockSize;
    vec3 x = texture2D(uMatRock, p.zy * s).rgb;
    vec3 y = texture2D(uMatRock, p.xz * s).rgb;
    vec3 z = texture2D(uMatRock, p.xy * s).rgb;
    float d = x.r * w.x + y.r * w.y + z.r * w.z;
    vec2 nx = x.gb * 2.0 - 1.0, ny = y.gb * 2.0 - 1.0, nz = z.gb * 2.0 - 1.0;
    bump = vec3(0.0, nx.y, nx.x) * w.x + vec3(ny.x, 0.0, ny.y) * w.y + vec3(nz.x, nz.y, 0.0) * w.z;
    return d * 2.0;
  }
  void main() {
    vec2 uv = vec2((vW.x + uHalf) / (2.0 * uHalf), (uHalf - vW.z) / (2.0 * uHalf));
    float g = texture2D(uMap, uv).r;
    vec3 c = marsTint(clamp(g * 0.82 + vTone, 0.0, 1.0));
    c = mix(c, vec3(dot(c, vec3(0.3333))), 0.3);          // rock is greyer than the dust around it
    vec3 n = normalize(vN);
    vec3 bump;
    c *= rockMat(vW * 3.0, n, bump);      // x3: rocks are small, show the scan's grain at its own scale
    n = normalize(n + bump * 0.9);
    float vis = texture2D(uShadowAoi, nodeUv(uv, uShadowAoiN)).r;
    float base = smoothstep(-0.6, 0.4, n.y);              // underside darker: it faces the ground
    c *= marsLight(n, normalize(cameraPosition - vW), vis, mix(0.35, 1.0, base));
    c = filmic(c);
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
    #ifdef USE_FOG
      float sg = pow(max(dot(normalize(vW - cameraPosition), uSunDir), 0.0), 14.0) * smoothstep(-0.06, 0.02, uSunDir.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.6, 0.72, 0.9), fogFactor * sg * 0.45);
    #endif
    gl_FragColor.rgb = outColor(gl_FragColor.rgb);
  }
`;

// soft contact shadow under each rock, stretched away from the Sun (a flat decal; rock-sized shadows are
// below the resolution of the baked terrain shadows)
const SHADOW_VERT = /* glsl */ `
  #include <common>
  varying vec2 vQ;
  void main() {
    vQ = position.xy * 2.0;  // -1..1 across the decal
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position.x, 0.0, position.y, 1.0);
  }
`;
const SHADOW_FRAG = /* glsl */ `
  uniform float uStrength;
  varying vec2 vQ;
  void main() {
    float d = length(vQ);
    float a = (1.0 - smoothstep(0.35, 1.0, d)) * uStrength;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`;

/** A lumpy, slightly flattened rock: an icosphere pushed in and out by a few random dents. */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rnd = mulberry(seed);
  const dents = Array.from({ length: 7 }, () => ({ d: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), k: 0.18 + rnd() * 0.3 }));
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    for (const { d, k } of dents) r -= k * Math.max(0, v.dot(d) - 0.55) * 2.2; // flat facets, like fractured rock
    r *= 0.92 + rnd() * 0.08;
    pos.setXYZ(i, v.x * r, v.y * r * 0.62, v.z * r);
  }
  geo.computeVertexNormals();
  return geo;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 0..1 values for a cell. */
function cellRand(i: number, j: number, k: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Rocks {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly at = new THREE.Vector2(Infinity, Infinity);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly shadows: THREE.InstancedMesh;
  private readonly strength = { value: 0.0 };
  private readonly sunDir: THREE.Vector3;
  private readonly sunAt = new THREE.Vector3();
  private readonly matRock = { value: NEUTRAL_MATERIAL as THREE.Texture };
  private readonly matRockSize = { value: 1.8 };

  constructor(
    private readonly grid: TerrainGrid,
    private readonly half: number,
    private readonly worldY: (x: number, y: number) => number, // local metres -> world height
    map: THREE.IUniform<THREE.Texture>,
    shared: ShadowUniforms,
  ) {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, { uMap: map, uShadowAoi: shared.uShadowAoi, uShadowAoiN: shared.uShadowAoiN, uSunDir: shared.uSunDir, uHalf: { value: half }, uMatRock: this.matRock, uMatRockSize: this.matRockSize, uLinearOut: shared.uLinearOut });
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
    this.meshes = [11, 23, 37].map((seed) => {
      const mesh = new THREE.InstancedMesh(rockGeometry(seed), material, MAX_PER_SHAPE);
      mesh.count = 0;
      mesh.frustumCulled = false; // the instances move with the camera
      this.group.add(mesh);
      return mesh;
    });
    this.sunDir = shared.uSunDir.value;
    const decal = new THREE.PlaneGeometry(1, 1);
    this.shadows = new THREE.InstancedMesh(decal, new THREE.ShaderMaterial({
      uniforms: { uStrength: this.strength }, vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }), MAX_PER_SHAPE * 3);
    this.shadows.count = 0;
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
    this.group.add(this.shadows);
    this.group.visible = false;
  }

  setMaterial(texture: THREE.Texture, sizeM: number): void {
    this.matRock.value = texture;
    this.matRockSize.value = sizeM;
  }

  /** Scatter rocks around the camera (world position) when it is low enough to see them. */
  update(camera: THREE.Camera, heightAboveGround: number, enabled: boolean): void {
    const show = enabled && heightAboveGround < SHOW_BELOW_M;
    this.group.visible = show;
    if (!show) return;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const sunMoved = this.sunDir.angleTo(this.sunAt) > 0.03;
    if (Math.hypot(cx - this.at.x, cz - this.at.y) < 12 && !sunMoved) return;
    this.at.set(cx, cz);
    this.sunAt.copy(this.sunDir);
    // shadow length per metre of rock height, along the ground away from the Sun
    const el = Math.max(0.05, Math.asin(THREE.MathUtils.clamp(this.sunDir.y, -1, 1)));
    const run = Math.min(6, 1 / Math.tan(el));
    const sx = -this.sunDir.x, sz = -this.sunDir.z;
    const sl = Math.hypot(sx, sz) || 1;
    const yaw = Math.atan2(sx / sl, sz / sl);
    this.strength.value = this.sunDir.y > 0 ? 0.5 * THREE.MathUtils.smoothstep(this.sunDir.y, 0.0, 0.15) : 0;
    let nShadow = 0;

    const g = this.grid;
    const counts = [0, 0, 0];
    const i0 = Math.floor((cx - RADIUS_M) / CELL_M);
    const i1 = Math.floor((cx + RADIUS_M) / CELL_M);
    const j0 = Math.floor((cz - RADIUS_M) / CELL_M);
    const j1 = Math.floor((cz + RADIUS_M) / CELL_M);
    const r2 = RADIUS_M * RADIUS_M;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = (i + cellRand(i, j, 1)) * CELL_M;
        const wz = (j + cellRand(i, j, 2)) * CELL_M;
        if ((wx - cx) ** 2 + (wz - cz) ** 2 > r2) continue;
        const x = wx + this.half; // local metres, x east
        const y = this.half - wz; //              y north
        if (x < 1 || y < 1 || x > g.size - 1 || y > g.size - 1) continue;
        const node = g.nodeAt(x, y);
        const sand = g.sand[node] / 255;
        const rough = Math.min(1, Math.max(0, (g.effort[node] / g.effortScale - 1 - 1.1 * sand) / 0.4));
        let density = (0.6 + 0.4 * rough) * (1 - sand) ** 3;
        if (g.slope[node] > 30) density *= 0.35;
        if (cellRand(i, j, 3) > density) continue;
        // power-law sizes: most a few cm, rarely tens of cm
        const size = Math.min(0.7, 0.06 * Math.pow(1 / (cellRand(i, j, 4) + 0.04), 0.6));
        if (size < Math.hypot(wx - cx, wz - cz) * 0.0035) continue;   // under ~2 px on screen: skip
        const shape = Math.floor(cellRand(i, j, 5) * 3);
        if (counts[shape] >= MAX_PER_SHAPE) continue;
        this.e.set((cellRand(i, j, 6) - 0.5) * 0.5, cellRand(i, j, 7) * Math.PI * 2, (cellRand(i, j, 8) - 0.5) * 0.5);
        this.q.setFromEuler(this.e);
        const a = 0.75 + cellRand(i, j, 9) * 0.6;
        this.s.set(size * a, size * (0.75 + cellRand(i, j, 10) * 0.5), size / a);
        this.p.set(wx, this.worldY(x, y) - size * 0.22, wz); // set into the ground
        this.m.compose(this.p, this.q, this.s);
        this.meshes[shape].setMatrixAt(counts[shape]++, this.m);
        // contact shadow: as wide as the rock, stretched away from the Sun by its height
        const h = this.s.y * 0.8;
        const len = this.s.x * 1.1 + h * run;
        this.p.set(wx + (sx / sl) * h * run * 0.5, this.worldY(x, y) + 0.01, wz + (sz / sl) * h * run * 0.5);
        this.e.set(0, yaw, 0);
        this.q.setFromEuler(this.e);
        this.s.set(this.s.x * 1.25, 1, len);
        this.m.compose(this.p, this.q, this.s);
        this.shadows.setMatrixAt(nShadow++, this.m);
      }
    }
    this.shadows.count = nShadow;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.meshes.forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
}
