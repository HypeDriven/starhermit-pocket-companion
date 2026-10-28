# Pocket Companion — Product and Game Specification

**Document status:** running specification of the game as built: a StarHermit engine script game (engine 1.22.0, `engine.minor=20`), played natively by the StarHermit client and in browsers by the engine's web runtime.  
**Game index:** 64  
**Genre:** Companion simulation  
**Players:** 1 player; optional asynchronous score comparison  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering:** the room on `starhermit:scene` (three.js-like), every screen and the HUD on `starhermit:ui` with an accessibility tree

## 1. Product vision

Pocket Companion is a game in which players feed, clean, entertain, and rest a responsive companion whose needs evolve over time. Its signature setting is a cozy customizable room centered on an expressive creature. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Feed, clean, entertain, and rest a responsive companion whose needs evolve over time.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **read a need, perform care or play, observe a response, and customize the shared room**. Pet is available in every stage and mode — as an action-tray button and by tapping Mote in the room — so the player can always interact with the companion directly; when a pet is not legal (overjoyed, resolving, finished) a tap still makes Mote react with hearts and a chirp, without advancing the clock. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Progress is trust and discovered interactions; neglect never causes permanent loss. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day by the StarHermit platform's clock (`serverNow`; the device clock until it answers).
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. The game is turn-based: needs drain per rules tick and ticks pass only when the player acts, so nothing progresses in real time or while the game is closed. Backgrounding (the runtime's suspend) opens the pause sheet. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The room fills the playfield but is never the only UI: menus, text, settings and descriptions are `starhermit:ui` widgets with roles and names (screen readers, and the web page's accessibility mirror), and Mote is a named target over its projected box.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation.
- **Large screens and text size:** the runtime scales the whole interface by the window's scale factor and the player's interface size and text size (Options); the layout picks among the four layouts above by logical size, and the room renders at the window's pixel ratio.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Daily challenge, local practice, pause, resume, results, and progression are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; widget equivalents for drawn controls (Mote is a named target); headings and live regions for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a cozy customizable room centered on an expressive creature. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Graphics

