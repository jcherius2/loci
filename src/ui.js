// Flat UI pieces drawn on cached canvas textures: panels and pinchable buttons.
import * as THREE from '../vendor/three.module.min.js';

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const PX = 1600; // canvas pixels per metre
const CACHE_MAX = 96;
const cache = new Map();

/** Greedy word wrap; "\n" forces a line break. */
export function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const probe = line ? line + ' ' + word : word;
      if (line && ctx.measureText(probe).width > maxW) { out.push(line); line = word; } else line = probe;
    }
    out.push(line);
  }
  return out;
}

/** Centre a text block on (cx, cy), shrinking the font until it fits maxW x maxH. */
export function fitText(ctx, text, cx, cy, maxW, maxH, size, color = '#ffffff', weight = 700) {
  let lines;
  for (; ; size -= 3) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    lines = wrap(ctx, text, maxW);
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    if ((lines.length * size * 1.22 <= maxH && widest <= maxW) || size <= 16) break;
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = size * 1.22, y0 = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, y0 + i * lh));
}

/** Rounded rectangle filling the whole canvas, with a border. */
export function box(ctx, w, h, r, fill, stroke, lw = 6) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(lw / 2, lw / 2, w - lw, h - lw, r); else ctx.rect(lw / 2, lw / 2, w - lw, h - lw);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

export function texture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function cached(key, w, h, draw) {
  let t = cache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = Math.round(w * PX);
  c.height = Math.round(h * PX);
  draw(c.getContext('2d'), c.width, c.height);
  t = texture(c);
  cache.set(key, t);
  if (cache.size > CACHE_MAX) { // drop the oldest; three re-uploads it if it is still shown
    const [oldKey, old] = cache.entries().next().value;
    old.dispose();
    cache.delete(oldKey);
  }
  return t;
}

const material = () => new THREE.MeshBasicMaterial({ alphaTest: 0.5 });

function swap(mesh, tex) {
  const first = !mesh.material.map;
  mesh.material.map = tex;
  if (first) mesh.material.needsUpdate = true;
}

/** Read-only text panel. panel.setText(text) swaps in a cached texture. */
export function makePanel(w, h) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material());
  mesh.setText = text => swap(mesh, cached(`p|${w}|${h}|${text}`, w, h, (ctx, W, H) => {
    box(ctx, W, H, 28, '#0b1626', '#5ee6ff', 5);
    fitText(ctx, text, W / 2, H / 2, W - 44, H - 28, 46);
  }));
  return mesh;
}

/**
 * Pinchable / touchable button. userData carries what main.js needs for hit tests:
 * half extents (hw, hh), the handler, and per-hand "armed" flags for fingertip touch.
 */
export function makeButton(label, w, h, bg, onSelect, round = false) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material());
  mesh.userData = { kind: 'button', hw: w / 2, hh: h / 2, onSelect, label: null, last: -1e9, armed: {}, hot: false };
  mesh.setLabel = text => {
    if (text === mesh.userData.label) return;
    mesh.userData.label = text;
    swap(mesh, cached(`b|${w}|${h}|${bg}|${round}|${text}`, w, h, (ctx, W, H) => {
      box(ctx, W, H, round ? H / 2 : H * 0.24, bg, '#ffffff', 5);
      fitText(ctx, text, W / 2, H / 2, W - (round ? 30 : 24), H - 14, Math.round(H * 0.44));
    }));
  };
  mesh.setLabel(label);
  return mesh;
}
