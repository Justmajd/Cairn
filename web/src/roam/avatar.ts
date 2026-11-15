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
  knee: THREE.Group;
}

/**
 * A whole-body pose: lean (forward, rad), lift (body raised or lowered, m), and per side (left, right)
 * hip and shoulder flexion (+ forward), knee bend (− backward), elbow bend (+), arm spread `shZ`.
 */
interface Pose {
  lean: number;
  lift: number;
  hip: [number, number];
  knee: [number, number];
  sh: [number, number];
  elb: [number, number];
  shZ: number;
}

/** On hands and knees after a fall: torso pitched ~70° forward, thighs upright, shins flat, arms straight down. */
const ALL_FOURS: Pose = { lean: 1.22, lift: 0.24, hip: [1.22, 1.22], knee: [-1.5, -1.5], sh: [1.18, 1.18], elb: [0.3, 0.3], shZ: 0.1 };
/** Flat on the front, braced on the forearms: how a body slides down a slope too steep to rest on. */
const PRONE: Pose = { lean: 1.5, lift: 0, hip: [0.12, 0.06], knee: [-0.3, -0.18], sh: [2.05, 1.95], elb: [1.35, 1.35], shZ: 0.32 };
/** Part way through a topple at lean `th` (rad): arms coming forward to break the fall, knees giving. */
function toppleAt(th: number): Pose {
  const k = Math.min(1, th);
  return { lean: th, lift: 0, hip: [0.55 * k, 0.45 * k], knee: [-0.9 * k, -0.8 * k], sh: [1.35 * k + 0.25 * Math.max(0, th - 1), 1.25 * k], elb: [0.25, 0.25], shZ: 0.15 };
}
/** Taking a sample: down on the right knee, left foot planted, the right hand reaching to the ground. */
function samplePose(p: number): Pose {
  const reach = Math.sin(Math.min(1, p) * Math.PI * 3) * 0.08; // working the scoop
  return { lean: 0.55, lift: 0, hip: [1.4, 0.3], knee: [-1.45, -1.62], sh: [0.75, 1.35 + reach], elb: [0.6, 0.25 + reach], shZ: 0.14 };
}
/** At the suitport: arms up to the hatch rim, pulling in. */
function boardPose(p: number): Pose {
  return { lean: -0.05 - 0.1 * p, lift: 0, hip: [0.05, 0], knee: [-0.1, -0.05], sh: [2.2 + 0.2 * p, 2.25 + 0.2 * p], elb: [0.5 - 0.2 * p, 0.5 - 0.2 * p], shZ: 0.18 };
}
/** Kneeling, sitting back on the heels, hands on the thighs. */
const KNEEL: Pose = { lean: 0.2, lift: -0.36, hip: [0.2, 0.2], knee: [-1.55, -1.55], sh: [0.45, 0.45], elb: [0.7, 0.7], shZ: 0.12 };
/** One knee up (left foot planted), pushing on the raised knee. */
const LUNGE: Pose = { lean: 0.42, lift: -0.34, hip: [1.45, 0.35], knee: [-1.45, -1.6], sh: [0.75, 0.5], elb: [0.6, 0.5], shZ: 0.1 };
/** Standing straight (the walking animation takes over from here). */
const STAND: Pose = { lean: 0.05, lift: 0, hip: [0, 0], knee: [0, 0], sh: [0, 0], elb: [0.35, 0.35], shZ: 0.12 };
/**
 * Seated slide, feet first down a slope of `slopeDeg`: the back about 20° off the slope behind (the
 * pack just clear of it), legs out along the slope downhill, heels digging in, hands back to brake.
 * Angles are worked out from the slope so the body lies on the ground rather than in it.
 */
function slidePose(slopeDeg: number): Pose {
  const slope = (Math.min(60, Math.max(20, slopeDeg)) * Math.PI) / 180;
  const back = Math.max(0.25, Math.PI / 2 - slope - 0.35); // lean back from vertical
  const legs = Math.PI / 2 - slope + back; // thighs along the slope, relative to the torso
  const seat = 0.2; // pelvis height above the ground
  return {
    lean: -back,
    lift: seat - 0.92 * Math.cos(back),
    hip: [legs, legs - 0.08],
    knee: [-0.25, -0.15],
    sh: [-1.0 + back, -0.95 + back],
    elb: [0.2, 0.2],
    shZ: 0.32,
  };
}

