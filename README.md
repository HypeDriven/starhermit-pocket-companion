# Pocket Companion

A cozy companion-care game: feed, clean, entertain, and rest **Mote**, an expressive
little creature living in a customizable room. Turn-based and fully deterministic —
every session is a replayable, hash-verified log of your commands.

A StarHermit engine script game (engine 1.19.2, `engine.minor=20`): the StarHermit
client plays it natively and browsers play the same package through the engine's web
runtime (`index.html` is the loader `npm run package` writes).

## Run

```bash
starhermit .            # the engine runtime (~/sh/runtime/1.19.2/…/starhermit)
npm run package         # after every change: the web loader + starhermit-files.json
node server.js          # optional dev server (static files + validated boards) on :8080
```

## Modes

- **Learn** — five interactive lessons; each requires performing the real action.
- **Journey** — 48 authored stages in 6 chapters with mastery trials.
- **Daily** — one shared seed per UTC day (platform clock); ranked.
- **Practice** — selectable difficulty, undo, never ranked.
- **Challenge** — move limits, speed targets, restricted tools.
- **Score Chase** — a shared seed per day, chasing the total.

## Architecture

| Path | Role |
| --- | --- |
| `native/main.ts` | Engine entry: state machine, modes, actions, lessons, results, input, lifecycle |
| `native/screens.ts` | All screens, HUD rails, tray, sheets and layouts on `starhermit:ui` |
| `native/render.ts`, `native/quality.ts` | The room and Mote on `starhermit:scene`; the look per graphics level |
| `native/audio.ts` | Samples per event with captions; ambience and music rendered to clips |
| `native/platform.ts` | Save + cloud merge + old cloud slot migration, options, clock, leaderboard |
| `src/rules.js`, `src/content.js`, `src/session.js` | Pure deterministic rules, content and sessions (shared with tests) |
| `src/progress.js` | Save model, merge, result bookkeeping, achievements |
| `src/i18n.js`, `src/strings.js`, `src/platform-i18n.js` | Nine-locale strings |
| `tools/ui-style.css` → `assets/ui-style.json` | The style sheet (`npm run css`) |
| `score-script.js` | The platform score script (high-score board) |

## Tests

```bash
npm test                # rules/content suite, save model, i18n, then native checks + play scripts
npm run test:browser    # the packaged web build in Chrome on the GPU (desktop, phone, landscape)
npm run plays           # regenerate tests/native/*.play from the rules
```

See `spec.md` for the full specification.
