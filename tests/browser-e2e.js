// Browser port of tests/e2e.mjs (same steps, same assertions). Loaded by browser-e2e.html.
// Differences: page.goto -> iframe host page (see the html); page.click -> element.click();
// page.mouse -> synthetic PointerEvents; no screenshot; no separate browser contexts
// (localStorage is cleared where e2e.mjs opened a new context).
const out = document.getElementById('out'), frame = document.getElementById('app');
const R = (window.__results = { passed: 0, failed: 0, lines: [], done: false });
const errors = (window.__errors = []);
const base = new URL('../', location.href).href;
const W = () => frame.contentWindow;
const J = x => (x === undefined ? x : JSON.parse(JSON.stringify(x))); // what page.evaluate returns
const log = s => { R.lines.push(s); out.textContent += s + '\n'; };
out.textContent = '';

const fmt = v => JSON.stringify(v);
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => same(a[k], b[k]));
};
const fail = (m, d) => { throw new Error(m ? `${m} (${d})` : d); };
const assert = {
  ok: (v, m) => v || fail(m, `expected truthy, got ${fmt(v)}`),
  equal: (a, b, m) => a === b || fail(m, `expected ${fmt(b)}, got ${fmt(a)}`),
  notEqual: (a, b, m) => a !== b || fail(m, `expected not ${fmt(b)}`),
  match: (s, re, m) => re.test(s) || fail(m, `${fmt(s)} does not match ${re}`),
  deepEqual: (a, b, m) => same(a, b) || fail(m, `expected ${fmt(b)}, got ${fmt(a)}`),
};

