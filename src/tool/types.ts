import type { z } from "zod"
import type { SensitivityClass } from "@/security"
import type { HITLTier } from "@/shared"
import type { ShellExecObserver } from "./shell-exec-types"

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Subagent recursion depth of the agent that owns this call (0 = root).
   *  Optional + duck-typed: the subagent slice reads it to enforce maxDepth;
   *  absent ⇒ treated as 0. Propagated by the dispatch seam from
   *  `AgentConfig.depth` (subagent absorption, ADR-0011). */
  depth?: number
  /** Session-scoped WorkingState handle (Codex memory L3 absorption). Optional
   *  and duck-typed so the `@/tool` slice never imports `@/agent`: the agent
   *  loop builds the concrete instance when `AgentConfig.workingState` is set,
   *  and the `update_working_state` meta-tool mutates it through this seam.
   *  Absent ⇒ working-state feature is OFF (byte-identical for all callers). */
  workingState?: WorkingStateHandle
  /** PR-5 / ADR-0081 — OPTIONAL observer for the closed `ShellExecEvent` union
   *  emitted by shell-class tools (bash today; any future sibling shell tool
   *  via the same seam). The bash tool forwards this directly to `runShell`
   *  through `ShellOptions.onShellEvent`; absent ⇒ no events emitted, exact
   *  byte-identical buffered behavior preserved (legacy path). Typed via
   *  `ShellExecObserver` so a new variant on the union is a compile error at
   *  every consumer that exhaustively switches on `event.kind`. */
  onShellEvent?: ShellExecObserver
  /** ADR-0086 — OPTIONAL plan-exit requester. The `request_plan_exit` tool
   *  calls this to surface a finished plan to whoever decides (CLI prompt /
   *  IDE modal / RPC) and get back the 3-way {@link PlanExitToolOutcome}.
   *  Duck-typed so `@/tool` never imports `@/agent`: the dispatch seam builds
   *  the concrete requester from `AgentConfig.planExitPort` (wrapping
   *  `runPlanExitFlow`). Absent ⇒ the tool is not registered. */
  requestPlanExit?: PlanExitRequester
}

/** ADR-0086 plan-exit decision — structural mirror of `PlanExitDecision`
 *  (`@/agent/plan-exit`); dispatch bridges the two by value. */
export type PlanExitToolDecision = "approved" | "rejected" | "changes_requested"

/** Structural mirror of `PlanExitOutcome`. `feedback` is non-empty IFF
 *  `decision === "changes_requested"` (the producer `buildPlanExit` enforces
 *  it; the tool only relays). */
export interface PlanExitToolOutcome {
  readonly decision: PlanExitToolDecision
  readonly feedback?: string
}

/** Requester the `request_plan_exit` tool invokes. */
export type PlanExitRequester = (plan: string) => Promise<PlanExitToolOutcome>

/** Duck-typed handle a tool uses to mutate or read the session WorkingState
 *  without importing `@/agent`. The agent loop is the only producer; tools are
 *  the consumers. `snapshot()` returns the current state by reference; callers
 *  must treat it as read-only and route mutations through `mutate()`. */
export interface WorkingStateHandle {
  /** Apply a partial replacement to the current state. Each provided field is
   *  a REPLACEMENT for the corresponding state field — absent fields preserve
   *  existing state. `hypothesis: null` clears the field. */
  mutate(patch: WorkingStatePatch): WorkingStateSnapshot
  /** Read-only snapshot of the current state. */
  snapshot(): WorkingStateSnapshot
}

/** Mirror of `BlockerSurface` from `@/agent/working-state` (kept here so
 *  `@/tool` is slice-isolated from `@/agent`). Adding a new surface requires
 *  updating BOTH sides — the compile-time assertion at the bottom of this
 *  file enforces structural equivalence. */
export type BlockerSurface = "type" | "owner" | "wire" | "test" | "runtime" | "build" | "other"

/** Structural duck-typed mirror of `WorkingState` (kept here so `@/tool` is
 *  slice-isolated from `@/agent`). */
export interface WorkingStateSnapshot {
  ownerShortlist: { file: string; reason: string }[]
  hypothesis?: string
  blockers: { what: string; surface: BlockerSurface }[]
  nextStepQueue: { what: string; deferred?: boolean }[]
  deferredValidation: { rail: string; reason: string }[]
}

