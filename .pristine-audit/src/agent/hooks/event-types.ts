import type { HITLTier } from "@/shared"
import type { RecoveryProvenance } from "../recovery-reason"

/**
 * Hook event vocabulary — the `HookEvent` discriminated union + every handler
 * request/response shape, extracted from `../hooks` (god-module split). Pure
 * types only (no runtime); re-exported from `../hooks` so importers are
 * byte-unaffected.
 */

export type HookEvent =
  | { type: "session_start"; sessionId: string }
  | { type: "session_end"; reason: string; turns: number }
  | { type: "pre_tool_use"; name: string; input: unknown }
  | { type: "post_tool_use"; name: string; input: unknown; ok: boolean; output: string }
  // ADR-0133 — NEW. Fired when `execute()` returned `ok:false` (a typed tool
  // failure) OR when the execute path threw and dispatch normalized it. The
  // `error` string is the post-redaction tool output text (the same content
  // the model would see). Response may carry `promptHook` (inject context for
  // a retry) or `abort` (halt the loop). `updatedInput` is NOT honored here
  // (the tool already ran with its input; rewriting it post-hoc is
  // meaningless).
  | { type: "post_tool_use_failure"; name: string; input: unknown; error: string }
  // ADR-0133 — NEW. Fired by `compaction.ts` IMMEDIATELY BEFORE the summarizer
  // LLM runs. `isFirstCompaction` lets a host treat the first compact of a
  // session differently (e.g. warm-up vs. steady-state). Response may carry
  // `abort` to skip THIS compaction (the loop's breaker treats it as no
  // progress and re-evaluates next turn).
  | {
      type: "pre_compact"
      messagesToCompact: number
      isFirstCompaction: boolean
    }
  // ADR-0409 — NEW. Fired by `compaction.ts` IMMEDIATELY AFTER a successful
  // compaction (or microcompact) settles. Carries `RecoveryProvenance` so a
  // subscriber sees WHY the compaction happened + the resume contract
  // (`resumeStep` is the human-readable "agent compacted: reason X —
  // resuming at step Y" string the Objective surfaces in nextActions).
  // Subscriber-less ⇒ existing compaction path byte-identical (the bus
  // fast-paths the empty-handler-list case).
  | {
      type: "post_compact"
      threadId: string
      provenance: RecoveryProvenance
    }
  // ADR-0133 — NEW. Fired by `subagent-runner.ts` immediately after the child
  // config has been built and BEFORE the child `runAgent` is invoked.
  // Response may carry `abort` (cancel the fork before it spawns) or
  // `promptHook` (the PARENT will see this in its NEXT turn after the child
  // resumes — typed as `subagentStartPromptHook` on the bus internally).
  | {
      type: "subagent_start"
      subagentId: string
      parentId: string | undefined
      taskPrompt: string
    }
  // ADR-0133 — NEW. Fired by `subagent-runner.ts` immediately after the child
  // returns. `result.ok` mirrors `SubagentResult.ok`; `result.finalText` is
  // the joined final-assistant text. Response may carry `promptHook` (e.g.
  // "the subagent reported X — consider Y") which the parent loop folds into
  // its NEXT prompt.
  | {
      type: "subagent_stop"
      subagentId: string
      result: { ok: boolean; finalText: string; turns: number }
    }
  // jun-6 — NEW. Fired by the admissibility gate IMMEDIATELY BEFORE it consults
  // the built-in policy stack (the new dispatch "step 3b", BEFORE step 4
  // mode-posture / step 5 earlyHardDeny — see dispatch.ts ordering). Unlike
  // `pre_tool_use` (step 11, the LAST gate, AFTER the decision, which rewrites
  // INPUT and denies), this event lets an operator-authored handler
  // PROGRAMMATICALLY SUPPLY the allow/deny/ask decision the policy stack would
  // otherwise compute. `input` is READ-ONLY here (NOT rewritten — that is
  // `pre_tool_use`'s job). `tier` is the HITL tier the gate has already inferred
  // (so a handler can reason "only gate always-confirm calls"); `cwd` is for
  // path-scoped policies.
  //
  // A handler may return `{ permission: "allow" | "deny" | "ask" }` (or a
  // `{ permission: { outcome, reason? } }` shape) to feed the gate's existing
  // admit / terminal-deny / reviewer arms. Returning NOTHING ⇒ no decision ⇒
  // the gate falls through to the existing stack (byte-identical). FIRST
  // decision wins (registration order), mirroring `pre_tool_use`'s
  // first-deny-wins.
  //
  // SECURITY (the HARD_DENY floor): a hook `allow` MUST NOT route around the
  // denylist. The gate adds this event to the SAME `earlyHardDeny`-pull-ahead
  // trigger as rules/reviewer/patternStore — when a handler is registered,
  // HARD_DENY is evaluated FIRST and a HARD_DENY call is terminal BEFORE the
  // hook's `allow` is consulted. The hook can only TIGHTEN (deny/ask), never
  // escalate beyond policy. A throwing / invalid handler is fail-closed (no
  // decision ⇒ fall through to the stack — the hook never weakens the gate).
  | {
      type: "permission_request"
      name: string
      input: unknown
      tier: HITLTier
      cwd: string
    }
  | { type: "turn_start"; turn: number }
  // S5 hook hardening — NEW. Fired by `loop.ts` ONCE per run, immediately
  // after `session_start`, when there is a trailing user-prompt message to
  // observe. `prompt` is the joined text of the LAST user message's text
  // blocks (the "prompt the model is about to see"); `attachmentsCount` is
  // the number of non-text blocks (images / documents) on that same message,
  // so a host can audit-log multi-modal turns without re-walking the
  // transcript. A `deny` short-circuits the loop into `aborted` (the surface
  // observes via `AgentOutcome.reason === "aborted"` + `stopCategory.origin
  // === "hook"`). An `updatedPrompt` string REWRITES the trailing user
  // message's text block before the LLM sees it (the rewrite is the same
  // Cursor-parity invariant pre_tool_use carries: it cannot bypass HARD_DENY
  // — there is no permission for user input; the surface is upstream).
  | {
      type: "user_prompt_submit"
      prompt: string
      attachmentsCount: number
      threadId: string
    }