async function step(name, fn) {
  try { const note = await fn(); R.passed++; log(`ok   ${name}${note ? '  [' + note + ']' : ''}`); }
  catch (e) { R.failed++; log(`FAIL ${name}\n     ${String(e && e.message).split('\n').slice(0, 6).join(' / ')}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frames = n => Promise.race([sleep(5000), new Promise(r => { const w = W(); const f = () => (n-- > 0 ? w.requestAnimationFrame(f) : r()); f(); })]);
const until = async (fn, arg, timeout = 8000) => {
  const t0 = performance.now();
  for (;;) {
    try { if (fn(W(), arg)) return; } catch {}
    if (performance.now() - t0 > timeout) throw new Error(`until() timed out: ${String(fn).slice(0, 160)}`);
    await sleep(16);
  }
};
const L = () => W().__loci, D = () => W().__dev, $ = id => W().document.getElementById(id);
const info = async () => J(L().info());
const cards = async () => J(L().cards());
const card = async id => (await cards()).find(c => c.id === id);
const ptr = async h => J(L().pointers()).find(p => p.handed === h);
const button = async name => J(L().buttons()).find(b => b.label.startsWith(name));
const stored = async () => JSON.parse(W().localStorage.getItem('loci.v1'));
let rig = 'hands', nonce = 0;
const pinch = async (h, v) => { rig === 'hands' ? D().hands[h].updatePinchValue(v) : D().controllers[h].updateButtonValue('trigger', v); await frames(4); };
const moveHand = async (h, d) => { const p = D()[rig][h].position; p.set(p.x + d[0], p.y + d[1], p.z + d[2]); await frames(3); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** page.goto with the init scripts of the current "context" (xr: IWER installed, vr: VR-only). */
let ctx = { xr: true, vr: false };
async function goto(url) {
  const n = String(++nonce);
  frame.src = 'browser-e2e.html?' + new URLSearchParams({ host: 1, xr: ctx.xr ? 1 : 0, vr: ctx.vr ? 1 : 0, target: new URL(url, base).href, nonce: n });
  await until(w => w.__hostNonce === n && w.document.readyState === 'complete', null, 15000);
}
function newContext(c, w, h) { ctx = c; frame.width = w; frame.height = h; W().localStorage.clear(); }

async function aim(h, target, how) {
  for (let i = 0; i < 6; i++) {
    const p = await ptr(h);
    const from = how === 'touch' ? p.tip : p.origin.map((o, k) => o + p.dir[k] * 0.2);
    if (dist(from, target) < 0.003) break;
    await moveHand(h, target.map((t, k) => t - from[k]));
  }
  return ptr(h);
}
async function rayPinch(name) {
  const b = await button(name);
  assert.ok(b, `button "${name}" is visible`);
  const p = await aim('right', b.pos, 'ray');
  assert.ok(String(p.hover).startsWith(name) && !p.direct, `ray hovers "${name}" (got ${p.hover}, direct ${p.direct})`);
  await pinch('right', 1);
  await pinch('right', 0);
}
async function enterXR() {
  await until(w => !w.document.getElementById('enter').disabled);
  $('enter').click(); // page.click: IWER's requestSession does not need a real user gesture
  await until(w => { const i = w.__loci.info(); return i.session && !i.needsHome && w.__loci.pointers().filter(p => p.valid && p.isHand).length === 2; });
  await frames(5);
}

// ---------- part 1: emulated Quest 3, hands ----------
newContext({ xr: true, vr: false }, 1000, 700);
await goto(base);
let id, placedAt, saved;

await step('emulator injected, session entered with two tracked hands', async () => {
  assert.equal(typeof W().IWER, 'object');
  await enterXR();
  const i = await info();
  assert.equal(i.mode, 'place');
  assert.match(i.hud, /^1\/3/);
  return `${i.xrMode}, opaque=${i.opaque}, floor=${i.floor}, features=${i.features.join('+')}`;
});

await step('pinching a card of the pile grabs it (direct pinch)', async () => {
  const i = await info();
  const front = (await cards()).filter(c => !c.placed).sort((a, b) => dist(a.pos, i.head) - dist(b.pos, i.head))[0];
  const toHead = i.head.map((h, k) => h - front.pos[k]), len = Math.hypot(...toHead);
  const p = await aim('right', front.pos.map((v, k) => v + (toHead[k] / len) * 0.012), 'touch');
  assert.equal(p.hover, front.id);
  assert.equal(p.direct, true);
  await pinch('right', 1);
  await until(w => w.__loci.cards().some(c => c.held));
  id = (await cards()).find(c => c.held).id;
  assert.equal(id, front.id, 'the top card of the pile is the one taken');
  assert.match((await info()).hud, /^2\/3/);
});

await step('the held card follows the hand', async () => {
  const before = (await card(id)).pos;
  for (let k = 0; k < 5; k++) await moveHand('right', [0.06, 0.05, -0.05]);
  const after = (await card(id)).pos;
  assert.ok(dist(after, [before[0] + 0.3, before[1] + 0.25, before[2] - 0.25]) < 0.03, `moved to ${after}`);
  assert.match((await info()).hud, /^3\/3/);
});

await step('releasing pins the card: order 1, box 1, position saved', async () => {
  await pinch('right', 0);
  await until((w, id) => { const c = w.__loci.cards().find(c => c.id === id); return c.placed && !c.held; }, id);
  placedAt = (await card(id)).pos;
  const i = await info(), c = (await stored()).decks[i.deck].cards[id];
  assert.equal(c.order, 1);
  assert.equal(c.box, 1);
  assert.ok(dist(c.pos, placedAt) < 0.002, `saved ${c.pos} vs ${placedAt}`);
  assert.equal((await stored()).settings.tutorialDone, true);
  assert.match(i.hud, /^Pinned: stop 1/);
  return `anchored=${(await card(id)).anchored}`;
});

await step('back of the left wrist turned to the face shows the wrist menu', async () => {
  const i = await info(), h = i.head;
  D().hands.left.position.set(h[0] - 0.12, h[1] - 0.12, h[2] - 0.38);
  await frames(3);
  assert.equal((await info()).menuPalm, false, 'menu hidden with the hand at rest');
  const q0 = (q => [q.x, q.y, q.z, q.w])(D().hands.left.quaternion);
  const setQ = q => D().hands.left.quaternion.set(q[0], q[1], q[2], q[3]);
  let found = null;
  for (let n = 0; n < 64 && found === null; n++) {
    const [x, y, z] = [n % 4, (n >> 2) % 4, n >> 4].map(k => (k * Math.PI) / 4);
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
    setQ([sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]);
    await frames(3);
    if ((await info()).menuPalm) found = n;
  }
  assert.notEqual(found, null, 'no orientation showed the wrist menu');
  await rayPinch('Walk');
  setQ(q0);
  await frames(3);
  return `orientation #${found}`;
});

await step('Walk mode shows the question side', async () => {
  if ((await info()).mode !== 'walk') { await rayPinch('Menu'); await rayPinch('Walk'); }
  const i = await info();
  assert.equal(i.mode, 'walk');
  assert.match(i.hud, /1 due/);
  await frames(30);
  assert.equal((await card(id)).face, 'q');
});

await step('ray + pinch from a distance flips the card to its answer', async () => {
  const p = await aim('right', placedAt, 'ray');
  assert.equal(p.hover, id);
  assert.equal(p.direct, false);
  await pinch('right', 1);
  await until((w, id) => w.__loci.cards().find(c => c.id === id).face === 'a', id);
  await pinch('right', 0);
  assert.equal((await info()).hud, 'Did you know it?');
});

await step('pinching "Knew it" moves the card to box 2, due in 2 days, position kept', async () => {
  await rayPinch('Knew it');
  const i = await info();
  saved = (await stored()).decks[i.deck].cards[id];
  assert.equal(saved.box, 2);
  assert.equal(saved.due, i.today + 2);
  assert.ok(dist(saved.pos, placedAt) < 0.002);
  assert.deepEqual((await stored()).streak, { count: 1, last: i.today });
  assert.match(i.hud, /All caught up/);
});

await step('after a reload the Today screen and the palace are restored', async () => {
  await goto(base); // page.reload (re-runs the init scripts, like Playwright)
  await until(w => /0 cards due · streak 1 day/.test(w.document.getElementById('today').textContent));
  await enterXR();
  const i = await info(), c = await card(id);
  assert.equal(i.mode, 'today');
  assert.match(i.hud, /^Today · .*\n0 cards due · streak 1 day$/);
  assert.ok(c.placed && c.box === 2 && dist(c.pos, saved.pos) < 0.001, `restored at ${c.pos}`);
});

await step('two days later the card is due again; the dock disc opens the menu', async () => {
  await goto(base + '?dayOffset=2');
  await until(w => /1 card due/.test(w.document.getElementById('today').textContent));
  await enterXR();
  assert.match((await info()).hud, /1 card due · streak 0 days/);
  await rayPinch('Menu');
  assert.equal((await info()).menu, true);
  await rayPinch('Exit');
  await until(w => !w.__loci.info().session && !w.document.getElementById('home').hidden);
});

// ---------- part 1b: VR-only headset ----------
newContext({ xr: true, vr: true }, 1000, 700);
const ready = () => until(w => w.__loci && !w.document.getElementById('enter').disabled);
const grab = async d => {
  const c = (await cards()).find(c => !c.placed);
  await aim('right', c.pos, 'touch');
  await pinch('right', 1);
  assert.ok((await card(c.id)).held);
  await moveHand('right', d);
  return c.id;
};

await step('decks.html link loads; ?deck= loads a local JSON file, rejects a missing one', async () => {
  await goto(base + 'decks.html');
  $('make').click();
  await goto($('link').getAttribute('href'));
  await ready();
  assert.match((await info()).deck, /^u/);
  assert.equal((await cards()).length, 3);
  await goto(base + '?deck=tests/deck.json');
  await ready();
  assert.equal((await cards()).length, 2);
  assert.equal($('note').textContent, '');
  await goto(base); // the imported deck is kept: no link needed to reach it again
  await ready();
  assert.equal((await cards()).length, 2);
  assert.equal(L().savedDecks().length, 1);
  await goto(base + '?deck=tests/nope.json');
  await until(w => /Could not load/.test(w.document.getElementById('note').textContent));
  while (errors.length && /404/.test(errors.at(-1))) errors.pop();
});

await step('immersive-vr: Decks panel, reach, menu hand, deck switch', async () => {
  await goto(base);
  await enterXR();
  const i = await info(), d0 = dist((await button('Menu')).pos, i.head);
  assert.ok(i.xrMode === 'immersive-vr' && i.opaque && !i.features.includes('plane-detection'), `${i.xrMode} ${i.features}`);
  await rayPinch('Menu');
  await rayPinch('Decks');
  assert.equal((await info()).mode, 'decks');
  await rayPinch('Reach');
  assert.equal((await stored()).settings.reach, 0.75);
  assert.ok(dist((await button('Menu')).pos, i.head) < d0 - 0.03);
  await rayPinch('Menu: left');
  assert.equal((await stored()).settings.menuHand, 'right');
  const other = J(L().buttons().map(b => b.label)).find(l => l.includes(' · ') && !l.startsWith('>'));
  await rayPinch(other.slice(0, 8));
  const j = await info();
  assert.ok(j.deck !== i.deck && j.mode === 'place', `${j.deck} ${j.mode}`);
});

await step('a hand that vanishes mid-pinch pins its card; tracking comes back', async () => {
  const id = await grab([0.2, 0.25, -0.2]);
  D().hands.right.connected = false;
  await frames(10);
  const st = await card(id);
  assert.ok(st.placed && !st.held);
  D().hands.right.connected = true; D().hands.right.updatePinchValue(0);
  await frames(10);
  assert.equal(J(L().pointers()).filter(p => p.valid && p.isHand).length, 2);
});

await step('the dock follows the user; Recenter palace keeps relative positions', async () => {
  const a = await grab([-0.3, 0.2, -0.25]);
  await pinch('right', 0);
  const i = await info(), before = await cards();
  const at = (l, id) => l.find(c => c.id === id).pos, b = before.find(c => c.placed && c.id !== a).id;
  const d = D(); d.position.x += 1.5; d.position.z += 1; d.quaternion.set(0, 0.8415, 0, 0.5403);
  await until(w => { const h = w.__loci.info().head, m = w.__loci.buttons().find(b => b.label === 'Menu').pos; return Math.hypot(m[0] - h[0], m[2] - h[2]) < 0.6; });
  await rayPinch('Menu');
  await rayPinch('Recenter');
  const after = await cards(), h = (await info()).head, s = (await stored()).decks[i.deck].cards;
  assert.ok(Math.abs(dist(at(after, a), at(after, b)) - dist(at(before, a), at(before, b))) < 1e-3);
  assert.ok(Math.abs(dist(at(after, a), h) - dist(at(before, a), i.head)) < 0.02 && dist(at(after, a), at(before, a)) > 0.5);
  assert.ok(dist(s[a].pos, at(after, a)) < 2e-3 && Math.abs(s[a].pos[1] - at(before, a)[1]) < 2e-3);
});

await step('controllers take over mid-session; the session ends and resumes', async () => {
  D().primaryInputMode = 'controller';
  await frames(10);
  const ps = J(L().pointers().map(p => [p.handed, p.valid, p.isHand]));
  assert.equal(ps.filter(p => p[1] && !p[2]).length, 2);
  rig = 'controllers';
  try {
    await rayPinch('Menu');
    await rayPinch('Exit');
    await until(w => !w.__loci.info().session && !w.document.getElementById('home').hidden);
  } finally { rig = 'hands'; }
  D().primaryInputMode = 'hand';
  await enterXR();
  assert.equal((await cards()).filter(c => c.placed).length, 2);
});

// ---------- part 2: mouse demo (no WebXR) ----------
newContext({ xr: false, vr: false }, 1280, 720);
await goto(base);
let mx = 0, my = 0, held = 0, capture = null;
const fire = (type, x, y) => {
  const w = W(), t = (type !== 'pointerdown' && capture) || w.document.elementFromPoint(x, y) || w.document.body;
  if (type === 'pointerdown') { capture = t; held = 1; }
  t.dispatchEvent(new w.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
    movementX: x - mx, movementY: y - my, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons: held }));
  if (type === 'pointerup') { capture = null; held = 0; }
  mx = x; my = y;
};
const mouse = {
  move: async (x, y, o = {}) => { const n = o.steps || 1, x0 = mx, y0 = my; for (let k = 1; k <= n; k++) fire('pointermove', x0 + ((x - x0) * k) / n, y0 + ((y - y0) * k) / n); },
  down: async () => fire('pointerdown', mx, my),
  up: async () => fire('pointerup', mx, my),
};

