import * as THREE from "three";

/**
 * Hand-built models: the crew's pressurised rover (the shelter), the stone cairns that mark the
 * stops, and shared shape helpers.  Built from primitives (no model files to download), at real size:
 * metres, Y up, the rover's front toward +X.
 */

/** A box with rounded edges and corners (an extruded rounded rectangle with a bevel). */
export function roundedBox(w: number, h: number, d: number, r: number, segments = 3): THREE.BufferGeometry {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  // a rectangle shrunk by r, extruded and bevelled by r: the result is w × h × d with round edges
  const x = -w / 2 + r;
  const y = -h / 2 + r;
  const rect = new THREE.Shape([new THREE.Vector2(x, y), new THREE.Vector2(-x, y), new THREE.Vector2(-x, -y), new THREE.Vector2(x, -y)]);
  const geo = new THREE.ExtrudeGeometry(rect, { depth: Math.max(1e-3, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: segments, curveSegments: segments });
  geo.translate(0, 0, -Math.max(1e-3, d - 2 * r) / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Deterministic pseudo-random numbers (so every cairn keeps its shape between visits). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A weathered stone: an icosphere pushed in and out, flattened, with facets. */
function stone(r: number, flat: number, rand: () => number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // the same random push for vertices at the same place, so the surface stays closed
  const pushes = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    let k = pushes.get(key);
    if (k === undefined) {
      k = 0.82 + rand() * 0.3;
      pushes.set(key, k);
    }
    v.multiplyScalar(k);
    v.y *= flat;
    if (v.y < -r * flat * 0.55) v.y = -r * flat * 0.55; // a flat underside to sit on
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.rotation.y = rand() * Math.PI * 2;
  return m;
}

/**
 * A cairn: flat stones stacked by hand, the largest at the bottom, about 1.1 m tall.
 * Planned stops (`active`) carry a survey flag in the interface accent.
 */
export function makeCairn(active: boolean, seed: number): THREE.Group {
  const rand = rng(seed);
  const g = new THREE.Group();
  const tones = active ? [0xd9b896, 0xc9a57f, 0xe2c4a2, 0xb98f6c] : [0x9a8d80, 0x8a7d71, 0xa59789, 0x7f736a];
  const mats = tones.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true }));
  // a few loose stones around the foot
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2;
    const d = 0.75 + rand() * 0.45;
    const s = stone(0.12 + rand() * 0.12, 0.6, rand, mats[i % mats.length]);
    s.position.set(Math.cos(a) * d, 0.04, Math.sin(a) * d);
    g.add(s);
  }
  let y = 0;
  const layers = 5 + Math.floor(rand() * 2);
  for (let i = 0; i < layers; i++) {
    const r = 0.58 * (1 - i / (layers + 1.2)) + rand() * 0.05;
    const flat = 0.36 + rand() * 0.14;
    const s = stone(r, flat, rand, mats[Math.floor(rand() * mats.length)]);
    const h = r * flat * 1.25;
    s.position.set((rand() - 0.5) * 0.08, y + h * 0.48, (rand() - 0.5) * 0.08);
    s.rotation.z = (rand() - 0.5) * 0.12;
    s.rotation.x = (rand() - 0.5) * 0.12;
    g.add(s);
    y += h * 0.92;
  }
  if (active) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 6), new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.6, roughness: 0.4 }));
    pole.position.set(0.12, y + 0.55, 0);
    pole.rotation.z = -0.05;
    const cloth = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.34, -0.09), new THREE.Vector2(0, -0.2)]);
    const flag = new THREE.Mesh(new THREE.ShapeGeometry(cloth), new THREE.MeshStandardMaterial({ color: 0xc6f432, emissive: 0x3a4a0c, roughness: 0.7, side: THREE.DoubleSide }));
    flag.position.set(0.13, y + 1.18, 0);
    g.add(pole, flag);
  }
  return g;
}

/**
 * The crew's portable radio relay: a 2.5 m telescopic mast on a tripod with a small UHF antenna and a
 * beacon light on top (the planner's RELAY_MAST_M; a demo assumption, not a specific product).
 */
