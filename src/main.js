// Loci: app state, modes (Today / Place / Walk / Decks), and the pinch / ray / touch interaction.
import * as THREE from '../vendor/three.module.min.js';
import * as srs from './srs.js';
import { BUILTIN, loadDeckParam, validateDeck } from './decks.js';
import { XR, Pointer } from './xr.js';
import { Card, Route, CARD_H } from './cards.js';
import { makeButton, makePanel } from './ui.js';
import { play, unlock, suspendAudio } from './audio.js';

const $ = id => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const params = new URLSearchParams(location.search);
// ?dayOffset=2 pretends it is two days later (to try the "come back" flow).
const today = () => srs.dayNumber() + (parseInt(params.get('dayOffset'), 10) || 0);
let store = null;
try { store = localStorage; } catch { /* storage blocked: play without saving */ }
const state = srs.load(store);
const S = state.settings;
const save = () => srs.save(store, state);

const TOUCH_R = 0.07;    // direct pinch: fingertips within 7 cm of a target 
const POKE_Z = 0.015;    // fingertip touch: within 1.5 cm of a button face
const COOLDOWN = 700;    // ms before the same button can fire again
const DWELL = 300;       // ms a fingertip must rest on a button before it fires (no accidental brush)
const PINCH_OPEN = 0.07; // thumb and index tips this far apart (and 3 cm wider than at the grab): pinch over
const STALE = 15;        // frames with no valid, pinching hand before a held card is released
const DECKS_KEY = 'loci.decks.v1', MAX_SAVED = 1; // the last imported deck, kept without its link
const BG = 0x0b1220;

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(BG, 1);
renderer.xr.enabled = true;
const el = renderer.domElement;
$('stage').appendChild(el);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 30);
camera.rotation.order = 'YXZ';
camera.position.set(0, 1.25, 0); // seated eye height for the mouse demo
camera.rotation.x = -0.32;       // looking slightly down, at the pile
const decor = new THREE.GridHelper(8, 16, 0x2f6f88, 0x1c3346); // the "simple decor" when there is no passthrough
scene.add(decor);
const xr = new XR(renderer);
scene.add(xr.jointMesh);
const route = new Route();
scene.add(route.line);

