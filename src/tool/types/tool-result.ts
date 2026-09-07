/**
 * Tool-result / tool-failure shape declarations for the `@/tool` slice
 * (extracted from `./types.ts` to keep that module under the god-module line
 * threshold). Covers the `ToolResult` envelope, the discriminated
 * {@link ToolFailure} reason set (incl. the C6 deny-reason mirror), the
 * cap-as-instruction {@link NextAction} hint, execution evidence, the
 * `ToolEvent` stream union, and the deferred-result handles.
 *
 * The complete original public surface is RE-EXPORTED verbatim from `../types`
 * so every external importer of `@/tool/types` stays byte-compatible.
 */
import type { DocumentBlock, ImageBlock } from "@/llm"
import type { SensitivityClass } from "@/security"

/**
 * ADR-0062 rule #3 — structured cap-as-instruction third channel.
 *
 * A tool may return a `nextAction` hint on its successful result when it
 * detects that its output was capped and the next call MUST apply a
 * specific change before switching tools. The dispatch seam reads this
 * and (when `QUANTA_CAP_ENFORCE=1`) enforces the hint by injecting a
 * `<system-reminder>` when a subsequent call ignores it.
 *
 * INVARIANT: `nextAction` is OPTIONAL — tools that omit it are byte-
 * identical. Only `file_tree_summary` populates it today; adding a
 * second tool that emits it never changes unrelated callers.
 *
 * The union is CLOSED via the `kind` discriminant. Adding a new variant
 * requires updating every exhaustive switch at consumer sites (the
 * dispatch seam's enforcement block). The two numeric variants carry a
 * `suggested` value derived purely from the current parameter × 2,
 * capped by the tool's own schema max — no heuristics.
 */
export type NextAction =
  | { kind: "increase_max_depth"; suggested: number; reason: string }
  | { kind: "raise_max_files"; suggested: number; reason: string }
  | { kind: "narrow_path"; reason: string }

