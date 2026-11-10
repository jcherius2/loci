# Loci — a memory palace for your hands

A WebXR prototype (mixed reality, hand tracking) for learning with the method of loci.
Pinch a card from the deck, pin it somewhere in your room, and it becomes a stop on a route.
Later you walk the route, flip each card, and answer "Knew it" / "Not yet".
A 5-box Leitner schedule (1, 2, 4, 8, 16 days) tells you what is due today.

Plain three.js, ES modules, no build step, no runtime CDN. Everything is stored in `localStorage`.

## Run

    ./get-vendor.sh              # once: copies three.module.min.js into vendor/
    python3 -m http.server 8080  # then open http://localhost:8080/

On a Quest, open the hosted page (HTTPS, e.g. GitHub Pages) in the browser and press **Enter**.
Hands are enough; controllers also work. Pinch the round **Menu** disc, low on
your left. Menu > Recenter palace brings every card back in front of you.

## Try it without a headset

- **Mouse demo**: on a desktop browser the Enter button starts the same scene with a mouse.
  Drag a card to pin it, drag empty space to look around, wheel changes distance.
- **Emulator**: install Meta's Immersive Web Emulator extension, or run the automated test below
  (it injects `iwer` and drives a simulated Quest 3 with hands).
- `?dayOffset=2` pretends it is two days later, to see the "Today" screen come back.

## Your own deck

Open `decks.html`, paste one `question ; answer` per line, and share the generated link.
You can also host a JSON file `{"title": "...", "cards": [{"q": "...", "a": "..."}]}` and open
`index.html?deck=<url>` (the host must allow CORS). Decks are capped at 12 cards.

## Tests

    npm install                    # only for the emulator (iwer)
    node --test tests/srs.test.mjs # scheduling and serialization
    node tests/e2e.mjs             # Playwright + iwer: full hands scenario, then mouse demo

## Accessibility

Seated, one hand, within arm's reach. Nothing depends on speed. Every target works by direct
pinch, by ray and pinch from a distance, or (buttons) by a fingertip touch. Decks > Reach brings
the interface closer; Decks > Menu switches the wrist menu to the other hand.

## Known limits

Never run on a physical headset yet. Anchors only stabilise cards within a session; between
sessions positions are relative to the floor origin (hence Recenter palace). See REVIEW.md.

Written by Claude, an AI model by Anthropic: the idea, design, code, tests and text are AI-generated; no human wrote or reviewed the code line by line.

MIT licence (see LICENSE). three.js is vendored under its own MIT licence (`vendor/THREE-LICENSE.txt`).
