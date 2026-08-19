/**
 * Pocket Companion — session layer.
 * Owns the live rules state; every mutation goes through a validated command.
 * Tracks an undo stack (practice), a replay envelope, and periodic hashes.
 */
import * as rules from './rules.js';
import { contentHash, CONTENT_VERSION, BUILD_VERSION } from './content.js';

export class Session {
  /**
   * @param contentCfg content definition (stage/practice/daily/challenge)
   * @param opts { undo:boolean, ranked:boolean, mode:string }
   */
  constructor(contentCfg, opts = {}) {
    this.content = contentCfg;
    this.mode = opts.mode || 'practice';
    this.ranked = !!opts.ranked;
    this.undoEnabled = !!opts.undo;
    this.state = rules.createGame(contentCfgToRules(contentCfg));
    this.initialHash = rules.hashState(this.state);
    this.envelope = {
      schemaVersion: 1,
      build: BUILD_VERSION,
      contentVersion: CONTENT_VERSION,
      stageId: this.state.stageId,
      seed: this.state.seed,
      initialHash: this.initialHash,
      timestampOffset: opts.timestampOffset || 0,
      startedAt: opts.now || Date.now(),
      commands: [],
      hashChain: [],   // every 10 commands: {n, hash}
      result: null,
      assists: opts.assists || [],
    };
    this._undoStack = [];
    this._awayBaseline = null;
  }

  /** Submit a player action. Always routed through the rules engine. */
  act(type, args = {}) {
    const snapshot = this.undoEnabled ? rules.serialize(this.state) : null;
    const cmd = rules.makeCommand(type, args);
    const result = rules.applyCommand(this.state, cmd);
    if (result.duplicate) return result;
    if (result.ok && this.undoEnabled) {
      this._undoStack.push(snapshot);
      if (this._undoStack.length > 64) this._undoStack.shift();
    }
    this.envelope.commands.push({ id: cmd.id, type: cmd.type, args: cmd.args });
    if (this.envelope.commands.length % 10 === 0) {
      this.envelope.hashChain.push({ n: this.envelope.commands.length, hash: rules.hashState(this.state) });
    }
    if (rules.isTerminal(this.state) && !this.envelope.result) {
      this.envelope.result = {
        status: this.state.status,
        reason: this.state.terminalReason,
        score: rules.scoreBreakdown(this.state),
        finalHash: rules.hashState(this.state),
        ticks: this.state.tick,
        invalidAttempts: this.state.invalidAttempts,
      };
    }
    return result;
  }

  /** Undo the last command where rules permit (practice mode). */
  undo() {
    if (!this.undoEnabled || this._undoStack.length === 0) return false;
    const snap = this._undoStack.pop();
    this.state = rules.deserialize(snap);
    // Mirror the undo in the envelope so replays stay honest.
    this.envelope.commands.pop();
    return true;
  }

  get legal() { rules.refreshCraving(this.state); return rules.legalActions(this.state); }
  get score() { return rules.scoreBreakdown(this.state); }
  get bondLevel() { return rules.bondLevel(this.state); }
  get terminal() { return rules.isTerminal(this.state); }

  snapshot() { return rules.serialize(this.state); }

  /** Restore from a durable snapshot; returns a "while you were away" diff. */
  static restore(contentCfg, snapshot, opts = {}) {
    const s = new Session(contentCfg, opts);
    const before = rules.serialize(s.state);
    s.state = rules.deserialize(snapshot);
    s.envelope = opts.envelope || s.envelope;
    const diff = {
      ticks: s.state.tick - before.tick,
      needs: Object.fromEntries(Object.keys(s.state.needs).map((k) => [k, s.state.needs[k] - before.needs[k]])),
      scoreDelta: rules.scoreBreakdown(s.state).total - rules.scoreBreakdown(before).total,
    };
    return { session: s, away: diff };
  }

  markAwayBaseline() { this._awayBaseline = this.snapshot(); }

  /** Diff between the marked baseline and now (for backgrounding pauses). */
  awaySummary() {
    if (!this._awayBaseline) return null;
    const base = rules.deserialize(this._awayBaseline);
    const cur = this.state;
    return {
      ticks: cur.tick - base.tick,
      scoreDelta: rules.scoreBreakdown(cur).total - rules.scoreBreakdown(base).total,
      statusChanged: base.status !== cur.status,
    };
  }

  /** Export the replay envelope for validation/submission. */
  exportReplay() {
    return JSON.parse(JSON.stringify({
      ...this.envelope,
      contentCfgHash: contentHash(this.content),
    }));
  }
}

function contentCfgToRules(cfg) {
  return {
    stageId: cfg.stageId || cfg.id,
    seed: cfg.seed,
    tickLimit: cfg.tickLimit,
    maxCommands: cfg.maxCommands,
    decay: cfg.decay,
    goals: cfg.goals,
    allowedActions: cfg.allowedActions,
    allowedDecor: cfg.allowedDecor,
    startNeeds: cfg.startNeeds,
    cravingEvery: cfg.cravingEvery,
    timeBonusPerTick: cfg.timeBonusPerTick,
  };
}

/**
 * Replay a command log against a content config and verify hashes.
 * Shared by the client (replay viewing) and the authoritative server.
 */
export function verifyReplay(contentCfg, envelope) {
  if (!envelope || envelope.schemaVersion !== 1) return { ok: false, reason: 'bad-envelope' };
  if (envelope.contentVersion !== CONTENT_VERSION) return { ok: false, reason: 'stale-version' };
  if (contentHash(contentCfg) !== envelope.contentCfgHash) return { ok: false, reason: 'content-mismatch' };
  if (!Array.isArray(envelope.commands) || envelope.commands.length > 5000) return { ok: false, reason: 'bad-commands' };
  const state = rules.createGame(contentCfgToRules(contentCfg));
  if (rules.hashState(state) !== envelope.initialHash) return { ok: false, reason: 'initial-hash-mismatch' };
  const chain = new Map((envelope.hashChain || []).map((h) => [h.n, h.hash]));
  for (let i = 0; i < envelope.commands.length; i++) {
    const c = envelope.commands[i];
    if (!c || typeof c.type !== 'string' || c.type.length > 32) return { ok: false, reason: 'bad-command', at: i };
    const r = rules.applyCommand(state, { id: String(c.id ?? `r${i}`), type: c.type, args: c.args || {} });
    if (!r.ok && !r.reason) return { ok: false, reason: 'apply-failed', at: i };
    const link = chain.get(i + 1);
    if (link && link !== rules.hashState(state)) return { ok: false, reason: 'hash-chain-mismatch', at: i };
  }
  const finalHash = rules.hashState(state);
  if (envelope.result && envelope.result.finalHash !== finalHash) return { ok: false, reason: 'final-hash-mismatch' };
  return {
    ok: true, finalHash,
    status: state.status,
    score: rules.scoreBreakdown(state),
    ticks: state.tick,
    invalidAttempts: state.invalidAttempts,
  };
}
