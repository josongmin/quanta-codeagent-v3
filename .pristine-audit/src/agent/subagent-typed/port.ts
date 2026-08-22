/**
 * Mode-typed delegation port (ADR-0218).
 *
 * 4-vendor convergence absorption:
 *   - Roo Boomerang/Orchestrator: parent → child mode-typed subtask (Architect /
 *     Debug / TDD), isolated context, result-only boomerang.
 *   - Devin sub-task delegation: typed handoff with a named role.
 *   - Codex `spawn_agent({ role: "explorer|worker|none" })`: closed role enum
 *     drives child registry filter + budget.
 *   - Cursor `subagent_await` family: handle-based async control surface.
 *
 * Distinct from {@link BackgroundSubagentScheduler} (ADR-0130): the BG
 * scheduler is a GENERIC worker — any prompt, no posture. This port adds the
 * MODE TYPING — every delegation declares its mode up front, which selects
 * (a) the child's prompt voice (b) the child's tool subset (c) the child's
 * budget cap. The two slices are complementary: the typed-delegation router
 * can wrap a BackgroundSubagentScheduler runner without modification.
 *
 * Plane-clean: this file is types-only. NO imports from `@/agent/loop`,
 * `@/agent/dispatch`, `@/llm`, `@/tool`. The injected runner is the sole
 * bridge to the actual agent loop.
 *
 * Default-OFF: the loop never constructs a `DelegationPort`. Callers (apps /
 * tier1 builders / future CLI command) opt in by wiring one through
 * `AgentConfig` — when the slot is absent the ToolRegistry stays
 * byte-identical and no mode-typed child is ever spawned.
 *
 * Contracts (5):
 *   1. NO-THROW on `delegate()` for budget overflow / mode missing —
 *      surfaces as `BoomerangResult { ok:false, errorKind:"…" }`. THROWS
 *      only for programmer-bug input (unknown mode passed at runtime when
 *      the closed-enum was bypassed via type assertion). Cap-exceeded is a
 *      caller-visible operational failure, not a throw.
 *   2. PARENT CONTEXT ISOLATION — the child runs in its OWN conversation;
 *      the parent never sees the child's intermediate messages. Only the
 *      typed `BoomerangResult` crosses the boundary.
 *   3. CANCELLATION PROPAGATION — `parentCtx.signal` (when present) chains
 *      into the child's signal. An abort on the parent unwinds the child
 *      synchronously; the boomerang result carries `errorKind:"cancelled"`.
 *   4. exactOptionalPropertyTypes — optional fields are OMITTED when absent,
 *      never `undefined`-set.
 *   5. BUDGET ENFORCEMENT — every mode has a `maxTurns` cap; an explicit
 *      `budget.maxTurns` greater than the mode cap is REJECTED before
 *      spawn (returns `errorKind:"budget-overflow"`).
 */

/** Local re-export of the same partition Codex uses for role policy
 *  (mirrors `@/subagent/role.ts:TOOL_KINDS`). Declared inline so this slice
 *  has no cross-slice import on `@/subagent` for the type alone — we only
 *  need the union of names, not the table. If a new bucket lands in
 *  `@/subagent/role.ts`, the cross-check in
 *  `tests/unit/subagent-mode-typed-hellgate.test.ts` catches the drift. */
export type ToolKind = "read" | "edit" | "shell" | "network" | "subagent" | "memory" | "lsp"

/** Mode enum — closed set (ADR-0218). Each entry maps to ONE
 *  {@link ModeProfile} in the registry. Adding a mode is a 2-step change:
 *  (a) extend this union, (b) add the matching row to
 *  `default-mode-registry.ts`. The registry's exhaustiveness test catches
 *  the omission at build time. */
export type AgentMode = "architect" | "editor" | "debug" | "tdd" | "explore"

/** Read-only list — handy for iteration + exhaustiveness in tests. */
export const AGENT_MODES: readonly AgentMode[] = Object.freeze([
  "architect",
  "editor",
  "debug",
  "tdd",
  "explore",
])

/** Per-mode profile read out of the registry by the delegation router. The
 *  `systemPromptVariant` is a CALLER-supplied string today — the actual
 *  per-mode persona variants live in `src/agent/mode.ts` (in flight on a
 *  separate track, owned by W1-7 agents). This slice intentionally does NOT
 *  import or mutate `mode.ts`; instead the registry stores a NAME the
 *  caller maps to its own variant table. When the persona variant lookup
 *  returns nothing the mode still works — `systemPromptVariant` is then
 *  treated as untyped guidance text. */
