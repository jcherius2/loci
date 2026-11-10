// Run with: node --test tests/srs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as srs from '../src/srs.js';
import { parseText, makeDeck, encodeDeckParam, loadDeckParam, BUILTIN, MAX_CARDS } from '../src/decks.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('intervals are 1, 2, 4, 8, 16 days over 5 boxes', () => {
  assert.deepEqual(srs.INTERVALS, [1, 2, 4, 8, 16]);
});

test('a known card climbs one box at a time and is capped at box 5', () => {
  const c = srs.newCard();
  const seen = [];
  for (let i = 0; i < 6; i++) { srs.review(c, true, 100); seen.push([c.box, c.due - 100]); }
  assert.deepEqual(seen, [[2, 2], [3, 4], [4, 8], [5, 16], [5, 16], [5, 16]]);
  assert.equal(c.reviews, 6);
});

test('a missed card returns to box 1 and is due the next day', () => {
  const c = { ...srs.newCard(), box: 4, due: 0 };
  srs.review(c, false, 50);
  assert.equal(c.box, 1);
  assert.equal(c.due, 51);
});

test('placing gives route order, rounds the position, and makes the card due today', () => {
  const s = srs.newState();
  const a = srs.place(s, 'd', 'c3', [0.12345, 1.2, -0.5], 10);
  const b = srs.place(s, 'd', 'c0', [1, 1, 1], 10);
  assert.equal(a.order, 1);
  assert.equal(b.order, 2);
  assert.deepEqual(a.pos, [0.123, 1.2, -0.5]);
  assert.equal(srs.dueCount(s, 'd', 10), 2);
  srs.place(s, 'd', 'c3', [2, 2, 2], 11); // moving a card keeps its order
  assert.equal(a.order, 1);
  assert.deepEqual(a.pos, [2, 2, 2]);
});

test('unplaced cards are never due; due counts follow the calendar', () => {
  const s = srs.newState();
  srs.cardState(s, 'd', 'c0');
  assert.equal(srs.dueCount(s, 'd', 999), 0);
  const c = srs.place(s, 'd', 'c1', [0, 1, 0], 10);
  srs.review(c, true, 10);
  assert.equal(srs.dueCount(s, 'd', 11), 0);
  assert.equal(srs.dueCount(s, 'd', 12), 1);
  assert.equal(srs.nextDue(s, 'd'), 12);
  assert.equal(srs.totalDue(s, 12), 1);
  assert.equal(srs.totalPlaced(s), 1);
});

test('streak counts consecutive days and resets after a gap', () => {
  const s = srs.newState();
  assert.equal(srs.currentStreak(s, 5), 0);
  assert.equal(srs.touchStreak(s, 5), 1);
  assert.equal(srs.touchStreak(s, 5), 1);
  assert.equal(srs.touchStreak(s, 6), 2);
  assert.equal(srs.currentStreak(s, 7), 2); // yesterday still counts
  assert.equal(srs.currentStreak(s, 8), 0);
  assert.equal(srs.touchStreak(s, 9), 1);
});

test('state survives a serialize / deserialize round trip', () => {
  const s = srs.newState();
  srs.review(srs.place(s, 'biases', 'c0', [0.3, 1.1, -0.6], 20), true, 20);
  srs.touchStreak(s, 20);
  s.deck = 'biases';
  s.settings.reach = 0.75;
  s.settings.menuHand = 'right';
  s.settings.tutorialDone = true;
  assert.deepEqual(srs.deserialize(srs.serialize(s)), s);
});

test('load and save go through a storage object', () => {
  const store = memoryStorage();
  assert.deepEqual(srs.load(store), srs.newState());
  const s = srs.newState();
  srs.place(s, 'd', 'c0', [1, 2, 3], 1);
  assert.equal(srs.save(store, s), true);
  assert.deepEqual(srs.load(store).decks.d.cards.c0.pos, [1, 2, 3]);
  assert.equal(srs.save({ setItem() { throw new Error('full'); } }, s), false);
});

