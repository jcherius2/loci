// Leitner scheduling and persistence. Pure module (no DOM): runs in Node for tests.
export const KEY = 'loci.v1';
export const INTERVALS = [1, 2, 4, 8, 16]; // days until next review, boxes 1..5
export const REACH = [0.75, 1, 1.3];
const DAY_MS = 86400000;

/** Local calendar day as an integer, so "due today" follows the user's midnight. */
export function dayNumber(ms = Date.now(), tzOffsetMin = new Date(ms).getTimezoneOffset()) {
  return Math.floor((ms - tzOffsetMin * 60000) / DAY_MS);
}

export function newState() {
  return {
    v: 1,
    deck: null,
    frame: null, // [x, y, z, yaw] of the user at the first pin
    decks: {},
    streak: { count: 0, last: null },
    settings: { reach: 1, menuHand: 'left', tutorialDone: false },
  };
}

export function newCard() {
  return { box: 1, due: 0, pos: null, order: null, reviews: 0 };
}

export function cardState(state, deckId, cardId) {
  const deck = state.decks[deckId] || (state.decks[deckId] = { cards: {} });
  return deck.cards[cardId] || (deck.cards[cardId] = newCard());
}

const placedCards = (state, deckId) =>
  Object.values((state.decks[deckId] || { cards: {} }).cards).filter(c => c.pos);

/** Pin a card at pos ([x, y, z], metres, floor-origin space). First pin gives it a route order. */
export function place(state, deckId, cardId, pos, today) {
  const card = cardState(state, deckId, cardId);
  if (card.order == null) {
    card.order = 1 + Math.max(0, ...placedCards(state, deckId).map(c => c.order || 0));
    card.due = today;
  }
  card.pos = pos.map(n => Math.round(n * 1000) / 1000);
  return card;
}

/** Leitner: a known card moves up one box, a missed card goes back to box 1. */
export function review(card, knew, today) {
  card.box = knew ? Math.min(INTERVALS.length, card.box + 1) : 1;
  card.due = today + INTERVALS[card.box - 1];
  card.reviews = (card.reviews || 0) + 1;
  return card;
}

export const isDue = (card, today) => card.pos != null && card.due <= today;
export const dueCount = (state, deckId, today) => placedCards(state, deckId).filter(c => c.due <= today).length;
export const totalDue = (state, today) => Object.keys(state.decks).reduce((n, id) => n + dueCount(state, id, today), 0);
export const totalPlaced = state => Object.keys(state.decks).reduce((n, id) => n + placedCards(state, id).length, 0);

/** Earliest due day among pinned cards of a deck, or null. */
export function nextDue(state, deckId) {
  const days = placedCards(state, deckId).map(c => c.due);
  return days.length ? Math.min(...days) : null;
}

/** Call once per graded review: counts consecutive days with at least one review. */
export function touchStreak(state, today) {
  const s = state.streak;
  if (s.last === today) return s.count;
  s.count = s.last === today - 1 ? s.count + 1 : 1;
  s.last = today;
  return s.count;
}

/** A streak is still alive if the last review was today or yesterday. */
export function currentStreak(state, today) {
  const s = state.streak;
  return s.last != null && s.last >= today - 1 ? s.count : 0;
}

/** Move every pinned card of every deck by the rigid motion taking frame `from` to frame `to` ([x, y, z, yaw]). */
export function recenter(state, from, to, liftY) {
  const d = to[3] - from[3], cos = Math.cos(d), sin = Math.sin(d);
  for (const deck of Object.values(state.decks)) {
    for (const c of Object.values(deck.cards)) {
      if (!c.pos) continue;
      const x = c.pos[0] - from[0], z = c.pos[2] - from[2];
      c.pos[0] = to[0] + x * cos + z * sin;
      c.pos[2] = to[2] - x * sin + z * cos;
      if (liftY) c.pos[1] += to[1] - from[1];
    }
  }
  state.frame = to.slice();
}

export const serialize = state => JSON.stringify(state);

const int = (n, lo, hi, fallback) => (Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

/** Parse and sanitise stored data; anything unreadable yields a fresh state. */
export function deserialize(text) {
  const s = newState();
  let raw;
  try { raw = JSON.parse(text); } catch { return s; }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return s;
  if (typeof raw.deck === 'string') s.deck = raw.deck;
  if (Array.isArray(raw.frame) && raw.frame.length === 4 && raw.frame.every(Number.isFinite)) s.frame = raw.frame.slice();
  const st = raw.streak || {};
  if (Number.isInteger(st.count) && Number.isInteger(st.last)) s.streak = { count: Math.max(0, st.count), last: st.last };
  const set = raw.settings || {};
  if (REACH.includes(set.reach)) s.settings.reach = set.reach;
  if (set.menuHand === 'right') s.settings.menuHand = 'right';
  s.settings.tutorialDone = set.tutorialDone === true;
  for (const [deckId, deck] of Object.entries(raw.decks || {})) {
    if (deckId === '__proto__' || !deck || typeof deck.cards !== 'object') continue;
    const cards = {};
    for (const [id, c] of Object.entries(deck.cards || {})) {
      if (id === '__proto__' || !c || typeof c !== 'object') continue;
      const order = int(c.order, 1, 9999, null);
      const ok = order != null && Array.isArray(c.pos) && c.pos.length === 3 && c.pos.every(Number.isFinite);
      cards[id] = {
        box: int(c.box, 1, INTERVALS.length, 1),
        due: Number.isFinite(c.due) ? Math.floor(c.due) : 0,
        pos: ok ? c.pos.slice() : null,
        order: ok ? order : null,
        reviews: int(c.reviews, 0, 1e9, 0),
      };
    }
    s.decks[deckId] = { cards };
  }
  return s;
}

export function load(storage) {
  try { return deserialize(storage.getItem(KEY) || ''); } catch { return newState(); }
}

export function save(storage, state) {
  try { storage.setItem(KEY, serialize(state)); return true; } catch { return false; }
}
