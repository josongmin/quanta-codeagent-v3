/**
 * Pre-flight dispatch dedup gate (T3 — SOTA++ structural fix for bench
 * Type F "Verify-Loop Stuck on Env"). A pure, deterministic state machine that
 * detects identical (tool name + canonical args) calls within a sliding window
 * and short-circuits with a synthetic observation block instead of dispatching.
 *
 * Precedent: this mirrors {@link CompactionBreaker}'s anti-thrash discipline
 * (rapid-refill breaker, ADR-0011) applied one layer up — the breaker stops a
 * compact↔PTL spin; this gate stops a `pip install flask` × N spin. The
 * observed failure (pallets bench run): 17 turns repeating
 * `pip install flask` / `chmod` / `export PATH` etc, same command, same
 * observation, no environment delta. The classifier
 * (`apps/bench/corpus/failure-classifier.ts#hasVerifyLoopStuck`) detects this AFTER
 * the fact for grading — this gate is the BEFORE-the-fact pre-dispatch brake.
 *
 * Design properties:
 *  - **Pure-by-state**: no `Date.now()`, no `Math.random()`; the caller passes
 *    `turn` explicitly so the gate is deterministic and unit-testable.
 *  - **Per-session**: one instance per `runAgent` invocation (constructed in
 *    `loop.ts` at session start; absent in `AgentConfig` ⇒ no gate, byte-
 *    identical to the pre-gate path).
 *  - **Three-regime** (bucket KEY differs, not just the threshold):
 *      · general — exact `<name> <canonical-args>` (byte-identical spins).
 *      · env     — ALL env-mutating shell commands (pip/npm/apt/chmod/export/
 *        ensurepip/…) collapse to ONE bucket, so the same intent under many
 *        spellings counts together. Live failure (sklearn): 11 DIFFERENT
 *        commands chasing one missing dep — exact-match dedup never caught it.
 *      · edit    — one bucket per target file, so variant edits to the same
 *        file count together. Live failure (pallets): 13 variant edits to one
 *        `__init__`, none landing.
 *  - **No new event type**: blocked calls return a synthetic
 *    {@link ToolResultBlock} matching the deny-style helper in
 *    `dispatch-helpers.ts#resultBlock` — the loop's tool_result pipeline
 *    handles it like any other observation. Spec is `is_error:false` (this is
 *    guidance, not an error).
 */

import type { ToolResultBlock } from "@/llm"
import { runtimeConfig } from "@/shared"

/** Tunable caps. Defaults: general 8-turn/3-cap, env 4-turn/3-cap (single
 *  bucket), edit 8-turn/5-cap (per file). */
export interface DedupGateCaps {
  /** Sliding window (turns) for general (non-env, non-edit) tool calls. */
  generalWindow: number
  /** Block at the Nth identical call within `generalWindow`. */
  generalThreshold: number
  /** Sliding window (turns) for env-modifying bash commands. */
  envWindow: number
  /** Block at the Nth env-modifying command within `envWindow`. Counts ALL
   *  env-mutating commands in ONE bucket — not per exact string — because the
   *  observed thrash fires the SAME intent (install a dep) under many different
   *  spellings (`pip install x`, `python3 -m pip install x`, `apt-get …`,
   *  `brew …`, `ensurepip`), which exact-match dedup never catches. */
  envThreshold: number
  /** Sliding window (turns) for repeated edits to the SAME file. */
  editWindow: number
  /** Block at the Nth edit/scripted_replace to one file within `editWindow`.
   *  Edits DO mutate state (unlike env repeats), so this is forgiving — it
   *  catches "can't land the change, flailing on one file" (observed: 13
   *  variant edits to the same `__init__`), not normal iterative editing. */
  editThreshold: number
}

export const DEFAULT_DEDUP_GATE_CAPS: DedupGateCaps = {
  generalWindow: 8,
  generalThreshold: 3,
  envWindow: 4,
  envThreshold: 3,
  editWindow: 8,
  editThreshold: 5,
}

/** Env-modifying command prefixes (case-insensitive on the FIRST shell token).
 *  Hit ⇒ env regime (tighter window/threshold). Members:
 *
 *   - package managers: pip / pip3 / python -m pip / python3 -m pip /
 *     npm / yarn / pnpm / apt / apt-get / conda / brew
 *   - python bootstrap: python -m ensurepip / python -m venv
 *   - permission/ownership: chmod / chown
 *   - shell state: export
 *   - elevation: sudo (almost always wrapping one of the above)
 *
 *  In this harness env-modifying commands are deliberately NEVER allowed to
 *  succeed (the sandbox is read-only with respect to the system), so a few
 *  attempts past the first are pure thrash — hence the tight single-bucket
 *  cap (any 3 env attempts in the window, regardless of spelling).
 */
/** Audited default env-prefix body. Each alternative is a regex fragment
 *  (intentionally — `pip3?`, `python3?\s+-m\s+(?:pip|…)`, `apt(?:-get)?` carry
 *  internal alternation that a pure literal list can't express). Operator
 *  extras (`QUANTA_DEDUP_ENV_PREFIXES_EXTRA`) are added as ESCAPED literals
 *  so `uv`, `poetry`, `cargo install`, etc. can be appended without knowing
 *  regex syntax. */