/** Patch shape for `WorkingStateHandle.mutate`. Each present field REPLACES
 *  the corresponding state field; `hypothesis: null` clears it. `| undefined`
 *  is spelled explicitly on every optional so a zod `.optional()` parse output
 *  (which is structurally `T | undefined`) is assignable under
 *  `exactOptionalPropertyTypes: true`. */
export interface WorkingStatePatch {
  ownerShortlist?: { file: string; reason: string }[] | undefined
  hypothesis?: string | null | undefined
  blockers?: { what: string; surface: BlockerSurface }[] | undefined
  nextStepQueue?: { what: string; deferred?: boolean | undefined }[] | undefined
  deferredValidation?: { rail: string; reason: string }[] | undefined
}

export interface ToolResult {
  ok: boolean
  /** Text returned to the model as the tool_result content. */
  output: string
  /** Optional execution evidence surfaced to RFC-0002 §5.2 trajectory.
   *  Tools that exec shell commands attach stderr/exitCode/log-spill paths
   *  here; tools that don't simply omit the field. Replaces the previous
   *  duck-typed extra-prop smuggling on `ToolResult` (CR3): the dispatch
   *  seam now reads `result.evidence?.*` through this typed surface so the
   *  `stdErr` vs `stderr` casing drift can no longer slip past `tsc`. */
  evidence?: ToolResultEvidence
  /** OPTIONAL (absorb #1): structured value paired with `output`. When a tool
   *  declares an `outputSchema`, the dispatch seam validates THIS field (not
   *  `output`) against the schema. Absent ⇒ no structured payload; existing
   *  callers are byte-identical. Typed `unknown` here so `ToolResult` stays
   *  non-generic; `defineTool` narrows it at the factory boundary. */
  structured?: unknown
  /** OPTIONAL (absorb #1): a deferred-result marker. When a tool sets
   *  `supportsDeferredResults` and returns a placeholder it is still running
   *  in, this carries the handle the poller resolves later. The presence of
   *  `deferred` means `output` is a provisional placeholder, not the final
   *  answer. Absent ⇒ ordinary synchronous result (byte-identical). */
  deferred?: DeferredHandle
  /** OPTIONAL (absorb #2 — Cursor `EditResult`/`ShellResult` failure model): a
   *  TYPED, discriminated reason a tool failed, letting the model branch on the
   *  failure KIND instead of regex-matching `output`.
   *
   *  INVARIANT: `failure` is only meaningful when `ok === false`. When present
   *  it carries the typed reason IN ADDITION TO (never instead of) `output` —
   *  `output` remains the model-facing tool_result text exactly as before, so a
   *  tool that omits `failure` is byte-identical for every existing caller.
   *  Tools opt in by populating it on their `ok:false` results; the dispatch
   *  seam surfaces it onto `DispatchResult.failure` unchanged. */
  failure?: ToolFailure
}

/** OPTIONAL (absorb #2 — Cursor `EditResult`/`ShellResult`): the discriminated
 *  set of failure reasons a tool may classify on an `ok:false` `ToolResult`.
 *  The literal `mode` is the discriminant; switching over it with a `never`
 *  default is exhaustive (a new variant becomes a compile error at every site).
 *
 *  Variants chosen to match how v3 tools actually fail today:
 *   - `not_found`: a target path/symbol/match did not exist (read on a missing
 *     file, `edit` `old_string not found`, `scripted_replace` `pattern not
 *     found`). `path` carried when the missing target is a file.
 *   - `permission_denied`: the action was refused by the FS jail or a real
 *     permission boundary. `isReadonly` distinguishes a refusal that exists
 *     ONLY because the session/tool is in read-only mode (would succeed if
 *     mutation were allowed) from a genuine permission denial — Cursor's
 *     `is_readonly` flag.
 *   - `rejected`: a human/gate declined the call (HITL deny, plan-mode block).
 *     `reason` is the stable tag.
 *   - `timeout`: execution exceeded a deadline. `timeoutMs` carried when known.
 *   - `error`: any other failure. `modelVisibleError` is the safe text shown to
 *     the model; `clientVisibleError` is richer detail for the UI/operator that
 *     is NOT necessarily forwarded to the model (Cursor's
 *     model-visible vs client-visible split). */