const ease = (x: number) => x * x * (3 - 2 * x);
const UP = new THREE.Vector3(0, 1, 0);
const lerpPose = (a: Pose, b: Pose, t: number): Pose => {
  const k = ease(Math.max(0, Math.min(1, t)));
  const m = (x: number, y: number) => x + (y - x) * k;
  const m2 = (x: [number, number], y: [number, number]): [number, number] => [m(x[0], y[0]), m(x[1], y[1])];
  return { lean: m(a.lean, b.lean), lift: m(a.lift, b.lift), hip: m2(a.hip, b.hip), knee: m2(a.knee, b.knee), sh: m2(a.sh, b.sh), elb: m2(a.elb, b.elb), shZ: m(a.shZ, b.shZ) };
};

/** The suited get-up, `u` seconds into its 4.2 s: sit back (1.3 s), one knee up (1.4 s), push to stand (1.5 s). */
function getUp(u: number, from: Pose = ALL_FOURS): Pose {
  if (u < 1.3) return lerpPose(from, KNEEL, u / 1.3);
  if (u < 2.7) return lerpPose(KNEEL, LUNGE, (u - 1.3) / 1.4);
  return lerpPose(LUNGE, STAND, (u - 2.7) / 1.5);
}

/** A woven-fabric bump texture for the suit's outer layer (the thermal micrometeoroid garment). */
function weave(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 4) {
    for (let x = 0; x < 128; x += 4) {
      const over = ((x >> 2) + (y >> 2)) % 2 === 0;
      g.fillStyle = over ? "#9a9a9a" : "#6a6a6a";
      g.fillRect(x, y, 4, 2);
      g.fillStyle = over ? "#727272" : "#949494";
      g.fillRect(x, y + 2, 4, 2);
    }
  }
  // a few seams and soft wrinkles
  g.strokeStyle = "rgba(40,40,40,0.5)";
  g.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo(0, 10 + i * 21);
    g.bezierCurveTo(40, 4 + i * 21, 80, 18 + i * 21, 128, 10 + i * 21);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  return t;
}

