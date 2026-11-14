import * as THREE from "three";
import type { TerrainGrid } from "../data/grid";
import type { GeologyUnit, RegionMeta } from "../types";

/** Sun direction used for relief shading — from the west, like the afternoon light in the HiRISE image. */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.62, -0.12).normalize();
export const SKY_HORIZON = 0xd9a878;
/** Background of the top-down map (matches the interface). */
export const MAP_BG = 0x0f0d0c;

/** Map layers coloured on the GPU from the data grids. */
export const LAYER_IDS = { none: 0, risk: 1, slope: 2, sand: 3, thermal: 4, geology: 5, shelter: 6, shield: 7, minerals: 8 } as const;
export type LayerId = keyof typeof LAYER_IDS;

const COMMON = /* glsl */ `
  // HiRISE / CTX are single grey bands: tint with a Mars ramp (display colour, not measured colour).
  vec3 marsTint(float g) {
    vec3 c = mix(vec3(0.13, 0.075, 0.05), vec3(0.66, 0.40, 0.255), smoothstep(0.0, 0.55, g));
    return mix(c, vec3(0.97, 0.82, 0.65), smoothstep(0.52, 1.0, g));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

/** Cast shadows: march from each pixel toward the Sun across the walk-area and regional elevation grids. */
const SHADOW = /* glsl */ `
  uniform sampler2D uAoiHeight;
  uniform float uAoiN;
  uniform float uAoiCell;
  uniform float uAoiHalf;
  uniform sampler2D uRegHeight;
  uniform float uRegN;
  uniform float uRegCell;
  uniform vec2 uRegOrigin; // world X of the west edge, world Z of the north edge
  uniform float uHasRegion;
  uniform vec3 uSunDir;
  uniform float uShadows;

  float groundAt(vec2 xz) {
    vec2 a = (xz + uAoiHalf) / uAoiCell;
    if (all(greaterThanEqual(a, vec2(0.0))) && all(lessThanEqual(a, vec2(uAoiN - 1.0)))) {
      return texture2D(uAoiHeight, (a + 0.5) / uAoiN).r * uExag;
    }
    if (uHasRegion > 0.5) {
      vec2 r = (xz - uRegOrigin) / uRegCell;
      if (all(greaterThanEqual(r, vec2(0.0))) && all(lessThanEqual(r, vec2(uRegN - 1.0)))) {
        return texture2D(uRegHeight, (r + 0.5) / uRegN).r * uExag;
      }
    }
    return -1e6;
  }

  // 1 = full sun, 0 = in shadow; soft edge from the closest miss along the ray
  float sunVisibility(vec3 p, vec3 n) {
    if (uSunDir.y <= 0.0) return 0.0;
    if (uShadows < 0.5) return 1.0;
    vec3 o = p + n * 0.6;
    float vis = 1.0;
    float t = 1.2;
    for (int i = 0; i < 64; i++) {
      vec3 q = o + uSunDir * t;
      float h = groundAt(q.xz);
      float gap = q.y - h;
      if (gap < 0.0) return 0.0;
      vis = min(vis, 9.0 * gap / t);
      t *= 1.115;
      if (t > 9000.0 || q.y > 1200.0 * uExag) break;
    }
    return clamp(vis, 0.0, 1.0);
  }

  // daylight: dim towards twilight, warm low sun
  vec3 sunLight(float nl, float vis) {
    float day = smoothstep(-2.0, 12.0, degrees(asin(clamp(uSunDir.y, -1.0, 1.0))));
    float direct = max(nl, 0.0) * vis;
    return vec3(0.36 + 0.86 * direct) * mix(0.25, 1.0, day);
  }