export type ToolFailure =
  | { mode: "not_found"; path?: string }
  | { mode: "permission_denied"; path?: string; isReadonly?: boolean }
  | { mode: "rejected"; reason: string }
  | { mode: "timeout"; timeoutMs?: number }
  | { mode: "error"; modelVisibleError?: string; clientVisibleError?: string }

/** Optional RFC-0002 §5.2 execution evidence a tool may attach to its
 *  `ToolResult`. All fields are optional individually: a tool may carry just
 *  a stderr tail, or just a spill path, or any combination. Implementations
 *  cap their own field lengths; the dispatch seam re-trims `stderr` to its
 *  own `STDERR_TAIL_CAP` as a defense-in-depth backstop. */
export interface ToolResultEvidence {
  /** Tail of stderr captured during execution. Implementations cap their
   *  own length — dispatch trims again to its `STDERR_TAIL_CAP` backstop. */
  stderr?: string
  /** Process exit code when the tool spawned an external process. */
  exitCode?: number
  /** Absolute path to a full log when output spilled. Caller-resolved
   *  (FS jail still applies to the path). */
  fullLogPath?: string
}

/**
 * Events a tool streams while running. A tool yields zero or more `progress`
 * events, then exactly one terminal `result` — which MUST be the last event.
 *
 * Deferred results (absorb #1) are carried on the terminal `result` via the
 * OPTIONAL `ToolResult.deferred` handle — NOT as a separate event variant.
 * Keeping the union at `progress | result` preserves byte-identical type
 * narrowing for every existing call site that switches on `event.type`.
 */
export type ToolEvent =
  | { type: "progress"; message: string }
  | { type: "result"; result: ToolResult }

/** OPTIONAL (absorb #1): an opaque, serializable handle identifying a deferred
 *  tool result. The dispatch seam hands this to a `DeferredResultRegistry` which
 *  resolves the final `ToolResult` once the out-of-band work completes. Kept
 *  minimal & string-keyed so it can cross a JSON boundary unchanged. */
export interface DeferredHandle {
  /** Stable id the registry/poller keys on. Unique within a session. */
  id: string
  /** Optional human-facing hint shown while the result is pending. */
  hint?: string | undefined
}

/** OPTIONAL (absorb #1): the resolution outcome of a deferred handle, as
 *  surfaced by `DeferredResultRegistry.poll`. */
export type DeferredToolResult =
  | { state: "pending"; handle: DeferredHandle }
  | { state: "resolved"; handle: DeferredHandle; result: ToolResult }

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Re-exported from the canonical
 * `@/shared` declaration — NOT redeclared — so the `@/tool` and `@/permission`
 * copies can never drift. `@/tool` reaching `@/shared` is allowed (the leaf
 * layer); biome only forbids the `@/tool ↔ @/permission` direction. Dispatch
 * still composes the two slices via duck-typing.
 */
export type { HITLTier }

/**
 * Phase 2 tool contract (RFC §6.2). `execute` is an async generator yielding
 * `ToolEvent`s; `isConcurrencySafe(input)` lets the dispatcher batch pure
 * reads to run in parallel while keeping side-effecting calls serialized.
 */
export interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  /** OPTIONAL (absorb #1): schema for the tool's STRUCTURED result
   *  (`ToolResult.structured`). When present, the dispatch seam validates the
   *  structured payload via {@link validateToolOutput}; a mismatch is surfaced
   *  as an `ok:false` ToolResult instructing the model to retry — never thrown
   *  past the loop. Absent ⇒ no structured-output contract (byte-identical). */
  outputSchema?: z.ZodType<O>
  /** OPTIONAL (absorb #1): produce a COMPACT, model-facing rendering of a
   *  result, distinct from the richer UI/`output` text, to save tokens. When
   *  absent the dispatch seam uses `result.output` as today (byte-identical). */
  toModelOutput?(result: ToolResult): string
  /** OPTIONAL (absorb #1): when `true`, this tool may return a deferred result
   *  (a `{type:"deferred"}` event or `ToolResult.deferred`) that a
   *  `DeferredResultRegistry` resolves later. Absent/false ⇒ synchronous only. */
  supportsDeferredResults?: boolean
  /** OPTIONAL (absorb #1): streaming-input callbacks, mirroring the LLM
   *  `tool_use_start` / `tool_use_delta` / `tool_use_end` events. The dispatch
   *  seam invokes these as the tool-call arguments stream in, BEFORE `execute`.
   *  All three are individually optional and side-effecting only (the parsed
   *  input is still passed to `execute`). Drive them in tests/dispatch via
   *  {@link driveStreamingInput}. */
  onInputStart?(): void
  onInputDelta?(delta: string): void
  onInputAvailable?(input: I): void
  isReadOnly(): boolean
  /** True ⇒ this call has no observable interaction with any other call and
   *  may run concurrently with other concurrency-safe calls. */
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
  /** OPTIONAL: input-dependent HITL tier (Codex hitl-audit.md absorption).
   *  When omitted, the dispatch gate infers tier from `isReadOnly()`:
   *  `true ⇒ "none"` (reversible, harmless), `false ⇒ "always-confirm"`
   *  (fail-closed secure-by-default, see `inferToolTier` in
   *  `@/permission/policy`). Tools that DO mutate but want pre-approval
   *  semantics (e.g. `write`/`edit`/`test_runner`/`scripted_replace`)
   *  explicitly opt in via `hitlTier: () => "pre-approval-ok"`. Tools whose
   *  tier varies per-input (`bash` — `git push` is always-confirm, `ls` is
   *  pre-approval-ok) provide their own classifier here. Only consulted
   *  when the HITL gate is explicitly enabled in `AgentConfig.hitl`. */
  hitlTier?(input: I): HITLTier
  /** S16: OPTIONAL. When a tool accepts a raw shell command string, it
   *  implements this to expose the command for HARD_DENY evaluation. The
   *  permission policy gates ANY tool whose `extractShellCommand` returns a
   *  non-null value through the same dangerous-pattern denylist as `bash` —
   *  so a sibling shell tool (a future `shell`/`exec`/MCP `run` tool, a
   *  typo'd `Bash`, etc.) cannot silently slip past the gate that previously
   *  only matched `action.tool === "bash"`. Tools whose input is not a shell
   *  string omit the method entirely. */
  extractShellCommand?(input: I): string | null
  /** PR-2 self-audit fix (ADR-0078): OPTIONAL structural declaration of the
   *  tool result's source sensitivity class for the secret-redaction gate.
   *  Mirrors the {@link extractShellCommand} pattern — tools that touch a
   *  filesystem path or run a shell command DECLARE their classifier here,
   *  rather than the dispatch seam guessing from `tool.name` / argument-field
   *  names. Returning `"secret"` causes the dispatch redaction layer to
   *  replace the entire tool result with `[REDACTED:source_class_secret]`
   *  before the model sees it; returning `"public"`/`"internal"` falls
   *  through to the Layer-2 deterministic-regex pattern matcher; returning
   *  `null` (or omitting the method) is identical to today's behavior
   *  (Layer-2 only, no source-class short-circuit). Pre-fix this lived in a
   *  hard-coded `PATH_TOOL_NAMES` / `COMMAND_TOOL_NAMES` set in dispatch.ts
   *  — a name-and-field-string heuristic that silently skipped any tool
   *  whose name wasn't `"Read"/"read"/"view_file"/"open_file"/"Bash"/...`.
   *  Declaration-based posture: a custom tool that adds a new file/command
   *  surface explicitly opts in by implementing this method. */
  classifySource?(input: I): SensitivityClass | null
}

/** Provider-agnostic schema the agent forwards to the LLM.
 *  `aliases` is a discovery-only hint used by the `ToolSearch` skill for
 *  lexical scoring (token + substring match at name-weight). It is NEVER
 *  forwarded to LLM provider adapters — both `@/llm/adapters/anthropic` and
 *  `@/llm/adapters/openai` explicitly project to `{ name, description,
 *  input_schema }` so the alias hint stays inside the tool catalog and the
 *  on-wire `tools` payload remains byte-identical for callers that omit
 *  `aliases`. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
  aliases?: string[]
}