function resize() {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- app state ----------
let decks = [], deck = null, cards = [];
let mode = 'place';      // 'today' | 'place' | 'walk' | 'decks'
let active = null;       // card currently revealed in Walk
let pileTop = null;      // only the top card of the pile can be taken
let tut = S.tutorialDone ? 3 : 0; // tutorial step: 0 pinch, 1 move, 2 release, 3 done
let demo = false, running = false, needsHome = true, menuPalm = false;
let xrMode = null, frame = null, flash = '', hudText = '', looking = false, last = 0;
let reachBtn, handBtn, away = 0;
const head = new THREE.Vector3(0, 1.25, 0);
const home = { pos: new THREE.Vector3(0, 1.25, 0), fwd: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

/** A point relative to where the user sat down: right, up (from eye level), forward (scaled by reach). */
const local = (r, u, f, out) => out.copy(home.pos).addScaledVector(home.right, r).addScaledVector(home.fwd, f * S.reach).setY(home.pos.y + u);

// ---------- UI objects ----------
const targets = []; // every pinchable button (cards are probed separately)
const add = (o, parent = scene) => { parent.add(o); if (o.userData.kind) targets.push(o); return o; };
const BLUE = '#1d4f7c', GREEN = '#1b7a48', AMBER = '#9a4a00';
const hud = add(makePanel(0.42, 0.15));
const hudBtn = [
  add(makeButton('Walk', 0.19, 0.07, GREEN, () => setMode('walk'))),
  add(makeButton('Place', 0.19, 0.07, BLUE, () => setMode('place'))),
];
const gradeBtn = [
  add(makeButton('Knew it', 0.16, 0.08, GREEN, () => grade(true))),
  add(makeButton('Not yet', 0.16, 0.08, AMBER, () => grade(false))),
];
const menu = new THREE.Group();
menu.visible = false;
scene.add(menu);
[['Place', () => setMode('place')], ['Walk', () => setMode('walk')], ['Decks', () => setMode('decks')], ['Exit', () => exit()], ['Recenter palace', () => recenter()]]
  .forEach(([label, fn], i) => {
    const b = add(makeButton(label, i > 3 ? 0.177 : 0.085, 0.05, BLUE, () => { menu.visible = false; fn(); }), menu);
    b.position.set(i > 3 ? 0 : i % 2 ? 0.046 : -0.046, 0.056 - (i >> 1) * 0.056, 0);
  });
// Menu discs: one always in the same place (dock), one riding the menu-hand wrist.
const dock = add(makeButton('Menu', 0.07, 0.07, '#3d3f7a', () => toggleMenu(dock), true));
const wristOrb = add(makeButton('menu', 0.055, 0.055, '#3d3f7a', () => toggleMenu(wristOrb), true));
wristOrb.visible = false;
const deckPanel = new THREE.Group();
deckPanel.visible = false;
scene.add(deckPanel);
const marker = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.034, 10), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
marker.rotation.x = Math.PI; // points down at the next due stop
marker.visible = false;
scene.add(marker);
const faceHead = [hud, ...hudBtn, ...gradeBtn, menu, dock, wristOrb, deckPanel];
const dotGeo = new THREE.SphereGeometry(0.006, 8, 6), dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const rays = [0, 1].map(() => {
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
  const r = { line, cursor: new THREE.Mesh(dotGeo, dotMat), tip: new THREE.Mesh(dotGeo, dotMat) };
  line.frustumCulled = false;
  for (const o of Object.values(r)) { o.visible = false; scene.add(o); }
  return r;
});

function buildDecks() {
  const row = i => 0.19 - i * 0.064, n = decks.length;
  decks.forEach((d, i) => {
    d.button = add(makeButton(d.title, 0.37, 0.056, BLUE, () => loadDeck(d)), deckPanel);
    d.button.position.y = row(i);
  });
  reachBtn = add(makeButton('Reach', 0.18, 0.056, '#3d3f7a', () => {
    S.reach = srs.REACH[(srs.REACH.indexOf(S.reach) + 2) % 3]; // normal -> near -> far
    save(); layout(); refreshDecks();
  }), deckPanel);
  handBtn = add(makeButton('Menu hand', 0.18, 0.056, '#3d3f7a', () => {
    S.menuHand = S.menuHand === 'left' ? 'right' : 'left';
    save(); refreshDecks();
  }), deckPanel);
  reachBtn.position.set(-0.095, row(n), 0);
  handBtn.position.set(0.095, row(n), 0);
  add(makeButton('Back', 0.37, 0.056, '#4a5568', () => setMode(startMode())), deckPanel).position.y = row(n + 1);
}

function refreshDecks() {
  for (const d of decks) {
    const all = Object.values((state.decks[d.id] || { cards: {} }).cards);
    d.button.setLabel(`${d === deck ? '> ' : ''}${d.title} · ${all.filter(c => c.pos).length}/${d.cards.length}`);
  }
  reachBtn.setLabel('Reach: ' + ['near', 'normal', 'far'][srs.REACH.indexOf(S.reach)]);
  handBtn.setLabel(`Menu: ${S.menuHand} wrist`);
}

// ---------- layout ----------
function setHome(pos, quat) {
  home.pos.copy(pos);
  home.fwd.set(0, 0, -1).applyQuaternion(quat).setY(0);
  if (home.fwd.lengthSq() < 0.01) home.fwd.set(0, 0, -1);
  home.fwd.normalize();
  home.right.set(-home.fwd.z, 0, home.fwd.x);
  needsHome = false;
  layout();
}

function layout() {
  local(0, -0.12, 0.56, hud.position); // below the line of sight
  local(-0.105, -0.235, 0.55, hudBtn[0].position);
  local(0.105, -0.235, 0.55, hudBtn[1].position);
  local(-0.23, -0.3, 0.36, dock.position);
  local(0, -0.1, 0.5, deckPanel.position);
  restack();
}

/** Unpinned cards wait in a small fanned pile in front of the user. */
function restack() {
  let k = 0;
  pileTop = null;
  for (const c of cards) {
    if (c.placed || c.held) continue;
    if (!k) pileTop = c;
    local(k * 0.005, -0.3 + k * 0.003, 0.42, c.mesh.position).addScaledVector(home.fwd, k * 0.012);
    k++;
  }
}

// ---------- decks and modes ----------
const startMode = () => (cards.some(c => c.placed) ? 'today' : 'place');
const nextDueCard = () => cards.filter(c => srs.isDue(c.st, today())).sort((a, b) => a.st.order - b.st.order)[0] || null;

function loadDeck(d) {
  for (const c of cards) { scene.remove(c.mesh); c.dispose(); }
  deck = d;
  state.deck = d.id;
  cards = d.cards.map((data, i) => new Card(data, i, srs.cardState(state, d.id, 'c' + i)));
  for (const c of cards) {
    scene.add(c.mesh);
    if (c.placed) c.mesh.position.fromArray(c.st.pos);
  }
  restack();
  route.update(cards);
  save();
  setMode(startMode());
}

function setMode(m) {
  if (m === 'walk' && !cards.some(c => c.placed)) { m = 'place'; flash = 'Pin at least one card first.'; }
  mode = m;
  active = null;
  const t = today();
  for (const c of cards) {
    c.mesh.visible = m !== 'decks' && (c.placed || m !== 'walk');
    c.flipTo(m === 'place' ? 'a' : 'q'); // Place shows question + answer, to study while pinning
    c.focus = false;
    c.dim = m === 'walk' && !srs.isDue(c.st, t);
  }
  deckPanel.visible = m === 'decks';
  hud.visible = route.line.visible = m !== 'decks';
  hudBtn.forEach(b => { b.visible = m === 'today'; });
  if (m === 'decks') refreshDecks();
  showGrade();
  refreshHud();
}

function refreshHud() {
  const t = today(), n = cards.length, pinned = cards.filter(c => c.placed).length;
  const due = srs.dueCount(state, deck.id, t), streak = plural(srs.currentStreak(state, t), 'day'), V = demo ? 'Click' : 'Pinch';
  let s = flash;
  flash = '';
  if (s) { /* one-off message */ }
  else if (mode === 'today') s = `Today · ${deck.title}\n${plural(due, 'card')} due · streak ${streak}`;
  else if (mode === 'place') {
    s = [`1/3  ${V} a card from the pile below`, '2/3  Keep holding. Move it somewhere you will remember', '3/3  Release to pin it there'][tut]
      || (pinned < n ? `Place · ${pinned}/${n} pinned\n${V}, move, release. Then Menu > Walk` : `All pinned.\n${V} the Menu disc > Walk`);
  } else if (mode === 'walk') {
    const next = nextDueCard(), gap = (srs.nextDue(state, deck.id) || t) - t;
    if (active) s = srs.isDue(active.st, t) ? 'Did you know it?' : `Not due yet (box ${active.st.box}).\n${V} it again to hide`;
    else if (next) s = `Walk · ${due} due\n${V} stop ${next.st.order} to reveal the answer`;
    else s = `All caught up · streak ${streak}\nNext review ${gap <= 1 ? 'tomorrow' : `in ${gap} days`}`;
  }
  hudText = s;
  hud.setText(s);
  hudBtn[0].setLabel(`Walk (${due})`);
  const next = mode === 'walk' && !active ? nextDueCard() : null;
  marker.visible = !!next;
  if (next) marker.position.copy(next.mesh.position).y += CARD_H / 2 + 0.035;
}

function homeSummary() {
  const t = today();
  $('today').textContent = srs.totalPlaced(state)
    ? `Today: ${plural(srs.totalDue(state, t), 'card')} due · streak ${plural(srs.currentStreak(state, t), 'day')}`
    : 'New here? Your first palace takes about two minutes.';
}

// ---------- actions ----------
function press(o, time) {
  const u = o.userData;
  if (time - u.last < COOLDOWN) return;
  u.last = time;
  o.scale.setScalar(0.86); // visual "pressed", eases back in animate()
  play('ui');
  u.onSelect();
}

function reanchor(c) {
  if (c.anchor && c.anchor.delete) c.anchor.delete();
  c.anchor = null;
  xr.anchor(frame, c.mesh.position, anchor => { c.anchor = anchor; });
}

/** The home pose as a palace frame: [x, y, z, yaw]. */
const frameNow = () => [home.pos.x, home.pos.y, home.pos.z, Math.atan2(-home.fwd.x, -home.fwd.z)];

/** Move the whole palace (all decks) rigidly, back in front of the user. */
function recenter() {
  const from = state.frame, live = xr.session && xr.head.valid;
  setHome(live ? xr.head.pos : camera.position, live ? xr.head.quat : camera.quaternion);
  const to = frameNow();
  srs.recenter(state, from || to, to, !(xr.floor || demo));
  for (const c of cards) {
    if (!c.placed) continue;
    c.mesh.position.fromArray(c.st.pos);
    reanchor(c);
  }
  save();
  route.update(cards);
  flash = 'Palace recentred.';
  refreshHud();
}

/** HUD, dock and pile rejoin a user who walked away or turned round. */
function follow(dt) {
  v1.copy(hud.position).sub(head).setY(0);
  v2.set(0, 0, -1).applyQuaternion(xr.head.quat);
  let stay = Math.hypot(head.x - home.pos.x, head.z - home.pos.z) < 0.6 && v1.dot(v2) > 0;
  for (const p of xr.list) if (p.grab) stay = true;
  away = stay ? 0 : away + dt;
  if (away < 1.2) return;
  away = 0;
  if (!menuPalm) menu.visible = false;
  setHome(xr.head.pos, xr.head.quat);
}

function toggleMenu(orb) {
  if (menu.visible && !menuPalm) { menu.visible = false; return; }
  menu.position.copy(orb.position).y += 0.15;
  menu.userData.exclude = orb.userData.exclude;
  menu.visible = true;
  menuPalm = false;
}

function pinchCard(p, c, direct, point, t) {
  if (mode === 'walk') return flip(c);
  if (mode === 'today') setMode('place');
  p.grab = c;
  c.held = true;
  p.gap0 = p.gap; // finger gap at the grab: "open" is judged against it
  p.direct = direct;
  p.offset.copy(c.mesh.position).sub(direct ? p.tip : point);
  p.dist0 = t;
  p.hand0 = Math.max(0.05, p.origin.distanceTo(head));
  p.start.copy(c.mesh.position);
  play('grab');
  restack(); // the next card comes to the top of the pile
  if (tut === 0) { tut = 1; refreshHud(); }
}

function drag(p) {
  const c = p.grab, pos = c.mesh.position;
  if (p.valid) {
    if (p.direct) v1.copy(p.tip);
    else {
      // Ray grab: pulling the hand towards you reels the card in (no extra gesture needed).
      const d = demo ? p.dist0 : clamp(p.dist0 * Math.pow(p.origin.distanceTo(head) / p.hand0, 2.5), 0.15, 5);
      v1.copy(p.origin).addScaledVector(p.dir, d);
    }
    pos.copy(v1).add(p.offset);
    if (xr.floor || demo) pos.y = Math.max(0.1, pos.y);
    p.hit = true;
    p.point.copy(pos);
    c.hot = true;
    if (tut === 1 && pos.distanceTo(p.start) > 0.12) { tut = 2; refreshHud(); }
  }
  // A lost selectend must not leave the card hanging: no tracked hand, or fingers apart, for STALE frames.
  const open = p.isHand && p.gap > 0 && p.gap > Math.max(PINCH_OPEN, p.gap0 + 0.03);
  p.stale = !p.valid || open ? p.stale + 1 : 0;
  if (p.stale > STALE) p.pinching = false;
  if (p.up || !p.pinching) drop(p, c);
}

function drop(p, c) {
  const pos = c.mesh.position;
  p.grab = null;
  p.stale = 0;
  c.held = false;
  srs.place(state, deck.id, c.id, pos.toArray(), today());
  if (!state.frame) state.frame = frameNow();
  c.placed = true;
  c.pulse();
  c.redraw();
  reanchor(c);
  if (tut < 3) {
    tut = 3;
    S.tutorialDone = true;
    flash = `Pinned: stop ${c.st.order} on your route.\nPin the rest, then Menu > Walk`;
  }
  save();
  play('drop');
  restack();
  route.update(cards);
  refreshHud();
}

function flip(c) {
  const open = active !== c;
  if (active) { active.flipTo('q'); active.focus = false; }
  active = open ? c : null;
  if (open) { c.flipTo('a'); c.focus = true; }
  play('flip');
  showGrade();
  refreshHud();
}

/** The two answer buttons appear within reach, just below the line of sight to the card. */
function showGrade() {
  const on = !!active && srs.isDue(active.st, today());
  gradeBtn.forEach(b => { b.visible = on; });
  if (!on) return;
  const dist = active.mesh.position.distanceTo(head);
  v1.copy(active.mesh.position).sub(head).normalize();
  v2.set(-v1.z, 0, v1.x).normalize();
  gradeBtn.forEach((b, i) => {
    b.position.copy(head).addScaledVector(v1, Math.min(dist * 0.93, 0.42 * S.reach)).addScaledVector(v2, i ? 0.09 : -0.09);
    b.position.y -= 0.135;
    b.userData.armed = {}; // a finger already there must leave before it can touch
  });
}

function grade(knew) {
  if (!active) return;
  const t = today();
  srs.review(active.st, knew, t);
  srs.touchStreak(state, t);
  save();
  play(knew ? 'good' : 'bad');
  active.flipTo('q');
  active.focus = false;
  active.dim = true;
  active.redraw();
  active.pulse();
  active = null;
  showGrade();
  refreshHud();
}

// ---------- hit testing: every target is a rectangle facing the user ----------
const L = { x: 0, y: 0, z: 0, hw: 0, hh: 0 };
const res = { obj: null, d: 0, t: 0, direct: false, point: new THREE.Vector3() };

/** Express a world point in the rectangle's own axes (world units). */
function toLocal(o, pt) {
  const e = o.matrixWorld.elements, dx = pt.x - e[12], dy = pt.y - e[13], dz = pt.z - e[14];
  const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
  L.x = (dx * e[0] + dy * e[1] + dz * e[2]) / sx;
  L.y = (dx * e[4] + dy * e[5] + dz * e[6]) / sy;
  L.z = (dx * e[8] + dy * e[9] + dz * e[10]) / sz;
  L.hw = o.userData.hw * sy;
  L.hh = o.userData.hh * sy;
  return L;
}

/** Direct pinch (fingertips near the rectangle) wins over the ray. */
function probe(o, p) {
  let l = toLocal(o, p.tip);
  const d = Math.hypot(Math.max(Math.abs(l.x) - l.hw, 0), Math.max(Math.abs(l.y) - l.hh, 0), l.z);
  if (d < res.d) { res.d = d; res.obj = o; res.direct = true; res.point.copy(p.tip); }
  if (res.direct) return;
  l = toLocal(o, p.origin);
  const ax = l.x, ay = l.y, az = l.z;
  l = toLocal(o, v1.copy(p.origin).add(p.dir));
  const dz = l.z - az;
  if (Math.abs(dz) < 1e-4) return;
  const t = -az / dz;
  if (t < 0.03 || t >= res.t) return;
  if (Math.abs(ax + t * (l.x - ax)) > l.hw || Math.abs(ay + t * (l.y - ay)) > l.hh) return;
  res.t = t;
  res.obj = o;
  res.point.copy(p.origin).addScaledVector(p.dir, t);
}

// A palm menu must not be operated by the hand that carries it.
const shown = (o, p) => o.visible && o.parent.visible && (o.userData.exclude || o.parent.userData.exclude) !== p.handed;

function interact(p, time) {
  if (p.grab) return drag(p);
  p.hit = false;
  p.hover = null;
  if (!p.valid) return;
  res.obj = null; res.d = TOUCH_R; res.t = 6; res.direct = false;
  for (const o of targets) if (shown(o, p)) probe(o, p);
  if (mode !== 'decks') for (const c of cards) if (c.mesh.visible && !c.held && (c.placed || c === pileTop)) probe(c.mesh, p);
  const o = res.obj;
  if (o) {
    const u = o.userData;
    p.hit = true;
    p.hover = o;
    p.direct = res.direct;
    p.point.copy(res.point);
    if (u.card) u.card.hot = true; else u.hot = true;
    if (p.down) { if (u.card) pinchCard(p, u.card, res.direct, res.point, res.t); else press(o, time); }
  } else if (demo && p.down) looking = true; // drag on empty space looks around
  if (p.isHand) poke(p, time);
}

/** Fingertip touch: fires once the index tip has entered a button and rested there DWELL ms. */
function poke(p, time) {
  const h = p.handed;
  for (const o of targets) {
    const u = o.userData, since = u.since || (u.since = {});
    if (!shown(o, p)) { u.armed[h] = false; since[h] = 0; continue; }
    const l = toLocal(o, p.index);
    if (Math.abs(l.x) > l.hw || Math.abs(l.y) > l.hh || Math.abs(l.z) > POKE_Z) { u.armed[h] = true; since[h] = 0; }
    else if (u.armed[h]) {
      u.hot = true; // grows while the finger rests: the dwell is visible
      if (!since[h]) since[h] = time || 1;
      else if (time - since[h] >= DWELL) { u.armed[h] = false; since[h] = 0; press(o, time); }
    }
  }
}

/** Turning the back of the menu-hand wrist to the eyes shows the menu (palm to the face is the
 *  Quest system gesture, so it is left alone); otherwise a small disc rides the wrist. */
function palmMenu() {
  let hand = null;
  for (const p of xr.list) if (p.valid && p.isHand && p.handed === S.menuHand) hand = p;
  let up = false;
  if (hand && hand.palm.valid && !hand.pinching) {
    v1.copy(head).sub(hand.palm.pos).normalize();
    up = hand.palm.normal.dot(v1) < (menuPalm ? -0.45 : -0.7); // back of the hand to the eyes; hysteresis: no flicker
    if (up) {
      menu.position.copy(hand.palm.pos).addScaledVector(v1, 0.06).y += 0.1;
      menu.userData.exclude = hand.handed;
      menu.visible = menuPalm = true;
    }
  }
  if (!up && menuPalm) menu.visible = menuPalm = false;
  wristOrb.visible = !!hand && !up;
  if (hand) {
    wristOrb.position.copy(hand.wrist).y += 0.075;
    wristOrb.userData.exclude = hand.handed;
  }
}

function visuals(pointers) {
  rays.forEach((r, i) => {
    const p = pointers[i], on = !!p && p.valid, far = on && p.hit && !p.direct;
    r.tip.visible = on && !demo;
    r.line.visible = far && !demo;
    r.cursor.visible = far;
    if (on) r.tip.position.copy(p.tip);
    if (!far) return;
    r.cursor.position.copy(p.point).addScaledVector(p.dir, -0.006);
    const a = r.line.geometry.attributes.position;
    a.setXYZ(0, p.origin.x, p.origin.y, p.origin.z);
    a.setXYZ(1, p.point.x, p.point.y, p.point.z);
    a.needsUpdate = true;
  });
}

// ---------- mouse demo (same scene, one pointer driven by the mouse) ----------
const MOUSE = [new Pointer(null)], mouse = MOUSE[0], ndc = new THREE.Vector2(9, 9), NONE = [];
const setNdc = e => { const r = el.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2); };
const release = () => { if (mouse.pinching) mouse.up = true; mouse.pinching = looking = false; };
el.addEventListener('pointermove', e => {
  if (looking) {
    camera.rotation.y += e.movementX * 0.004;
    camera.rotation.x = clamp(camera.rotation.x + e.movementY * 0.004, -1.2, 1.2);
  }
  setNdc(e);
});
el.addEventListener('pointerdown', e => {
  if (!demo) return;
  setNdc(e);
  mouse.pinching = mouse.down = true;
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointerup', release);
el.addEventListener('pointercancel', release);
el.addEventListener('wheel', e => {
  if (!mouse.grab) return;
  mouse.dist0 = clamp(mouse.dist0 * (e.deltaY > 0 ? 1.1 : 0.9), 0.2, 5);
  e.preventDefault();
}, { passive: false });

function updateMouse() {
  mouse.valid = true;
  mouse.origin.copy(camera.position);
  mouse.dir.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
  mouse.tip.set(0, -999, 0); // the mouse never "touches": ray only
}

// ---------- frame loop ----------
function tick(time, xrFrame) {
  const dt = clamp((time - last) / 1000, 0.001, 0.05);
  last = time;
  frame = xrFrame || null;
  let pointers = NONE;
  if (xr.session && xrFrame) {
    xr.update(xrFrame);
    pointers = xr.list;
    if (xr.head.valid) {
      head.copy(xr.head.pos);
      if (needsHome) setHome(xr.head.pos, xr.head.quat); else if (running) follow(dt);
    }
  } else {
    head.copy(camera.position);
    if (demo) { updateMouse(); pointers = MOUSE; }
  }
  if (running) {
    scene.updateMatrixWorld();
    for (const o of targets) o.userData.hot = false;
    for (const c of cards) c.hot = false;
    if (xr.session) palmMenu();
    for (const p of pointers) interact(p, time);
    visuals(pointers);
  }
  const k = Math.min(1, dt * 12);
  for (const o of faceHead) if (o.visible) o.lookAt(head);
  for (const o of targets) {
    const hot = o.userData.hot;
    o.scale.setScalar(o.scale.x + ((hot ? 1.08 : 1) - o.scale.x) * k);
    o.material.color.setScalar(hot ? 1 : 0.8);
  }
  for (const c of cards) {
    if (c.anchor && !c.held && frame) xr.anchorPos(frame, c.anchor, c.mesh.position);
    c.update(dt, head);
  }
  if (xr.session) xr.endFrame();
  mouse.down = mouse.up = false;
  renderer.render(scene, camera);
}

// ---------- entering and leaving ----------
function begin(isDemo) {
  demo = isDemo;
  running = true;
  $('home').hidden = true;
  $('bar').hidden = !isDemo;
  setMode(startMode());
}

async function enter() {
  unlock();
  $('enter').disabled = true;
  try {
    await xr.enter(xrMode);
  } catch (e) {
    $('note').textContent = `Could not start the headset session (${e.message}). Here is the mouse demo.`;
    return startDemo();
  } finally {
    $('enter').disabled = false;
  }
  needsHome = true;
  xr.onReset = () => { needsHome = true; };
  // The system menu (or another app) taking focus can swallow selectend: release cards, mute tones.
  xr.session.addEventListener('visibilitychange', e => {
    const shownNow = e.session.visibilityState === 'visible';
    suspendAudio(!shownNow);
    if (!shownNow) for (const p of xr.list) if (p.grab) { p.pinching = false; drop(p, p.grab); }
  });
  renderer.setClearColor(BG, xr.opaque ? 1 : 0);
  decor.visible = xr.opaque;
  xr.onEnd = all => {
    for (const p of all) if (p.grab) drop(p, p.grab); // never lose a held card
    frame = null;
    rays.forEach(r => { r.line.visible = r.cursor.visible = r.tip.visible = false; });
    menu.visible = wristOrb.visible = menuPalm = false;
    renderer.setClearColor(BG, 1);
    decor.visible = true;
    setHome(camera.position, camera.quaternion);
    leave();
  };
  begin(false);
}

function startDemo() {
  unlock();
  setHome(camera.position, camera.quaternion);
  begin(true);
}

function leave() {
  demo = running = false;
  $('home').hidden = false;
  $('bar').hidden = true;
  homeSummary();
  resize();
}

function exit() {
  if (xr.session) xr.session.end().catch(() => {}); else leave();
}

/** Imported decks kept in localStorage, so their progress stays reachable without the link. */
function savedDecks() {
  let list = [];
  try { list = JSON.parse((store && store.getItem(DECKS_KEY)) || '[]'); } catch { /* blocked or corrupted: none */ }
  const out = [];
  if (Array.isArray(list)) for (const x of list) {
    try { const d = validateDeck(x); if (!out.some(o => o.id === d.id)) out.push(d); } catch { /* skip a bad entry */ }
  }
  return out.slice(0, MAX_SAVED);
}

function keepDecks(list) {
  const json = JSON.stringify(list.map(d => ({ title: d.title, cards: d.cards })));
  if (json.length > 65536) return; // same ceiling as a ?deck= file
  try { if (store) store.setItem(DECKS_KEY, json); } catch { /* quota or blocked: the link still works */ }
}

async function init() {
  decks = [...BUILTIN];
  let kept = savedDecks();
  const param = params.get('deck');
  if (param) {
    try {
      const d = await loadDeckParam(param);
      kept = [d, ...kept.filter(k => k.id !== d.id)].slice(0, MAX_SAVED);
      keepDecks(kept);
      state.deck = d.id;
    } catch (e) { $('note').textContent = `Could not load that deck (${e.message}). Showing the built-in decks.`; }
  }
  for (const d of kept) if (!decks.some(b => b.id === d.id)) decks.push(d);
  buildDecks();
  setHome(camera.position, camera.quaternion);
  loadDeck(decks.find(d => d.id === state.deck) || decks[0]);
  const m = await XR.modes();
  xrMode = m.ar ? 'immersive-ar' : m.vr ? 'immersive-vr' : null;
  $('enter').textContent = xrMode ? 'Enter' : 'Enter (mouse demo)';
  $('enter').onclick = xrMode ? enter : startDemo;
  $('enter').disabled = false;
  $('demo').hidden = !xrMode;
  $('demo').onclick = startDemo;
  $('back').onclick = exit;
  if (!xrMode && !$('note').textContent) $('note').textContent = 'No headset detected: the demo runs the same scene with a mouse.';
  homeSummary();
  renderer.setAnimationLoop(tick);
}

// Read-only hooks for the automated tests (tests/e2e.mjs).
const label = o => (o ? (o.userData.card ? o.userData.card.id : o.userData.label) : null);
window.__loci = {
  info: () => ({ mode, demo, running, needsHome, session: !!xr.session, xrMode, opaque: xr.opaque, floor: xr.floor, anchors: xr.anchorsOk,
    features: xr.features, menu: menu.visible, menuPalm, hud: hudText, deck: deck && deck.id, today: today(), head: head.toArray() }),
  cards: () => cards.map(c => ({ id: c.id, pos: c.mesh.position.toArray(), placed: c.placed, held: c.held, face: c.face, box: c.st.box, anchored: !!c.anchor })),
  pointers: () => (xr.session ? xr.list : MOUSE).map(p => ({ handed: p.handed, valid: p.valid, isHand: p.isHand, pinching: p.pinching, direct: p.direct,
    hover: label(p.hover), tip: p.tip.toArray(), origin: p.origin.toArray(), dir: p.dir.toArray() })),
  buttons: () => targets.filter(o => o.visible && o.parent.visible).map(o => ({ label: o.userData.label, pos: o.getWorldPosition(new THREE.Vector3()).toArray() })),
  screen: a => { const v = new THREE.Vector3().fromArray(a).project(camera); return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight]; },
  savedDecks: () => savedDecks().map(d => d.id),
};

// A hidden tab: tones stop; on return the Today line is recomputed (the day may have changed).
document.addEventListener('visibilitychange', () => {
  suspendAudio(document.hidden);
  if (!document.hidden && !running) homeSummary();
});

init();
