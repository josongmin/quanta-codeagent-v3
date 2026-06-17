/**
 * Localize-phase guard (Agentless "localize-first" absorption — Tier 0 safety
 * hardening). Pure, deterministic policy: no LLM, no I/O. Addresses an observed
 * SWE-bench Verified failure pattern — the model edits `adapters.py` on the
 * FIRST turn when the gold patch lives in `models.py`. The `localize` tool
 * exists but is not FORCED, so the model skips exploration and edits straight
 * into the wrong file. `search_codebase` now covers broad repo search, but the
 * guard still exists because broad search is not the same as pinning the edit
 * owner for a concrete fault.
 *
 * Agentless's 3-phase pipeline keeps fault-localization as a HARD boundary
 * before the repair phase: file/function must be confirmed before any edit.
 * That phase is one of the validated contributors to its 41.5% on SWE-bench
 * Verified. This module mirrors the boundary at the DISPATCH SEAM: during the
 * first N turns of a run, mutating tools (`edit`, `write`, `scripted_replace`)
 * are blocked with a reminder steering the model to `search_codebase`/`read`/
 * `grep`/`glob`/`localize` first.
 *
 * Pure / cycle-safe: no imports from sibling agent modules. State is owned by
 * the loop (one instance per `runAgent` invocation) and threaded as a single
 * arg into {@link decideLocalizePhase}. Absent config OR absent state ⇒
 * `{ block: false }` (byte-identical to the pre-feature loop).
 */

/** Per-session phase tracker. `turn` is the 0-indexed turn counter the loop
 *  increments at the TOP of each turn (turn 0 ⇒ first turn). */
export interface LocalizePhaseState {
  turn: number
}

/** Fresh state for a session — turn 0, no edits seen yet. */
export const createLocalizePhaseState = (): LocalizePhaseState => ({ turn: 0 })

/** Guard configuration.
 *
 *  - `phase1Turns` — number of leading turns during which mutating tools are
 *    blocked. Domain: integer >= 1. Anything else (undefined, < 1, NaN, Infinity)
 *    ⇒ guard FULLY OFF (byte-identical loop).
 *
 *  Closed shape (no extra fields). New invariants need a new ADR + a config
 *  bump — the bench wiring depends on this surface being narrow + obvious. */
export interface LocalizePhaseConfig {
  /** Phase-1 turn count. Integer >= 1; absent / invalid ⇒ guard OFF. */
  phase1Turns?: number
  /** Append the LSP-nav grounding steer ({@link LSP_GROUNDING_STEER}) to the
   *  Phase-1 block message. DEFAULT-ON in bench whenever LSP nav is on (set by
   *  `benchPostureFromState`); suppressed by `QUANTA_BENCH_LSP_STEER=off` (the
   *  A/B baseline). Absent here ⇒ the original (pre-steer) message. */
  lspGroundingSteer?: boolean
}

/**
 * The set of tools considered mutating for the purposes of this gate.
 *
 * CLOSED SET (fail-open by design):
 *   - `edit`              — applies a unified diff to a file
 *   - `write`             — creates/overwrites a file
 *   - `scripted_replace`  — sed-style scripted edit
 *
 * NOT in the set (intentional):
 *   - `bash`              — covers a huge legitimate non-mutating surface
 *                           (test runs, greps, file reads via `cat`); blocking
 *                           bash would force the model to use slower dedicated
 *                           tools for every probe and break verify/repro flow.
 *                           A `bash` with `>` redirection IS technically
 *                           mutating but we accept the trade-off — the loss
 *                           of measurement-grade phase enforcement here is
 *                           outweighed by the cost of breaking bash entirely.
 *   - `search_codebase`/`read`/`grep`/`glob`/`localize` — non-mutating
 *                           exploration tools, the whole point is to
 *                           ENCOURAGE these.
 *
 * Adding a new mutating tool (e.g. `multi_edit`) requires explicitly listing
 * it here AND updating the ADR — silent-coverage would be a security/policy
 * regression. The closed set is exported for invariant tests.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "scripted_replace",
  // apply_patch (V4A multi-file patch, isReadOnly:()=>false) is a REGISTERED
  // mutating-FS edit tool that previously ESCAPED this Phase-1 block (audit #10),
  // letting the model edit the wrong file before the fault was localized. Added
  // EXPLICITLY here (the closed-set design) — NOT via raw isReadOnly, which would
  // also wrongly gate `bash` (a deliberately-exempt tool: isReadOnly===false but
  // not a file-edit tool).
  "apply_patch",
  // apply_patch_structured (src/tool/apply-patch-structured-tool.ts, name
  // "apply_patch_structured", isReadOnly:()=>false) is the SIBLING registered
  // structured-op variant of apply_patch — same audit #10 mutating-FS class. The
  // original fix added only the string-patch "apply_patch" and missed this sibling,
  // so the model could apply_patch_structured the WRONG file before localization.
  // Added EXPLICITLY (closed-set design).
  "apply_patch_structured",
])

/** Opt-in LSP-nav GROUNDING sentence appended to the Phase-1 nudge.
 *
 *  Measured gap (easy-django bench transcripts): the nav tools are wired +
 *  sandbox-rooted + live, but the model reaches for them in ~0% of runs,
 *  defaulting to grep — which causes the two failure modes seen in the hard-tier
 *  causal audit: (1) OWNER MISLOCATION (text match lands on the wrong
 *  class/override; `lsp_definition` resolves the method that actually runs) and
 *  (2) MISSED MULTI-FILE CO-CHANGE (`lsp_references` surfaces every call site
 *  that must change together). A NUDGE, not a hard gate — pyright over-reports
 *  on Django dynamics, so we never block on it.
 *
 *  In bench this ships DEFAULT-ON (coupled to LSP nav in `benchPostureFromState`);
 *  the A/B baseline is `QUANTA_BENCH_LSP_STEER=off`, which suppresses it so the
 *  Phase-1 message reverts to the original (pre-steer) text. The builder default
 *  (`lspSteer=false`) keeps the original message for any non-bench caller. */