test('corrupt or hostile stored data falls back to safe values', () => {
  assert.deepEqual(srs.deserialize('not json'), srs.newState());
  assert.deepEqual(srs.deserialize('{"v":2}'), srs.newState());
  const s = srs.deserialize(JSON.stringify({
    v: 1, settings: { reach: 99, menuHand: 'foot' }, streak: { count: 'x' },
    decks: { d: { cards: { a: { box: 42, due: 'soon', pos: [1, 'x', 3], order: 2 }, b: { box: 3, due: 7, pos: [1, 2, 3], order: 1 }, c: null } } },
  }));
  assert.equal(s.settings.reach, 1);
  assert.equal(s.settings.menuHand, 'left');
  assert.deepEqual(s.streak, { count: 0, last: null });
  assert.deepEqual(s.decks.d.cards.a, { box: 5, due: 0, pos: null, order: null, reviews: 0 });
  assert.deepEqual(s.decks.d.cards.b, { box: 3, due: 7, pos: [1, 2, 3], order: 1, reviews: 0 });
  assert.equal('c' in s.decks.d.cards, false);
});

test('dayNumber follows the local midnight', () => {
  const noonUtc = Date.UTC(2026, 9, 10, 12);
  assert.equal(srs.dayNumber(noonUtc, 0), Math.floor(noonUtc / 86400000));
  assert.equal(srs.dayNumber(Date.UTC(2026, 9, 10, 23, 30), -120), srs.dayNumber(noonUtc, 0) + 1); // UTC+2
  assert.equal(srs.dayNumber(Date.UTC(2026, 9, 10, 1), 300), srs.dayNumber(noonUtc, 0) - 1);       // UTC-5
});

test('built-in decks have 8 to 12 complete cards', () => {
  assert.deepEqual(BUILTIN.map(d => d.title), ['12 cognitive biases', 'Greek alphabet', 'First 10 elements', 'French essentials']);
  for (const d of BUILTIN) {
    assert.ok(d.cards.length >= 8 && d.cards.length <= 12, d.title);
    for (const c of d.cards) assert.ok(c.q && c.a);
  }
});

test('pasted text becomes a deck, and the link payload round-trips (accents included)', async () => {
  const cards = parseText('Bonjour ; Hello\n\nno separator here\n ; missing question\nÀ bientôt ; See you soon; really\n');
  assert.deepEqual(cards, [{ q: 'Bonjour', a: 'Hello' }, { q: 'À bientôt', a: 'See you soon; really' }]);
  const deck = makeDeck('  Été  ', cards);
  const back = await loadDeckParam(encodeDeckParam(deck));
  assert.deepEqual(back, deck);
  assert.throws(() => makeDeck('empty', []));
  const many = Array.from({ length: 30 }, (_, i) => ({ q: 'q' + i, a: 'a' + i }));
  assert.equal(makeDeck('big', many).cards.length, MAX_CARDS);
});

import * as srs2 from '../src/srs.js';
test('recenter moves every pinned card rigidly', () => {
  const s = srs2.newState();
  srs2.place(s, 'd', 'c0', [0, 1, -1], 5);
  srs2.place(s, 'e', 'c0', [1, 1.5, -1], 5);
  srs2.recenter(s, [0, 1.6, 0, 0], [2, 1.2, 3, Math.PI / 2], false);
  const p = s.decks.d.cards.c0.pos, q = s.decks.e.cards.c0.pos;
  assert.ok(Math.abs(p[0] - 1) < 1e-9 && p[1] === 1 && Math.abs(p[2] - 3) < 1e-9, String(p));
  assert.ok(Math.abs(Math.hypot(q[0] - p[0], q[2] - p[2]) - 1) < 1e-9 && q[1] === 1.5);
  assert.deepEqual(srs2.deserialize(srs2.serialize(s)).frame, [2, 1.2, 3, Math.PI / 2]);
  assert.equal(srs2.deserialize('{"v":1,"frame":[1,"x",0,0]}').frame, null);
});
