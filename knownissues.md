# Known Issues — Pocket Companion

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and a headless-Chrome boot/mode/crawl sweep.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 127 pass, 0 failed (4 golden sessions + content validation) |
| `node --check` on all modules | clean (9 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present — replaced by an ad-hoc CDP boot/mode/crawl sweep (see below) |

Ad-hoc headless-Chrome coverage: boot with 0 console errors and 0 failed requests, all six mode
cards opened (Learn, Journey, Daily, Practice, Challenge, Score Chase), sessions started from
Daily/Practice/Challenge/Chase and driven through hint/undo/pause/resume, care actions (Wash,
Sing, …) clicked in-round, a **Daily session played to completion** (55 care actions → "Session
complete — Mote is thriving!", full itemised breakdown, three achievements, and a validated
leaderboard submission, all with 0 console errors), a 70-click random UI crawl (0 errors), and a
corrupt-`localStorage` reload matrix (`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

This is the cleanest of the eight games in this batch: the score-submission path is genuinely
authoritative and no runtime error was produced by any path exercised.

## Confirmed defects

Defects below were each verified by reading the source, not just reported by the model.

### 1. The `ticks > 4000` plausibility bound is applied to a client-declared value, so it cannot bite

- **File:** `server.js:74-82` (`plausible`) called from `server.js:143`
- **Trigger:** Submit a replay whose real length exceeds 4000 ticks with `"ticks": 0` in the
  request body.
- **Behaviour:** The helper's parameter is named `verified`, but the call site passes unverified
  client fields:

  ```js
  if (!plausible(replay, { score: { total: Number(body.score) || 0 }, ticks: Number(body.ticks) || 0 }))
    return json(res, 400, { error: 'implausible-score' });
  ```

  The score half is later reconciled against the replay (`server.js:149`
  `verified.score.total !== Number(body.score)`), so the score bound is effectively enforced.
  `ticks` never is: `server.js:154` stores the authoritative `verified.ticks` on the entry, but
  nothing ever compares it to the bound. A run of any duration passes the guard by declaring
  `ticks: 0`.
- **Expected:** Run the plausibility bounds against the values returned by `verifyReplay`, after
  validation — which is what the function's own doc comment ("applied even when replay validation
  succeeds") describes.
- **Evidence:** The two quoted locations; `verified.ticks` appears nowhere between `server.js:147`
  and the entry construction at `server.js:153`.

### 2. `assists` on a validated board entry is client-declared

- **File:** `server.js:156`
- **Trigger:** Submit a ranked result with `"assists": []`.
- **Behaviour:** Every other field of the entry is taken from the authoritative verdict
  (`verified.score.total`, `verified.ticks`, `verified.invalidAttempts`, `cfg.stageId`,
  `cfg.seed`), but the assist list is copied from the request:

  ```js
  assists: Array.isArray(body.assists) ? body.assists.slice(0, 4) : [],
  ```

  A player who used hints or undo can therefore appear on a ranked board as unassisted.
- **Expected:** spec.md:203 — "Include ruleset, content version, seed, assists, and duration with
  every submission; reject impossible or stale-version scores." The assist set should be
  authoritative like every neighbouring field.
- **Evidence:** The quoted line, contrasted with the surrounding authoritative fields. Note the
  server currently *cannot* re-derive it: `Session.undo` (`src/session.js:67-74`) deliberately pops
  the undone command back off the envelope ("Mirror the undo in the envelope so replays stay
  honest"), so assist usage leaves no trace in the replay. Undo is only offered in unranked
  practice (`src/main.js:290`), which limits the impact, but the ranked `assists` value — e.g.
  `'timing-assist'` from `src/main.js:285-292` — is still whatever the client says it is.

## Suspected — not confirmed

### 1. `excluded` is hard-coded `false` on the daily descriptor

- **File:** `server.js:112`
- **Concern:** `ruleset: cfg.stageId, excluded: false, // defective days are excluded, never replaced`
  — the field exists and the comment states the intended policy, but nothing can ever set it to
  `true`; there is no store of excluded days and no admin path.
  spec.md §Difficulty and content generation: "If content is defective, mark the day excluded from
  ranking rather than silently replacing it."
- **Why unconfirmed:** The exclusion mechanism may legitimately live in the StarHermit host rather
  than in this script.

## Investigated and rejected

### Model claim: `decorate` has no `gate`

The model review claimed `src/rules.js:104` defines the `decorate` action without a `gate`, so
`isLegal` would return `undefined`. **This is false.** `decorate` has a full gate at
`src/rules.js:108-112` (`(s, args) => { … return 'unknown-item' … return null; }`). Recorded here
only so the claim is not re-investigated.

## Checked, no defects found

- Suspend/resume: entered a round, performed an action, reloaded the page, and confirmed the
  game re-boots with its snapshot intact and no console errors or failed requests.
- `src/rules.js` + `src/session.js`: need decay, action gates and invalid reasons, bond/trust
  progression, discovery tracking, `checkTerminal` (goals-met / neglected / expired), integer
  scoring with itemised components, serialization and defensive re-clamping on load. All 127 tests
  pass including four golden sessions with stable hashes.
- spec.md:38's "neglect never causes permanent loss": verified by reading `_finishSession`
  (`src/main.js:558-593`) and `src/storage.js:143-165` — a `neglected` session still records
  discoveries, best scores, `sessionsPlayed` and achievements; nothing persistent is rolled back.
- `server.js` score submission is otherwise authoritative: `verifyReplay(cfg, replay)` drives the
  stored score/ticks/invalidAttempts, `verified.status !== 'complete'` is rejected, the entry id is
  derived from the replay hash for idempotency, and the board sort (`server.js:164`) implements the
  spec tie-break (score → invalidAttempts → ticks → stable id) correctly — one of the few games in
  this batch that does.
- Static serving: paths outside `ROOT`, anything containing `data/`, and `server.js` itself are
  403'd (`server.js:184`).
- Persistence: `pocket-companion:profile`, `:last-session` and `:boards` survive five kinds of
  corruption; `migrateProfile` (`src/storage.js:169`) backfills v1 → v2 fields.
- Determinism: no `Math.random` in the simulation — the only uses are a fallback command id
  (`src/rules.js:244`), practice seed selection, and audio/particles.

## QA side effects

- `data/leaderboards.json` already existed in the repo before this pass (dated 2026-08-19).
  Completing a Daily session in headless Chrome appended one genuine validated entry to it
  (`daily:2026-08-20`, name "Guest", score 3161, ticks 141). Left in place for central cleanup.

## Not tested

- `src/render.js` visual output beyond "boots and draws without errors"; headless SwiftShader
  cannot judge the acceptance criteria in spec.md §4.
- A full ranked round submitted end-to-end through `POST /api/v1/boards/<id>/submit`: producing a
  genuine winning replay envelope by synthetic clicking was out of scope, so defect 1 was
  established by reading rather than by a live submission.
- Touch, gamepad and haptics paths.
