import * as THREE from "three";

/**
 * Post-processing for the 3D views, kept small and cheap (no EffectComposer):
 *  1. the scene into a half-float buffer, 4x MSAA, with a depth texture;
 *  2. ambient occlusion from that depth at half resolution (8 samples, radius in metres scaled with
 *     distance, so it works from eye level to orbit), then a 2-pass depth-aware blur;
 *  3. glare: the brightest light (the Sun and its halo) bloomed at quarter resolution;
 *  4. composite: AO, glare, a light vignette and fine grain, then linear -> sRGB to the screen.
 * CAIRN's own shaders write linear colour while this is on (see COMMON's outColor in terrain.ts).
 */
const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const AO_FRAG = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform vec2 uTexel;     // 1 / full-resolution size
  uniform float uAspect;
  uniform float uIntensity;
  varying vec2 vUv;
  vec3 viewPos(vec2 uv, float d) {
    vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    float d = texture2D(tDepth, vUv).r;
    if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv, d);
    // normal from neighbouring depths (one full-res texel away)
    vec3 Px = viewPos(vUv + vec2(uTexel.x, 0.0), texture2D(tDepth, vUv + vec2(uTexel.x, 0.0)).r);
    vec3 Py = viewPos(vUv + vec2(0.0, uTexel.y), texture2D(tDepth, vUv + vec2(0.0, uTexel.y)).r);
    vec3 N = normalize(cross(Px - P, Py - P));
    float dist = -P.z;
    float radius = clamp(dist * 0.035, 0.12, 60.0);          // metres
    float rs = radius * uProj[1][1] / dist * 0.5;            // in uv (vertical)
    float a0 = ign(gl_FragCoord.xy) * 6.2831853;
    float occ = 0.0;
    for (int i = 0; i < 8; i++) {
      float t = (float(i) + 0.5) / 8.0;
      float ang = a0 + t * 6.2831853 * 3.0;
      vec2 suv = vUv + vec2(cos(ang) / uAspect, sin(ang)) * t * rs;
      float sd = texture2D(tDepth, suv).r;
      vec3 S = viewPos(suv, sd);
      vec3 v = S - P;
      float vv = dot(v, v);
      float vn = dot(v, N);
      float fall = max(0.0, 1.0 - vv / (radius * radius));
      occ += max(0.0, vn - 0.02 * dist * 0.01) / (vv + 0.0005 * dist * dist + 1e-4) * fall;
    }
    float ao = clamp(1.0 - uIntensity * radius * occ / 8.0, 0.0, 1.0);
    ao = ao * ao;
    gl_FragColor = vec4(ao, d, 0.0, 1.0);
  }
`;

const AO_BLUR_FRAG = /* glsl */ `
  uniform sampler2D tAo;   // r = ao, g = depth
  uniform vec2 uDir;       // texel step
  varying vec2 vUv;
  void main() {
    vec2 c = texture2D(tAo, vUv).rg;
    float sum = c.r, w = 1.0;
    for (int i = 1; i <= 3; i++) {
      for (int s = -1; s <= 1; s += 2) {
        vec2 o = texture2D(tAo, vUv + uDir * float(i * s)).rg;
        float k = exp(-abs(o.g - c.g) * 4000.0) * (1.0 - float(i) / 4.0);
        sum += o.r * k;
        w += k;
      }
    }
    gl_FragColor = vec4(sum / w, c.g, 0.0, 1.0);
  }
`;

const BRIGHT_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tColor, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(c * smoothstep(0.72, 1.1, l), 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 0.227;
    s += (texture2D(tSrc, vUv + uDir * 1.385).rgb + texture2D(tSrc, vUv - uDir * 1.385).rgb) * 0.316;
    s += (texture2D(tSrc, vUv + uDir * 3.231).rgb + texture2D(tSrc, vUv - uDir * 3.231).rgb) * 0.070;
    gl_FragColor = vec4(s, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tAo;
  uniform sampler2D tBloom;
  uniform float uAo;
  uniform float uBloom;
  uniform vec2 uRes;
  varying vec2 vUv;
  vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec3 c = texture2D(tColor, vUv).rgb;
    float ao = texture2D(tAo, vUv).r;
    c *= mix(1.0, ao, uAo);
    c += texture2D(tBloom, vUv).rgb * uBloom;
    vec2 q = vUv - 0.5;
    c *= 1.0 - 0.22 * pow(clamp(length(q * vec2(uRes.x / uRes.y, 1.0)) * 1.15, 0.0, 1.0), 2.4); // vignette
    c = linearToSrgb(clamp(c, 0.0, 1.0));
    c += (hash(vUv * uRes) - 0.5) * (1.6 / 255.0);                                         // fine grain (no banding)
    gl_FragColor = vec4(c, 1.0);
  }
`;