export function makeRelayMast(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xd4d7db, metalness: 0.7, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.3, roughness: 0.6 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.95, 6), metal);
    leg.position.set(Math.cos(a) * 0.3, 0.42, Math.sin(a) * 0.3);
    leg.rotation.set(Math.sin(a) * 0.38, 0, -Math.cos(a) * 0.38);
    g.add(leg);
  }
  const box = new THREE.Mesh(roundedBox(0.22, 0.16, 0.14, 0.02), dark);
  box.position.y = 0.82;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, 1.75, 8), metal);
  pole.position.y = 1.62;
  const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.42, 5), dark);
  whip.position.y = 2.7;
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshStandardMaterial({ color: 0xc6f432, emissive: 0xc6f432, emissiveIntensity: 1.4 }));
  beacon.position.y = 2.5;
  g.add(box, pole, whip, beacon);
  return g;
}

/** A survey flag on a thin wire, planted where the crew logged a find. */
export function makeSurveyFlag(color = 0x9fb4c6): THREE.Group {
  const g = new THREE.Group();
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.75, 5), new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.6, roughness: 0.4 }));
  wire.position.y = 0.37;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.11), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.8, side: THREE.DoubleSide }));
  cloth.position.set(0.085, 0.68, 0);
  g.add(wire, cloth);
  return g;
}

/**
 * The crew's pressurised rover, about 6 m long: a rounded cabin on a six-wheeled chassis, a raked
 * windscreen at the front (+X), two suitports on the rear wall (the crew climb into their suits from
 * inside, so no airlock), a radiator and a high-gain antenna on the roof, lights.  Not a specific
 * vehicle: a generic small pressurised rover of the kind NASA studies for Mars.
 */