export type HookEventType = HookEvent["type"]

/** Narrow a {@link HookEvent} to one variant by its `type`. */
export type HookEventOf<T extends HookEventType> = Extract<HookEvent, { type: T }>

/** A `pre_tool_use` handler may return this to block the call. */
export interface HookDeny {
  deny: string
}

/** A `pre_tool_use` handler may return this to REWRITE the tool input before
 *  execution (Cursor `updated_input` parity). Presence of the `updatedInput`
 *  KEY is the signal — the value itself is opaque (the tool re-validates its
 *  own schema), so a rewrite to `undefined`/`null` is still an explicit
 *  rewrite, distinct from a no-op handler that returns nothing. */
export interface HookUpdatedInput {
  updatedInput: unknown
}

/** S5 — a `user_prompt_submit` handler may return this to REWRITE the prompt
 *  text the model sees. Same semantics as {@link HookUpdatedInput}: presence
 *  of the `updatedPrompt` KEY is the signal. Empty string is a valid
 *  (intentional) clear; consumer treats it as the new prompt text. */
export interface HookUpdatedPrompt {
  updatedPrompt: string
}

/** jun-6 — the three-valued decision a `permission_request` handler may supply
 *  to the admissibility gate BEFORE the policy stack runs. Mirrors the existing
 *  `PermissionInspectionOutcome` vocabulary (`@/permission` inspector:
 *  `"allow" | "deny" | "ask"`) so the gate routes it into its EXISTING arms:
 *  `allow` ⇒ short-circuit admit (subject to the HARD_DENY floor — see the
 *  `permission_request` event doc), `deny` ⇒ the gate's terminal `deny()`
 *  helper, `ask` ⇒ the reviewer / `onConfirm` path. `reason` is carried ONLY on
 *  `deny` (a short human-readable one-liner — MUST NOT include tool input). */
export type HookPermissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "ask" }

/** jun-6 — the raw response shape a `permission_request` handler returns. The
 *  handler may return the terse `{ permission: "allow" | "deny" | "ask" }`
 *  string form (with an optional sibling `reason` for `deny`), OR the explicit
 *  `{ permission: { outcome, reason? } }` object form. Both normalize to a
 *  {@link HookPermissionDecision} via {@link normalizePermissionDecision}. */
export interface HookPermissionResponse {
  permission: "allow" | "deny" | "ask" | HookPermissionDecision
  /** Optional deny reason for the terse string form (`{ permission: "deny",
   *  reason: "…" }`). Ignored for the object form (which carries its own). */
  reason?: string
}