const DEFAULT_ENV_PREFIX_BODY =
  "pip3?|python3?\\s+-m\\s+(?:pip|ensurepip|venv)|npm|yarn|pnpm|apt(?:-get)?|conda|brew|chmod|chown|export"

const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Build the env-detection regex from `DEFAULT_ENV_PREFIX_BODY` plus any
 *  operator-supplied literal prefixes (merge, not replace). Recomputed per
 *  call so test seams that flip `QUANTA_DEDUP_ENV_PREFIXES_EXTRA` and reset
 *  the runtime-config cache see the new value. */
const envPrefixRegex = (): RegExp => {
  const extras = runtimeConfig().dedupEnvPrefixesExtra
  const tail = extras
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map(escapeRegexLiteral)
    .join("|")
  const body = tail.length > 0 ? `${DEFAULT_ENV_PREFIX_BODY}|${tail}` : DEFAULT_ENV_PREFIX_BODY
  return new RegExp(`^(?:sudo\\s+)?(?:${body})\\b`, "i")
}

/** True when this bash command should be routed to the env regime. Operates
 *  on the FIRST clause only (everything before the first `;`/`&&`/`||`) so a
 *  chain like `pip install x && pytest` is classed env (the env half is the
 *  first action). Non-`bash` tools never reach this function. */
const isEnvBashCommand = (command: string): boolean => {
  // First clause only: a chain like `pip install x && pytest` is classed env
  // (pip leads). Conservative: misclassifying a chain as env only makes the
  // gate STRICTER, which is the safe direction for false positives.
  const head = command.split(/\s*(?:;|&&|\|\|)\s*/, 1)[0] ?? ""
  return envPrefixRegex().test(head.trimStart())
}

/** Deterministically canonicalize tool args for hashing.
 *
 *  Rules:
 *   - JSON.stringify with sorted keys (stable across object property order).
 *   - String values are trimmed and have runs of whitespace collapsed (so
 *     "`pip   install   flask`" and "`pip install flask`" hash identically).
 *   - Line endings normalized to `\n` (CRLF and LF hash identically).
 *   - Non-string scalars (numbers/booleans/null) pass through verbatim.
 *   - Arrays preserve order (semantic in tool arg shapes).
 *   - `undefined`-valued keys are dropped (JSON.stringify already does this).
 *   - Cycles fall through to a sentinel so a self-referential input does not
 *     throw (defensive — real tool inputs are JSON-serializable).
 *
 *  We deliberately do NOT drop `timeout_ms` or `cwd` — the spec calls for
 *  catching BYTE-identical repeats, not semantically-similar ones. Adding
 *  drops here is a one-line tweak if false positives appear in production.
 */
export const canonicalizeArgs = (args: unknown): string => {
  const seen = new WeakSet<object>()
  const normalize = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v
        .trim()
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+/g, " ")
    }
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[cycle]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(normalize)
    const sortedKeys = Object.keys(v as Record<string, unknown>).sort()
    const out: Record<string, unknown> = {}
    for (const k of sortedKeys) {
      const child = (v as Record<string, unknown>)[k]
      if (child === undefined) continue
      out[k] = normalize(child)
    }
    return out
  }
  try {
    return JSON.stringify(normalize(args))
  } catch {
    // Defensive: a non-serializable input (BigInt, function) yields an
    // unstable but unique enough fallback so the gate never throws.
    return `__nonser__:${String(args)}`
  }
}

/** Read the bash `command` field from a tool input shape. Returns `undefined`
 *  for non-bash tools or malformed inputs (treat as general). */
const bashCommandOf = (name: string, args: unknown): string | undefined => {
  if (name !== "bash") return undefined
  if (typeof args !== "object" || args === null) return undefined
  const cmd = (args as { command?: unknown }).command
  return typeof cmd === "string" ? cmd : undefined
}

/** Edit-family tools whose target file is bucketed for thrash detection.
 *  `edit`/`multi_edit` carry `path`; `scripted_replace` carries `file`. */
const EDIT_TOOLS = new Set(["edit", "multi_edit", "scripted_replace"])

/** Extract the normalized target file path for an edit-family tool, or
 *  `undefined` for non-edit tools / malformed inputs (treat as general). */
const editFileOf = (name: string, args: unknown): string | undefined => {
  if (!EDIT_TOOLS.has(name)) return undefined
  if (typeof args !== "object" || args === null) return undefined
  const rec = args as { path?: unknown; file?: unknown }
  const p = typeof rec.path === "string" ? rec.path : rec.file
  return typeof p === "string" ? p.trim() : undefined
}

/** Bucket regime + key for a candidate dispatch. The KEY (not just the
 *  threshold) is what differs per regime:
 *   - env:     ALL env-mutating commands collapse to one `__env__` bucket, so
 *              N attempts under different spellings count together.
 *   - edit:    one bucket per target file (`__edit__:<path>`), so variant
 *              edits to the same file count together.
 *   - general: exact `<name> <canonical-args>` (catches byte-identical spins). */