function pass(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false }));
  m.frustumCulled = false;
  return m;
}

export class PostFX {
  private readonly scene: THREE.WebGLRenderTarget;
  private readonly ao: THREE.WebGLRenderTarget;
  private readonly aoTmp: THREE.WebGLRenderTarget;
  private readonly bright: THREE.WebGLRenderTarget;
  private readonly bloomTmp: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly aoPass: THREE.Mesh;
  private readonly aoBlur: THREE.Mesh;
  private readonly brightPass: THREE.Mesh;
  private readonly blurPass: THREE.Mesh;
  private readonly composite: THREE.Mesh;
  private w = 1;
  private h = 1;

  constructor() {
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth, depthBuffer: true });
    const lin = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false } as const;
    this.ao = new THREE.WebGLRenderTarget(1, 1, { ...lin, type: THREE.HalfFloatType });
    this.aoTmp = new THREE.WebGLRenderTarget(1, 1, { ...lin, type: THREE.HalfFloatType });
    this.bright = new THREE.WebGLRenderTarget(1, 1, { ...lin, type: THREE.HalfFloatType });
    this.bloomTmp = new THREE.WebGLRenderTarget(1, 1, { ...lin, type: THREE.HalfFloatType });
    this.aoPass = pass(AO_FRAG, {
      tDepth: { value: depth }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uIntensity: { value: 4.0 },
    });
    this.aoBlur = pass(AO_BLUR_FRAG, { tAo: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.brightPass = pass(BRIGHT_FRAG, { tColor: { value: this.scene.texture } });
    this.blurPass = pass(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.composite = pass(COMPOSITE_FRAG, {
      tColor: { value: this.scene.texture }, tAo: { value: this.ao.texture }, tBloom: { value: this.bright.texture },
      uAo: { value: 0.85 }, uBloom: { value: 0.35 }, uRes: { value: new THREE.Vector2() },
    });
  }

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.scene.setSize(w, h);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.ao.setSize(hw, hh);
    this.aoTmp.setSize(hw, hh);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.bright.setSize(qw, qh);
    this.bloomTmp.setSize(qw, qh);
    (this.composite.material as THREE.ShaderMaterial).uniforms.uRes.value.set(w, h);
  }

  private draw(r: THREE.WebGLRenderer, mesh: THREE.Mesh, target: THREE.WebGLRenderTarget | null): void {
    this.quadScene.children.length = 0;
    this.quadScene.add(mesh);
    r.setRenderTarget(target);
    r.render(this.quadScene, this.quadCam);
  }

  render(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
    const prevAuto = r.autoClear;
    r.setRenderTarget(this.scene);
    r.clear();
    r.render(scene, camera);
    r.autoClear = true;

    const au = (this.aoPass.material as THREE.ShaderMaterial).uniforms;
    au.uProj.value.copy(camera.projectionMatrix);
    au.uInvProj.value.copy(camera.projectionMatrixInverse);
    au.uTexel.value.set(1 / this.w, 1 / this.h);
    au.uAspect.value = this.w / this.h;
    this.draw(r, this.aoPass, this.ao);
    const bu = (this.aoBlur.material as THREE.ShaderMaterial).uniforms;
    bu.tAo.value = this.ao.texture;
    bu.uDir.value.set(1 / this.ao.width, 0);
    this.draw(r, this.aoBlur, this.aoTmp);
    bu.tAo.value = this.aoTmp.texture;
    bu.uDir.value.set(0, 1 / this.ao.height);
    this.draw(r, this.aoBlur, this.ao);

    this.draw(r, this.brightPass, this.bright);
    const gu = (this.blurPass.material as THREE.ShaderMaterial).uniforms;
    for (let k = 0; k < 1; k++) {
      gu.tSrc.value = this.bright.texture;
      gu.uDir.value.set((1 + k) / this.bright.width, 0);
      this.draw(r, this.blurPass, this.bloomTmp);
      gu.tSrc.value = this.bloomTmp.texture;
      gu.uDir.value.set(0, (1 + k) / this.bright.height);
      this.draw(r, this.blurPass, this.bright);
    }

    this.draw(r, this.composite, null);
    r.autoClear = prevAuto;
  }
}
