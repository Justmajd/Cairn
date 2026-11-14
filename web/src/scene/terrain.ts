import * as THREE from "three";
import type { TerrainGrid } from "../data/grid";
import type { GeologyUnit, RegionMeta } from "../types";

/** Sun direction used for relief shading — from the west, like the afternoon light in the HiRISE image. */
export const SUN_DIR = new THREE.Vector3(-0.72, 0.62, -0.12).normalize();
export const SKY_HORIZON = 0xd9a878;
/** Background of the top-down map (matches the interface). */
export const MAP_BG = 0x0f0d0c;

/** Map layers coloured on the GPU from the data grids. */
export const LAYER_IDS = { none: 0, risk: 1, slope: 2, sand: 3, thermal: 4, geology: 5, shelter: 6, shield: 7, minerals: 8, radio: 9 } as const;
export type LayerId = keyof typeof LAYER_IDS;

const COMMON = /* glsl */ `
  // HiRISE / CTX are single grey bands: tint with a Mars ramp (display colour, not measured colour).
  vec3 marsTint(float g) {
    vec3 c = mix(vec3(0.13, 0.075, 0.05), vec3(0.66, 0.40, 0.255), smoothstep(0.0, 0.55, g));
    return mix(c, vec3(0.97, 0.82, 0.65), smoothstep(0.52, 1.0, g));
  }
  // node-registered grids (n x n, row 0 = north) sampled from mesh uv (v = 1 at the north edge)
  vec2 nodeUv(vec2 uv, float n) { return vec2((uv.x * (n - 1.0) + 0.5) / n, ((1.0 - uv.y) * (n - 1.0) + 0.5) / n); }
`;

