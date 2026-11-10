# e2e in the browser (no Node)

Port of `tests/e2e.mjs` to a test page. It needs `vendor/three.module.min.js` and `vendor/iwer.min.js` (iwer 2.5.0, unpkg). `vendor/` is git-ignored (`loci/.gitignore`).

Run: serve `loci/` (`py -m http.server 8765`), open `http://127.0.0.1:8765/tests/browser-e2e.html`, wait for the `e2e: X passed, Y failed` line. The result is also in `window.__results = {passed, failed, lines, done}`.

How it works: the iframe loads `browser-e2e.html?host=1…`. That page installs the emulated Quest 3 (same `quest()` as e2e.mjs) before the app runs. It then moves to the target URL with `history.replaceState` and writes the app HTML with `document.open/write`, so it stays the same Window and IWER stays installed. Errors go to `parent.__errors`.

Steps: all 16 steps ported, with the same names and assertions. Differences:
- `page.click` is replaced by `element.click()`. IWER's requestSession does not ask for a user gesture (not checked yet).
- `page.mouse` is replaced by synthetic PointerEvents (pointerId 1, mouse). `setPointerCapture` may refuse this pointer.
- No screenshot and no deviceScaleFactor 0.5.
- No separate browser contexts: `localStorage.clear()` and the iframe size change in their place.
- Browser 404 messages ("Failed to load resource") cannot be seen from inside the page. Only window errors and `console.error` are caught.
- A hidden tab slows down requestAnimationFrame, so the tab must stay visible.

Baseline run: **not done**. Starting the server was declined on 2026-10-25.