export interface ToolResult {
  ok: boolean
  /** Text returned to the model as the tool_result content. */
  output: string
  /**
   * Producer-owned provenance for outputs whose source is resolved only during
   * execution (for example an opaque background/PTY handle). Dispatch joins
   * this with input-derived classification and applies the stricter class.
   */
  source?: {
    readonly class: SensitivityClass
    readonly label: string
  }
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
  /** ADR-0062 rule #3 — OPTIONAL structured cap-as-instruction hint. When a
   *  tool detects its output was capped (depth rollup or file-count truncation),
   *  it populates this field so the dispatch seam can enforce the suggestion
   *  structurally rather than relying solely on the prose in `output`.
   *
   *  Tools that do NOT emit it are byte-identical (no allocation, no change to
   *  the existing `output` channel). The dispatch seam reads this ONLY when
   *  `QUANTA_CAP_ENFORCE=1` is set — DEFAULT-OFF. */
  nextAction?: NextAction
  /** OPTIONAL (ADR-0126): structured image attachments to surface to the model
   *  via the next user message's tool_result content. The dispatch seam reads
   *  this field and composes an Anthropic-API tool_result block whose `content`
   *  is `[{type:"text",text:output}, ...images.map(toImageContentBlock)]`.
   *  Absent ⇒ tool_result content is the legacy string-only shape
   *  (byte-identical). Each image is a base64-encoded ImageBlock; caller is
   *  responsible for size/policy checks UPSTREAM.
   *
   *  Slice-fence note: this is the FIRST `ToolResult` field whose type is
   *  imported from `@/llm`. biome's `@/tool` override does NOT restrict `@/llm`
   *  (only `@/memory`, `@/stream`, `@/permission`, `@/lsp`, `@/observability`,
   *  `@/mcp`, `@/patch`, `@/rules`), so this import is structurally allowed —
   *  but the historical doc on `ToolContext` listed `@/llm` among its `MUST
   *  NEVER import` set. That copy was a doc drift from a pre-vision posture; the
   *  authoritative slice fence is the biome override. */
  images?: ImageBlock[]
  /** OPTIONAL (ADR-0137): structured document attachments to surface to the
   *  model via the next user message's tool_result content. Sibling of
   *  {@link images}: dispatch's `composeToolResultContent` appends these AFTER
   *  any image blocks so the composed `[text, ...images, ...documents]` array
   *  preserves both modalities in the order the tool produced. Today the only
   *  supported media type is `application/pdf` (Anthropic native document
   *  block — see ADR-0137). Absent ⇒ no document attachments (byte-identical).
   *  Each document is base64-encoded; caller is responsible for size / policy
   *  checks UPSTREAM (the `pdf_read` tool enforces the 32 MB Anthropic API cap
   *  + magic-byte sniff at its boundary). */
  documents?: DocumentBlock[]
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
 *   - `spawn_error`: an external process could not be launched at all (Cursor
 *     `ShellSpawnError` — e.g. `command not found`, ENOENT). Distinct from
 *     `error` because the retry strategy differs: the model should pick a
 *     DIFFERENT command rather than re-read an error string. `error` carries the
 *     spawn diagnostic.
 *   - `error`: any other failure. `modelVisibleError` is the safe text shown to
 *     the model; `clientVisibleError` is richer detail for the UI/operator that
 *     is NOT necessarily forwarded to the model (Cursor's
 *     model-visible vs client-visible split). */
/** C6 (RFC jun-6-deny-reason-surfacing) — duck-typed mirror of `DenyLayer`
 *  from `@/permission/deny-reason` (kept here so `@/tool` stays slice-isolated
 *  from `@/permission` — RFC §3.1; biome enforces). The deny SITE (always
 *  unambiguous). Adding a value requires updating BOTH the producer AND this
 *  mirror. */
export type DenyLayerMirror =
  | "hard-deny"
  | "stack"
  | "reviewer"
  | "hook"
  | "tool-profile"
  | "mode"
  | "broker"

/** C6 — duck-typed mirror of `DenyPillar` from `@/permission/deny-reason`. */
export type DenyPillarMirror = "fileSystem" | "network" | "sandbox" | "control" | "approval"

/** C6 — duck-typed mirror of `PermissionStackSource` from
 *  `@/permission/recorder` (the stack-axis enum reused verbatim on the
 *  `layer:"stack"` deny path when derivable). */
export type DenyStackSourceMirror =
  | "hard-deny"
  | "read-only-bypass"
  | "post-denial-override"
  | "per-thread"
  | "per-host"
  | "global-default"

/**
 * C6 (RFC jun-6-deny-reason-surfacing) — duck-typed mirror of
 * `StructuredDenyReason` from `@/permission/deny-reason` (kept here so `@/tool`
 * stays slice-isolated from `@/permission` — RFC §3.1; biome enforces the
 * fence). The producer's `StructuredDenyReason` is structurally assignable to
 * this shape; the agent-side `deny(..., denyReason)` builder attaches the real
 * value, and this mirror is the only declaration `@/tool` consumers branch on.
 *
 * NO-LEAK (the core C6 constraint): `safeReason` is the recorder's already-
 * sanitized one-liner surfaced VERBATIM — NEVER raw input / command text /
 * regex source / matched HARD_DENY pattern. The HARD_DENY case carries the
 * CATEGORICAL `hardDenySafeReason()` form, never the command-echoing prose.
 *
 * MIRROR INVARIANT — adding a `layer` / `pillar` / `stackSource` literal
 * requires updating BOTH the producer AND this mirror; a consumer-side
 * round-trip test in `tests/unit/` (which CAN see both slices) catches drift.
 */
export interface DenyReasonValue {
  readonly verdict: "deny"
  readonly layer: DenyLayerMirror
  readonly pillar?: DenyPillarMirror
  readonly stackSource?: DenyStackSourceMirror
  readonly safeReason: string
}

export type ToolFailure =
  | { mode: "not_found"; path?: string }
  | {
      mode: "permission_denied"
      path?: string
      isReadonly?: boolean
      /** C6 (RFC jun-6-deny-reason-surfacing) — OPTIONAL structured "why was
       *  this denied" record, attached ONLY when `surfaceDenyReason`
       *  (`QUANTA_DENY_REASON`) is on AND the deny flows through the
       *  admissibility-gate's `deny(..., denyReason)` path. Lets the model
       *  branch on the deciding `layer` / `pillar` instead of regex-matching
       *  the prose `content`. ABSENT (default-OFF / a tool-level FS-jail deny
       *  that does not thread it) ⇒ the envelope is `{mode, isReadonly}` only,
       *  byte-identical to today.
       *
       *  SLICE FENCE (RFC §3.1; biome enforces): `@/tool` MUST NOT import
       *  `@/permission`, so the value-shape is MIRRORED locally as
       *  {@link DenyReasonValue} — structurally equivalent to
       *  `StructuredDenyReason` from `@/permission/deny-reason`. The agent-side
       *  deny() builder (`@/agent/dispatch-helpers`) produces the real
       *  `StructuredDenyReason` (assignable to this mirror by structure) and the
       *  gate is the only populating site. Adding a `DenyLayer` / `DenyPillar`
       *  literal requires updating BOTH the producer AND this mirror; a
       *  consumer-side test in `tests/unit/` (which CAN see both slices) catches
       *  drift. */
      denyReason?: DenyReasonValue
    }
  | { mode: "rejected"; reason: string }
  | { mode: "timeout"; timeoutMs?: number }
  | { mode: "spawn_error"; error: string }
  | { mode: "error"; modelVisibleError?: string; clientVisibleError?: string }
  /** ADR-0295 — OS sandbox refused the call. Emitted by the bash tool (and any
   *  future shell-class sibling) when its `mode="read"` per-call wrap forwarded
   *  a write/exec/network attempt that the kernel/Seatbelt rejected with
   *  EACCES / "Operation not permitted". `reason` is a CLOSED enum so a future
   *  arm (e.g. `kqueue_denied`) becomes a compile error at every exhaustive
   *  switch. The OS is the enforcer — no pattern-matching on the command. */
  | { mode: "sandbox_violation"; reason: SandboxViolationReason }
  /** ADR-0295 — OS sandbox cannot be enforced on this host (sandbox-exec
   *  missing, linux backend not implemented per-call, unsupported platform).
   *  The bash tool surfaces this BEFORE spawning when `mode="read"` is
   *  requested — explicitly NOT falling back to an unsandboxed legacy spawn
   *  (fail-closed posture). `reason` is the opaque stable tag from the port. */
  | { mode: "sandbox_unavailable"; reason: string }
  /** ADR-0398 — `edit`/`write` tool was called with an `expected_hash`
   *  precondition that did NOT match the current file's sha256. The on-disk
   *  bytes are UNTOUCHED (no partial write, no rollback to perform). The
   *  caller (model or human gate) can re-read the file and decide whether the
   *  divergence is intentional (give up the edit) or stale-context (re-issue
   *  with the fresh `expected_hash`). The two hashes are surfaced as hex
   *  strings so downstream tooling can diff them without re-reading the
   *  file. `path` is the file the precondition guarded. */
  | {
      mode: "stale_precondition"
      path?: string
      expectedHash: string
      actualHash: string
    }

/** Closed enum of OS-sandbox violation kinds. Each arm maps a class of OS
 *  denial to a stable tag the model can branch on. Adding a new arm requires
 *  updating every exhaustive switch (consumer-side compile error). */
export type SandboxViolationReason = "write_denied" | "exec_denied" | "network_denied" | "unknown"

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
  /** Exact shell command the tool resolved and executed. Used when a caller
   *  needs to re-run the SAME verifier the tool actually ran, not a sentinel
   *  tool name or a host-side re-derivation. */
  executedCommand?: string
  /** Absolute path to a full log when output spilled. Caller-resolved
   *  (FS jail still applies to the path). */
  fullLogPath?: string
  /** B1 (RFC jul-3): the command was killed by a wall-clock DEADLINE before completing — the
   *  exit code is a kill sentinel and any output is PARTIAL. Downstream inspectors (the terminal
   *  verify-gate) must not treat a timed-out result as a completed observation. Absent ⇒ ran to
   *  completion. */
  timedOut?: boolean
  /** RFC02-4 (C2) — the wall-clock DEADLINE (ms) the executor applied, present
   *  ONLY when that deadline is a known fact the executor set (a `timed_out`
   *  completion or a `background` auto-detach). This is the SAME `timeoutMs` the
   *  bash tool passed to the runner — NOT parsed from stderr / the command
   *  string. One unit (ms). Absent ⇒ the executor did not apply / did not reach a
   *  deadline. A single evidence source; CLI/model/recorder each PROJECT it. */
  timeoutMs?: number
  /** RFC02-4 (C2) — the id of the background shell the command was DETACHED
   *  into when it exceeded its deadline under a `background`/`prompt` seam. The
   *  executor learns this directly from the registry `adopt()` return (not from
   *  output parsing). Present iff {@link detached} is true. */
  backgroundShellId?: string
  /** RFC02-4 (C2) — the command did not complete inline: it was DETACHED into
   *  the background-shell registry (auto-background on deadline). An executor-
   *  known control fact, not a stderr/command inference. Absent ⇒ ran inline. */
  detached?: boolean
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