The room renders with ACES filmic tone mapping (exposure 1) and sRGB output: a warm hemisphere fill, a key directional light with soft shadows, and the lamp as a point light with a bright bulb (three.js r160 intensities ÷ π, as the engine takes three's legacy light units). Mote's plush body takes the mood colour; eyes are glossy (clear-coat on High/Ultra) with catchlights; a soft contact shadow grounds Mote on every level. With room detail the props appear (lamp, plant, shelf of books, cushion, yarn ball) and surfaces get the procedural canvas textures (plank grain and seams, plaster with faint wallpaper stripes, wainscot panels, a woven rug, wound yarn) and the window shows a gradient night or day sky with stars and moon on dark themes. Ambient motion adds dust motes drifting in a pool of window light, a gentle lamp flicker and window shimmer; it holds still under reduced motion (the runtime's option). Emote particles (hearts, bubbles, notes, crumbs, zzz, stars, sparkles) are pooled sprites.

The runtime's Options choose the graphics level (Auto from the hardware, or a level); `native/quality.ts` maps its tier (`frame().quality`) to the browser build's presets, scaling emote and dust budgets within a tier by the level (≤ 2×). Changes apply live.

| Tier | Shadows | AO (GTAO) | Bloom (0.42 / 0.45 / 0.92) | Grade + vignette | AA | Reflections (room environment) | Detail + ambient | Shading | Textures | Body segments | Emotes / motes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | off | off | off | plain | Lambert | ½ | 24×18 | 60 / 40 |
| Balanced | 512 | off | on (½ res) | on | FXAA | on | on | Standard | ½ | 32×24 | 160 / 50 |
| High | 1024 | on (½ res) | on (½ res) | on | SMAA | on | on | clear-coat | 1 | 40×30 | 400 / 70 |
| Ultra | 2048 | high | on | on | MSAA | on | on | clear-coat | 1.5 | 56×40 | 600 / 120 |

The colour grade is the old shader on linear light (0.22 S-curve, saturation 1.07, cool shadows / warm highlights over luma 0.15–0.85, a 0.24 vignette from 0.38 to 0.9); its final small lift is left out. The render scale, adaptive resolution, frame-rate limit and readout, and the GPU summary that the old Graphics panel offered are the runtime's.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

## 5. Technical architecture

### Client modules

- `native/main.ts` (engine entry): the state machine, modes, actions, hints, undo, lessons, results and progression, the resume snapshot, input (actions, pointer and touch on Mote) and the lifecycle.
- `native/screens.ts`: the top bar, HUD rails, action tray, room overlays (craving bubble, floating points, lesson card, phone pause button), the pause / settings / help / decoration sheets, every full-page screen and the four layouts.
- `native/render.ts`: the room and Mote on `starhermit:scene`; `native/quality.ts`: the look per graphics level.
- `native/audio.ts`: the authored samples (`sfx/*.opus`) per event with captions, the ambient bed and the music pad rendered into looping clips.
- `native/platform.ts`: the save, the old cloud slot migration, the game's options as engine settings, the platform clock, the invite link, the high-score board and score posting; `native/i18n.ts` and `native/style.ts` (the converted style sheet, palettes, high contrast); `native/game.ts` types the shared modules.
- Shared with the node tests, unchanged in behaviour: `src/rules.js`, `src/content.js`, `src/session.js`, `src/progress.js` (the save model, merge, bookkeeping; moved from the old storage.js / main.js), `src/i18n.js`, `src/strings.js`, `src/platform-i18n.js`. `server.js` stays the local dev server.

No module mutates rules state except through a validated command; rendering reads the rules' mood and events.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Recover WebGL context by rebuilding GPU resources from retained CPU descriptors. If 3D is unavailable, present a clear compatibility message and preserve account/session state.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- `starhermit.txt`: `launch=index.html` (the engine's web loader from `npm run package`, with `starhermit-files.json`), `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.22.0`, `engine.minor=20`, capabilities `platform,storage,clipboard`, the `control.*` actions (`slot1`–`slot10` on the number keys and numpad, `hint` H, `undo` U, `camera` C, `pause` Escape) with gamepad defaults (Start pause, North hint, West undo, Select camera; the tray and every button by D-pad focus and South), `server=score-script.js`.
- `.starhermitignore` leaves out tests/, tools/, docs and the dev server.

### Controls
- Keys: 1–9, 0 act on tray slots 1–10 in the tray's order (Decorate opens the decorations sheet), H hint, U undo (Practice and Learn), C camera, Escape pause (or closes every open sheet and resumes). Players rebind keys and pads in the runtime's Options (Settings → Key bindings).
- Pointer and touch: the tray buttons, every widget, and a tap or click on Mote (pets when legal; otherwise Mote still wiggles and chirps). Phones and short landscape show a pause button in the room; the pause sheet there also carries Hint and Undo (the score rail is hidden).
- Gamepad: D-pad moves focus, South presses, East closes a sheet, Start pauses.

### Saves, options, identity
- The save is `{ v, profile, boards }` in `starhermit:storage` `saves` (schema 1): on the device and, signed in, in the account's cloud slot. Another device's save merges in (journey records keep the most stars and best score, daily results and stage bests the higher score, achievements the earliest unlock, discoveries, decor, lessons and daily days are unioned, sessions played the larger count, local boards best 50 each; this device keeps its name and settings).
- The browser build's cloud slot (`game:<slug>`, `{ profile, boards }` through the JS SDK) shows as a foreign save: it is merged in once (its settings and name win, as the old start-up load did), its game options are carried over, and it is replaced.
- The game's own options are engine `settings` (synced with the account): Color palette (default / deuteranopia / protanopia / tritanopia), Captions, Left-handed layout (mirrored tray), Timing assist (halved drain; sessions are unranked), Haptics. The browser build's values in the account's settings KV are adopted unless set since, then all its KV keys are removed. Volumes, mute, voice limit, graphics, frame rate, language, larger text, high contrast and reduced motion are the runtime's Options (Settings → Open Options).
- The last safe session snapshot (resume after a closed window) stays on this device (`storage`); the title offers **Resume session**, also right after leaving a session.
- The top bar shows the player's name (guests: their editable display name, used on local boards) and the cloud-sync note.
- **Invite a friend** (signed in) copies the invite link; **Sign in with StarHermit** (guests) asks the runtime to sign in.

### Clock
- The Daily's UTC day, the Score chase seed and timestamps (journey completion, achievement unlocks, session start) come from the platform's clock (`serverNow`), with the device clock until it answers. There is no real-time or offline progression to clock: the rules advance only with the player's actions.

### Achievements and leaderboards
- Achievements are local (part of the cloud-synced save).
- One platform board, `high-score` (0–100,000). Signed in, every finished ranked session (Daily first completion, Challenge, Score chase; no timing assist) posts its total through `score-script.js` (a practice session whose socket carries `{ type: "result", scores }`), and the results show "Leaderboard rank: #N" (or posted / not posted). The leaderboard screen reads `high-score` (Global / Friends) signed in, else the local casual board of the last session's content.

### Not used
- Matchmaking, hosted rooms, chat, replays and voice: the game is solo.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Language

- Every player-facing string ships in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT (`src/strings.js`, account strings in `src/platform-i18n.js`); the game follows the runtime's interface language (Options → Language, else the account's preferred language, else the device's). A change shows on the next frame and never touches the session. The game name and Mote's name are never translated.
- `tests/i18n.test.mjs` checks that every key used in `native/*.ts` and the content exists in all nine locales with matching placeholders.

### Graphics and performance

- `npm run test:native` renders the play scripts natively at the render check's level; `--render-check --quality low|balanced|high|ultra` checks each tier. The browser check plays on the GPU.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, friends-only filtering, cloud-save conflict handling, activity start/end pairing, and server-time countdown accuracy.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.

## Layouts

- **Wide (≥ 1024 logical px):** objective, needs and bond rail on the left (260 px), the room, score, clock and Hint / Undo / Camera / Pause on the right (260 px), the action tray below.
- **Compact (701–1023 px):** the three status blocks in a row above, the room with the score rail (220 px) beside it, the tray below.
- **Phone (≤ 700 px):** objective and bond side by side, needs below, the room, then the tray in balanced wrapped rows; pause in the room's corner; the lesson card spans the room's top.
- **Short landscape (≤ 900 × 500 px):** a narrow scrolling status rail (200 px) beside the room, the tray below, pause in the room.
- Full-page screens scroll when taller than the window; sheets scroll with their footer buttons pinned.

## Engine port: differences and known limitations

- Graphics settings are the runtime's levels; the old per-effect overrides, render-scale slider and frame-rate readout are not offered (the runtime has its own).
- Physical sheen (the plush rim on High/Ultra) is not drawn by the engine; the plush keeps its colour and clear-coat. The grade's final small lift (× 0.975 + 0.02) is left out.
- The emote particles are pooled sprites instead of one instanced shader mesh (same atlas drawings, motion and fades).
- The synthesized fallback blips that played while a sample was still decoding are not ported: such an event is silent (its caption still shows). The ambient bed and music pad are rendered into clips and play on the music bus (no ambience bus).
- Dead browser settings are dropped: Hold-to-repeat and Camera shake were stored but never used; Music/Effects/Ambience/Voice volumes, graphics, reduced motion, high contrast and larger text moved to the runtime's Options. The Camera button still only confirms "Camera recentered" (the authored sway needs no reset), as before.
- Lesson text loses its bold emphasis (`**…**` is shown plain); help text loses its inline markup.
- Guests' old browser localStorage progress cannot migrate (accepted); signed-in cloud saves do.
- Pre-existing rules behaviour kept: the "while you were away" summary reports the ticks a restored session already had (no time passes while away).

## Checks

- `npm test`: `tests/run.mjs` (rules, property, fuzz, golden and content validation — 127 checks), `tests/progress.test.mjs` (save model, merge, the old cloud document, options, bookkeeping), `tests/i18n.test.mjs`, then `tests/native.mjs`: the web index is current, `tsc`, `starhermit check .` with no warnings, and the play scripts in `tests/native/` as render checks: Journey 1–3 by keys to their results (desktop), the five lessons by finger (phone, DPR 3), the Beat the Clock challenge by finger with pause and help (short landscape, DPR 3), and the menus (profile, settings, help, practice setup, leave and resume, decorations). `npm run plays` regenerates the generated scripts from the rules.
- `npm run test:browser` (`tools/browser-play.mjs`) plays the packaged web build in Chrome on the GPU at desktop, phone and landscape (keys, clicks and taps on the tray and Mote, pause, settings) and fails on console errors.