/**
 * Cast shadows: march toward the Sun across the walk-area and regional elevation grids.
 * Runs in the bake pass (once per Sun position), not per pixel per frame.
 */
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
    for (int i = 0; i < 96; i++) { // reaches ~9 km: crater rims cast shadows at low sun
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
`;

/** Sun light for the terrain shaders; the visibility comes from the baked shadow texture. */
const LIGHT = /* glsl */ `
  uniform vec3 uSunDir;
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

/** Walk-area vertices carry only a position: the image uv follows from it (and the normal comes from the relief texture). */
const AOI_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  uniform float uExag;
  uniform float uAoiHalf;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vec3 p = position;
    vUv = vec2((p.x + uAoiHalf) / (2.0 * uAoiHalf), 1.0 - (p.z + uAoiHalf) / (2.0 * uAoiHalf));
    p.y *= uExag;
    vWorld = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
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
  uniform float uDetail;
  uniform sampler2D uRelief;
  uniform float uReliefRange;
  uniform float uExag;
  ${LIGHT}
  uniform sampler2D uShadowAoi;
  uniform float uShadowAoiN;
  uniform int uLayer;
  uniform float uLayerMix;
  uniform float uGridN;
  uniform sampler2D uSlope;
  uniform sampler2D uSand;
  uniform sampler2D uEffort;
  uniform sampler2D uRisk;
  uniform sampler2D uThermal;
  uniform sampler2D uShelter;
  uniform float uReveal; // minutes from the rover shown so far (the layer floods outward when it opens)
  uniform sampler2D uRadio;
  uniform sampler2D uShield;
  uniform sampler2D uMinerals;
  uniform sampler2D uGeo;
  uniform sampler2D uGeoLut;
  varying vec2 vUv;
  varying vec3 vWorld;

  // Catmull-Rom bicubic sampling in 9 bilinear taps: sharp, smooth magnification instead of blocky texels.
  // Only called while the image is magnified, so it reads mip level 0 explicitly (no derivatives in a branch).
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
    r += textureLod(tex, vec2(t0.x, t0.y), 0.0).r * w0.x * w0.y;
    r += textureLod(tex, vec2(t12.x, t0.y), 0.0).r * w12.x * w0.y;
    r += textureLod(tex, vec2(t3.x, t0.y), 0.0).r * w3.x * w0.y;
    r += textureLod(tex, vec2(t0.x, t12.y), 0.0).r * w0.x * w12.y;
    r += textureLod(tex, vec2(t12.x, t12.y), 0.0).r * w12.x * w12.y;
    r += textureLod(tex, vec2(t3.x, t12.y), 0.0).r * w3.x * w12.y;
    r += textureLod(tex, vec2(t0.x, t3.y), 0.0).r * w0.x * w3.y;
    r += textureLod(tex, vec2(t12.x, t3.y), 0.0).r * w12.x * w3.y;
    r += textureLod(tex, vec2(t3.x, t3.y), 0.0).r * w3.x * w3.y;
    return r;
  }

  // data grids are node-registered (n x n), row 0 = north
  vec2 gridUv(vec2 uv) { return nodeUv(uv, uGridN); }

  // ---- ground detail below the image resolution (rendering detail, not data) -----------------
  // sin-free hash: stays precise at kilometre-scale coordinates (the sin hash shows a grid there)
  float hash2(vec2 p) {
    p = fract(p * 0.3183099 + vec2(0.71, 0.113));
    p *= 17.0;
    return fract(p.x * p.y * (p.x + p.y));
  }
  // value noise and its derivatives: x = value (0..1), yz = d/dp
  vec3 noised(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
    float k = a - b - c + d;
    return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
  }
  // Regolith at the camera: four rotated octaves as height (bump) and brightness, plus scattered pebbles.
  // pw = ground size of one screen pixel (m); each feature fades out before it is smaller than a pixel,
  // so nothing shimmers and far ground costs nothing.  xy = height gradient d/d(x, z), z = brightness offset.
  vec3 regolith(vec2 p, float pw) {
    vec3 acc = vec3(0.0);
    mat2 m = mat2(1.0);
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    float f = 1.6;
    float amp = 0.05; // metres of height at the coarsest octave
    for (int k = 0; k < 4; k++) {
      float w = 1.0 - smoothstep(0.18, 0.45, pw * f);
      if (w <= 0.0) break;
      vec3 nd = noised(m * p * f + float(k) * 17.31);
      acc.xy += w * amp * f * (transpose(m) * nd.yz);
      acc.z += w * (nd.x - 0.5) * (0.13 - 0.025 * float(k));
      m = rot * m;
      f *= 2.7;
      amp *= 0.42;
    }
    // scattered pebbles, 2-8 cm, irregular, some lighter and some darker than the soil
    float wp = 1.0 - smoothstep(0.012, 0.03, pw);
    if (wp > 0.0) {
      vec2 cell = floor(p * 3.0);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 c = cell + vec2(float(i), float(j));
          if (hash2(c) > 0.25) continue;
          vec2 ctr = (c + 0.15 + 0.7 * vec2(hash2(c + 3.1), hash2(c + 7.7))) / 3.0;
          vec2 v = p - ctr;
          float ang = atan(v.y, v.x);
          float r = (0.02 + 0.06 * hash2(c + 11.3) * hash2(c + 5.2)) * (1.0 + 0.22 * sin(3.0 * ang + 6.3 * hash2(c + 1.7)) + 0.12 * sin(5.0 * ang));
          float q = dot(v, v) / (r * r);
          if (q < 1.0) {
            float sq = sqrt(max(1.0 - q, 0.08));
            acc.xy -= wp * 0.45 * v / (r * sq); // low dome, 0.45 r high
            acc.z += wp * (hash2(c + 2.9) - 0.6) * 0.16 * smoothstep(1.0, 0.6, q);
          }
        }
      }
    }
    return acc;
  }

  vec4 ramp(float x, float s0, float s1, float s2, float s3, float s4, vec4 c0, vec4 c1, vec4 c2, vec4 c3, vec4 c4) {
    if (x <= s0) return c0;
    if (x <= s1) return mix(c0, c1, (x - s0) / (s1 - s0));
    if (x <= s2) return mix(c1, c2, (x - s1) / (s2 - s1));
    if (x <= s3) return mix(c2, c3, (x - s2) / (s3 - s2));
    if (x <= s4) return mix(c3, c4, (x - s3) / (s4 - s3));
    return c4;
  }

  // Hazard colours from the Okabe-Ito palette (readable with red-green colour blindness):
  // sky blue = easy, yellow, orange, vermillion = hard; impassable ground is purple AND hatched,
  // so it never depends on colour alone.
  const vec3 OK_BLUE = vec3(0.34, 0.71, 0.91);
  const vec3 OK_YELLOW = vec3(0.94, 0.89, 0.26);
  const vec3 OK_ORANGE = vec3(0.9, 0.62, 0.0);
  const vec3 OK_VERMILLION = vec3(0.84, 0.37, 0.0);
  const vec3 OK_PURPLE = vec3(0.55, 0.16, 0.45);

  // diagonal stripes on the ground, anti-aliased so they fade to a flat tint when zoomed far out
  float hatch(float spacing) {
    float k = (vWorld.x - vWorld.z) / spacing;
    float w = fwidth(k);
    float f = abs(fract(k) - 0.5);
    return 1.0 - smoothstep(0.32 - w, 0.32 + w, f);
  }

  vec4 impassable(vec4 c, float amount) {
    vec4 stripes = mix(vec4(OK_PURPLE, 0.86), vec4(0.98, 0.9, 0.96, 0.9), hatch(9.0) * 0.75);
    return mix(c, stripes, amount);
  }

  vec4 layerColor(vec2 g) {
    if (uLayer == 1) {
      float effort = texture2D(uEffort, g).r * 255.0 / 50.0;
      float riskRaw = texture2D(uRisk, g).r * 255.0;
      float total = effort * min(riskRaw, 254.0) / 50.0;
      vec4 c = ramp(total, 1.0, 1.25, 1.9, 2.8, 4.5,
        vec4(OK_BLUE, 0.0), vec4(OK_BLUE, 0.4), vec4(OK_YELLOW, 0.58),
        vec4(OK_ORANGE, 0.7), vec4(OK_VERMILLION, 0.8));
      return impassable(c, smoothstep(200.0, 250.0, riskRaw));
    }
    if (uLayer == 2) {
      float deg = texture2D(uSlope, g).r * 255.0;
      vec4 c = ramp(deg, 5.0, 10.0, 15.0, 20.0, 25.0,
        vec4(OK_BLUE, 0.0), vec4(OK_BLUE, 0.45), vec4(OK_YELLOW, 0.6),
        vec4(OK_ORANGE, 0.72), vec4(OK_VERMILLION, 0.82));
      return impassable(c, step(250.0, texture2D(uRisk, g).r * 255.0));
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
    if (uLayer == 9) {
      // radio shadow: metres the suit antenna sits below the line of sight to the rover's mast
      float depth = texture2D(uRadio, g).r * 255.0 * 0.25;
      if (depth <= 0.5) return vec4(0.0);
      vec4 c = mix(vec4(0.62, 0.66, 0.9, 0.4), vec4(0.06, 0.07, 0.18, 0.74), smoothstep(0.5, 5.0, depth));
      // dots: dead zones read as "no signal" without relying on colour
      vec2 cellUv = fract(vWorld.xz / 7.0) - 0.5;
      float pip = 1.0 - smoothstep(0.12, 0.12 + fwidth(vWorld.x) / 7.0 * 1.5, length(cellUv));
      return mix(c, vec4(0.85, 0.88, 1.0, c.a), pip * 0.55 * step(2.0, depth));
    }
    if (uLayer == 6) {
      float raw = texture2D(uShelter, g).r * 255.0;
      float minutes = raw / 4.0;
      vec4 c = ramp(minutes, 0.0, 6.0, 12.0, 18.0, 24.0,
        vec4(OK_BLUE, 0.55), vec4(OK_YELLOW, 0.55), vec4(OK_ORANGE, 0.62),
        vec4(OK_VERMILLION, 0.66), vec4(OK_PURPLE, 0.7));
      // contour every 2 minutes, one screen pixel wide at any zoom
      float k = minutes / 2.0;
      float w = fwidth(k) * 1.1;
      float line = 1.0 - smoothstep(0.0, w, min(fract(k), 1.0 - fract(k)));
      c = mix(c, vec4(0.05, 0.03, 0.02, 0.85), line * 0.8);
      c = impassable(c, smoothstep(240.0, 252.0, raw));
      if (uReveal < 900.0) {
        // flooding outward from the rover: a bright front, nothing beyond it yet
        float ahead = smoothstep(uReveal - 0.4, uReveal, minutes);
        float front = 1.0 - smoothstep(0.0, 0.8, abs(minutes - uReveal + 0.4));
        c = mix(c, vec4(1.0, 1.0, 1.0, 0.9), front * 0.85);
        c.a *= 1.0 - ahead;
      }
      return c;
    }
    return vec4(0.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    // texel footprint: Catmull-Rom only while the image is magnified (close up)
    vec2 tp = vUv * uMapSize;
    float footprint = max(length(dFdx(tp)), length(dFdy(tp)));
    float g = texture2D(uMap, vUv).r;
    if (footprint < 1.6) g = mix(g, sampleCatmullRom(uMap, vUv, uMapSize), smoothstep(1.6, 0.7, footprint));
    vec3 c = marsTint(clamp(g, 0.0, 1.0));

    // per-pixel lighting from the 1 m HiRISE elevation gradient
    vec2 grad = (texture2D(uRelief, vUv).rg * 2.0 - 1.0) * uReliefRange * uExag;
    vec3 n = vec3(-grad.x, 1.0, grad.y);

    // close to the camera, regolith detail below the 25 cm image so the ground is not smeared at eye height
    float pw = max(length(dFdx(vWorld)), length(dFdy(vWorld)));
    if (pw < 0.3 && uDetail > 0.5) {
      vec3 rg = regolith(vWorld.xz, pw);
      float lim = length(rg.xy);
      vec2 gd = rg.xy * min(1.0, 1.6 / max(lim, 1e-4)) * uExag;
      n += vec3(-gd.x, 0.0, -gd.y);
      c *= 1.0 + rg.z;
    }
    n = normalize(n);
    float nl = dot(n, uSunDir);
    c *= sunLight(nl, texture2D(uShadowAoi, nodeUv(vUv, uShadowAoiN)).r);

    if (uLayer > 0) {
      vec4 o = layerColor(gridUv(vUv));
      c = mix(c, o.rgb, o.a * uLayerMix);
    }
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
    #ifdef USE_FOG
      // distant haze is lit from behind when looking toward the Sun (forward scattering, as in the sky)
      float sg = pow(max(dot(normalize(vWorld - cameraPosition), uSunDir), 0.0), 14.0) * smoothstep(-0.06, 0.02, uSunDir.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.6, 0.72, 0.9), fogFactor * sg * 0.45);
    #endif
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
  ${LIGHT}
  uniform sampler2D uShadowReg;
  uniform float uShadowRegN;
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
    c *= sunLight(dot(n, uSunDir), texture2D(uShadowReg, nodeUv(vUv, uShadowRegN)).r);
    c *= 0.86; // slightly darker than the HiRISE walk area, which stays the focus
    vec2 e = uHalf - abs(vWorld.xz);
    c = mix(uEdgeColor, c, smoothstep(0.0, uFade, min(e.x, e.y)));
    gl_FragColor = vec4(c, 1.0);
    #include <fog_fragment>
    #ifdef USE_FOG
      // distant haze is lit from behind when looking toward the Sun (forward scattering, as in the sky)
      float sg = pow(max(dot(normalize(vWorld - cameraPosition), uSunDir), 0.0), 14.0) * smoothstep(-0.06, 0.02, uSunDir.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.6, 0.72, 0.9), fogFactor * sg * 0.45);
    #endif
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
  /**
   * Choose each tile's mesh detail from the on-screen size of one grid cell (pixels; below
   * thresholds[0] every 2nd node, below thresholds[1] every 4th) and skip tiles outside the view.
   */
  updateLod?: (camera: THREE.PerspectiveCamera, viewPx: number, thresholds: [number, number]) => void;
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
  uShadowAoi: THREE.IUniform<THREE.Texture | null>;
  uShadowAoiN: THREE.IUniform<number>;
  uShadowReg: THREE.IUniform<THREE.Texture | null>;
  uShadowRegN: THREE.IUniform<number>;
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
    uShadowAoi: { value: null },
    uShadowAoiN: { value: 2 },
    uShadowReg: { value: null },
    uShadowRegN: { value: 2 },
  };
}

