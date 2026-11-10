// End-to-end run without a headset: Playwright + IWER (Meta's WebXR emulator) as a Quest 3 with hands.
// Run with: node tests/e2e.mjs   (LOCI_SHOT=/path/demo.png to choose where the demo screenshot goes)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = process.env.LOCI_SHOT || path.join(os.tmpdir(), 'loci-demo.png');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright')); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

let page, passed = 0, failed = 0;
const errors = [];
async function step(name, fn) {
  try { const note = await fn(); passed++; console.log(`ok   ${name}${note ? '  [' + note + ']' : ''}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').slice(0, 6).join(' / ')}`); }
}
const frames = n => page.evaluate(k => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
const info = () => page.evaluate(() => __loci.info());
const cards = () => page.evaluate(() => __loci.cards());
const card = async id => (await cards()).find(c => c.id === id);
const ptr = async h => (await page.evaluate(() => __loci.pointers())).find(p => p.handed === h);
const button = async name => (await page.evaluate(() => __loci.buttons())).find(b => b.label.startsWith(name));
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('loci.v1')));
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
let rig = 'hands';
const pinch = async (h, v) => { await page.evaluate(([r, h, v]) => (r === 'hands' ? __dev.hands[h].updatePinchValue(v) : __dev.controllers[h].updateButtonValue('trigger', v)), [rig, h, v]); await frames(4); };
const moveHand = async (h, d) => {
  await page.evaluate(([r, h, d]) => { const p = __dev[r][h].position; p.set(p.x + d[0], p.y + d[1], p.z + d[2]); }, [rig, h, d]);
  await frames(3);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Move a hand so that its pinch point ('touch') or its ray 20 cm ahead ('ray') lands on target. */
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
  await until(() => !document.getElementById('enter').disabled);
  await page.click('#enter');
  await until(() => { const i = __loci.info(); return i.session && !i.needsHome && __loci.pointers().filter(p => p.valid && p.isHand).length === 2; });
  await frames(5);
}