export const LSP_GROUNDING_STEER =
  " Before editing a symbol you found by text search, confirm its TRUE owner with `lsp_definition` (go-to-definition — a text match often points to the wrong class or an override, not the method that actually runs) and use `lsp_references` (find-references) to surface every call site that may have to change together for a multi-file fix."

/** The forcing nudge injected when a mutating tool is attempted in Phase 1.
 *  Builder, not constant — the turn header `(turn N/M)` needs interpolation.
 *  `lspSteer` (default false) appends {@link LSP_GROUNDING_STEER}; false keeps
 *  the byte-identical frozen-`agentless-v1` message. */
export const buildLocalizePhaseForceMessage = (
  turn: number,
  phase1Turns: number,
  lspSteer = false,
): string =>
  `Phase 1 (localization, turn ${turn + 1}/${phase1Turns}): edits are blocked until you have identified the exact file and function to modify. Use \`search_codebase\` for broad repo search, \`localize\` for fault localization, then \`read\`, \`grep\`, or \`glob\` to confirm the candidate location.${lspSteer ? LSP_GROUNDING_STEER : ""} Re-confirm by reading the candidate location, then proceed.`

/** Is `phase1Turns` a positive integer (the only ACTIVE configuration)? Any
 *  other value (undefined, 0, negative, NaN, Infinity, non-integer) ⇒ FALSE
 *  ⇒ guard OFF. Closed predicate — the bench-wiring + hellgate suites pin
 *  exactly the active domain here. */
const isActivePhase1Turns = (n: unknown): n is number => {
  if (typeof n !== "number") return false
  if (!Number.isFinite(n)) return false
  if (!Number.isInteger(n)) return false
  return n >= 1
}

/**
 * Decide whether to block a mutating tool dispatch during Phase 1.
 *
 *  - `cfg === undefined` ⇒ `{ block: false }` (no config ⇒ guard OFF).
 *  - `cfg.phase1Turns` not a positive integer ⇒ `{ block: false }` (invalid
 *    config ⇒ guard OFF — no silent half-enabled state).
 *  - `state.turn >= phase1Turns` ⇒ `{ block: false }` (Phase 2 — pass-through).
 *  - `state.turn < phase1Turns` AND tool ∈ MUTATING_TOOL_NAMES ⇒ block with the
 *    Phase 1 reminder. search_codebase/read/grep/glob/localize and other
 *    non-mutating tools pass through.
 *
 * Pure: reads `state.turn` and `cfg.phase1Turns`; never mutates either. Idempotent
 * — calling twice with the same args yields the same decision (no side effects).
 *
 * The state's `turn` field is mutated by the LOOP at turn-top (state.turn = N),
 * not by this guard. That keeps the gate stateless w.r.t. dispatch ordering —
 * two mutating tools in the same turn each see the same `turn` value and each
 * get the same block decision.
 */
export const decideLocalizePhase = (args: {
  toolName: string
  state: LocalizePhaseState | undefined
  cfg: LocalizePhaseConfig | undefined
}): { block: boolean; text?: string } => {
  const { toolName, state, cfg } = args
  if (cfg === undefined) return { block: false }
  if (state === undefined) return { block: false }
  const phase1Turns = cfg.phase1Turns
  if (!isActivePhase1Turns(phase1Turns)) return { block: false }
  // Phase 2 — passthrough. `state.turn` is 0-indexed (turn 0 = first turn),
  // so `state.turn < phase1Turns` is the in-phase predicate.
  if (state.turn >= phase1Turns) return { block: false }
  // Phase 1 — only mutating tools are blocked; everything else passes.
  if (!MUTATING_TOOL_NAMES.has(toolName)) return { block: false }
  return {
    block: true,
    text: buildLocalizePhaseForceMessage(state.turn, phase1Turns, cfg.lspGroundingSteer === true),
  }
}