export function makeRover(): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.5, metalness: 0.05 });
  const panel = new THREE.MeshStandardMaterial({ color: 0xcfcdc8, roughness: 0.6 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.7, metalness: 0.4 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x2b2a29, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xa9adb3, roughness: 0.35, metalness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a232b, roughness: 0.12, metalness: 0.85, side: THREE.DoubleSide });
  const accent = new THREE.MeshStandardMaterial({ color: 0xc6f432, emissive: 0x2a3608, roughness: 0.5 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: 1.4 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  // cabin: a side profile with a raked nose, extruded across the width and rounded off
  const L = 5.6;
  const W = 2.5;
  const prof = new THREE.Shape();
  prof.moveTo(-L / 2, 0);
  prof.lineTo(L / 2 - 0.2, 0);
  prof.quadraticCurveTo(L / 2 + 0.25, 0.05, L / 2 + 0.25, 0.55);
  prof.lineTo(L / 2 - 0.55, 1.75); // windscreen rake
  prof.quadraticCurveTo(L / 2 - 0.85, 1.95, L / 2 - 1.3, 1.95);
  prof.lineTo(-L / 2 + 0.35, 1.95);
  prof.quadraticCurveTo(-L / 2, 1.95, -L / 2, 1.6);
  prof.lineTo(-L / 2, 0);
  const cabinGeo = new THREE.ExtrudeGeometry(prof, { depth: W - 0.5, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.22, bevelSegments: 4, curveSegments: 10 });
  cabinGeo.translate(0, 0, -(W - 0.5) / 2);
  cabinGeo.computeVertexNormals();
  add(cabinGeo, hull, 0, 1.15, 0);

  // windscreen and side windows
  // the windscreen lies on the raked nose (1.2 m up over 0.8 m back)
  add(new THREE.PlaneGeometry(W - 0.4, 1.3).rotateY(Math.PI / 2).rotateZ(Math.atan2(0.8, 1.2)), glass, 2.86, 2.43, 0);
  for (const side of [-1, 1]) {
    for (const x of [1.2, -0.15]) add(new THREE.BoxGeometry(0.95, 0.5, 0.03), glass, x, 2.5, side * (W / 2 + 0.01));
    // the accent stripe along each side
    add(new THREE.BoxGeometry(L - 0.4, 0.07, 0.02), accent, -0.1, 1.72, side * (W / 2 + 0.05));
    // fenders over the wheels
    for (const x of [-1.9, 0, 1.9]) {
      const f = add(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 18, 1, true, Math.PI * 0.08, Math.PI * 0.84), panel, x, 0.62, side * (W / 2 - 0.05));
      f.rotation.x = Math.PI / 2;
      f.rotation.y = Math.PI / 2;
      (f.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    }
  }

  // rear wall: two suitports (round hatches with a suit's backpack docked in each)
  for (const z of [-0.6, 0.6]) {
    const ring = add(new THREE.TorusGeometry(0.42, 0.06, 10, 28), metal, -L / 2 - 0.26, 2.05, z);
    ring.rotation.y = Math.PI / 2;
    const hatch = add(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 28), panel, -L / 2 - 0.25, 2.05, z);
    hatch.rotation.z = Math.PI / 2;
    add(roundedBox(0.18, 0.55, 0.46, 0.06), hull, -L / 2 - 0.36, 2.02, z); // the parked suit's backpack
  }
  // rear porch and step
  add(new THREE.BoxGeometry(0.7, 0.06, 2.0), frame, -L / 2 - 0.6, 1.2, 0);
  add(new THREE.BoxGeometry(0.45, 0.05, 1.2), frame, -L / 2 - 0.8, 0.62, 0);

  // roof: radiator panel, antenna mast with a dish, a light bar
  add(roundedBox(2.6, 0.08, 1.9, 0.03), panel, -0.75, 3.38, 0);
  for (let i = 0; i < 9; i++) add(new THREE.BoxGeometry(2.4, 0.015, 0.03), frame, -0.75, 3.43, -0.85 + i * 0.21);
  add(new THREE.CylinderGeometry(0.04, 0.05, 1.1, 8), metal, -2.2, 3.85, 0.75);
  const dish = add(new THREE.SphereGeometry(0.42, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.32), metal, -2.2, 4.42, 0.75);
  dish.rotation.set(-0.9, 0.6, 0);
  (dish.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  add(new THREE.BoxGeometry(0.2, 0.08, 1.6), frame, 1.05, 3.36, 0);
  for (const z of [-0.6, -0.2, 0.2, 0.6]) add(new THREE.BoxGeometry(0.06, 0.06, 0.18), lamp, 1.16, 3.36, z);
  // headlights in the nose
  for (const z of [-0.8, 0.8]) add(new THREE.BoxGeometry(0.06, 0.16, 0.42), lamp, L / 2 + 0.47, 1.55, z);

  // chassis rails and six wheels on rocker arms
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(L - 0.2, 0.22, 0.16), frame, 0, 0.98, side * (W / 2 - 0.25));
    for (const x of [-1.9, 0, 1.9]) {
      const z = side * (W / 2 + 0.05);
      const t = add(new THREE.CylinderGeometry(0.58, 0.58, 0.42, 24), tire, x, 0.58, z);
      t.rotation.x = Math.PI / 2;
      // chevron tread: thin bars around the tyre
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const bar = add(new THREE.BoxGeometry(0.07, 0.035, 0.4), tire, x + Math.cos(a) * 0.59, 0.58 + Math.sin(a) * 0.59, z);
        bar.rotation.z = a;
      }
      const hub = add(new THREE.CylinderGeometry(0.3, 0.3, 0.44, 18), metal, x, 0.58, z);
      hub.rotation.x = Math.PI / 2;
      const arm = add(new THREE.BoxGeometry(0.14, 0.5, 0.1), frame, x, 0.8, side * (W / 2 - 0.2));
      arm.rotation.z = x === 0 ? 0 : x > 0 ? -0.35 : 0.35;
    }
  }
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.userData.poiMarker = true;
  });
  return g;
}

/** Half-length and half-width of the rover's footprint (m), for walking into it. */
export const ROVER_HALF = { x: 3.3, z: 1.55 };

/**
 * A soft Mars environment for reflections on the models: butterscotch sky above, dark ochre ground
 * below.  Without it metal and the gold visor reflect nothing and render black.
 */
export function marsEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const colors: number[] = [];
  const p = geo.attributes.position;
  const sky = new THREE.Color(0xd9b48c);
  const horizon = new THREE.Color(0xc79a74);
  const ground = new THREE.Color(0x5a3c2a);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 10;
    if (y >= 0) c.copy(horizon).lerp(sky, Math.pow(y, 0.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -y * 3));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.04).texture;
  pmrem.dispose();
  geo.dispose();
  return tex;
}
