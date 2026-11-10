// WebXR session and input. Only standard API: select events for the pinch,
// targetRaySpace / gripSpace for poses, and hand joints when inputSource.hand exists.
import * as THREE from '../vendor/three.module.min.js';

// All optional: the session must work when none of these is granted.
export const FEATURES = ['local-floor', 'hand-tracking', 'anchors'];
const MAX_JOINTS = 50;
const V = () => new THREE.Vector3();
const quat = new THREE.Quaternion(), a = V(), b = V(), mat = new THREE.Matrix4();

/** One pinch-capable input: a hand, a controller, or the mouse in demo mode. */
export class Pointer {
  constructor(src) {
    this.src = src;
    this.handed = src ? src.handedness : 'none';
    this.origin = V();            // ray origin
    this.dir = V().set(0, 0, -1); // ray direction
    this.tip = V();               // pinch point (between thumb and index, or the grip)
    this.index = V();             // index fingertip, for touching buttons
    this.wrist = V();
    this.palm = { pos: V(), normal: V(), valid: false };
    this.valid = false;
    this.isHand = false;
    this.pinching = false;
    this.down = false;            // pinch started this frame
    this.up = false;              // pinch ended this frame
    this.lost = false;
    this.gap = 0;                 // thumb tip to index tip (m), 0 when unknown
    // Interaction state, owned by main.js.
    this.stale = 0;               // frames a held card has had no valid, pinching hand
    this.gap0 = 0;                // finger gap when the card was grabbed
    this.hover = null;
    this.hit = false;
    this.direct = false;
    this.point = V();
    this.grab = null;
    this.offset = V();
    this.start = V();
    this.dist0 = 0;
    this.hand0 = 1;
  }
}

