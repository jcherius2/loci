// Rendering-load probe without a headset: Playwright + IWER (Quest 3, two hands), same setup as e2e.mjs.
// Per frame over 600 frames: three.js draw calls / triangles / programs / geometries / textures,
// real WebGL draw calls (prototype wrap), JS time of the animation-loop callback, JS heap.
// The page code is NOT modified on disk: the probe server patches main.js / decks.js in memory only
// (hooks around the animation loop, a handle on renderer/scene/cards, and the 12-card deck cap lifted
// so that 30 and 60 cards can be measured as a stress case).
// Run: PLAYWRIGHT_PATH=... LOCI_BROWSER=... node tests/perf-probe.mjs   (LOCI_N=12,30,60  LOCI_FRAMES=600)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright')); }
const SIZES = (process.env.LOCI_N || '12,30,60').split(',').map(Number);
const FRAMES = Number(process.env.LOCI_FRAMES || 600);

const PATCH = {
  '/src/main.js': s => {
    const a = 'renderer.setAnimationLoop(tick);', b = 'renderer.render(scene, camera);';
    if (!s.includes(a) || !s.includes(b)) throw new Error('main.js hooks not found');
    return s.replace(a, 'renderer.setAnimationLoop((t, f) => { const s0 = performance.now(); tick(t, f); if (window.__perfPost) window.__perfPost(performance.now() - s0); });')
      .replace(b, 'if (window.__perfPre) window.__perfPre(); ' + b)
      + '\nwindow.__perf = { renderer, scene, menu, route, restack: () => restack(), get cards() { return cards; }, get head() { return head; } };\n';
  },
  '/src/decks.js': s => s.replace('MAX_CARDS = 12', 'MAX_CARDS = 60'),
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, rel.replace(/\/$/, '/index.html'));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  if (PATCH[rel]) return res.end(PATCH[rel](fs.readFileSync(file, 'utf8')));
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.LOCI_BROWSER || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });

