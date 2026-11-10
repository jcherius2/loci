// Built-in decks, the "question ; answer" text format, and ?deck= import.
export const MAX_CARDS = 12;
const MAX_TEXT = 140;

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** djb2 hash, used to give imported decks a stable id. */
export function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** One card per line: "question ; answer". Lines without both parts are skipped. */
export function parseText(text) {
  const cards = [];
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(';');
    if (i < 0) continue;
    const q = clean(line.slice(0, i)), a = clean(line.slice(i + 1));
    if (q && a) cards.push({ q, a });
  }
  return cards;
}

export function makeDeck(title, cards, id) {
  const list = (Array.isArray(cards) ? cards : [])
    .map(c => (Array.isArray(c) ? { q: clean(c[0]), a: clean(c[1]) } : { q: clean(c && c.q), a: clean(c && c.a) }))
    .filter(c => c.q && c.a)
    .slice(0, MAX_CARDS);
  if (!list.length) throw new Error('a deck needs at least one card with a question and an answer');
  const name = clean(title).slice(0, 40) || 'My deck';
  return { id: id || 'u' + hash(name + JSON.stringify(list)), title: name, cards: list };
}

/** Accepts {title, cards:[{q,a}]} or {title, cards:[[q,a]]}. */
export function validateDeck(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('deck JSON must be an object');
  return makeDeck(obj.title, obj.cards);
}

const PREFIX = 'data:application/json;base64,';

/** Pack a deck into a data: URL so a link can carry it without any server. */
export function encodeDeckParam(deck) {
  const bytes = new TextEncoder().encode(JSON.stringify({ title: deck.title, cards: deck.cards }));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return PREFIX + btoa(bin);
}

/** Resolve the ?deck= value: an embedded data: URL, or the URL of a JSON file. */
export async function loadDeckParam(param) {
  if (param.startsWith(PREFIX)) {
    const bin = atob(param.slice(PREFIX.length));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return validateDeck(JSON.parse(new TextDecoder().decode(bytes)));
  }
  const url = new URL(param, location.href);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) deck links are supported');
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > 65536) throw new Error('deck file too large');
  return validateDeck(JSON.parse(text));
}

const builtin = (id, title, text) => makeDeck(title, parseText(text), id);

export const BUILTIN = [
  builtin('biases', '12 cognitive biases', `
Confirmation bias ; Favouring information that confirms what you already believe
Anchoring ; Relying too much on the first number or fact you hear
Availability heuristic ; Judging how likely something is by how easily examples come to mind
Sunk cost fallacy ; Continuing because of what you already spent, not what you will gain
Hindsight bias ; Believing afterwards that you knew it all along
Dunning-Kruger effect ; Low skill leads to overestimating your own ability
Survivorship bias ; Looking only at the winners and ignoring those who failed
Loss aversion ; A loss hurts more than an equal gain pleases
Framing effect ; Deciding differently depending on how the same facts are presented
Halo effect ; One good trait colours your judgement of everything else
Bandwagon effect ; Adopting a belief because many other people hold it
Planning fallacy ; Underestimating how long your own tasks will take`),
  builtin('greek', 'Greek alphabet', `
Α α ; Alpha (1st letter)
Β β ; Beta (2nd letter)
Γ γ ; Gamma (3rd letter)
Δ δ ; Delta (4th letter)
Ε ε ; Epsilon (5th letter)
Ζ ζ ; Zeta (6th letter)
Η η ; Eta (7th letter)
Θ θ ; Theta (8th letter)
Ι ι ; Iota (9th letter)
Κ κ ; Kappa (10th letter)
Λ λ ; Lambda (11th letter)
Μ μ ; Mu (12th letter)`),
  builtin('elements', 'First 10 elements', `
Element 1 ; Hydrogen (H)
Element 2 ; Helium (He)
Element 3 ; Lithium (Li)
Element 4 ; Beryllium (Be)
Element 5 ; Boron (B)
Element 6 ; Carbon (C)
Element 7 ; Nitrogen (N)
Element 8 ; Oxygen (O)
Element 9 ; Fluorine (F)
Element 10 ; Neon (Ne)`),
  builtin('french', 'French essentials', `
Hello ; Bonjour
Thank you ; Merci
Please ; S'il vous plaît
Excuse me ; Excusez-moi
Where is...? ; Où est... ?
How much is it? ; C'est combien ?
I would like... ; Je voudrais...
I don't understand ; Je ne comprends pas
Goodbye ; Au revoir
Yes / No ; Oui / Non`),
];