const bucketOf = (
  name: string,
  args: unknown,
): { regime: "general" | "env" | "edit"; key: string } => {
  const bashCmd = bashCommandOf(name, args)
  if (bashCmd !== undefined && isEnvBashCommand(bashCmd)) {
    return { regime: "env", key: "__env__" }
  }
  const editFile = editFileOf(name, args)
  if (editFile !== undefined) return { regime: "edit", key: `__edit__:${editFile}` }
  return { regime: "general", key: `${name} ${canonicalizeArgs(args)}` }
}

export type DedupVerdict =
  | { blocked: false }
  | { blocked: true; observation: string; count: number; regime: "general" | "env" | "edit" }

/** Per-session dedup gate. State is a `Map<hashKey, number[]>` — the list of
 *  turns at which the call was made. Lookups prune entries outside the
 *  active window on every `record()` call (cheap; bounded by threshold). */
export class DedupGate {
  private readonly caps: DedupGateCaps
  /** Hash key → ordered list of turns at which the call was issued (oldest
   *  first). Bounded: pruned to entries within `window` on every record. */
  private readonly history = new Map<string, number[]>()

  constructor(caps: Partial<DedupGateCaps> = {}) {
    this.caps = { ...DEFAULT_DEDUP_GATE_CAPS, ...caps }
  }

  /** Record a candidate dispatch. Returns `{blocked:false}` to proceed, or
   *  `{blocked:true, observation, ...}` to short-circuit with the synthetic
   *  observation message.
   *
   *  Even when BLOCKED the call is recorded — so a 4th identical attempt is
   *  blocked the same as the 3rd (the model gets the same observation until
   *  it changes tactic, which is the intended UX). This also keeps the state
   *  trivially testable: the count returned matches the number of identical
   *  calls observed including the current one. */
  record(name: string, args: unknown, turn: number): DedupVerdict {
    const { regime, key } = bucketOf(name, args)
    const window =
      regime === "env"
        ? this.caps.envWindow
        : regime === "edit"
          ? this.caps.editWindow
          : this.caps.generalWindow
    const threshold =
      regime === "env"
        ? this.caps.envThreshold
        : regime === "edit"
          ? this.caps.editThreshold
          : this.caps.generalThreshold

    const prior = this.history.get(key) ?? []
    // Prune entries outside the active window (we count "within last N turns
    // INCLUDING the current turn", so a turn is in-window when
    // `turn - prior >= 0 && turn - prior < window`).
    const kept: number[] = []
    for (const t of prior) {
      if (turn - t < window && turn - t >= 0) kept.push(t)
    }
    kept.push(turn)
    this.history.set(key, kept)

    if (kept.length < threshold) return { blocked: false }
    return {
      blocked: true,
      count: kept.length,
      regime,
      observation: buildObservation({ name, count: kept.length, window, regime }),
    }
  }

  /** Build a synthetic `tool_result` block for the blocked dispatch. The
   *  caller wires this into the dispatch path so the loop sees a normal
   *  observation (not an error) and the model gets the guidance text. */
  static syntheticResult(id: string, observation: string): ToolResultBlock {
    // Mirrors `dispatch-helpers.ts#resultBlock(id, content, false)`. Reused
    // shape — the loop's tool_result pipeline handles this exactly like any
    // other non-error observation.
    return {
      type: "tool_result",
      tool_use_id: id,
      content: observation,
    }
  }

  /** Internal state size, for telemetry / assertions only. */
  get size(): number {
    return this.history.size
  }
}

/** Render the observation text. Kept in a separate function so the exact
 *  wording is in one place (and trivially editable without touching the
 *  state machine). One message per regime — env and edit get tailored
 *  guidance because their thrash shapes (and the right corrective action)
 *  differ from a plain byte-identical repeat. */
const buildObservation = (args: {
  name: string
  count: number
  window: number
  regime: "general" | "env" | "edit"
}): string => {
  if (args.regime === "env") {
    return (
      `[dedup-gate] You have attempted ${args.count} environment-modifying commands ` +
      `in the last ${args.window} turns (install / package-manager / chmod / etc, ` +
      `under various spellings). These are NOT permitted in this harness — the ` +
      `sandbox is read-only with respect to the system, so no spelling will ` +
      `succeed. Stop trying to change the environment: if a dependency is missing, ` +
      `declare the environment unavailable for verification and finish with your ` +
      `code change as the deliverable.`
    )
  }
  if (args.regime === "edit") {
    return (
      `[dedup-gate] You have edited this same file ${args.count} times in the last ` +
      `${args.window} turns without the change landing. Repeating variant edits is ` +
      `flailing. Re-read the current file state, run the test to see the ACTUAL ` +
      `failure, then reconsider — do not keep trying spelling variants of the same edit.`
    )
  }
  return (
    `[dedup-gate] This exact tool call (${args.name}) was issued ${args.count} times in ` +
    `the last ${args.window} turns and produced the same observation each time. ` +
    `Repeating it will not change state. Change tactic: try a different file, ` +
    `a different command, or declare done.`
  )
}
