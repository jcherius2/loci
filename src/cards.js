// A card is one textured quad (one draw call). Its two faces are two canvases swapped mid-flip.
import * as THREE from '../vendor/three.module.min.js';
import { box, fitText, texture, FONT } from './ui.js';

export const CARD_W = 0.24, CARD_H = 0.15;
const W = 512, H = 320;
const GEO = new THREE.PlaneGeometry(CARD_W, CARD_H);
const FLIP_S = 0.28;

const canvasTexture = () => {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return texture(c);
};

export class Card {
  /** data: {q, a}; st: the persisted scheduling record from srs.js (shared reference). */
  constructor(data, index, st) {
    this.id = 'c' + index;
    this.q = data.q;
    this.a = data.a;
    this.st = st;
    this.placed = st.pos != null;
    this.held = false;   // currently pinched
    this.hot = false;    // hovered this frame
    this.dim = false;    // not due (Walk mode)
    this.focus = false;  // revealed: grows with distance so far cards stay readable
    this.anchor = null;  // XRAnchor, when the session provides one
    this.face = 'q';     // face we are turning to: 'q' question only, 'a' question + answer
    this.shown = 'q';
    this.anim = 1;
    this.size = 1;
    this.bump = 0;
    this.tex = { q: canvasTexture(), a: canvasTexture() };
    this.mesh = new THREE.Mesh(GEO, new THREE.MeshBasicMaterial({ map: this.tex.q, alphaTest: 0.5 }));
    this.mesh.userData = { card: this, hw: CARD_W / 2, hh: CARD_H / 2 };
    this.redraw();
  }

  /** Repaint both faces (route number and Leitner box change over time). */
  redraw() {
    for (const f of ['q', 'a']) {
      const tex = this.tex[f], ctx = tex.image.getContext('2d'), edge = f === 'q' ? '#5ee6ff' : '#ffd166';
      ctx.clearRect(0, 0, W, H);
      box(ctx, W, H, 28, '#0f1b2d', edge, 8);
      if (f === 'q') fitText(ctx, this.q, W / 2, H / 2 + 16, W - 64, H - 120, 56);
      else {
        fitText(ctx, this.q, W / 2, 84, W - 200, 52, 30, '#9fdcf0', 600);
        ctx.fillStyle = edge;
        ctx.fillRect(64, 120, W - 128, 3);
        fitText(ctx, this.a, W / 2, 214, W - 64, 156, 46);
      }
      if (this.st.order) {
        ctx.beginPath();
        ctx.arc(50, 50, 28, 0, Math.PI * 2);
        ctx.fillStyle = edge;
        ctx.fill();
        fitText(ctx, String(this.st.order), 50, 52, 50, 44, 34, '#0f1b2d', 800);
      }
      ctx.font = `600 22px ${FONT}`;
      ctx.fillStyle = '#b8c7d9';
      ctx.textAlign = 'right';
      ctx.fillText(this.placed ? `box ${this.st.box}/5` : 'new', W - 30, 46);
      tex.needsUpdate = true;
    }
  }

  flipTo(face) {
    if (face === this.face) return;
    this.face = face;
    this.anim = 0;
  }

  /** Brief grow, as visual confirmation of an action. */
  pulse() { this.bump = 0.25; }

  update(dt, head) {
    const m = this.mesh;
    if (this.anim < 1) {
      this.anim = Math.min(1, this.anim + dt / FLIP_S);
      if (this.anim >= 0.5 && this.shown !== this.face) {
        this.shown = this.face;
        m.material.map = this.tex[this.face];
      }
    }
    const target = this.focus ? THREE.MathUtils.clamp(m.position.distanceTo(head) / 0.6, 1, 3.5) : 1;
    const k = Math.min(1, dt * 10);
    this.size += (target - this.size) * k;
    this.bump -= this.bump * k;
    const s = this.size * (1 + this.bump) * (this.hot ? 1.05 : 1);
    m.lookAt(head);
    m.scale.set(s * Math.max(0.03, Math.abs(Math.cos(Math.PI * this.anim))), s, s);
    m.material.color.setScalar(this.hot ? 1 : this.dim ? 0.42 : 0.9);
  }

  dispose() {
    this.tex.q.dispose();
    this.tex.a.dispose();
    this.mesh.material.dispose();
  }
}

/** The route: one thin line through the pinned cards, in pinning order. */
export class Route {
  constructor(max = 16) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, 0);
    // Opaque, drawn first and without depth write, so cards always cover the thread.
    this.line = new THREE.Line(this.geo, new THREE.LineBasicMaterial({ color: 0x2f8ea6, depthWrite: false }));
    this.line.renderOrder = -1;
    this.line.frustumCulled = false;
  }

  update(cards) {
    const stops = cards.filter(c => c.placed).sort((a, b) => a.st.order - b.st.order).slice(0, this.max);
    stops.forEach((c, i) => c.mesh.position.toArray(this.pos, i * 3));
    this.geo.setDrawRange(0, stops.length);
    this.geo.attributes.position.needsUpdate = true;
  }
}
