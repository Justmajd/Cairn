import * as THREE from "three";
import type { WalkerState } from "../eva/walker";
import { roundedBox } from "../scene/models";

/**
 * What free roam adds to the scene: an articulated astronaut animated from the walking physics,
 * a soft shadow on the ground under it, boot prints pressed into the regolith, kicked-up dust and a
 * breadcrumb trail for the map.  World coordinates: X east, Y up, Z south (see SceneView.toWorld).
 */

type V3 = THREE.Vector3;

interface Joint {
  pivot: THREE.Group;
  knee?: THREE.Group;
}

export class Astronaut {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly legs: Joint[] = [];
  private readonly arms: Joint[] = [];
  private readonly marker: THREE.Group;
  private readonly helmet = new THREE.Group();
  private landDip = 0;
  private lean = 0;
  private dust = 0;
  private readonly suitMat = new THREE.MeshStandardMaterial({ color: 0xefebe4, roughness: 0.85 });
  private static readonly CLEAN = new THREE.Color(0xefebe4);
  private static readonly DUSTY = new THREE.Color(0xc39a74);

  constructor() {
    // suit fabric picks up dust as you walk (see addDust)
    const suit = this.suitMat;
    const soft = new THREE.MeshStandardMaterial({ color: 0xd9d5cd, roughness: 0.9 }); // bellows at the joints
    const hard = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.45, metalness: 0.05 }); // composite shells
    const metal = new THREE.MeshStandardMaterial({ color: 0xb4b8be, roughness: 0.32, metalness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x45413d, roughness: 0.85 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xc6f432, roughness: 0.6, emissive: 0x2a3608 });
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xe0a84a, metalness: 0.9, roughness: 0.18, clearcoat: 1, emissive: 0x3a2306 });
    const bubble = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.16, depthWrite: false });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: 1.2 });
    const screen = new THREE.MeshStandardMaterial({ color: 0x0d1410, emissive: 0x4fbf6a, emissiveIntensity: 0.6 });
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    /** a limb segment: tapered tube with a ribbed bellows joint at its top */
    const segment = (parent: THREE.Object3D, rTop: number, rBot: number, len: number, mat: THREE.Material) => {
      mesh(new THREE.CylinderGeometry(rTop, rBot, len, 14), mat, 0, -len / 2, 0, parent);
      for (let i = 0; i < 3; i++) mesh(new THREE.TorusGeometry(rTop * 1.02, 0.012, 6, 16).rotateX(Math.PI / 2), soft, 0, -0.03 - i * 0.03, 0, parent);
    };
    this.root.add(this.body);

    // legs: hip bearing → thigh → knee → lower leg → boot with a thick sole
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.12, 0.92, 0);
      mesh(new THREE.SphereGeometry(0.115, 14, 10), soft, 0, 0, 0, hip);
      segment(hip, 0.11, 0.095, 0.42, suit);
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      mesh(new THREE.SphereGeometry(0.1, 12, 10), soft, 0, 0, 0, knee);
      segment(knee, 0.095, 0.085, 0.36, suit);
      mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 14), metal, 0, -0.36, 0, knee); // ankle bearing
      const boot = mesh(roundedBox(0.17, 0.13, 0.32, 0.05), hard, 0, -0.43, -0.055, knee);
      mesh(roundedBox(0.18, 0.04, 0.33, 0.015), dark, 0, -0.065, 0, boot);
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ pivot: hip, knee });
    }
    // brief and waist: a soft lower torso, a metal waist bearing
    mesh(new THREE.SphereGeometry(0.21, 16, 12), suit, 0, 0.95, 0).scale.set(1.18, 0.8, 0.9);
    mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 24).rotateX(Math.PI / 2), metal, 0, 1.06, 0);
    // hard upper torso: a lathe-turned shell, wider at the shoulders
    const hut = new THREE.LatheGeometry([
      new THREE.Vector2(0.19, 0), new THREE.Vector2(0.22, 0.08), new THREE.Vector2(0.25, 0.22), new THREE.Vector2(0.27, 0.34),
      new THREE.Vector2(0.24, 0.43), new THREE.Vector2(0.14, 0.49), new THREE.Vector2(0.1, 0.5),
    ], 24);
    mesh(hut, hard, 0, 1.06, 0).scale.set(1.12, 1, 0.82);
    mesh(new THREE.BoxGeometry(0.5, 0.05, 0.02), stripe, 0, 1.36, -0.205); // chest band
    // display and control module on the chest
    const dcm = mesh(roundedBox(0.3, 0.15, 0.1, 0.03), hard, 0, 1.2, -0.27);
    mesh(new THREE.PlaneGeometry(0.16, 0.07), screen, -0.04, 0.02, -0.052, dcm).rotation.y = Math.PI;
    for (const x of [0.08, 0.11]) mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.02, 8).rotateX(Math.PI / 2), dark, x, 0.02, -0.055, dcm);
    // portable life-support system (backpack) with an antenna and a stripe
    const pack = mesh(roundedBox(0.48, 0.62, 0.24, 0.06), hard, 0, 1.3, 0.3);
    mesh(new THREE.BoxGeometry(0.49, 0.05, 0.245), stripe, 0, 0.2, 0, pack);
    mesh(roundedBox(0.36, 0.14, 0.06, 0.02), dark, 0, -0.16, 0.13, pack);
    mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 6), metal, 0.18, 0.47, 0.05, pack);
    // neck ring and helmet: a clear bubble over the head, a gold sun visor half down, two lamps
    // (the helmet is its own group: in the visor view the camera is inside it, so it is hidden there)
    const hm = this.helmet;
    this.body.add(hm);
    mesh(new THREE.TorusGeometry(0.15, 0.03, 8, 24).rotateX(Math.PI / 2), metal, 0, 1.57, 0, hm);
    mesh(new THREE.SphereGeometry(0.11, 14, 12), dark, 0, 1.69, 0.01, hm); // head and comms cap inside
    const shell = mesh(new THREE.SphereGeometry(0.2, 22, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), hard, 0, 1.69, 0.015, hm);
    shell.rotation.x = 0.55; // covers the back and top, open at the face
    const visor = mesh(new THREE.SphereGeometry(0.195, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), gold, 0, 1.69, 0, hm);
    visor.rotation.x = -1.1;
    mesh(new THREE.SphereGeometry(0.19, 22, 16), bubble, 0, 1.69, 0, hm);
    for (const side of [-1, 1]) {
      const lampBox = mesh(roundedBox(0.05, 0.05, 0.08, 0.015), hard, side * 0.2, 1.76, -0.02, hm);
      mesh(new THREE.CircleGeometry(0.018, 12), lamp, 0, 0, -0.041, lampBox).rotation.y = Math.PI;
    }
    // arms: shoulder bearing → upper arm → elbow → forearm → wrist ring → glove
    for (const side of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(side * 0.33, 1.42, 0);
      mesh(new THREE.SphereGeometry(0.105, 12, 10), soft, 0, 0, 0, sh);
      segment(sh, 0.085, 0.075, 0.3, suit);
      const elbow = new THREE.Group();
      elbow.position.y = -0.32;
      mesh(new THREE.SphereGeometry(0.075, 10, 8), soft, 0, 0, 0, elbow);
      segment(elbow, 0.072, 0.06, 0.26, suit);
      mesh(new THREE.TorusGeometry(0.062, 0.016, 8, 16).rotateX(Math.PI / 2), metal, 0, -0.27, 0, elbow);
      const glove = mesh(roundedBox(0.09, 0.13, 0.06, 0.025), dark, 0, -0.35, -0.01, elbow);
      mesh(roundedBox(0.03, 0.06, 0.03, 0.012), dark, side * -0.05, 0.02, -0.02, glove);
      sh.add(elbow);
      this.body.add(sh);
      this.arms.push({ pivot: sh, knee: elbow });
    }
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = false;
    });

    // map marker: a fern ring that keeps a readable size from far away
    this.marker = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc6f432, transparent: true, opacity: 0.95, depthTest: false, fog: false }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc6f432, transparent: true, opacity: 0.5, depthTest: false, fog: false }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc6f432, depthTest: false, fog: false }));
    nose.position.set(0, 0, -1.6);
    for (const m of [ring, dot, nose]) m.renderOrder = 30;
    this.marker.add(ring, dot, nose);
    this.marker.visible = false;
  }

  /** The map marker is its own object: it is scaled to stay readable, the body is not. */
  get mapMarker(): THREE.Group {
    return this.marker;
  }

  /**
   * Pose the suit from the physics: legs swing with the stride phase, both legs tuck in a bound,
   * knees soak up a landing, the body leans into acceleration, and a fall lays it on the ground.
   */
  update(s: WalkerState, at: V3, dt: number, landed: number, showMarker: boolean): void {
    this.root.position.copy(at);
    this.root.rotation.y = -s.heading;
    this.marker.position.copy(at).y += 0.05;
    this.marker.rotation.y = -s.heading;
    this.marker.visible = showMarker;
    if (landed > 0) this.landDip = Math.min(0.22, landed * 0.06);
    this.landDip = Math.max(0, this.landDip - dt * 0.6);

    const speed = Math.hypot(s.vx, s.vy);
    const ph = s.phase;
    let hipA = 0;
    let hipB = 0;
    let kneeA = 0;
    let kneeB = 0;
    let arm = 0;
    let crouch = this.landDip;
    const k = Math.min(1, speed / 0.9);
    if (s.gait === "walk") {
      hipA = Math.sin(ph) * 0.42 * k;
      hipB = -hipA;
      kneeA = Math.max(0, Math.sin(ph - 0.9)) * 0.7 * k;
      kneeB = Math.max(0, Math.sin(ph + Math.PI - 0.9)) * 0.7 * k;
      arm = Math.sin(ph) * 0.3 * k;
    } else if (s.gait === "air" || s.gait === "lope") {
      // a bound: lead leg forward, trailing leg back, knees bent; tucked tighter in a jump
      const jump = s.air?.jump ?? false;
      const tuck = jump ? 0.75 : 0.45;
      const stride = jump ? 0.15 : 0.38 * Math.min(1, speed / 1.6);
      hipA = stride;
      hipB = -stride * 0.6;
      kneeA = tuck;
      kneeB = tuck * 1.2;
      arm = jump ? -0.5 : 0.25;
      if (s.gait === "lope") crouch += 0.06;
    } else if (s.gait === "slide") {
      hipA = 0.5;
      hipB = 0.3;
      kneeA = 0.8;
      kneeB = 0.9;
      crouch += 0.2;
      arm = -0.7;
    }
    const legs: [number, number][] = [[hipA, kneeA], [hipB, kneeB]];
    this.legs.forEach((l, i) => {
      l.pivot.rotation.x = -legs[i][0] + legs[i][1] * 0.35;
      l.knee!.rotation.x = -legs[i][1]; // knees bend backward
    });
    this.arms.forEach((a, i) => {
      if (this.fp && s.gait !== "down") {
        // seen from inside the helmet: a pressurised suit holds the arms a little forward and out, so
        // the gloves come into view at the bottom when you glance down; they still swing with the stride
        a.pivot.rotation.x = 0.45 + (i === 0 ? arm : -arm) * 0.35;
        a.pivot.rotation.z = (i === 0 ? -1 : 1) * 0.22;
        a.knee!.rotation.x = 0.95;
        return;
      }
      a.pivot.rotation.x = i === 0 ? arm : -arm;
      a.pivot.rotation.z = (i === 0 ? -1 : 1) * (s.gait === "air" ? 0.35 : 0.12);
      a.knee!.rotation.x = 0.35 + Math.abs(arm) * 0.4; // elbows bend forward
    });
    // lean into the motion; flat on the ground after a fall
    const leanGoal = s.gait === "down" ? -1.35 : s.gait === "lope" || s.gait === "air" ? 0.22 * Math.min(1, speed / 2) : 0.08 * k;
    this.lean += (leanGoal - this.lean) * Math.min(1, dt * (s.gait === "down" ? 6 : 4));
    this.body.rotation.x = -this.lean;
    this.body.position.y = -crouch * (s.gait === "down" ? 0 : 1) + (s.gait === "down" ? 0.25 : 0);
  }

  /** Mars dust clings to the suit: a little with every step, a lot from a fall or a slide (0 clean … 1 caked). */
  addDust(amount: number): void {
    this.dust = Math.min(1, this.dust + amount);
    this.suitMat.color.copy(Astronaut.CLEAN).lerp(Astronaut.DUSTY, this.dust * 0.75);
  }

  /** Visor view: the camera is inside the helmet, so the helmet is hidden; the rest of the body stays. */
  firstPerson(on: boolean): void {
    this.fp = on;
    // from inside the helmet only the arms are in view: the torso, pack and legs would surround the
    // camera (a real suit hides them too — the helmet is fixed and you cannot look down at your chest)
    const arms = new Set<THREE.Object3D>(this.arms.map((a) => a.pivot));
    for (const c of this.body.children) c.visible = !on || arms.has(c);
  }
  private fp = false;

  /** Where the eyes are (world), following the body's lean, crouch and falls. */
  eyeWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.body.localToWorld(out.set(0, 1.71, -0.1));
  }

  /** Eye height above the feet this frame (crouches and falls lower it). */
  eyeHeight(): number {
    return 1.67 - this.landDip * 0.9 + (this.lean < -0.5 ? -1.1 : 0);
  }
}