/** Shadow-map resolution relative to the elevation grids (2 = twice as many nodes per side). */
const SHADOW_UPSAMPLE = 2;

/**
 * Sun visibility baked into two textures (walk area and region) by a full-screen pass that ray-marches
 * the elevation grids.  The terrain shaders only sample it, so a frame costs one texture read instead of
 * a 64-step march per pixel.  Re-baked when the Sun moves, the exaggeration changes or shadows toggle.
 */
export class ShadowBaker {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly aoiTarget: THREE.WebGLRenderTarget;
  private readonly regTarget: THREE.WebGLRenderTarget | null;
  // quarter-cost versions (one texel per grid node) used while the Sun is being dragged
  private readonly aoiFast: THREE.WebGLRenderTarget;
  private readonly regFast: THREE.WebGLRenderTarget | null;

  constructor(private readonly shared: ShadowUniforms) {
    const target = (n: number) => new THREE.WebGLRenderTarget(n, n, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    const aoiN = (shared.uAoiN.value - 1) * SHADOW_UPSAMPLE + 1;
    this.aoiTarget = target(aoiN);
    this.aoiFast = target(shared.uAoiN.value);
    shared.uShadowAoi.value = this.aoiTarget.texture;
    shared.uShadowAoiN.value = aoiN;
    if (shared.uHasRegion.value > 0.5) {
      const regN = (shared.uRegN.value - 1) * SHADOW_UPSAMPLE + 1;
      this.regTarget = target(regN);
      this.regFast = target(shared.uRegN.value);
      shared.uShadowReg.value = this.regTarget.texture;
      shared.uShadowRegN.value = regN;
    } else {
      this.regTarget = null;
      this.regFast = null;
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, uOrigin: { value: new THREE.Vector2() }, uStep: { value: 1 } },
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uExag;
        ${SHADOW}
        uniform vec2 uOrigin; // world X, Z of texel (0, 0)
        uniform float uStep;  // metres per texel
        float gnd(vec2 q, float h0) { float h = groundAt(q); return h < -1e5 ? h0 : h; }
        void main() {
          vec2 xz = uOrigin + (gl_FragCoord.xy - 0.5) * uStep;
          float h0 = groundAt(xz);
          float hx = gnd(xz + vec2(1.0, 0.0), h0) - gnd(xz - vec2(1.0, 0.0), h0);
          float hz = gnd(xz + vec2(0.0, 1.0), h0) - gnd(xz - vec2(0.0, 1.0), h0);
          vec3 n = normalize(vec3(-hx * 0.5, 1.0, -hz * 0.5));
          gl_FragColor = vec4(sunVisibility(vec3(xz.x, h0, xz.y), n), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Bake cast shadows for the current Sun.  `fast`: one texel per grid node (a quarter of the work), for while the Sun moves. */
  bake(renderer: THREE.WebGLRenderer, fast = false): void {
    const sh = this.shared;
    const u = this.material.uniforms;
    const prev = renderer.getRenderTarget();
    const up = fast ? 1 : SHADOW_UPSAMPLE;
    const aoi = fast ? this.aoiFast : this.aoiTarget;
    const half = sh.uAoiHalf.value;
    u.uOrigin.value.set(-half, -half);
    u.uStep.value = sh.uAoiCell.value / up;
    renderer.setRenderTarget(aoi);
    renderer.render(this.scene, this.camera);
    sh.uShadowAoi.value = aoi.texture;
    sh.uShadowAoiN.value = aoi.width;
    const reg = fast ? this.regFast : this.regTarget;
    if (reg) {
      u.uOrigin.value.copy(sh.uRegOrigin.value);
      u.uStep.value = sh.uRegCell.value / up;
      renderer.setRenderTarget(reg);
      renderer.render(this.scene, this.camera);
      sh.uShadowReg.value = reg.texture;
      sh.uShadowRegN.value = reg.width;
    }
    renderer.setRenderTarget(prev);
  }
}

function material(frag: string, extra: Record<string, THREE.IUniform>, shared: ShadowUniforms, vert = VERT): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(uniforms, shared, extra); // shared + texture uniforms are assigned after merge so they are not cloned
  return new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, fog: true, side: THREE.DoubleSide });
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

  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      const r = j * step;
      const c = i * step;
      pos[k * 3] = c * grid.cell - half;
      pos[k * 3 + 1] = h[r * n + c] - zRef;
      pos[k * 3 + 2] = r * grid.cell - half;
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
  });

  // Level of detail per tile: 8 x 8 tiles, each drawn with every node, every 2nd or every 4th node.
  // A coarse tile keeps every node along its own edges and zips them to its coarse interior, so tiles
  // at different levels always share the same edge vertices: no cracks between them.
  const TILES = 8;
  const T = (m - 1) / TILES;
  const ks = [1, 2, 4].filter((k) => Number.isInteger(T / k) && (k === 1 || T / k >= 4));
  let buf = new Uint32Array(1 << 22);
  let q = 0;
  const tri = (a: number, b: number, c: number) => {
    if (q + 3 > buf.length) {
      const grown = new Uint32Array(buf.length * 2);
      grown.set(buf);
      buf = grown;
    }
    buf[q++] = a; buf[q++] = b; buf[q++] = c;
  };
  const ranges: { start: number; count: number }[][] = ks.map(() => []); // [level][tile]
  const tileH: { lo: number; hi: number }[] = [];
  ks.forEach((k, level) => {
    for (let ty = 0; ty < TILES; ty++) {
      for (let tx = 0; tx < TILES; tx++) {
        const v = (c: number, r: number) => (ty * T + r) * m + tx * T + c;
        const begin = q;
        const lo = k === 1 ? 0 : k;
        for (let r = lo; r < T - lo; r += k) {
          for (let c = lo; c < T - lo; c += k) {
            const a = v(c, r), b = v(c + k, r), d = v(c, r + k), e = v(c + k, r + k);
            tri(a, d, b);
            tri(b, d, e);
          }
        }
        if (k > 1) {
          // zip the fine outer edge (T + 1 nodes) to the coarse inner row (from k to T - k)
          const zip = (outer: (i: number) => number, inner: (i: number) => number) => {
            const nIn = T / k - 1;
            let i = 0;
            let j = 0;
            while (i < T || j < nIn - 1) {
              const nextOuter = i < T ? (i + 1) / T : Infinity;
              const nextInner = j < nIn - 1 ? (k + (j + 1) * k) / T : Infinity;
              if (nextOuter <= nextInner) {
                tri(outer(i), outer(i + 1), inner(k + j * k));
                i++;
              } else {
                tri(outer(i), inner(k + (j + 1) * k), inner(k + j * k));
                j++;
              }
            }
          };
          zip((i) => v(i, 0), (c) => v(c, k));
          zip((i) => v(i, T), (c) => v(c, T - k));
          zip((i) => v(0, i), (r) => v(k, r));
          zip((i) => v(T, i), (r) => v(T - k, r));
        }
        ranges[level].push({ start: begin, count: q - begin });
        if (level === 0) {
          let hLo = Infinity;
          let hHi = -Infinity;
          for (let r = 0; r <= T; r++) {
            for (let c = 0; c <= T; c++) {
              const y = pos[v(c, r) * 3 + 1];
              if (y < hLo) hLo = y;
              if (y > hHi) hHi = y;
            }
          }
          tileH.push({ lo: hLo, hi: hHi });
        }
      }
    }
  });
  // skirt around the whole walk area: always drawn
  const skirtStart = q;
  for (let s = 0; s < border; s++) {
    const a = ring[s];
    const b = ring[(s + 1) % border];
    const a2 = m * m + s;
    const b2 = m * m + ((s + 1) % border);
    tri(a, b, a2);
    tri(b, b2, a2);
  }
  const skirtCount = q - skirtStart;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(buf.slice(0, q), 1));
  geometry.computeBoundingSphere();

  const img = map.image as { width: number; height: number };
  const mat = material(AOI_FRAG, {
    uMap: { value: map },
    uMapSize: { value: new THREE.Vector2(img.width, img.height) },
    uDetail: { value: step === 1 ? 1 : 0 }, // ?q=low skips the close-up regolith detail
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
    uReveal: { value: 1000 },
    uRadio: { value: layers.slope },
    uGeo: { value: layers.geology },
    uGeoLut: { value: layers.geoLut },
    uShield: { value: layers.shield },
    uMinerals: { value: layers.minerals },
  }, shared, AOI_VERT);
  const mesh = new THREE.Mesh(geometry, [mat]); // material array: draw only the groups chosen below
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;

  const frustum = new THREE.Frustum();
  const box = new THREE.Box3();
  const pv = new THREE.Matrix4();
  const tileSize = T * step * grid.cell;
  let signature = "";
  const updateLod = (camera: THREE.PerspectiveCamera, viewPx: number, thresholds: [number, number]) => {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const exag = shared.uExag.value;
    const pxPerM = viewPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const cellM = step * grid.cell;
    const choice: number[] = [];
    for (let t = 0; t < TILES * TILES; t++) {
      const tx = t % TILES;
      const ty = Math.floor(t / TILES);
      box.min.set(tx * tileSize - half, tileH[t].lo * exag - 1, ty * tileSize - half);
      box.max.set((tx + 1) * tileSize - half, tileH[t].hi * exag + 1, (ty + 1) * tileSize - half);
      if (!frustum.intersectsBox(box)) {
        choice.push(-1);
        continue;
      }
      const cellPx = (cellM * pxPerM) / Math.max(1, box.distanceToPoint(camera.position));
      choice.push(Math.min(ks.length - 1, cellPx < thresholds[1] ? 2 : cellPx < thresholds[0] ? 1 : 0));
    }
    const sig = choice.join(",");
    if (sig === signature) return;
    signature = sig;
    // consecutive tiles at the same level are contiguous in the index buffer: one draw call per run
    geometry.clearGroups();
    let start = 0;
    let count = 0;
    for (let t = 0; t <= choice.length; t++) {
      const level = t < choice.length ? choice[t] : -1;
      if (count > 0 && level >= 0 && ranges[level][t].start === start + count) {
        count += ranges[level][t].count; // same level as the previous tile: extend the run
        continue;
      }
      if (count > 0) geometry.addGroup(start, count, 0);
      start = level >= 0 ? ranges[level][t].start : 0;
      count = level >= 0 ? ranges[level][t].count : 0;
    }
    geometry.addGroup(skirtStart, skirtCount, 0);
  };
  // until the first update: every tile at full detail, plus the skirt
  geometry.addGroup(0, ranges[0][ranges[0].length - 1].start + ranges[0][ranges[0].length - 1].count, 0);
  geometry.addGroup(skirtStart, skirtCount, 0);
  return { mesh, uniforms: mat.uniforms, updateLod };
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
export function buildSky(sunDir: THREE.IUniform<THREE.Vector3>): { mesh: THREE.Mesh; setMapMode: (k: number) => void; setSunElevation: (deg: number) => void } {
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
      uSunDir: sunDir,
    },
    vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uMapBg; uniform float uMap; uniform float uDay; uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float t = pow(clamp(d.y, 0.0, 1.0), 0.45);
        vec3 c = mix(uHorizon, uZenith, t);
        c = mix(c, uHorizon * 0.82, smoothstep(0.0, -0.25, d.y));
        c *= mix(0.22, 1.0, uDay); // dusk and night
        // Fine dust scatters blue light forward: the sky around the Sun is bluish, most of all near sunset
        // (as the rovers photograph it).  Then the Sun's disc, 0.35 deg across from Mars.
        float mu = dot(d, uSunDir);
        float up = smoothstep(-0.06, 0.02, uSunDir.y);
        float low = 1.0 - smoothstep(0.05, 0.5, uSunDir.y);
        float m = max(mu, 0.0);
        float glow = (pow(m, 18.0) * (0.16 + 0.6 * low) + pow(m, 300.0) * 0.45) * up;
        c = mix(c, vec3(0.6, 0.72, 0.9) * mix(0.55, 1.0, uDay), clamp(glow, 0.0, 0.85));
        c = mix(c, vec3(1.0, 0.98, 0.94), smoothstep(0.9999893, 0.9999953, mu) * up);
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