/**
 * The astronaut: a planetary surface suit built to real proportions (about 1.9 m with the helmet),
 * after the shapes of current NASA surface-suit designs but not a copy of any one suit: a hard upper
 * torso with shoulder and waist bearings, a soft fabric layer with ribbed joints, a life-support pack,
 * a helmet with a clear bubble, gold sun visor, lamps and a camera, lugged boots and articulated gloves.
 *
 * It is posed by the walking physics.  A pressurised suit is stiff (its joints are held near their
 * neutral angles by ~30 kPa inside), so it does not flop: a fall is a topple, timed as an inverted
 * pendulum in Mars gravity, onto outstretched hands and knees; getting up is the slow suited sequence
 * (sit back on the heels, one knee up, push to stand); a slide on steep ground is seated, feet first,
 * braking with the hands.
 */
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
  private fp = false;
  private readonly suitMat: THREE.MeshPhysicalMaterial;
  private readonly bootMat: THREE.MeshPhysicalMaterial;
  private static readonly CLEAN = new THREE.Color(0xeeebe5);
  private static readonly DUSTY = new THREE.Color(0xbf946c);

  // ---- falls and slides
  /** the topple: lean angle (rad) and its rate, integrated as an inverted pendulum */
  private topple: { th: number; om: number; contactT: number | null; thC: number } | null = null;
  private proneW = 0;
  // ---- small motions and actions
  private breath = 0;
  private turnPhase = 0;
  private lastHeading: number | null = null;
  private action: { kind: "sample" | "board"; progress: number } | null = null;
  private actionW = 0;
  private actionKind: "sample" | "board" = "sample";
  private actionP = 0;
  // ---- smoothing: every joint eases toward its target, so no state change ever snaps
  private readonly smoothQ = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly smoothP = new Map<THREE.Object3D, THREE.Vector3>();
  private offY = 0;
  private smoothInit = false;
  private slideW = 0;
  /** how far the body is posed by a fall or a slide (0 … 1): the visor follows the head by this much */
  private overW = 0;

  /** `accent`: the ID stripes and map marker (EV1 fern, EV2 amber — real crews tell suits apart by stripes). */
  constructor(private readonly g = 3.721, private readonly groundAt: (x: number, z: number) => number = () => 0, accent = 0xc6f432) {
    const bump = weave();
    this.suitMat = new THREE.MeshPhysicalMaterial({ color: Astronaut.CLEAN, roughness: 0.93, sheen: 0.7, sheenRoughness: 0.75, sheenColor: new THREE.Color(0xffffff), bumpMap: bump, bumpScale: 1.2 });
    this.bootMat = this.suitMat.clone();
    const suit = this.suitMat;
    const lower = this.bootMat; // lower legs and boots get dustier first
    const soft = new THREE.MeshPhysicalMaterial({ color: 0xd8d3ca, roughness: 0.95, sheen: 0.5, sheenRoughness: 0.8, bumpMap: bump, bumpScale: 2 }); // bellows
    const hard = new THREE.MeshPhysicalMaterial({ color: 0xf3f1ec, roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.5 }); // composite shells
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.75 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3e3a36, roughness: 0.9 });
    const glove = new THREE.MeshPhysicalMaterial({ color: 0x4a4540, roughness: 0.85, sheen: 0.4, bumpMap: bump, bumpScale: 0.6 });
    const stripe = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.7, emissive: new THREE.Color(accent).multiplyScalar(0.18) });
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xe0a84a, metalness: 0.9, roughness: 0.16, clearcoat: 1, emissive: 0x3a2306 });
    const bubble = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, clearcoat: 1, transparent: true, opacity: 0.14, depthWrite: false });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: 1.3 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.1, metalness: 0.8 });
    const screen = new THREE.MeshStandardMaterial({ color: 0x0d1410, emissive: 0x4fbf6a, emissiveIntensity: 0.6 });
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const ring = (r: number, t: number, mat: THREE.Material, y: number, parent: THREE.Object3D) => mesh(new THREE.TorusGeometry(r, t, 8, 24).rotateX(Math.PI / 2), mat, 0, y, 0, parent);
    /** a limb segment: a tapered fabric tube, ribbed where it bends */
    const segment = (parent: THREE.Object3D, rTop: number, rBot: number, len: number, mat: THREE.Material, ribs = 3) => {
      mesh(new THREE.CylinderGeometry(rTop, rBot, len, 18, 4), mat, 0, -len / 2, 0, parent);
      for (let i = 0; i < ribs; i++) ring(rTop * 1.03, 0.013, soft, -0.035 - i * 0.032, parent);
    };
    this.root.add(this.body);

    // ---- legs: hip bearing → thigh (ID stripe) → knee → lower leg → ankle → boot with a lugged sole
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.12, 0.92, 0);
      mesh(new THREE.SphereGeometry(0.125, 16, 12), soft, 0, 0, 0, hip);
      ring(0.115, 0.02, metal, -0.06, hip); // hip bearing
      segment(hip, 0.12, 0.1, 0.42, suit, 2);
      ring(0.113, 0.02, stripe, -0.22, hip); // EV identification stripe
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      mesh(new THREE.SphereGeometry(0.108, 14, 10), soft, 0, 0, 0, knee);
      mesh(new THREE.SphereGeometry(0.075, 12, 8), hard, 0, 0.01, -0.07, knee).scale.set(1, 1.1, 0.6); // knee pad
      segment(knee, 0.1, 0.09, 0.34, lower, 3);
      ring(0.095, 0.018, metal, -0.34, knee); // ankle bearing
      const boot = new THREE.Group();
      boot.position.set(0, -0.43, 0);
      knee.add(boot);
      mesh(roundedBox(0.19, 0.15, 0.34, 0.06), lower, 0, 0.02, -0.05, boot);
      mesh(roundedBox(0.17, 0.11, 0.14, 0.04), hard, 0, 0.08, 0.04, boot); // heel cup
      mesh(roundedBox(0.2, 0.045, 0.36, 0.018), dark, 0, -0.06, -0.05, boot); // sole
      for (let i = 0; i < 6; i++) mesh(new THREE.BoxGeometry(0.19, 0.02, 0.025), dark, 0, -0.09, 0.1 - i * 0.055, boot); // lugs
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ pivot: hip, knee });
    }
    // ---- brief and waist: soft lower torso, a metal waist bearing, the hard upper torso above
    mesh(new THREE.CapsuleGeometry(0.2, 0.1, 6, 16), suit, 0, 0.98, 0).scale.set(1.2, 1, 0.92);
    ring(0.205, 0.026, metal, 1.08, this.body);
    const hut = new THREE.LatheGeometry([
      new THREE.Vector2(0.2, 0), new THREE.Vector2(0.23, 0.07), new THREE.Vector2(0.26, 0.2), new THREE.Vector2(0.285, 0.32),
      new THREE.Vector2(0.27, 0.4), new THREE.Vector2(0.2, 0.47), new THREE.Vector2(0.13, 0.5), new THREE.Vector2(0.11, 0.51),
    ], 28);
    mesh(hut, hard, 0, 1.08, 0).scale.set(1.15, 1, 0.84);
    mesh(new THREE.BoxGeometry(0.52, 0.045, 0.02), stripe, 0, 1.38, -0.215); // chest band
    // display and control module, with hoses running back to the pack
    const dcm = mesh(roundedBox(0.32, 0.16, 0.11, 0.035), hard, 0, 1.2, -0.285);
    mesh(new THREE.PlaneGeometry(0.17, 0.075), screen, -0.045, 0.02, -0.057, dcm).rotation.y = Math.PI;
    for (const [x, c] of [[0.085, dark], [0.12, metal]] as const) mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.025, 10).rotateX(Math.PI / 2), c, x, 0.025, -0.06, dcm);
    for (const side of [-1, 1]) {
      const hose = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.16, 1.17, -0.27), new THREE.Vector3(side * 0.3, 1.1, -0.18),
        new THREE.Vector3(side * 0.33, 1.12, 0.05), new THREE.Vector3(side * 0.22, 1.2, 0.22),
      ]);
      mesh(new THREE.TubeGeometry(hose, 20, 0.018, 8), dark);
    }
    // ---- life-support pack: shell, lid, lower shroud, handles, vents, rear lights, antenna
    const pack = new THREE.Group();
    pack.position.set(0, 1.3, 0.32);
    this.body.add(pack);
    mesh(roundedBox(0.5, 0.64, 0.26, 0.07), hard, 0, 0, 0, pack);
    mesh(roundedBox(0.46, 0.08, 0.24, 0.03), hard, 0, 0.35, -0.01, pack);
    mesh(roundedBox(0.44, 0.16, 0.2, 0.05), suit, 0, -0.39, -0.02, pack);
    mesh(new THREE.BoxGeometry(0.51, 0.045, 0.265), stripe, 0, 0.2, 0, pack);
    for (let i = 0; i < 5; i++) mesh(new THREE.BoxGeometry(0.3, 0.012, 0.01), dark, 0, -0.08 - i * 0.035, 0.133, pack); // vent
    for (const side of [-1, 1]) {
      const handle = mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 12, Math.PI), metal, side * 0.255, 0.12, 0, pack);
      handle.rotation.set(0, side * Math.PI / 2, Math.PI / 2);
      mesh(new THREE.CircleGeometry(0.018, 10), lamp, side * 0.17, 0.28, 0.132, pack);
    }
    mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 6), metal, 0.19, 0.55, 0.06, pack);
    mesh(new THREE.SphereGeometry(0.016, 8, 6), dark, 0.19, 0.77, 0.06, pack);

    // ---- helmet (its own group: hidden in the visor view, where the camera is inside it)
    const hm = this.helmet;
    this.body.add(hm);
    ring(0.155, 0.032, metal, 1.585, hm); // neck ring
    mesh(new THREE.SphereGeometry(0.11, 14, 12), dark, 0, 1.69, 0.01, hm); // head and comms cap inside
    const shell = mesh(new THREE.SphereGeometry(0.205, 26, 18, 0, Math.PI * 2, 0, Math.PI * 0.6), hard, 0, 1.69, 0.02, hm);
    shell.rotation.x = 0.6; // covers the back and top, open at the face
    const visor = mesh(new THREE.SphereGeometry(0.198, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), gold, 0, 1.69, 0, hm);
    visor.rotation.x = -1.1;
    mesh(new THREE.SphereGeometry(0.19, 26, 18), bubble, 0, 1.69, 0, hm);
    mesh(new THREE.BoxGeometry(0.03, 0.05, 0.3), hard, 0, 1.9, 0.03, hm); // crest rail
    for (const side of [-1, 1]) {
      const box = mesh(roundedBox(0.055, 0.06, 0.1, 0.018), hard, side * 0.205, 1.76, -0.02, hm);
      mesh(new THREE.CircleGeometry(0.02, 14), lamp, 0, 0.005, -0.051, box).rotation.y = Math.PI;
      if (side > 0) mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 10).rotateX(Math.PI / 2), lens, 0, -0.022, -0.055, box); // camera
    }

    // ---- arms: shoulder bearing → upper arm (stripe) → elbow → forearm (wrist checklist) → wrist ring → glove
    for (const side of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(side * 0.34, 1.42, 0);
      mesh(new THREE.SphereGeometry(0.115, 14, 10), soft, 0, 0, 0, sh);
      const bearing = mesh(new THREE.TorusGeometry(0.1, 0.022, 8, 22), metal, side * 0.035, 0, 0, sh);
      bearing.rotation.y = Math.PI / 2;
      segment(sh, 0.095, 0.082, 0.3, suit, 2);
      ring(0.09, 0.016, stripe, -0.16, sh);
      const elbow = new THREE.Group();
      elbow.position.y = -0.32;
      mesh(new THREE.SphereGeometry(0.083, 12, 10), soft, 0, 0, 0, elbow);
      segment(elbow, 0.078, 0.066, 0.25, suit, 3);
      ring(0.07, 0.022, metal, -0.265, elbow); // wrist disconnect
      if (side < 0) mesh(roundedBox(0.09, 0.11, 0.03, 0.01), hard, 0.0, -0.14, -0.075, elbow); // cuff checklist
      const hand = new THREE.Group();
      hand.position.y = -0.3;
      elbow.add(hand);
      mesh(new THREE.CylinderGeometry(0.066, 0.06, 0.06, 14), glove, 0, 0, 0, hand); // gauntlet
      mesh(roundedBox(0.1, 0.1, 0.05, 0.02), glove, 0, -0.08, -0.005, hand); // palm
      for (let f = 0; f < 4; f++) {
        const finger = mesh(new THREE.CapsuleGeometry(0.0125, 0.055, 3, 6), glove, -0.034 + f * 0.023, -0.155, -0.012, hand);
        finger.rotation.x = 0.35; // gloves are stiff: the fingers stay a little curled
      }
      const thumb = mesh(new THREE.CapsuleGeometry(0.014, 0.045, 3, 6), glove, side * -0.055, -0.07, -0.025, hand);
      thumb.rotation.z = side * -0.6;
      sh.add(elbow);
      this.body.add(sh);
      this.arms.push({ pivot: sh, knee: elbow });
    }

    // ---- map marker: a fern ring that keeps a readable size from far away
    this.marker = new THREE.Group();
    const ringM = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false, fog: false }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5, depthTest: false, fog: false }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: accent, depthTest: false, fog: false }));
    nose.position.set(0, 0, -1.6);
    for (const m of [ringM, dot, nose]) m.renderOrder = 30;
    this.marker.add(ringM, dot, nose);
    this.marker.visible = false;
  }

  /** The map marker is its own object: it is scaled to stay readable, the body is not. */
  get mapMarker(): THREE.Group {
    return this.marker;
  }

  /** How much a fall or slide poses the body (0 … 1): the visor camera follows the head by this much. */
  get poseWeight(): number {
    return this.overW;
  }

  /**
   * Pose the suit from the physics: legs swing with the stride phase, both legs tuck in a bound,
   * knees soak up a landing, the body leans into acceleration.  Falls and slides are laid over that.
   */
  update(s: WalkerState, at: V3, dt: number, landed: number, showMarker: boolean): void {
    this.marker.position.copy(at).y += 0.05;
    this.marker.rotation.y = -s.heading;
    this.marker.visible = showMarker;
    this.animate(s, at, dt, landed);
    let over = 0;

    // a fall: the body topples until it really meets the ground (hands first, the belly on a steep drop),
    // settles onto the terrain and tilts with it, slides on down if the ground is too steep to rest on,
    // and only then gets up — all timed against the walker's clock
    if (s.gait === "down") {
      if (!this.topple) this.topple = { th: 0.12, om: Math.min(1.2, Math.hypot(s.vx, s.vy) / 0.3) * 0.35, contactT: null, thC: 0 };
      const t = this.topple;
      const L = 1.0; // centre of mass above the feet (m)
      let pose: Pose;
      let align = 0;
      if (t.contactT === null) {
        t.om += (this.g / L) * Math.sin(t.th) * dt;
        t.th += t.om * dt;
        pose = toppleAt(t.th);
      } else {
        t.contactT += dt;
        this.proneW += Math.sign((s.sliding ? 1 : 0) - this.proneW) * Math.min(Math.abs((s.sliding ? 1 : 0) - this.proneW), dt / 0.5);
        const rest = lerpPose(ALL_FOURS, PRONE, this.proneW);
        const k = Math.min(1, t.contactT / 0.4);
        pose = lerpPose(toppleAt(t.thC), rest, k);
        align = ease(k);
        const u = 4.2 - s.downT; // the last 4.2 s of being down are the get-up
        if (u > 0 && !s.sliding) {
          pose = getUp(u, rest);
          align = 1 - ease(Math.max(0, Math.min(1, (u - 1.3) / 1.4)));
        }
      }
      this.applyPose(pose, 1);
      this.alignToGround(align);
      const hands = this.settle();
      if (t.contactT === null && (hands <= 0.02 || t.th >= 1.55)) {
        t.contactT = 0;
        t.thC = t.th;
      }
      over = 1;
    } else if (this.topple) {
      this.topple = null;
      this.proneW = 0;
    }

    // a slide: seated, feet first downhill, leaning back on the hands
    const goal = s.gait === "slide" ? 1 : 0;
    this.slideW += Math.sign(goal - this.slideW) * Math.min(Math.abs(goal - this.slideW), dt / (goal ? 0.6 : 1.4));
    if (this.slideW > 0.001 && s.gait !== "down") {
      const k = this.slideW * this.slideW * (3 - 2 * this.slideW);
      this.applyPose(slidePose(s.slopeDeg), k);
      over = Math.max(over, k);
    }

    // actions: kneel to take a sample; reach for the suitport's hatch
    const want = this.action && s.gait !== "down" && s.gait !== "slide" ? 1 : 0;
    if (this.action) {
      this.actionKind = this.action.kind;
      this.actionP = this.action.progress;
    }
    this.actionW += Math.sign(want - this.actionW) * Math.min(Math.abs(want - this.actionW), dt / 0.45);
    if (this.actionW > 0.001) {
      const k = ease(this.actionW);
      this.applyPose(this.actionKind === "sample" ? samplePose(this.actionP) : boardPose(this.actionP), k);
      if (this.actionKind === "sample") this.settle(k);
      over = Math.max(over, this.actionKind === "sample" ? k * 0.6 : 0);
    }
    this.overW = over;
    this.smoothJoints(at, dt);
  }

  /** Favouring an injured right ankle: a short, stiff step on that side and a dip onto the good leg. */
  setLimp(on: boolean): void {
    this.limp = on;
  }
  private limp = false;

  /** What the hands are doing at a stop or the rover (null: nothing); `progress` 0 … 1 of the hold. */
  setAction(kind: "sample" | "board" | null, progress = 0): void {
    this.action = kind ? { kind, progress } : null;
  }

  /**
   * Ease every joint from where it was toward where this frame's pose puts it (a time constant of
   * ~70 ms: quick enough for the stride, slow enough that a change of state never snaps).
   */
  private smoothJoints(at: V3, dt: number): void {
    const objs = [this.root, this.body, ...this.legs.flatMap((j) => [j.pivot, j.knee]), ...this.arms.flatMap((j) => [j.pivot, j.knee])];
    const k = 1 - Math.exp(-dt * 14);
    const off = this.root.position.y - at.y;
    if (!this.smoothInit) {
      for (const o of objs) {
        this.smoothQ.set(o, o.quaternion.clone());
        this.smoothP.set(o, o.position.clone());
      }
      this.offY = off;
      this.smoothInit = true;
      return;
    }
    for (const o of objs) {
      const q = this.smoothQ.get(o)!;
      q.slerp(o.quaternion, k);
      o.quaternion.copy(q);
      if (o !== this.root) {
        const p = this.smoothP.get(o)!;
        p.lerp(o.position, k);
        o.position.copy(p);
      }
    }
    this.offY += (off - this.offY) * k;
    this.root.position.y = at.y + this.offY;
  }

  /** Tilt the whole body (about the feet) to the slope under it, by `a` (0 upright … 1 on the slope). */
  private alignToGround(a: number): void {
    if (a <= 0.001) return;
    this.root.updateMatrixWorld(true);
    const c = this.body.localToWorld(new THREE.Vector3(0, 0.6, -0.5));
    const e = 0.6;
    const dx = (this.groundAt(c.x + e, c.z) - this.groundAt(c.x - e, c.z)) / (2 * e);
    const dz = (this.groundAt(c.x, c.z + e) - this.groundAt(c.x, c.z - e)) / (2 * e);
    const n = new THREE.Vector3(-dx, 1, -dz).normalize();
    const tilt = new THREE.Quaternion().setFromUnitVectors(UP, n);
    this.root.quaternion.premultiply(new THREE.Quaternion().slerp(tilt, a));
  }

  /**
   * Rest the body on the terrain: whichever contact point (fingertips, knees, toes, heels, elbows, chest,
   * helmet, pack) is lowest relative to the ground under it decides the height, so nothing floats and
   * nothing sinks.  Returns how far the hands are above the ground afterwards (m).
   */
  private settle(weight = 1): number {
    this.root.updateMatrixWorld(true);
    const pts: [THREE.Object3D, number, number, number, boolean][] = [];
    for (const a of this.arms) pts.push([a.knee, 0, -0.47, 0, true], [a.knee, 0, 0, 0.06, false]);
    for (const l of this.legs) pts.push([l.knee, 0, 0.01, -0.12, false], [l.knee, 0, -0.51, -0.2, false], [l.knee, 0, -0.51, 0.1, false]);
    pts.push([this.body, 0, 1.25, -0.34, false], [this.body, 0, 1.7, -0.21, false], [this.body, 0, 1.55, 0.47, false], [this.body, 0, 0.82, 0.12, false]);
    let low = Infinity;
    let hand = Infinity;
    const v = new THREE.Vector3();
    for (const [o, x, y, z, isHand] of pts) {
      o.localToWorld(v.set(x, y, z));
      const clear = v.y - this.groundAt(v.x, v.z);
      low = Math.min(low, clear);
      if (isHand) hand = Math.min(hand, clear);
    }
    if (Number.isFinite(low)) this.root.position.y -= low * weight;
    return hand - low;
  }

  /** Blend the current joint angles toward a pose by `w`. */
  private applyPose(p: Pose, w: number): void {
    const mix = (a: number, b: number) => a + (b - a) * w;
    this.lean = mix(this.lean, p.lean);
    this.body.rotation.set(-this.lean, 0, 0);
    this.body.position.set(0, mix(this.body.position.y, p.lift), 0);
    this.legs.forEach((l, i) => {
      l.pivot.rotation.x = mix(l.pivot.rotation.x, p.hip[i]);
      l.knee.rotation.x = mix(l.knee.rotation.x, p.knee[i]);
    });
    this.arms.forEach((a, i) => {
      a.pivot.rotation.x = mix(a.pivot.rotation.x, p.sh[i]);
      a.pivot.rotation.z = mix(a.pivot.rotation.z, (i === 0 ? -1 : 1) * p.shZ);
      a.knee.rotation.x = mix(a.knee.rotation.x, p.elb[i]);
    });
  }

  /** The walking animation. */
  private animate(s: WalkerState, at: V3, dt: number, landed: number): void {
    this.root.position.copy(at);
    this.root.rotation.set(0, -s.heading, 0);
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
    // breathing: a slow rise and fall of the chest, the arms drifting with it
    this.breath += dt * ((14 + Math.min(30, Math.max(0, s.effortW - 100) * 0.045)) / 60) * Math.PI * 2;
    const br = Math.sin(this.breath);
    // turning on the spot: small shuffling steps
    let dh = this.lastHeading === null ? 0 : s.heading - this.lastHeading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.lastHeading = s.heading;
    const turning = s.gait === "stand" && Math.abs(dh) / Math.max(dt, 1e-3) > 0.5;
    if (s.gait === "stand") {
      // keep stepping while turning; when the turn stops, finish the step under way, then stand
      if (turning || Math.abs(Math.sin(this.turnPhase)) > 0.08) this.turnPhase += dt * 7;
      else this.turnPhase = 0;
      hipA = Math.sin(this.turnPhase) * 0.16;
      hipB = -hipA;
      kneeA = Math.max(0, Math.sin(this.turnPhase - 0.9)) * 0.3;
      kneeB = Math.max(0, Math.sin(this.turnPhase + Math.PI - 0.9)) * 0.3;
      arm = 0.03 * br;
      crouch += 0.006 * (1 + br);
    }
    if (s.gait === "walk") {
      hipA = Math.sin(ph) * 0.42 * k;
      hipB = -hipA;
      kneeA = Math.max(0, Math.sin(ph - 0.9)) * 0.7 * k;
      kneeB = Math.max(0, Math.sin(ph + Math.PI - 0.9)) * 0.7 * k;
      arm = Math.sin(ph) * 0.3 * k;
    } else if (s.gait === "air" || s.gait === "lope") {
      // a bound: lead leg forward, trailing leg back, knees bent; tucked tighter in a jump
      const jump = s.air?.jump ?? false;
      // rising: legs tucked; coming down: legs reach for the ground, arms out for balance
      const falling = s.gait === "air" && s.vz < 0;
      const tuck = (jump ? 0.75 : 0.45) * (falling ? 0.45 : 1);
      const stride = jump ? (falling ? 0.28 : 0.15) : 0.38 * Math.min(1, speed / 1.6);
      hipA = stride;
      hipB = -stride * 0.6 + (falling && jump ? 0.2 : 0);
      kneeA = tuck;
      kneeB = tuck * 1.2;
      arm = jump ? (falling ? -0.15 : -0.5) : 0.25;
      if (s.gait === "lope") crouch += 0.06;
    }
    if (this.limp && s.gait === "walk") {
      hipB *= 0.55;
      kneeB *= 0.25;
      crouch += Math.max(0, Math.sin(ph)) * 0.05; // the body drops onto the good leg
    }
    const legs: [number, number][] = [[hipA, kneeA], [hipB, kneeB]];
    this.legs.forEach((l, i) => {
      l.pivot.rotation.set(legs[i][0] + legs[i][1] * 0.35, 0, 0);
      l.knee.rotation.set(-legs[i][1], 0, 0); // knees bend backward
    });
    this.arms.forEach((a, i) => {
      if (this.fp) {
        // seen from inside the helmet: a pressurised suit holds the arms a little forward and out, so
        // the gloves come into view at the bottom when you glance down; they still swing with the stride
        a.pivot.rotation.set(0.45 + (i === 0 ? arm : -arm) * 0.35, 0, (i === 0 ? -1 : 1) * 0.22);
        a.knee.rotation.set(0.95, 0, 0);
        return;
      }
      a.pivot.rotation.set(i === 0 ? arm : -arm, 0, (i === 0 ? -1 : 1) * (s.gait === "air" ? 0.35 : 0.12));
      a.knee.rotation.set(0.35 + Math.abs(arm) * 0.4, 0, 0); // elbows bend forward
    });
    const leanGoal = (s.gait === "lope" || s.gait === "air" ? 0.22 * Math.min(1, speed / 2) : 0.08 * k) + (s.gait === "stand" ? 0.012 * br : 0);
    this.lean += (leanGoal - this.lean) * Math.min(1, dt * 4);
    this.body.rotation.set(-this.lean, 0, 0);
    this.body.position.set(0, -crouch, 0);
  }

  /** Mars dust clings to the suit: a little with every step, a lot from a fall or a slide (0 clean … 1 caked). */
  addDust(amount: number): void {
    this.dust = Math.min(1, this.dust + amount);
    this.suitMat.color.copy(Astronaut.CLEAN).lerp(Astronaut.DUSTY, this.dust * 0.6);
    this.bootMat.color.copy(Astronaut.CLEAN).lerp(Astronaut.DUSTY, Math.min(1, this.dust * 1.6 + 0.08));
  }

  /** Visor view: the camera is inside the helmet; only the arms stay in view. */
  firstPerson(on: boolean): void {
    this.fp = on;
    // the torso, pack and legs would surround the camera (a real suit hides them too — the helmet is
    // fixed and you cannot look down at your chest)
    const arms = new Set<THREE.Object3D>(this.arms.map((a) => a.pivot));
    for (const c of this.body.children) c.visible = !on || arms.has(c);
  }

  /** Where the eyes are (world), following the body's lean, crouch, falls and tumbles. */
  eyeWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.body.localToWorld(out.set(0, 1.71, -0.1));
  }

  /** The middle of the body (world): what the 3D camera looks at, standing, fallen or sliding. */
  centreWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.body.localToWorld(out.set(0, 1.1, 0));
  }

  /** Which way the face points (world): for the visor camera while tumbling. */
  faceWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    const q = new THREE.Quaternion();
    this.body.getWorldQuaternion(q);
    return out.set(0, -0.25, -1).normalize().applyQuaternion(q);
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