export class XR {
  constructor(renderer) {
    this.renderer = renderer;
    this.session = null;
    this.refSpace = null;
    this.pointers = new Map(); // XRInputSource -> Pointer
    this.list = [];            // pointers to process this frame
    this.head = { pos: V(), quat: new THREE.Quaternion(), valid: false };
    this.opaque = true;        // false in passthrough
    this.floor = false;        // true when the origin is on the floor
    this.anchorsOk = false;
    this.features = [];
    this.onEnd = null;
    // Joint dots, drawn only when the real hands are not visible (VR).
    this.jointMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.007, 6, 4), new THREE.MeshBasicMaterial({ color: 0x9fdcf0 }), MAX_JOINTS);
    this.jointMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.jointMesh.frustumCulled = false;
    this.jointMesh.count = 0;
  }

  static async modes() {
    const xr = navigator.xr;
    if (!xr || !xr.isSessionSupported) return { ar: false, vr: false };
    const ask = mode => xr.isSessionSupported(mode).catch(() => false);
    return { ar: await ask('immersive-ar'), vr: await ask('immersive-vr') };
  }

  async enter(mode) {
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: FEATURES });
    let type = 'local-floor';
    try { await session.requestReferenceSpace(type); } catch { type = 'local'; }
    this.renderer.xr.setReferenceSpaceType(type);
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.refSpace = this.renderer.xr.getReferenceSpace();
    // Headset recentred: main.js lays the UI out again.
    this.refSpace.addEventListener('reset', () => this.onReset && this.onReset());
    this.floor = type === 'local-floor';
    this.features = Array.from(session.enabledFeatures || []);
    this.anchorsOk = this.features.includes('anchors');
    this.opaque = session.environmentBlendMode ? session.environmentBlendMode === 'opaque' : mode !== 'immersive-ar';
    this.head.valid = false;
    session.addEventListener('selectstart', e => { const p = this.pointer(e.inputSource); p.pinching = true; p.down = true; });
    session.addEventListener('selectend', e => { const p = this.pointer(e.inputSource); p.pinching = false; p.up = true; });
    session.addEventListener('inputsourceschange', e => {
      for (const src of e.removed) { const p = this.pointers.get(src); if (p) this.lose(p); }
    });
    session.addEventListener('end', () => {
      this.session = null;
      this.refSpace = null;
      this.jointMesh.count = 0;
      const all = [...this.pointers.values()];
      all.forEach(p => this.lose(p));
      this.pointers.clear();
      this.list.length = 0;
      if (this.onEnd) this.onEnd(all);
    });
  }

  pointer(src) {
    let p = this.pointers.get(src);
    if (!p) this.pointers.set(src, (p = new Pointer(src)));
    return p;
  }

  /** A vanished input releases whatever it held, as if the pinch had ended. */
  lose(p) {
    p.lost = true;
    p.valid = false;
    p.up = p.pinching || !!p.grab;
    p.pinching = false;
  }

  /** Read head and input poses for this frame. */
  update(frame) {
    const ref = this.refSpace, list = this.list;
    list.length = 0;
    this.joints = 0;
    const view = frame.getViewerPose(ref);
    if (view) {
      this.head.pos.copy(view.transform.position);
      this.head.quat.copy(view.transform.orientation);
      this.head.valid = true;
    }
    for (const p of this.pointers.values()) if (p.lost) list.push(p);
    for (const src of this.session.inputSources) {
      if (src.targetRayMode === 'screen' || !src.targetRaySpace) continue;
      const p = this.pointer(src), ray = frame.getPose(src.targetRaySpace, ref);
      list.push(p);
      p.isHand = false;
      p.palm.valid = false;
      p.gap = 0;
      if (src.hand && frame.getJointPose) {
        try { this.readHand(frame, src, p, ref); } catch { p.isHand = false; }
      }
      // Joints tracked but no aim ray: aim from the head through the fingers.
      p.valid = !!ray || (p.isHand && this.head.valid);
      if (!p.valid) continue;
      if (ray) {
        p.origin.copy(ray.transform.position);
        p.dir.set(0, 0, -1).applyQuaternion(quat.copy(ray.transform.orientation)).normalize();
      } else {
        p.origin.copy(p.tip);
        p.dir.copy(p.tip).sub(this.head.pos).normalize();
      }
      if (!p.isHand) {
        const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
        p.tip.copy(grip ? grip.transform.position : p.origin);
        p.wrist.copy(p.tip);
      }
    }
    this.jointMesh.count = this.joints;
    this.jointMesh.instanceMatrix.needsUpdate = true;
  }

  readHand(frame, src, p, ref) {
    const joint = name => { const s = src.hand.get(name); return s ? frame.getJointPose(s, ref) : null; };
    const tip = joint('index-finger-tip'), thumb = joint('thumb-tip');
    if (!tip) return;
    p.isHand = true;
    p.index.copy(tip.transform.position);
    p.tip.copy(p.index);
    if (thumb) {
      p.tip.add(thumb.transform.position).multiplyScalar(0.5);
      p.gap = 2 * p.tip.distanceTo(p.index); // tip is the midpoint of thumb and index
    }
    const wrist = joint('wrist'), idx = joint('index-finger-metacarpal'), pinky = joint('pinky-finger-metacarpal');
    if (wrist && idx && pinky) {
      p.wrist.copy(wrist.transform.position);
      a.copy(idx.transform.position).sub(p.wrist);
      b.copy(pinky.transform.position).sub(p.wrist);
      // Palm normal from three joints; the cross product flips with handedness.
      p.palm.normal.crossVectors(b, a).normalize();
      if (p.handed === 'right') p.palm.normal.negate();
      p.palm.pos.copy(a).add(b).multiplyScalar(0.5).add(p.wrist);
      p.palm.valid = true;
    } else p.wrist.copy(p.tip);
    if (!this.opaque) return;
    for (const space of src.hand.values()) {
      if (this.joints >= MAX_JOINTS) break;
      const pose = frame.getJointPose(space, ref);
      if (!pose) continue;
      const t = pose.transform.position;
      this.jointMesh.setMatrixAt(this.joints++, mat.makeTranslation(t.x, t.y, t.z));
    }
  }

  /** Ask for an anchor at a world position; calls done(anchor) if the runtime gives one. */
  anchor(frame, pos, done) {
    if (!this.anchorsOk || !frame || typeof frame.createAnchor !== 'function' || typeof XRRigidTransform === 'undefined') return;
    try {
      frame.createAnchor(new XRRigidTransform({ x: pos.x, y: pos.y, z: pos.z, w: 1 }), this.refSpace).then(done, () => {});
    } catch { /* anchors are a bonus */ }
  }

  /** Follow an anchor (drift correction), ignoring implausible jumps. */
  anchorPos(frame, anchor, out) {
    try {
      if (!frame.trackedAnchors || !frame.trackedAnchors.has(anchor)) return;
      const pose = frame.getPose(anchor.anchorSpace, this.refSpace);
      if (pose && a.copy(pose.transform.position).distanceTo(out) < 0.5) out.copy(a);
    } catch { /* keep the stored position */ }
  }

  endFrame() {
    for (const [src, p] of this.pointers) {
      p.down = p.up = false;
      if (p.lost) this.pointers.delete(src);
    }
  }
}