`;

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform float uExag;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.y *= uExag;
    vNormal = normalize(vec3(normal.x * uExag, normal.y, normal.z * uExag));
    vWorld = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

/** Walk-area terrain: 25 cm HiRISE image (Catmull-Rom filtered), 1 m relief lighting, GPU map layers. */
const AOI_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${COMMON}
  uniform sampler2D uMap;
  uniform vec2 uMapSize;
  uniform sampler2D uRelief;
  uniform float uReliefRange;
  uniform float uExag;
  ${SHADOW}
  uniform int uLayer;
  uniform float uLayerMix;
  uniform float uGridN;
  uniform sampler2D uSlope;
  uniform sampler2D uSand;
  uniform sampler2D uEffort;
  uniform sampler2D uRisk;
  uniform sampler2D uThermal;
  uniform sampler2D uShelter;
  uniform sampler2D uShield;
  uniform sampler2D uMinerals;
  uniform sampler2D uGeo;
  uniform sampler2D uGeoLut;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;

  // Catmull-Rom bicubic sampling in 9 bilinear taps: sharp, smooth magnification instead of blocky texels.
  float sampleCatmullRom(sampler2D tex, vec2 uv, vec2 size) {
    vec2 p = uv * size;
    vec2 t1 = floor(p - 0.5) + 0.5;
    vec2 f = p - t1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t0 = (t1 - 1.0) / size;
    vec2 t3 = (t1 + 2.0) / size;
    vec2 t12 = (t1 + w2 / w12) / size;
    float r = 0.0;
    r += texture2D(tex, vec2(t0.x, t0.y)).r * w0.x * w0.y;
    r += texture2D(tex, vec2(t12.x, t0.y)).r * w12.x * w0.y;
    r += texture2D(tex, vec2(t3.x, t0.y)).r * w3.x * w0.y;
    r += texture2D(tex, vec2(t0.x, t12.y)).r * w0.x * w12.y;
    r += texture2D(tex, vec2(t12.x, t12.y)).r * w12.x * w12.y;
    r += texture2D(tex, vec2(t3.x, t12.y)).r * w3.x * w12.y;
    r += texture2D(tex, vec2(t0.x, t3.y)).r * w0.x * w3.y;
    r += texture2D(tex, vec2(t12.x, t3.y)).r * w12.x * w3.y;
    r += texture2D(tex, vec2(t3.x, t3.y)).r * w3.x * w3.y;
    return r;
  }

  // data grids are node-registered (n x n), row 0 = north
  vec2 gridUv(vec2 uv) { return vec2((uv.x * (uGridN - 1.0) + 0.5) / uGridN, ((1.0 - uv.y) * (uGridN - 1.0) + 0.5) / uGridN); }

  vec4 ramp(float x, float s0, float s1, float s2, float s3, float s4, vec4 c0, vec4 c1, vec4 c2, vec4 c3, vec4 c4) {
    if (x <= s0) return c0;
    if (x <= s1) return mix(c0, c1, (x - s0) / (s1 - s0));
    if (x <= s2) return mix(c1, c2, (x - s1) / (s2 - s1));
    if (x <= s3) return mix(c2, c3, (x - s2) / (s3 - s2));
    if (x <= s4) return mix(c3, c4, (x - s3) / (s4 - s3));
    return c4;
  }

  vec4 layerColor(vec2 g) {
    if (uLayer == 1) {
      float effort = texture2D(uEffort, g).r * 255.0 / 50.0;
      float riskRaw = texture2D(uRisk, g).r * 255.0;
      float total = effort * min(riskRaw, 254.0) / 50.0;
      vec4 c = ramp(total, 1.0, 1.25, 1.9, 2.8, 4.5,
        vec4(0.12, 0.78, 0.43, 0.0), vec4(0.12, 0.78, 0.43, 0.35), vec4(0.94, 0.86, 0.16, 0.55),
        vec4(0.98, 0.51, 0.08, 0.68), vec4(0.9, 0.2, 0.16, 0.78));
      return mix(c, vec4(0.48, 0.0, 0.16, 0.86), smoothstep(200.0, 250.0, riskRaw));
    }
    if (uLayer == 2) {
      float deg = texture2D(uSlope, g).r * 255.0;
      return ramp(deg, 5.0, 10.0, 15.0, 20.0, 25.0,
        vec4(0.16, 0.78, 0.47, 0.0), vec4(0.47, 0.86, 0.31, 0.45), vec4(1.0, 0.86, 0.0, 0.6),
        vec4(1.0, 0.55, 0.0, 0.7), vec4(0.92, 0.16, 0.16, 0.82));
    }
    if (uLayer == 3) {
      float s = texture2D(uSand, g).r;
      return vec4(1.0, 0.76, 0.3, smoothstep(0.15, 0.85, s) * 0.8);
    }
    if (uLayer == 4) {
      float t = texture2D(uThermal, g).r;
      return ramp(t, 0.0, 0.3, 0.55, 0.8, 1.0,
        vec4(0.08, 0.04, 0.35, 0.62), vec4(0.45, 0.08, 0.55, 0.62), vec4(0.82, 0.24, 0.36, 0.62),
        vec4(0.98, 0.6, 0.15, 0.62), vec4(0.98, 0.94, 0.6, 0.62));
    }
    if (uLayer == 5) {
      ivec2 node = ivec2(floor(vUv.x * (uGridN - 1.0) + 0.5), floor((1.0 - vUv.y) * (uGridN - 1.0) + 0.5));
      int id = int(texelFetch(uGeo, node, 0).r * 255.0 + 0.5);
      vec4 c = texelFetch(uGeoLut, ivec2(id, 0), 0);
      int n1 = int(texelFetch(uGeo, node + ivec2(1, 0), 0).r * 255.0 + 0.5);
      int n2 = int(texelFetch(uGeo, node + ivec2(0, 1), 0).r * 255.0 + 0.5);
      if (n1 != id || n2 != id) c = vec4(c.rgb * 0.45, 0.9); // unit boundaries
      return c;
    }
    if (uLayer == 8) {
      // CRISM summary parameters: r = olivine, g = Fe/Mg clay, b = carbonate (0..1 strength), a = imaged by CRISM
      vec4 m = texture2D(uMinerals, g);
      if (m.a < 0.5) {
        float hatch = step(0.82, fract((vWorld.x + vWorld.z) / 14.0));
        return vec4(0.08, 0.06, 0.05, 0.28 + 0.18 * hatch); // not imaged by CRISM
      }
      vec3 col = (m.r * vec3(0.72, 0.88, 0.29) + m.g * vec3(0.3, 0.64, 1.0) + m.b * vec3(1.0, 0.35, 0.82)) / max(m.r + m.g + m.b, 1e-3);
      return vec4(col, smoothstep(0.05, 0.55, max(m.r, max(m.g, m.b))) * 0.88);
    }
    if (uLayer == 7) {
      float f = texture2D(uShield, g).r;            // dose factor, 1 = open sky
      float cut = (1.0 - f) * 100.0;                // percent less dose
      vec4 c = ramp(cut, 0.0, 1.0, 4.0, 8.0, 14.0,
        vec4(0.25, 0.55, 1.0, 0.0), vec4(0.25, 0.55, 1.0, 0.25), vec4(0.3, 0.7, 1.0, 0.55),
        vec4(0.55, 0.85, 1.0, 0.72), vec4(0.85, 0.97, 1.0, 0.85));
      return c;
    }
    if (uLayer == 6) {
      float raw = texture2D(uShelter, g).r * 255.0;
      float minutes = raw / 4.0;
      vec4 c = ramp(minutes, 0.0, 6.0, 12.0, 18.0, 24.0,
        vec4(0.2, 0.95, 0.5, 0.55), vec4(0.75, 0.95, 0.25, 0.55), vec4(1.0, 0.8, 0.15, 0.6),
        vec4(1.0, 0.45, 0.1, 0.65), vec4(0.85, 0.12, 0.25, 0.68));
      if (minutes > 24.0) c = mix(c, vec4(0.85, 0.12, 0.25, 0.68), clamp((minutes - 24.0) / 12.0, 0.0, 1.0));
      // contour every 2 minutes, one screen pixel wide at any zoom
      float k = minutes / 2.0;
      float w = fwidth(k) * 1.1;
      float line = 1.0 - smoothstep(0.0, w, min(fract(k), 1.0 - fract(k)));
      c = mix(c, vec4(0.05, 0.03, 0.02, 0.85), line * 0.8);
      return mix(c, vec4(0.25, 0.0, 0.12, 0.85), smoothstep(240.0, 252.0, raw));
    }
    return vec4(0.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    // texel footprint: Catmull-Rom only while the image is magnified (close up)
    vec2 tp = vUv * uMapSize;
    float footprint = max(length(dFdx(tp)), length(dFdy(tp)));
    float base = texture2D(uMap, vUv).r;
    float sharp = sampleCatmullRom(uMap, vUv, uMapSize);
    float g = clamp(mix(base, sharp, smoothstep(1.6, 0.7, footprint)), 0.0, 1.0);
    vec3 c = marsTint(g);

    // per-pixel lighting from the 1 m HiRISE elevation gradient
    vec2 grad = (texture2D(uRelief, vUv).rg * 2.0 - 1.0) * uReliefRange * uExag;
    vec3 n = normalize(vec3(-grad.x, 1.0, grad.y));
    float nl = dot(n, uSunDir);
    c *= sunLight(nl, sunVisibility(vWorld, n));

    // fine grain right at the camera so the ground does not look smeared at eye height (rendering detail only)
    float d = distance(cameraPosition, vWorld);
    float grain = (noise(vWorld.xz * 4.0) - 0.5) * 0.14 + (noise(vWorld.xz * 13.0) - 0.5) * 0.1 + (noise(vWorld.xz * 37.0) - 0.5) * 0.07;
    c *= 1.0 + grain * smoothstep(35.0, 1.5, d);

    if (uLayer > 0) {
      vec4 o = layerColor(gridUv(vUv));
      c = mix(c, o.rgb, o.a * uLayerMix);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
  }
`;