export interface ModeProfile {
  /** The mode this profile is for — must equal the registry key. */
  readonly mode: AgentMode
  /** Free-form name the host can use to look up a system-prompt variant
   *  in `src/agent/mode.ts` (or anywhere else). Read-only from this slice. */
  readonly systemPromptVariant: string
  /** Allowlist of tool KINDS the child is permitted to use. Mirrors
   *  {@link ToolKind} from `@/subagent/role` so the registry can derive
   *  the same per-kind shape Codex uses for role policy. Empty array ⇒
   *  inherit parent. */
  readonly allowedToolKinds: readonly ToolKind[]
  /** Hard ceiling on child turns. Caller-supplied `budget.maxTurns` may
   *  be SMALLER but not LARGER — exceed ⇒ {@link BoomerangResult} with
   *  `errorKind:"budget-overflow"`. */
  readonly maxTurns: number
  /** Hard ceiling on child tokens (provider-counted). Same overflow
   *  semantics as `maxTurns`. */
  readonly maxTokens: number
  /** One-line human-readable rationale — surfaced in observability. */
  readonly rationale: string
}

/** The closed shape of a finished delegation. ONLY this crosses the
 *  parent/child boundary — no intermediate messages, no tool transcripts. */
export interface BoomerangResult {
  /** Whether the child reached a terminal SUCCESS state. */
  readonly ok: boolean
  /** Short summary (≤200 chars) suitable for surfacing in a status bar. */
  readonly summary: string
  /** Mode that was actually invoked (echo of the request, for trace). */
  readonly mode: AgentMode
  /** Artifacts the child produced. Free-form NAMED key/value pairs the
   *  caller agreed on with the child via the mode profile's prompt
   *  (e.g. `{ "plan.md": "..." }`). Absent when child produced none. */
  readonly artifacts?: Readonly<Record<string, string>>
  /** Number of model turns the child consumed. 0 when not yet started. */
  readonly turns: number
  /** Provider-counted token cost. Absent when the runner does not report. */
  readonly tokens?: number
  /** Wall-clock duration (ms). */
  readonly durationMs: number
  /** Closed error-kind union — present iff `ok === false`. */
  readonly errorKind?: BoomerangErrorKind
  /** Free-form error message — present iff `errorKind` is set. */
  readonly errorMessage?: string
}

/** Closed union of failure modes the boomerang surface can report. The host
 *  branches on this; no prose parsing. */
export type BoomerangErrorKind =
  | "cancelled"
  | "budget-overflow"
  | "mode-missing"
  | "runner-error"
  | "timeout"

/** A delegation request handed to {@link DelegationPort.delegate}. The mode
 *  is REQUIRED — there is no "default" mode in this slice (the host should
 *  use the generic ADR-0130 BG scheduler when no mode posture is needed). */
export interface DelegationRequest {
  readonly mode: AgentMode
  readonly prompt: string
  /** Optional per-call budget cap — must be ≤ the mode's cap. */
  readonly budget?: {
    readonly maxTurns?: number
    readonly maxTokens?: number
  }
  /** Optional parent-side cancellation. When the signal fires, the child
   *  unwinds; the boomerang carries `errorKind:"cancelled"`. */
  readonly parentSignal?: AbortSignal
  /** Optional opaque metadata the host can use to correlate child to
   *  parent (e.g. a parent turn id). Pure passthrough — never inspected. */
  readonly correlation?: Readonly<Record<string, string>>
}

/** Closed port: parent → child mode-typed handoff with isolated context. */
export interface DelegationPort {
  /** Spawn a child agent under the given mode. Resolves when the child
   *  reaches a terminal state OR `parentSignal` fires. NEVER throws for
   *  operational failures — they surface in {@link BoomerangResult.errorKind}. */
  delegate(req: DelegationRequest): Promise<BoomerangResult>
  /** List all known modes — pure passthrough from the registry. Useful for
   *  surfacing the mode picker to the host UI. */
  listModes(): readonly AgentMode[]
  /** Read-only profile lookup. Returns `null` for unknown mode (no throw —
   *  callers branch). */
  describeMode(mode: AgentMode): ModeProfile | null
}

/** Thrown by {@link assertKnownMode} for runtime-only mode-enum bypass via
 *  type assertion. Programmer-bug surface — operational mode-missing is a
 *  {@link BoomerangResult} with `errorKind:"mode-missing"`. */
export class UnknownModeError extends Error {
  override readonly name = "UnknownModeError"
  readonly mode: string
  constructor(mode: string) {
    super(`unknown agent mode '${mode}' (not in AGENT_MODES)`)
    this.mode = mode
  }
}

/** Defensive runtime guard for callers that received an `AgentMode` value
 *  from an untyped source (env, JSON). Throws {@link UnknownModeError} on
 *  miss. Pure — no IO. */
export const assertKnownMode = (mode: string): AgentMode => {
  if ((AGENT_MODES as readonly string[]).includes(mode)) return mode as AgentMode
  throw new UnknownModeError(mode)
}