const browser = await chromium.launch({ executablePath: process.env.LOCI_BROWSER || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const watch = p => { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); };

const quest = vrOnly => { // in the page: emulated Quest 3
  const d = new IWER.XRDevice(IWER.metaQuest3);
  d.installRuntime({ forceInstall: true });
  d.primaryInputMode = 'hand';
  if (vrOnly) { const ask = navigator.xr.isSessionSupported.bind(navigator.xr); navigator.xr.isSessionSupported = m => (m === 'immersive-ar' ? Promise.resolve(false) : ask(m)); }
  window.__dev = d;
};

// ---------- part 1: emulated Quest 3, hands ----------
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await ctx.addInitScript({ path: path.join(root, 'node_modules/iwer/build/iwer.min.js') });
await ctx.addInitScript(quest, false);
page = await ctx.newPage();
watch(page);
await page.goto(base);
let id, placedAt, saved;

await step('emulator injected, session entered with two tracked hands', async () => {
  assert.equal(await page.evaluate(() => typeof IWER), 'object');
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
  await until(() => __loci.cards().some(c => c.held));
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
  await until(id => { const c = __loci.cards().find(c => c.id === id); return c.placed && !c.held; }, id);
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
  const i = await info();
  await page.evaluate(h => __dev.hands.left.position.set(h[0] - 0.12, h[1] - 0.12, h[2] - 0.38), i.head);
  await frames(3);
  assert.equal((await info()).menuPalm, false, 'menu hidden with the hand at rest');
  const q0 = await page.evaluate(() => { const q = __dev.hands.left.quaternion; return [q.x, q.y, q.z, q.w]; });
  const setQ = q => page.evaluate(q => __dev.hands.left.quaternion.set(q[0], q[1], q[2], q[3]), q);
  let found = null;
  for (let n = 0; n < 64 && !found; n++) { // try every 90-degree orientation of the hand
    const [x, y, z] = [n % 4, (n >> 2) % 4, n >> 4].map(k => (k * Math.PI) / 4);
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
    await setQ([sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]);
    await frames(3);
    if ((await info()).menuPalm) found = n;
  }
  assert.notEqual(found, null, 'no orientation showed the wrist menu');
  await rayPinch('Walk');
  await setQ(q0);
  await frames(3);
  return `orientation #${found}`;
});

await step('Walk mode shows the question side', async () => {
  if ((await info()).mode !== 'walk') { await rayPinch('Menu'); await rayPinch('Walk'); } // fallback: dock disc
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
  await until(id => __loci.cards().find(c => c.id === id).face === 'a', id);
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
  await page.reload();
  await until(() => /0 cards due · streak 1 day/.test(document.getElementById('today').textContent));
  await enterXR();
  const i = await info(), c = await card(id);
  assert.equal(i.mode, 'today');
  assert.match(i.hud, /^Today · .*\n0 cards due · streak 1 day$/);
  assert.ok(c.placed && c.box === 2 && dist(c.pos, saved.pos) < 0.001, `restored at ${c.pos}`);
});

await step('two days later the card is due again; the dock disc opens the menu', async () => {
  await page.goto(base + '?dayOffset=2');
  await until(() => /1 card due/.test(document.getElementById('today').textContent));
  await enterXR();
  assert.match((await info()).hud, /1 card due · streak 0 days/);
  await rayPinch('Menu');
  assert.equal((await info()).menu, true);
  await rayPinch('Exit');
  await until(() => !__loci.info().session && !document.getElementById('home').hidden);
});
await ctx.close();

// ---------- part 1b: VR-only headset, paths never run before ----------
const ctxB = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await ctxB.addInitScript({ path: path.join(root, 'node_modules/iwer/build/iwer.min.js') });
await ctxB.addInitScript(quest, true);
page = await ctxB.newPage();
watch(page);
const ready = () => until(() => window.__loci && !document.getElementById('enter').disabled);
const grab = async d => {
  const c = (await cards()).find(c => !c.placed);
  await aim('right', c.pos, 'touch');
  await pinch('right', 1);
  assert.ok((await card(c.id)).held);
  await moveHand('right', d);
  return c.id;
};

await step('decks.html link loads; ?deck= loads a local JSON file, rejects a missing one', async () => {
  await page.goto(base + 'decks.html');
  await page.click('#make');
  await page.goto(await page.getAttribute('#link', 'href'));
  await ready();
  assert.match((await info()).deck, /^u/);
  assert.equal((await cards()).length, 3);
  await page.goto(base + '?deck=tests/deck.json');
  await ready();
  assert.equal((await cards()).length, 2);
  assert.equal(await page.textContent('#note'), '');
  await page.goto(base); // the imported deck is kept: no link needed to reach it again
  await ready();
  assert.equal((await cards()).length, 2);
  assert.equal((await page.evaluate(() => __loci.savedDecks())).length, 1);
  await page.goto(base + '?deck=tests/nope.json');
  await until(() => /Could not load/.test(document.getElementById('note').textContent));
  while (errors.length && /404/.test(errors.at(-1))) errors.pop();
});

await step('immersive-vr: Decks panel, reach, menu hand, deck switch', async () => {
  await page.goto(base);
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
  const other = (await page.evaluate(() => __loci.buttons().map(b => b.label))).find(l => l.includes(' · ') && !l.startsWith('>'));
  await rayPinch(other.slice(0, 8));
  const j = await info();
  assert.ok(j.deck !== i.deck && j.mode === 'place', `${j.deck} ${j.mode}`);
});

await step('a hand that vanishes mid-pinch pins its card; tracking comes back', async () => {
  const id = await grab([0.2, 0.25, -0.2]);
  await page.evaluate(() => { __dev.hands.right.connected = false; });
  await frames(10);
  const st = await card(id);
  assert.ok(st.placed && !st.held);
  await page.evaluate(() => { __dev.hands.right.connected = true; __dev.hands.right.updatePinchValue(0); });
  await frames(10);
  assert.equal((await page.evaluate(() => __loci.pointers())).filter(p => p.valid && p.isHand).length, 2);
});

await step('the dock follows the user; Recenter palace keeps relative positions', async () => {
  const a = await grab([-0.3, 0.2, -0.25]);
  await pinch('right', 0);
  const i = await info(), before = await cards();
  const at = (l, id) => l.find(c => c.id === id).pos, b = before.find(c => c.placed && c.id !== a).id;
  await page.evaluate(() => { __dev.position.x += 1.5; __dev.position.z += 1; __dev.quaternion.set(0, 0.8415, 0, 0.5403); });
  await until(() => { const h = __loci.info().head, m = __loci.buttons().find(b => b.label === 'Menu').pos; return Math.hypot(m[0] - h[0], m[2] - h[2]) < 0.6; });
  await rayPinch('Menu');
  await rayPinch('Recenter');
  const after = await cards(), h = (await info()).head, s = (await stored()).decks[i.deck].cards;
  assert.ok(Math.abs(dist(at(after, a), at(after, b)) - dist(at(before, a), at(before, b))) < 1e-3);
  assert.ok(Math.abs(dist(at(after, a), h) - dist(at(before, a), i.head)) < 0.02 && dist(at(after, a), at(before, a)) > 0.5);
  assert.ok(dist(s[a].pos, at(after, a)) < 2e-3 && Math.abs(s[a].pos[1] - at(before, a)[1]) < 2e-3);
});

await step('controllers take over mid-session; the session ends and resumes', async () => {
  await page.evaluate(() => { __dev.primaryInputMode = 'controller'; });
  await frames(10);
  const ps = await page.evaluate(() => __loci.pointers().map(p => [p.handed, p.valid, p.isHand]));
  assert.equal(ps.filter(p => p[1] && !p[2]).length, 2);
  rig = 'controllers';
  await rayPinch('Menu');
  await rayPinch('Exit');
  await until(() => !__loci.info().session && !document.getElementById('home').hidden);
  rig = 'hands';
  await page.evaluate(() => { __dev.primaryInputMode = 'hand'; });
  await enterXR();
  assert.equal((await cards()).filter(c => c.placed).length, 2);
});
await ctxB.close();

// ---------- part 2: mouse demo (no WebXR), plus a half-scale screenshot ----------
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 0.5 });
page = await ctx2.newPage();
watch(page);
await page.goto(base);

