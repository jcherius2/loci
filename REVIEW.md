# Loci: hostile review

No headset: findings come from the code and the `iwer` emulator, which proves nothing
about a real Quest 3.

## Defects

Blocking: none proven. The WebXR calls are sound (`requestSession` in the click, optional
features only, `local-floor` then `local`, input sources re-read every frame).

Serious (6)
- FIXED direct-pinch tolerance 4.5 cm: the old test passed by 1 mm. Now 7 cm.
- FIXED HUD, Menu disc and pile stayed where the session began. They now rejoin a user
  who walks 0.6 m away or turns their back.
- FIXED a hand with joints but no aim-ray pose was ignored (no pinch, palm or touch).
- FIXED nothing handled a moved origin. Menu > Recenter palace moves every deck rigidly;
  a reference-space `reset` lays the UI out again.
- FIXED the HUD hid the middle of the view (41 x 15 degrees at eye level). Lowered 10 cm.
- FIXED-in-patch the palm menu shared its pose with the Quest system gesture. It now opens
  with the back of the wrist turned to the eyes; the Menu disc is unchanged.

Medium (7)
- FIXED `plane-detection` requested for nothing.
- FIXED blocked `localStorage` threw at load (blank page).
- FIXED `?deck=` accepted a JSON file of any size (now 64 KB).
- FIXED-in-patch an imported deck was not stored. The last one is kept in `loci.decks.v1`
  (64 KB ceiling) and listed without its link.
- OPEN no persistent anchors: between sessions the palace follows the floor origin.
- FIXED-in-patch a lost `selectend` kept a card held. Released after 15 frames without a
  tracked hand or with thumb and index apart, and when the session loses visibility.
- FIXED-in-patch fingertip touch had no dwell. A button now fires after 300 ms of contact.

Minor (4): FIXED-in-patch `visibilitychange` (tones paused, Today line recomputed).
Open: per-frame allocations; a time-zone change can shift "today";
audio and frame rate never measured.

## Check first on a real Quest 3 (one minute each)

1. Enter: passthrough starts, one hand-tracking prompt, HUD readable below the eye line.
2. Pinch the top card, move, release: pinned with a sound, within 60 s of entering.
3. Aim at a card 2 m away, pinch, pull your hand back: the card reels in.
4. Menu disc: pinch it with each hand, then poke it with an index.
5. Back of the left wrist to your face: the menu opens; palm to the face: only the system icon.
6. Walk 2 m and turn round: HUD and disc rejoin you, and stay put while you lean.
7. Hold the Meta button to recentre, then Menu > Recenter palace: same layout, in front.
8. Swap hands for controllers and back: trigger works, no card stuck in the air.
9. Decks > Reach near and far, change deck, Exit, Enter: cards where you left them.
10. OVR Metrics Tool, 12 cards, Walk: 72 fps or more; sounds audible.