/** ADR-0133 — text a handler asks the loop to fold into the NEXT LLM turn's
 *  prompt. `injectAfterSystem` is appended to the end of the system prompt;
 *  `injectBeforeUser` is prepended to the trailing user-side messages. Both
 *  optional (a handler may set one or both). Each side has an independent
 *  {@link PROMPT_HOOK_MAX_CHARS} budget; accumulation across multiple emits in
 *  the same turn is governed by the bus on its `emit` call (per-emit) and by
 *  the loop's pending-queue trimmer (across emits). */
export interface HookPromptInject {
  injectAfterSystem?: string
  injectBeforeUser?: string
}

/** A handler return that asks the loop to abort the current operation
 *  (compaction skip / subagent fork cancel / dispatch throw). First wins;
 *  subsequent handlers for this emit are NOT run. */
export interface HookAbort {
  abort: { reason: string }
}

/** ADR-0133 — V2 deferred. A handler may surface a tool-set delta for the
 *  NEXT turn: `add` registers extra tools (lazy-load), `remove` blacklists
 *  by name. We type the field on {@link HookEmitResult} so callers can
 *  forward it through their pipelines, but the loop does NOT yet apply it
 *  (no producer wires `add`/`remove` today; V2 will wire the registry
 *  patcher). Defined so the contract is forward-compatible. */
export interface HookToolOverride {
  add?: readonly { name: string; description?: string }[]
  remove?: readonly string[]
}

/**
 * A handler may return anything; only a `{ deny: string }` and/or
 * `{ updatedInput }` from a `pre_tool_use` handler is acted on (deny blocks the
 * call; updatedInput rewrites its args). Returning nothing is the common no-op
 * case, so the return type is intentionally `unknown` (a `HookDeny | void`
 * union trips biome's noConfusingVoidType, and forcing every no-op handler to
 * `return undefined` is poor ergonomics).
 *
 * ADR-0133 — a handler MAY also return a combined object with any of
 * `{ promptHook, abort, toolOverride }`. These are recognized for EVERY event
 * variant (not just pre_tool_use); the seam that consumes the emit decides
 * whether the response is meaningful (e.g. `pre_compact` honors `abort`,
 * ignores `updatedInput`).
 */
export type HookHandler<T extends HookEventType> = (event: HookEventOf<T>) => unknown

/** Result of {@link HookBus.emit}.
 *
 *  - `deny`: first `pre_tool_use` refusal (else null). Backward-compat.
 *  - `updatedInput`: PRESENT (key included) only when a `pre_tool_use` handler
 *    rewrote the args. Backward-compat.
 *
 *  ADR-0133 — NEW (all optional; OMITTED when no handler set them):
 *  - `promptHook`: accumulated `injectAfterSystem` / `injectBeforeUser` text
 *    from every handler that returned one. Capped at
 *    {@link PROMPT_HOOK_MAX_CHARS} per side; FIFO trim with a logger warning
 *    when exceeded.
 *  - `abort`: present (with `reason`) when the FIRST handler that returned
 *    one — like `deny`, the rest are not consulted. Note that for
 *    `pre_tool_use` we still run subsequent handlers for the rewrite chain
 *    (deny stops further deny consideration, not the chain itself); for the
 *    other events `abort` short-circuits the loop.
 *  - `toolOverride`: V2-deferred. Defined for forward compat — callers may
 *    forward it; today the loop ignores it. */
export interface HookEmitResult {
  deny: HookDeny | null
  updatedInput?: unknown
  promptHook?: HookPromptInject
  abort?: { reason: string }
  toolOverride?: HookToolOverride
  /** S5 — present (and a string) when a `user_prompt_submit` handler returned
   *  `{updatedPrompt}`. The LAST rewrite wins (rewrites compose; only the
   *  trailing value is surfaced). Consumers that ignore the key see the
   *  legacy shape (no behavior change). */
  updatedPrompt?: string
  /** S5 — number of handlers in THIS emit that exceeded their timeout. Zero
   *  when no handler timed out; field is OMITTED in the no-timeout case so
   *  the legacy `{deny, updatedInput?}` shape is byte-identical. */
  timeoutCount?: number
  /** jun-6 — present (key included) ONLY when a `permission_request` handler
   *  supplied a decision. The FIRST decision wins (registration order); later
   *  handlers do not override it. OMITTED when no handler set it
   *  (presence-not-truthiness, same discipline as `promptHook` / `abort`) so a
   *  result with no decision is byte-identical to today and the gate falls
   *  through to the policy stack. */
  permissionDecision?: HookPermissionDecision
}