await step('mouse demo: drag two cards to pin them, then walk and grade one', async () => {
  await until(() => !document.getElementById('enter').disabled);
  assert.match(await page.textContent('#enter'), /mouse demo/);
  await page.click('#enter');
  await until(() => __loci.info().demo);
  await frames(5);
  for (const [dx, dy] of [[330, -250], [-360, -200]]) {
    const head = (await info()).head;
    const front = (await cards()).filter(c => !c.placed).sort((a, b) => dist(a.pos, head) - dist(b.pos, head))[0];
    const [x, y] = await page.evaluate(p => __loci.screen(p), front.pos);
    await page.mouse.move(x, y);
    await frames(3);
    await page.mouse.down();
    await frames(3);
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await frames(3);
    await page.mouse.up();
    await frames(3);
  }
  const pinned = (await cards()).filter(c => c.placed);
  assert.equal(pinned.length, 2);
  await page.mouse.move(640, 200);
  await frames(40);
  await page.screenshot({ path: SHOT });
  const click = async pos => { const [x, y] = await page.evaluate(p => __loci.screen(p), pos); await page.mouse.move(x, y); await frames(3); await page.mouse.down(); await frames(3); await page.mouse.up(); await frames(3); };
  await click((await button('Menu')).pos);
  await click((await button('Walk')).pos);
  assert.equal((await info()).mode, 'walk');
  await click(pinned[0].pos);
  await click((await button('Not yet')).pos);
  const i = await info(), c = (await stored()).decks[i.deck].cards[pinned[0].id];
  assert.equal(c.box, 1);
  assert.equal(c.due, i.today + 1);
  return `screenshot ${SHOT}`;
});

await step('no page or console errors', async () => { assert.deepEqual(errors, []); });

await browser.close();
server.close();
console.log(`\ne2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
