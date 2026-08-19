# Pocket Companion

A cozy companion-care game: feed, clean, entertain, and rest **Mote**, an expressive
little creature living in a customizable room. Turn-based and fully deterministic —
every session is a replayable, hash-verified log of your commands.

## Run

```bash
node server.js          # serves the game + validated leaderboards on :8080 (PORT env to change)
# or any static file server works for offline/local play:
python3 -m http.server  # then open http://localhost:8000
```

No build step, no dependencies (Three.js r160 is vendored in `vendor/`).

## Modes

- **Learn** — five interactive lessons; each requires performing the real action.
- **Journey** — 48 authored stages in 6 chapters with mastery trials.
- **Daily** — one shared immutable seed per UTC day; replay-validated ranked board.
- **Practice** — selectable difficulty, undo, never ranked.
- **Challenge** — move limits, speed targets, restricted tools.
- **Score Chase** — asynchronous board on a shared seed.

## Architecture

| Path | Role |
| --- | --- |
| `src/rules.js` | Pure deterministic rules engine (integer permille math, seeded mulberry32 streams, legal-action API, scoring, serialization/migration, state hashing) |
| `src/content.js` | Versioned content: themes, decor, 48 stages, lessons, challenges, daily generator, offline validator |
| `src/session.js` | Command routing, undo, replay envelopes, snapshot restore, replay verification |
| `src/storage.js` | Versioned, checksummed local saves; achievements; casual boards |
| `src/platform.js` | Host adapter: launch token, time sync, presence, telemetry consent, API fallback |
| `src/render.js` | Three.js scene (procedural room + creature, pooled particles, quality tiers) |
| `src/audio.js` | WebAudio synth: buses, seeded variants, captions hooks |
| `src/ui.js` / `index.html` / `css/style.css` | Semantic DOM shell: responsive breakpoints, focus management, keyboard/gamepad, accessibility |
| `server.js` | Zero-dependency Node authoritative script: static hosting, time, daily info, replay-validated leaderboards |
| `starhermit.txt` | StarHermit packaging manifest (`name`, `launch`, `server`) |

## Tests

```bash
node tests/run.mjs              # unit + property + fuzz + golden + content validation (127 checks)
node tests/validate-content.mjs # content gate only (legality, reachability, bounded, no soft locks)
node tests/tune.mjs             # balance probe: greedy-solve report for every stage
```