const quest = () => {
  const d = new IWER.XRDevice(IWER.metaQuest3);
  d.installRuntime({ forceInstall: true });
  d.primaryInputMode = 'hand';
  window.__dev = d;
  window.__gl = 0; // every real draw call issued to WebGL
  for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype])
    for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const f = P[k]; if (f) P[k] = function (...a) { window.__gl++; return f.apply(this, a); };
    }
};
const deckParam = n => 'data:application/json;base64,' + Buffer.from(JSON.stringify({ title: `Perf ${n}`,
  cards: Array.from({ length: n }, (_, i) => ({ q: `Question number ${i + 1}: what is the capital of country ${i}?`, a: `Answer ${i + 1}, a medium-length answer line` })) })).toString('base64');

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const results = [];
for (const n of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript({ path: path.join(root, 'node_modules/iwer/build/iwer.min.js') });
  await ctx.addInitScript(quest);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const frames = k => page.evaluate(k => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), k);
  await page.goto(base + '?deck=' + encodeURIComponent(deckParam(n)));
  await page.waitForFunction(() => !document.getElementById('enter').disabled, null, { timeout: 15000 });
  await page.click('#enter');
  await page.waitForFunction(() => { const i = __loci.info(); return i.session && !i.needsHome && __loci.pointers().filter(p => p.valid && p.isHand).length === 2; }, null, { timeout: 15000 });
  await frames(5);
  // Pin n-1 cards over a 180-degree arc in front of the user (1.2 to 3 m, 0.9 to 1.7 m high); one card stays in the pile.
  const placed = await page.evaluate(() => {
    const P = __perf, h = P.head, list = P.cards.slice(1);
    list.forEach((c, i) => {
      const ang = -Math.PI / 2 + Math.PI * ((i * 0.618) % 1), r = 1.2 + 1.8 * ((i * 0.37) % 1);
      const pos = [h.x + Math.sin(ang) * r, 0.9 + 0.8 * ((i * 0.53) % 1), h.z - Math.cos(ang) * r];
      c.st.pos = pos; c.st.order = i + 1; c.placed = true; c.mesh.position.fromArray(pos); c.redraw();
    });
    P.restack(); P.route.update(P.cards);
    return P.cards.filter(c => c.placed).length;
  });
  await frames(5);
  // Grab the pile card with the right hand (direct pinch, as in e2e.mjs).
  const ptr = async () => (await page.evaluate(() => __loci.pointers())).find(p => p.handed === 'right');
  const pile = (await page.evaluate(() => __loci.cards())).find(c => !c.placed);
  const head = (await page.evaluate(() => __loci.info())).head;
  const to = head.map((v, k) => v - pile.pos[k]), len = Math.hypot(...to), target = pile.pos.map((v, k) => v + (to[k] / len) * 0.012);
  for (let i = 0; i < 6; i++) {
    const p = await ptr(), d = target.map((t, k) => t - p.tip[k]);
    if (Math.hypot(...d) < 0.003) break;
    await page.evaluate(d => { const p = __dev.hands.right.position; p.set(p.x + d[0], p.y + d[1], p.z + d[2]); }, d);
    await frames(3);
  }
  await page.evaluate(() => __dev.hands.right.updatePinchValue(1));
  await frames(6);
  const held = await page.evaluate(() => __loci.cards().some(c => c.held));
  // Menu forced open in front of the user, just before every render.
  await page.evaluate(() => { const P = __perf; window.__perfPre = () => { window.__hp = performance.memory.usedJSHeapSize; P.menu.visible = true; P.menu.position.set(P.head.x - 0.15, P.head.y - 0.1, P.head.z - 0.5); }; });
  await frames(30);
  const r = await page.evaluate(N => new Promise(done => {
    if (window.gc) gc();
    const R = __perf.renderer, s = { js: [], calls: [], tris: [], gl: [], heap: [], rend: [] };
    const heap0 = performance.memory.usedJSHeapSize;
    let gl0 = __gl;
    window.__perfPost = ms => {
      const i = R.info;
      s.js.push(ms); s.calls.push(i.render.calls); s.tris.push(i.render.triangles); s.gl.push(__gl - gl0); gl0 = __gl;
      s.heap.push(performance.memory.usedJSHeapSize); s.rend.push(performance.memory.usedJSHeapSize - __hp);
      if (s.js.length >= N) {
        window.__perfPost = null;
        if (window.gc) gc();
        done({ views: R.xr.getCamera().cameras.length, s, heap0, heapAfterGc: performance.memory.usedJSHeapSize, programs: R.info.programs.length, geometries: R.info.memory.geometries, textures: R.info.memory.textures });
      }
    };
  }), FRAMES);
  // Heap: sum of increases between consecutive samples = bytes allocated per frame (drops = GC).
  let up = 0, gcs = 0; const rend = r.s.rend.filter(d => d >= 0);
  for (let i = 1; i < r.s.heap.length; i++) { const d = r.s.heap[i] - r.s.heap[i - 1]; if (d > 0) up += d; else if (d < 0) gcs++; }
  results.push({ cards: n, placed, held, frames: r.s.js.length,
    callsPerFrame: { median: q(r.s.calls, 0.5), max: Math.max(...r.s.calls) }, glDrawsPerFrame: { median: q(r.s.gl, 0.5), max: Math.max(...r.s.gl) },
    triangles: { median: q(r.s.tris, 0.5), max: Math.max(...r.s.tris) }, programs: r.programs, geometries: r.geometries, textures: r.textures,
    jsMs: { median: +q(r.s.js, 0.5).toFixed(3), p95: +q(r.s.js, 0.95).toFixed(3), max: +Math.max(...r.s.js).toFixed(3) },
    views: r.views, heap: { renderKBPerFrame: +(rend.reduce((a, b) => a + b, 0) / Math.max(1, rend.length) / 1024).toFixed(2), allocKBPerFrame: +(up / r.s.js.length / 1024).toFixed(2), gcDuringRun: gcs, retainedKB: +((r.heapAfterGc - r.heap0) / 1024).toFixed(1) },
    errors });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
server.close();