/** Regional CTX terrain around the walk area: fades into the background at its outer edge. */
const REGION_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${COMMON}
  uniform sampler2D uMap;
  uniform float uExag;
  ${SHADOW}
  uniform vec3 uEdgeColor;
  uniform float uHalf;
  uniform float uFade;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 c = marsTint(texture2D(uMap, vUv).r);
    vec3 n = normalize(vNormal);
    c *= sunLight(dot(n, uSunDir), sunVisibility(vWorld, n));
    c *= 0.86; // slightly darker than the HiRISE walk area, which stays the focus
    vec2 e = uHalf - abs(vWorld.xz);
    c = mix(uEdgeColor, c, smoothstep(0.0, uFade, min(e.x, e.y)));
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
  }
`;

export interface GridTextures {
  slope: THREE.DataTexture;
  sand: THREE.DataTexture;
  effort: THREE.DataTexture;
  risk: THREE.DataTexture;
  thermal: THREE.DataTexture;
  geology: THREE.DataTexture;
  geoLut: THREE.DataTexture;
  shield: THREE.DataTexture;
  minerals: THREE.DataTexture;
}

/** One byte per node, smoothly interpolated on the GPU (so layers look smooth, not pixelated). */
export function byteTexture(data: Uint8Array, n: number, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter): THREE.DataTexture {
  const tex = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.unpackAlignment = 1;
  tex.magFilter = filter;
  tex.minFilter = filter === THREE.NearestFilter ? THREE.NearestFilter : THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function geologyLut(units: GeologyUnit[]): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (const u of units) data.set([u.color[0], u.color[1], u.color[2], 140], u.id * 4);
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** RGBA-per-node grid (4 bytes) as a texture, smoothly interpolated. */
export function rgbaTexture(rgba: Uint8Array | null, n: number): THREE.DataTexture {
  const data = rgba ? new Uint8Array(rgba) : new Uint8Array(n * n * 4);
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface Terrain {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
}

/** Uniforms shared by both terrain materials (one object, so a change applies to both). */
export interface ShadowUniforms {
  uAoiHeight: THREE.IUniform<THREE.Texture | null>;
  uAoiN: THREE.IUniform<number>;
  uAoiCell: THREE.IUniform<number>;
  uAoiHalf: THREE.IUniform<number>;
  uRegHeight: THREE.IUniform<THREE.Texture | null>;
  uRegN: THREE.IUniform<number>;
  uRegCell: THREE.IUniform<number>;
  uRegOrigin: THREE.IUniform<THREE.Vector2>;
  uHasRegion: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uShadows: THREE.IUniform<number>;
  uExag: THREE.IUniform<number>;
}

/** Heights (metres above `zRef`) as a half-float texture: hardware-filtered and precise to ~0.25 m. */
export function heightTexture(heights: Float32Array, n: number, zRef: number): THREE.DataTexture {
  const data = new Uint16Array(n * n);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i] - zRef);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 2;
  tex.needsUpdate = true;
  return tex;
}

export function makeShadowUniforms(): ShadowUniforms {
  return {
    uAoiHeight: { value: null },
    uAoiN: { value: 2 },
    uAoiCell: { value: 1 },
    uAoiHalf: { value: 1 },
    uRegHeight: { value: null },
    uRegN: { value: 2 },
    uRegCell: { value: 1 },
    uRegOrigin: { value: new THREE.Vector2() },
    uHasRegion: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uShadows: { value: 1 },
    uExag: { value: 1 },
  };
}

function material(frag: string, extra: Record<string, THREE.IUniform>, shared: ShadowUniforms): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(uniforms, shared, extra); // shared + texture uniforms are assigned after merge so they are not cloned
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, fog: true, side: THREE.DoubleSide });
}

/**
 * Walk-area terrain straight from the HiRISE elevation grid, plus a 30 m skirt around its edge that
 * hides any hairline gap against the regional terrain.
 * World frame: X = east, Z = south (north is -Z), Y = height above `zRef`, origin at the walk-area centre.
 */
export function buildTerrain(
  grid: TerrainGrid,
  zRef: number,
  map: THREE.Texture,
  relief: THREE.Texture,
  reliefRange: number,
  layers: GridTextures,
  step: number,
  shared: ShadowUniforms,
): Terrain {
  const n = grid.n;
  const m = Math.floor((n - 1) / step) + 1;
  const half = grid.size / 2;
  const h = grid.height;
  const border = 4 * (m - 1);
  const total = m * m + border;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      const r = j * step;
      const c = i * step;
      pos[k * 3] = c * grid.cell - half;
      pos[k * 3 + 1] = h[r * n + c] - zRef;
      pos[k * 3 + 2] = r * grid.cell - half;
      nor[k * 3 + 1] = 1;
      uv[k * 2] = c / (n - 1);
      uv[k * 2 + 1] = 1 - r / (n - 1);
    }
  }
  // skirt: a copy of every border vertex, 30 m lower, walking the edge clockwise
  const ring: number[] = [];
  for (let i = 0; i < m - 1; i++) ring.push(i);
  for (let j = 0; j < m - 1; j++) ring.push(j * m + m - 1);
  for (let i = m - 1; i > 0; i--) ring.push((m - 1) * m + i);
  for (let j = m - 1; j > 0; j--) ring.push(j * m);
  ring.forEach((src, q) => {
    const k = m * m + q;
    pos[k * 3] = pos[src * 3];
    pos[k * 3 + 1] = pos[src * 3 + 1] - 30;
    pos[k * 3 + 2] = pos[src * 3 + 2];
    nor[k * 3 + 1] = 1;
    uv[k * 2] = uv[src * 2];
    uv[k * 2 + 1] = uv[src * 2 + 1];
  });

  const index = new Uint32Array((m - 1) * (m - 1) * 6 + border * 6);
  let q = 0;
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const a = j * m + i;
      const b = a + 1;
      const d = a + m;
      const e = d + 1;
      index[q++] = a; index[q++] = d; index[q++] = b;
      index[q++] = b; index[q++] = d; index[q++] = e;
    }
  }
  for (let s = 0; s < border; s++) {
    const a = ring[s];
    const b = ring[(s + 1) % border];
    const a2 = m * m + s;
    const b2 = m * m + ((s + 1) % border);
    index[q++] = a; index[q++] = b; index[q++] = a2;
    index[q++] = b; index[q++] = b2; index[q++] = a2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();

  const img = map.image as { width: number; height: number };
  const mat = material(AOI_FRAG, {
    uMap: { value: map },
    uMapSize: { value: new THREE.Vector2(img.width, img.height) },
    uRelief: { value: relief },
    uReliefRange: { value: reliefRange },
    uLayer: { value: 0 },
    uLayerMix: { value: 0.8 },
    uGridN: { value: n },
    uSlope: { value: layers.slope },
    uSand: { value: layers.sand },
    uEffort: { value: layers.effort },
    uRisk: { value: layers.risk },
    uThermal: { value: layers.thermal },
    uShelter: { value: layers.slope },
    uGeo: { value: layers.geology },
    uGeoLut: { value: layers.geoLut },
    uShield: { value: layers.shield },
    uMinerals: { value: layers.minerals },
  }, shared);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, uniforms: mat.uniforms };
}

/** Regional CTX terrain with a hole where the HiRISE walk area sits. */
export function buildRegion(region: RegionMeta, heights: Float32Array, zRef: number, map: THREE.Texture, aoiSize: number, step: number, shared: ShadowUniforms): Terrain {
  const n = region.n;
  const m = Math.floor((n - 1) / step) + 1;
  const cell = region.cellM * step;
  // region origin relative to the walk-area centre (world X east, Z south)
  const x0 = region.originLocal.x - aoiSize / 2;
  const zTop = aoiSize / 2 - (region.originLocal.y + region.sizeM); // north edge
  const pos = new Float32Array(m * m * 3);
  const nor = new Float32Array(m * m * 3);
  const uv = new Float32Array(m * m * 2);
  const at = (r: number, c: number) => heights[Math.max(0, Math.min(n - 1, r)) * n + Math.max(0, Math.min(n - 1, c))];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      const r = j * step;
      const c = i * step;
      pos[k * 3] = x0 + i * cell;
      pos[k * 3 + 1] = at(r, c) - zRef;
      pos[k * 3 + 2] = zTop + j * cell;
      const dzdx = (at(r, c + step) - at(r, c - step)) / (2 * cell);
      const dzdz = (at(r + step, c) - at(r - step, c)) / (2 * cell);
      const inv = 1 / Math.hypot(dzdx, 1, dzdz);
      nor[k * 3] = -dzdx * inv;
      nor[k * 3 + 1] = inv;
      nor[k * 3 + 2] = -dzdz * inv;
      uv[k * 2] = c / (n - 1);
      uv[k * 2 + 1] = 1 - r / (n - 1);
    }
  }
  const lo = region.inner.from / step;
  const hi = region.inner.to / step;
  const index: number[] = [];
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      if (i >= lo && i < hi && j >= lo && j < hi) continue; // hole for the walk area
      const a = j * m + i;
      const b = a + 1;
      const d = a + m;
      const e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(index), 1));
  geometry.computeBoundingSphere();
  const mat = material(REGION_FRAG, {
    uMap: { value: map },
    uEdgeColor: { value: new THREE.Color().setHex(MAP_BG, THREE.LinearSRGBColorSpace) },
    uHalf: { value: region.sizeM / 2 },
    uFade: { value: 2600 },
  }, shared);
  // the region is centred on the walk area only if the margins are equal (they are, by construction)
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, uniforms: mat.uniforms };
}

/** Sky dome: butterscotch haze at the horizon, darker overhead; a flat dark backdrop in the map view. */
export function buildSky(): { mesh: THREE.Mesh; setMapMode: (k: number) => void; setSunElevation: (deg: number) => void } {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    // colours are written straight to the framebuffer, so keep the hex values as display values
    uniforms: {
      uHorizon: { value: new THREE.Color().setHex(SKY_HORIZON, THREE.LinearSRGBColorSpace) },
      uZenith: { value: new THREE.Color().setHex(0x6b4a3a, THREE.LinearSRGBColorSpace) },
      uMapBg: { value: new THREE.Color().setHex(MAP_BG, THREE.LinearSRGBColorSpace) },
      uMap: { value: 1 },
      uDay: { value: 1 },
    },
    vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uMapBg; uniform float uMap; uniform float uDay; varying vec3 vDir;
      void main() {
        float t = pow(clamp(vDir.y, 0.0, 1.0), 0.45);
        vec3 c = mix(uHorizon, uZenith, t);
        c = mix(c, uHorizon * 0.82, smoothstep(0.0, -0.25, vDir.y));
        c *= mix(0.22, 1.0, uDay); // dusk and night
        gl_FragColor = vec4(mix(c, uMapBg, uMap), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return {
    mesh,
    setMapMode: (k) => (material.uniforms.uMap.value = k),
    setSunElevation: (deg) => (material.uniforms.uDay.value = Math.min(1, Math.max(0, (deg + 2) / 14))),
  };
}