/** A soft dark ellipse on the ground below the astronaut, cast away from the Sun: it stays down when you jump. */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  constructor() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, "rgba(0,0,0,0.55)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.mesh.renderOrder = 2;
  }

  place(feet: V3, groundY: number, sunDir: V3): void {
    const h = Math.max(0, feet.y - groundY);
    const el = Math.max(0.12, sunDir.y);
    const len = (0.9 + h) / Math.tan(Math.asin(Math.min(0.999, el))); // body ~0.9 m to its centre
    const away = new THREE.Vector2(-sunDir.x, -sunDir.z);
    if (away.lengthSq() > 1e-6) away.normalize();
    const reach = Math.min(6, len * 0.5);
    this.mesh.position.set(feet.x + away.x * reach, groundY + 0.03, feet.z + away.y * reach);
    this.mesh.rotation.y = Math.atan2(away.x, away.y);
    const fade = 1 / (1 + h * 0.8);
    this.mesh.scale.set(0.8 + h * 0.15, 1, Math.max(0.9, Math.min(5, 0.9 + len * 0.6)));
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = fade * (sunDir.y > 0 ? 1 : 0.2);
  }
}

/** Boot prints: a ring buffer of instanced decals laid on the ground, tilted to its slope. */
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private count = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tint = new THREE.Color();

  constructor(private readonly max = 700) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    // sole outline with tread bars: toe, ball, arch gap, heel
    const bar = (y: number, w: number) => g.fillRect(32 - w / 2, y, w, 7);
    for (let y = 8; y < 60; y += 11) bar(y, 46 - Math.abs(y - 30) * 0.5);
    for (let y = 82; y < 122; y += 11) bar(y, 38);
    g.fillRect(26, 62, 12, 18);
    const tex = new THREE.CanvasTexture(c);
    // pressed regolith is darker than the dusty surface: a dark, translucent print (the shading of the
    // ground underneath still shows through)
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x2e2119, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 0.33).rotateX(-Math.PI / 2), mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  }

  /** `pos` world point on the ground, `heading` clockwise from north, `normal` the ground normal; deeper in sand. */
  add(pos: V3, heading: number, normal: V3, sand: number): void {
    const yaw = new THREE.Quaternion().setFromAxisAngle(this.up, -heading);
    this.q.setFromUnitVectors(this.up, normal).multiply(yaw);
    this.m.compose(pos.clone().add(normal.clone().multiplyScalar(0.015)), this.q, new THREE.Vector3(1, 1, 1));
    this.mesh.setMatrixAt(this.next, this.m);
    // loose sand keeps a deeper, darker print than firm ground
    const d = 1.25 - sand * 0.6;
    this.mesh.setColorAt(this.next, this.tint.setRGB(d, d, d));
    this.next = (this.next + 1) % this.max;
    this.count = Math.min(this.max, this.count + 1);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

interface Grain {
  p: V3;
  v: V3;
  life: number;
  fine: boolean;
}

/**
 * Dust kicked up by the boots.  Coarse grains fly in clean ballistic arcs (Mars' air is too thin to
 * slow them); the fine fraction is caught by the thin air and settles slowly, leaving a brief haze.
 */
export class Dust {
  readonly points: THREE.Points;
  private readonly grains: Grain[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;

  constructor(private readonly g: number, private readonly groundAt: (x: number, z: number) => number, private readonly max = 900) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d")!;
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 15);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    const mat = new THREE.PointsMaterial({ size: 0.06, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    geo.setDrawRange(0, 0);
  }

  /** A puff at a footfall: `power` 1 for a step, more for a landing; `vel` the walker's velocity (world). */
  kick(at: V3, vel: V3, power: number, sand: number): void {
    const n = Math.round((6 + sand * 10) * power);
    for (let i = 0; i < n && this.grains.length < this.max; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = (0.2 + Math.random() * 0.7) * Math.sqrt(power);
      const fine = Math.random() < 0.45;
      this.grains.push({
        p: at.clone().add(new THREE.Vector3(Math.cos(a) * 0.08, 0.03, Math.sin(a) * 0.08)),
        v: new THREE.Vector3(Math.cos(a) * out + vel.x * 0.35, (0.4 + Math.random() * 1.1) * Math.sqrt(power), Math.sin(a) * out + vel.z * 0.35),
        life: fine ? 2.5 + Math.random() * 2.5 : 3,
        fine,
      });
    }
  }

  get active(): boolean {
    return this.grains.length > 0;
  }

  update(dt: number): void {
    const gs = this.grains;
    for (let i = gs.length - 1; i >= 0; i--) {
      const q = gs[i];
      q.life -= dt;
      if (q.fine) {
        // fine dust: drag in the thin air, settling at a slow terminal speed
        const k = Math.max(0, 1 - dt * 2.2);
        q.v.x *= k;
        q.v.z *= k;
        q.v.y = q.v.y * k - this.g * 0.12 * dt;
      } else q.v.y -= this.g * dt;
      q.p.addScaledVector(q.v, dt);
      const ground = this.groundAt(q.p.x, q.p.z);
      if (q.life <= 0 || (q.p.y < ground && !q.fine) || q.p.y < ground - 0.05) gs.splice(i, 1);
    }
    for (let i = 0; i < gs.length; i++) {
      const q = gs[i];
      this.pos.set([q.p.x, q.p.y, q.p.z], i * 3);
      const a = q.fine ? Math.min(0.35, q.life * 0.12) : Math.min(0.9, q.life);
      this.col.set(q.fine ? [0.78, 0.6, 0.45, a] : [0.55, 0.4, 0.3, a], i * 4);
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, gs.length);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}

/** The way walked, for the map: a line that grows every couple of metres. */
export class Trail {
  readonly line: THREE.Line;
  private readonly pos: Float32Array;
  private n = 0;
  private last: V3 | null = null;

  constructor(private readonly max = 6000) {
    this.pos = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xc6f432, transparent: true, opacity: 0.85, depthTest: false, fog: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 25;
  }

  push(p: V3): void {
    if (this.last && this.last.distanceToSquared(p) < 4) return;
    if (this.n >= this.max) {
      this.pos.copyWithin(0, 3);
      this.n--;
    }
    this.pos.set([p.x, p.y + 0.4, p.z], this.n * 3);
    this.n++;
    this.last = p.clone();
    const geo = this.line.geometry;
    geo.setDrawRange(0, this.n);
    geo.attributes.position.needsUpdate = true;
  }
}