await step('mouse demo: drag two cards to pin them, then walk and grade one', async () => {
  await until(w => !w.document.getElementById('enter').disabled);
  assert.match($('enter').textContent, /mouse demo/);
  $('enter').click();
  await until(w => w.__loci.info().demo);
  await frames(5);
  for (const [dx, dy] of [[330, -250], [-360, -200]]) {
    const head = (await info()).head;
    const front = (await cards()).filter(c => !c.placed).sort((a, b) => dist(a.pos, head) - dist(b.pos, head))[0];
    const [x, y] = L().screen(front.pos);
    await mouse.move(x, y); await frames(3);
    await mouse.down(); await frames(3);
    await mouse.move(x + dx, y + dy, { steps: 6 }); await frames(3);
    await mouse.up(); await frames(3);
  }
  const pinned = (await cards()).filter(c => c.placed);
  assert.equal(pinned.length, 2);
  await mouse.move(640, 200);
  await frames(40); // (no screenshot here)
  const click = async pos => { const [x, y] = L().screen(pos); await mouse.move(x, y); await frames(3); await mouse.down(); await frames(3); await mouse.up(); await frames(3); };
  await click((await button('Menu')).pos);
  await click((await button('Walk')).pos);
  assert.equal((await info()).mode, 'walk');
  await click(pinned[0].pos);
  await click((await button('Not yet')).pos);
  const i = await info(), c = (await stored()).decks[i.deck].cards[pinned[0].id];
  assert.equal(c.box, 1);
  assert.equal(c.due, i.today + 1);
});

await step('no page or console errors', async () => { assert.deepEqual(errors, []); });

log(`\ne2e: ${R.passed} passed, ${R.failed} failed`);
R.done = true;
