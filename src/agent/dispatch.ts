import type { ToolUseBlock } from "@/llm"
import { attrs, endSpan, QUANTA_ATTRS, SPAN_NAMES, type Span, startSpan } from "@/observability"
import {
  type AutoModeClassifier,
  gitWriteProtectReason,
  type PermissionContext,
} from "@/permission"
import { type RedactionHit, redactSecrets, type SensitivityClass } from "@/security"
import { compositePiiScanner } from "@/security/pii-redaction"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, ToolResult, WorkingStateHandle } from "@/tool"
import { composeToolResultContent } from "@/tool/image/compose"
import { runAdmissibilityGate } from "./admissibility-gate"
import { wireCheckpointedEffectChannel } from "./checkpoint-wiring"
import { emitCapReminderDecision } from "./decision-emit-phase3"
import { DedupGate } from "./dispatch-dedup"
import { deny, resultBlock } from "./dispatch-helpers"
import { checkDispatchAllowed } from "./dispatch-seam-guard"
import type { DispatchResult } from "./dispatch-types"
import { LocalEffectChannel } from "./effect-channel"
import { decideLocalizePhase } from "./localize-phase-guard"
import { resolveCollaborationMode } from "./mode"
import { planStoreToMutator } from "./plan/mutator-adapter"
import { runPlanExitFlow } from "./plan-exit-flow"
import { materializeReviewerAgent } from "./tier1/reviewer-subagent"
import type { AgentConfig } from "./types"

export type { DispatchResult } from "./dispatch-types"

/** Max chars of stderr retained on the dispatch result (RFC-0002 §5.2).
 *  Kept in lock-step with the per-tool cap (bash/test_runner = 4 000) so this
 *  is genuinely a defense-in-depth backstop — for a well-behaved tool the
 *  trim is idempotent (`slice(-4000)` of an already-≤4000 string), and it
 *  only kicks in when a third-party tool exceeds the agreed cap. R5 audit
 *  C1 found the previous 2 000 here silently dropped the front half of
 *  every well-behaved tool's evidence; matching caps removes that no-op
 *  layered halving. */
const STDERR_TAIL_CAP = 4_000

/** Read RFC-0002 §5.2 evidence from a `ToolResult.evidence` (CR3: typed, not
 *  duck-typed). The dispatch surface flattens the optional nested fields onto
 *  `DispatchResult` (`stderrTail` / `exitCode` / `fullLogPath`) — the stream
 *  and trajectory recorders consume those flat fields unchanged. Each output
 *  field is conditional-set so `exactOptionalPropertyTypes` never sees an
 *  `undefined` value. */
const evidenceOf = (
  result: ToolResult,
): Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> => {
  const out: Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> = {}
  const ev = result.evidence
  if (ev === undefined) return out
  if (typeof ev.stderr === "string" && ev.stderr.length > 0) {
    out.stderrTail = ev.stderr.slice(-STDERR_TAIL_CAP)
  }
  if (typeof ev.exitCode === "number") out.exitCode = ev.exitCode
  if (typeof ev.fullLogPath === "string" && ev.fullLogPath.length > 0) {
    out.fullLogPath = ev.fullLogPath
  }
  return out
}

// `resultBlock` / `deny` now live in `./dispatch-helpers` so both `dispatch.ts`
// and `./admissibility-gate.ts` can construct deny / tool_result values without
// either file importing the other's full implementation surface.

/** T3 — pre-flight dedup gate consult. Returns a synthetic non-error
 *  tool_result {@link DispatchResult} to short-circuit a thrashing call, or
 *  `null` when the gate is absent / unconfigured / the call is admissible.
 *
 *  Default-OFF preserved: when `config.dedupGate` is `undefined` this is a
 *  single property check + early return (zero allocation), so dispatch is
 *  byte-identical to the pre-T3 path for any caller that did not opt in. */
const consultDedupGate = (call: ToolUseBlock, config: AgentConfig): DispatchResult | null => {
  const gate = config.dedupGate
  if (!gate) return null
  // The gate is pure-by-state: it needs the caller-supplied turn (no
  // Date.now/random) so a missing turn source means "no dedup window" — we
  // skip rather than synthesize a fake counter that would behave randomly
  // depending on call ordering across unrelated turns.
  const turn = config.run?.turn
  if (typeof turn !== "number") return null
  const verdict = gate.record(call.name, call.input, turn)
  if (!verdict.blocked) return null
  return {
    block: DedupGate.syntheticResult(call.id, verdict.observation),
    ok: true,
    preview: `dedup-gate-${verdict.regime}`,
  }
}

/** Localize-phase pre-flight consult (Agentless absorption — Tier 0). Returns
 *  a deny-style {@link DispatchResult} when the gate decides to block a
 *  mutating tool in Phase 1, or `null` when the call passes through (gate
 *  OFF, Phase 2, or non-mutating tool).
 *
 *  Default-OFF: when `config.localizePhase` is absent OR `localizePhaseState`
 *  is absent OR the phase1Turns is not a positive integer, the inner
 *  {@link decideLocalizePhase} returns `{block:false}` and this function
 *  returns `null` — single property check + early return, so dispatch is
 *  byte-identical to the pre-feature path. Placed alongside `consultDedupGate`
 *  so the dispatch surface has ONE pre-admissibility consult cluster (both
 *  are state-aware gates that should short-circuit BEFORE burning permission
 *  / HITL / hook work). */
const consultLocalizePhase = (call: ToolUseBlock, config: AgentConfig): DispatchResult | null => {
  const decision = decideLocalizePhase({
    toolName: call.name,
    state: config.localizePhaseState,
    cfg: config.localizePhase,
  })
  if (!decision.block) return null
  // `text` is always present on a block decision (the policy always builds it),
  // but guard with a fallback so a future refactor that returns `{block:true}`
  // without a `text` produces a typed deny instead of an undefined-stringifying
  // tool_result.
  const reason = decision.text ?? "Localize-phase: edit blocked during Phase 1."
  return deny(call.id, reason, "localize-phase-blocked")
}

/** ADR-0229 — dispatch-guard pre-flight consult. Returns a deny-style
 *  {@link DispatchResult} when the guard refuses the call (preview tag
 *  `"guard-deny"` for deny outcomes, `"guard-ask"` when the guard requests
 *  HITL — collapsed to a deny in v1 because the HITL re-routing wire is a
 *  deferred follow-up), or `null` when the guard admits (or no guard is
 *  wired). Sibling to `consultDedupGate` / `consultLocalizePhase` — keeps
 *  the dispatch pre-flight cluster small and uniform.
 *
 *  Default-OFF preserved: `config.dispatchGuard` absent ⇒ one optional-chain
 *  property check, zero allocation. Byte-identical to the pre-ADR-0229 path. */
const consultDispatchGuard = (call: ToolUseBlock, config: AgentConfig): DispatchResult | null => {
  const guard = config.dispatchGuard
  if (!guard) return null
  const decision = guard.check(call.name, call.input)
  if (decision.kind === "allow") return null
  if (decision.kind === "ask") {
    // Collapse `ask` to a deny in v1 (the wire to HITL queue is a deferred
    // follow-up). The `"guard-ask"` preview tag is the recognition surface a
    // future re-router keys on without changing this seam.
    return deny(call.id, `Dispatch guard requested confirmation: ${decision.reason}`, "guard-ask")
  }
  // `kind === "deny"`. `hardDeny:true` carries the security-boundary
  // signal forward via the deny content prefix — downstream loop classifiers
  // (and the existing `handoff` preview-tag consumers) keep working unchanged
  // because we use a NEW tag (`"guard-deny"`) that opts in to the new behavior
  // without colliding with the existing 16+ preview-tag vocabulary.
  const prefix = decision.hardDeny
    ? "Action blocked by dispatch guard (hard): "
    : "Action blocked by dispatch guard: "
  return deny(call.id, `${prefix}${decision.reason}`, "guard-deny")
}

const isSessionApprovalRequiredError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("approval" in error)) return false
  const approval = (error as { approval?: unknown }).approval
  return (
    typeof approval === "object" &&
    approval !== null &&
    "approvalId" in approval &&
    "reason" in approval &&
    "requestedAt" in approval
  )
}

/**
 * Run one tool call end to end: gates → execute → normalize errors.
 * Tool/permission/plan/hook failures become error tool_results (the model
 * recovers); only the loop's own fatal conditions propagate.
 *
 * **CANONICAL ORDERING (LOCKED — see `permission-hook-ordering.test.ts`)**
 *
 * Pre-execute pipeline (all in `dispatchToolInner` + `runAdmissibilityGate`):
 *
 *   0. registry.has(name) ......... unknown tool → deny ("Unknown tool: …")
 *   1. dispatch-seam guard ........ plan-mode mutating tools → deny
 *                                   (ADR-0036; outer gate, runs in dispatch.ts)
 *   2. dedup gate ................. T3 anti-thrash short-circuit (default-OFF)
 *   3. localize-phase gate ........ Agentless Phase-1 mutating block (default-OFF)
 *   3a. dispatch-guard ............ ADR-0229 composer of git-write-protect /
 *                                   branch-only / host-allowlist detectors
 *                                   (default-OFF when `config.dispatchGuard`
 *                                   is absent)
 *   4. mode-posture block ......... plan/review/audit mode (admissibility-gate §1)
 *   5. earlyHardDeny .............. HARD_DENY pulled ahead when ANY allow-capable
 *                                   bypass is wired (rules/reviewer/patternStore)
 *                                   so they cannot route around the denylist
 *                                   (admissibility-gate §2; AUDIT-FIX)
 *   6. pattern auto-pass .......... ADR-0061 rememberPatterns (default-OFF)
 *                                   → on auto-pass, fires `pre_tool_use` hook last
 *   7. prefix-rule DSL gate ....... ADR-0031 (default-OFF)
 *                                   allow→hook, deny→terminal, ask→reviewer
 *   8. HITL 4-tier gate ........... ADR-0047 (default-OFF when hitl disabled)
 *                                   hand-off→deny, always-confirm→onConfirm,
 *                                   none→hook, pre-approval→fallthrough
 *   9. permission stack ........... ADR-0046 per-thread/per-host/post-denial
 *                                   (default-OFF when stack.enabled !== true)
 *  10. mode policy (legacy) ....... evaluate() + classifier for auto-mode
 *                                   contains HARD_DENY (for paths that DIDN'T
 *                                   trigger earlyHardDeny — kept for parity)
 *  11. pre_tool_use hook ......... ADR-0133 (LAST gate, can deny OR rewrite input)
 *
 * Execute: `execute()` runs the (possibly rewritten) call via the registry.
 *
 * Post-execute pipeline (`emitPostToolUseHooks`):
 *  12. post_tool_use hook ......... fires ALWAYS (ok or !ok) — audit symmetry
 *  13. post_tool_use_failure hook . fires ONLY when ok:false — recovery channel
 *
 * **Invariants** (enforced by tests/unit/permission-hook-ordering.test.ts):
 *  · Permission denial (steps 4-10) ⇒ `pre_tool_use` hook NEVER fires.
 *  · HARD_DENY ⇒ permission AND hook both skipped (steps 5/10).
 *  · Plan mode (step 1 or 4) ⇒ permission AND hook skipped for mutating tools.
 *  · Hook `updatedInput` (step 11) is applied AFTER permission/HARD_DENY ran
 *    on the ORIGINAL input — intentional: a hook is operator-authored local
 *    code at the same trust level as the permission config itself. See
 *    `hooks.ts` SECURITY note. There is NO re-permission check on the rewrite.
 *  · Hook deny (step 11) ⇒ `execute()` not called ⇒ post-hooks (12/13) skipped.
 *  · post_tool_use fires before post_tool_use_failure when both apply (12 → 13).
 *  · A throwing hook never breaks dispatch (HookBus isolates; dispatch wraps
 *    post_tool_use_failure emit in try/catch as belt-and-braces).
 *  · Concurrent dispatches use independent admissibility-gate state — order
 *    is per-call, not global.
 *
 *  `workingState` is the optional session-scoped Codex memory L3 handle
 *  (ADR-0021). When the agent loop has built one (`AgentConfig.workingState?.
 *  enabled === true`) it is passed here so `ctx.workingState` is populated on
 *  the {@link ToolContext} forwarded to every tool. Absent ⇒ the field is
 *  OMITTED on `ctx` (exactOptionalPropertyTypes: never `undefined`), so
 *  callers without the opt-in are byte-identical. The closure pattern
 *  `createUpdateWorkingStateTool(handle)` continues to work — `ctx.workingState`
 *  is the second seam so future tools (or callers that don't capture via
 *  closure) can read the same handle.
 */
export const dispatchTool = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  onProgress?: (message: string) => void,
  autoClassifier?: AutoModeClassifier,
  workingState?: WorkingStateHandle,
): Promise<DispatchResult> => {
  // Codex 10-step span tree — `handle_tool_call` (innermost wrap). Opens
  // BEFORE the unknown-tool / dedup / admissibility-gate denies so every
  // dispatch attempt — admissible OR rejected — appears under the turn's
  // span tree. Closes via the single `finally` site (no early returns leak
  // an unclosed span). Status is derived from the final {@link DispatchResult}.
  // Default-OFF (no sink) ⇒ all `startSpan`/`endSpan` calls are the shared
  // NOOP_SPAN sentinel (zero allocation), so dispatch is byte-identical to
  // the pre-span path.
  const toolSpan: Span = startSpan(SPAN_NAMES.handleToolCall, toolSpanAttrs(call.name, call.id))
  try {
    const out = await dispatchToolInner(
      call,
      config,
      permission,
      onProgress,
      autoClassifier,
      workingState,
    )
    // Map `ok` ⇒ "success", non-ok ⇒ "error". A "blocked" outcome would
    // need the admissibility-gate to signal it explicitly; today the gate
    // returns a non-ok DispatchResult, so we surface it as "error" — the
    // `quanta.tool.call.status` enum union includes "blocked" but the seam
    // has no signal channel for it yet. Future work can refine.
    endSpan(
      toolSpan,
      out.ok ? "ok" : "error",
      attrs({ [QUANTA_ATTRS.tool.status]: out.ok ? "success" : "error" }),
    )
    return out
  } catch (e) {
    if (isSessionApprovalRequiredError(e)) {
      endSpan(toolSpan, "error", attrs({ [QUANTA_ATTRS.tool.status]: "error" }))
      throw e
    }
    // NO-THROW CONTRACT (AUDIT-FIX). `dispatchTool` is the loop's single-tool
    // pipeline and the streaming engine (`streaming-dispatch.ts`) is built on
    // the documented invariant that it NEVER throws — every failure becomes an
    // `ok:false` tool_result. `execute()` already normalizes tool throws, but
    // the PRE-execute path has un-normalized throw surfaces that escape here:
    //   · `registry.extractShellCommand` → tool-declared `extractShellCommand`
    //     (third-party code) can throw (called at `dispatchToolInner` L168).
    //   · `runAdmissibilityGate` → a wired `reviewerPort` rethrows by design
    //     (`reviewAndDecide`: "throws from the port propagate").
    //   · the dedup gate / a non-conforming `config.hooks.emit`.
    // Previously this `catch` re-threw, breaking the contract: the streaming
    // engine survived it (allSettled + synthetic block) but produced a generic
    // "dispatch threw unexpectedly" message instead of a proper error
    // tool_result, and any NON-streaming caller would see a raw exception.
    // We now NORMALIZE the throw into an error DispatchResult so the no-throw
    // contract holds structurally for EVERY path. The span is still closed
    // error before returning.
    endSpan(toolSpan, "error", attrs({ [QUANTA_ATTRS.tool.status]: "error" }))
    const message = e instanceof QuantaError ? e.message : toError(e).message
    return deny(call.id, `Tool dispatch failed for ${call.name}: ${message}`, "dispatch-error")
  }
}

/**
 * ADR-0269 Phase 3 — emit BOTH the legacy `tool_progress` reminder AND the
 * sidechannel `kind:"cap"` decision row when the ADR-0062 cap-enforcer
 * fires. Extracted to keep `dispatchToolInner`'s cognitive complexity below
 * biome's cap with the added decision-emit branch. Default-OFF for the
 * decision side: `config.decisionEmitter === undefined` ⇒ the helper inside
 * `emitCapReminderDecision` short-circuits before any allocation.
 */
const handleCapReminder = (
  config: AgentConfig,
  effectiveCall: ToolUseBlock,
  reminder: string,
): void => {
  config.stream.emit({
    type: "tool_progress",
    id: effectiveCall.id,
    name: effectiveCall.name,
    message: reminder,
  })
  emitCapReminderDecision(config.decisionEmitter, {
    tool: effectiveCall.name,
    toolCallId: effectiveCall.id,
    reminder,
    turn: config.run?.turn ?? 0,
  })
}

/** ADR-0062 rule #3 — pure helper: prepend the cap-enforcement reminder to a
 *  DispatchResult so the model reads the phrasing in the tool_result content.
 *  Extracted to keep `dispatchToolInner`'s cognitive complexity below biome's
 *  cap. When `reminder` is empty-string / undefined the result is UNCHANGED
 *  (byte-identical — this helper is only called when a reminder is present). */
const prependCapReminder = (out: DispatchResult, reminder: string): DispatchResult => ({
  ...out,
  preview: `<system-reminder>\n${reminder}\n</system-reminder>\n\n${out.preview}`,
  block: {
    ...out.block,
    content: `<system-reminder>\n${reminder}\n</system-reminder>\n\n${typeof out.block.content === "string" ? out.block.content : ""}`,
  },
})

const observeEffortClassifierToolFailure = (
  classifier: AgentConfig["effortClassifier"],
  toolName: string,
  out: DispatchResult,
): void => {
  if (classifier === undefined || out.ok) return
  classifier.onToolFailure(toolName)
}

/** ADR-0223 wrap: `execute(...)` bracketed by stuck-detector ticks so the
 *  auto-background slice can poll "is this tool past the 2s threshold?" without
 *  any per-call timer. Extracted to keep `dispatchToolInner` under biome's
 *  cognitive-complexity cap. Default-OFF byte-identical: when
 *  `config.autoBackground?.detector` is absent, both `tick*` calls short-
 *  circuit at the optional chain (zero allocation). The `tickToolEnd` runs
 *  from a `finally` so a throwing `execute()` (the outer dispatch catch
 *  normalizes throws to a deny-style result) still drops the tracker entry —
 *  no memory leak across thrown calls. */
const executeWithStuckTracking = async (
  effectiveCall: ToolUseBlock,
  config: AgentConfig,
  ctx: ToolContext,
  onProgress?: (message: string) => void,
): Promise<DispatchResult> => {
  const detector = config.autoBackground?.detector
  detector?.tickToolStart({
    toolCallId: effectiveCall.id,
    toolName: effectiveCall.name,
  })
  try {
    return await execute(effectiveCall, config, ctx, onProgress)
  } finally {
    detector?.tickToolEnd({ toolCallId: effectiveCall.id })
  }
}

const buildRequestPlanExit = (
  config: AgentConfig,
  collabMode: ReturnType<typeof resolveCollaborationMode>,
): ToolContext["requestPlanExit"] => {
  const planExitPort = config.planExitPort
  return planExitPort !== undefined
    ? async (plan: string) => {
        const outcome = await runPlanExitFlow(collabMode, plan, planExitPort)
        config.onPlanExitOutcome?.({ plan, outcome })
        return outcome
      }
    : undefined
}

/** ADR-0416 sibling-identity fix — project the STABLE mailbox labels onto the
 *  ToolContext partial. Each label is omitted when its `AgentConfig` slot is
 *  absent (root session / legacy caller) so the subagent-mailbox tools fall
 *  back to the depth-derived label and the ctx stays byte-identical. Extracted
 *  from `buildToolContext` to keep that builder under the cognitive-complexity
 *  cap. */
const mailboxLabels = (
  config: AgentConfig,
): { agentLabel?: string; parentAgentLabel?: string } => ({
  ...(config.mailboxAgentId !== undefined ? { agentLabel: config.mailboxAgentId } : {}),
  ...(config.mailboxParentId !== undefined ? { parentAgentLabel: config.mailboxParentId } : {}),
})

const buildToolContext = (args: {
  config: AgentConfig
  workingState: WorkingStateHandle | undefined
  collabMode: ReturnType<typeof resolveCollaborationMode>
  toolCallId: string
}): ToolContext => {
  const { config, workingState, collabMode, toolCallId } = args
  const requestPlanExit = buildRequestPlanExit(config, collabMode)
  const reviewerAgent = materializeReviewerAgent(config)
  return {
    cwd: config.cwd,
    signal: config.signal,
    gitWriteGuard: gitWriteProtectReason,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    // ADR-0416 sibling-identity fix — surface the STABLE per-agent mailbox
    // label (and the parent's) so the subagent-mailbox tools address each
    // sibling uniquely. ABSENT (root session / legacy caller) ⇒ omitted ⇒ the
    // tools fall back to the depth-derived label (byte-identical). Extracted to
    // a helper so this builder stays under the biome cognitive-complexity cap.
    ...mailboxLabels(config),
    ...(workingState !== undefined ? { workingState } : {}),
    ...(requestPlanExit !== undefined ? { requestPlanExit } : {}),
    ...(reviewerAgent !== undefined ? { reviewerAgent } : {}),
    ...(config.onShellEvent !== undefined ? { onShellEvent: config.onShellEvent } : {}),
    ...(config.planStore !== undefined
      ? { planMutator: planStoreToMutator(config.planStore) }
      : {}),
    ...(config.userInputPort !== undefined ? { requestUserInput: config.userInputPort } : {}),
    ...((): { shellSnapshot?: import("@/tool").ShellSnapshotRestoreSeam } => {
      const seam = config.shellSnapshotSession?.currentSeam()
      return seam !== undefined ? { shellSnapshot: seam } : {}
    })(),
    ...(config.sessionConfigPort !== undefined ? { sessionConfig: config.sessionConfigPort } : {}),
    // ADR-0474 — thread the per-session stale-read-guard state so `read` records
    // mtimes and `write`/`edit` block stale mutations. ABSENT ⇒ no tracking
    // (byte-identical default-OFF).
    ...(config.readFileState !== undefined ? { readFileState: config.readFileState } : {}),
    // ADR-0421 wire-finish — thread the fast-apply fallback port from
    // AgentConfig into the ToolContext so `apply_patch` actually receives it.
    // ABSENT ⇒ ctx field absent ⇒ apply_patch byte-identical (default-OFF).
    ...(config.fastApplyFallback !== undefined
      ? { fastApplyFallback: config.fastApplyFallback }
      : {}),
    // ADR-0428 jun-02 wire — surface the LIVE proxy-env (bound loopback address)
    // so shell-class tools inject HTTP(S)_PROXY into the child spawn. ABSENT ⇒
    // omitted ⇒ `withProxyEnv` returns the same base env (byte-identical legacy).
    ...(config.proxyEnv !== undefined ? { proxyEnv: config.proxyEnv } : {}),
    // ADR-0455 — surface the DECLARED local-environment selection so shell-class
    // tools compose its vars / PATH-prepends over the scrubbed child env
    // (allowlist still governs). ABSENT (no config file / no env selected) ⇒
    // omitted ⇒ `applyLocalEnv` returns the same base env (byte-identical legacy).
    ...(config.localEnv !== undefined ? { localEnv: config.localEnv } : {}),
    // ADR-0440 wire-finish — surface the tool-diff capture sink + the current
    // call id so a file-mutating tool can feed its before/after to the canvas
    // emitter. ABSENT (gate OFF / non-canvas caller) ⇒ both fields omitted ⇒ no
    // tool captures anything, byte-identical legacy path.
    ...(config.onToolDiff !== undefined ? { toolDiff: config.onToolDiff, toolCallId } : {}),
  }
}

/** Span-free dispatch body (extracted so the outer wrap keeps a single
 *  control flow). Identical logic to the pre-span path. */
const dispatchToolInner = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  onProgress: ((message: string) => void) | undefined,
  autoClassifier: AutoModeClassifier | undefined,
  workingState: WorkingStateHandle | undefined,
): Promise<DispatchResult> => {
  const { registry } = config

  if (!registry.has(call.name)) {
    return deny(call.id, `Unknown tool: ${call.name}`, "unknown tool")
  }

  // ADR-0036 L4 wire (plan-mode-dispatch-block): consult the dispatch-seam
  // guard BEFORE the dedup gate / admissibility gate. The seam is a single
  // table lookup (`MUTATING_TOOL_TABLE`) and a `default` collaboration mode
  // short-circuits to `{ ok: true }` in one branch, so this is byte-identical
  // for every caller that hasn't opted in (the default of
  // `resolveCollaborationMode` is `"default"`).
  //
  // Read-only fast path: a tool that DECLARES `isReadOnly() === true` is
  // unconditionally allowed in plan posture regardless of table membership.
  // The registry's per-tool `isReadOnly()` is the runtime SSOT for the
  // mutating-vs-read-only invariant — every built-in tool implements it; a
  // host that ships a custom read-only tool without remembering to add it to
  // the table should still be allowed (the table is fail-closed FOR
  // MUTATING tools, not for safe ones). For mutating / unknown calls we
  // route through the seam guard which fails-closed via UnknownToolError on
  // any tool missing from MUTATING_TOOL_TABLE — that's where the "no silent
  // mutating bypass" invariant lives. SOTA (Codex): the block is dispatch-
  // time + stateless (no per-turn unwinding); a `default` ⇒ `plan`
  // transition only affects calls AFTER the transition.
  const collab = resolveCollaborationMode(config)
  if (collab === "plan" && !registry.isReadOnly(call.name)) {
    const seamDecision = checkDispatchAllowed({ collaborationMode: collab }, { name: call.name })
    if (!seamDecision.ok) {
      return deny(call.id, seamDecision.reason.message, "mode-blocked")
    }
  }

  // T3 — pre-flight dedup gate (SOTA++ structural brake on Type F Verify-Loop
  // Stuck on Env). Consulted BEFORE the admissibility gate so a thrashing
  // call never burns permission/HITL/hook work. Default-OFF: when
  // `config.dedupGate` is absent (or `config.run?.turn` is unavailable so we
  // have no turn source) this is a one-`undefined`-check no-op and dispatch
  // is byte-identical. The block synthesizes a non-error tool_result mirroring
  // `dispatch-helpers.ts#resultBlock(id, content, false)` — no new event type,
  // the loop's tool_result pipeline handles it like any other observation.
  const dedupShort = consultDedupGate(call, config)
  if (dedupShort) return dedupShort

  // Localize-phase pre-flight (Agentless absorption — Tier 0). Mirrors the
  // dedup-gate placement: consulted BEFORE the admissibility gate so a
  // Phase-1 mutating-tool attempt never burns permission/HITL/hook work.
  // Default-OFF: when `config.localizePhase` / `localizePhaseState` is unset
  // or `phase1Turns` is invalid, the gate returns `null` (single property
  // check + early return → byte-identical dispatch).
  const localizeShort = consultLocalizePhase(call, config)
  if (localizeShort) return localizeShort

  // ADR-0229 — pre-flight dispatch guard. Composes git-write-protect /
  // branch-only / host-allowlist detectors behind one closed port. Default-OFF
  // (single optional-chain `undefined` check when `config.dispatchGuard`
  // absent → byte-identical to the pre-ADR path). Placed alongside the other
  // pre-flights so an early static rejection never burns permission/HITL/hook
  // work.
  const guardShort = consultDispatchGuard(call, config)
  if (guardShort) return guardShort

  // S16: populate `shellCommand` from the registry so the permission policy
  // applies HARD_DENY uniformly to ANY tool that exposes a shell-command
  // surface (`extractShellCommand` method) — not just one named "bash".
  const shellCommand = registry.extractShellCommand(call.name, call.input)
  const action = {
    tool: call.name,
    input: call.input,
    isReadOnly: registry.isReadOnly(call.name),
    ...(shellCommand !== null ? { shellCommand } : {}),
  }

  // SSOT pre-execute gate (see admissibility-gate.ts for the canonical order).
  // A `pre_tool_use` hook may rewrite the tool args (Cursor `updated_input`
  // parity). The gate runs that hook on its admit path and surfaces the rewrite
  // through `onInputMutation`; we capture it here and execute the MUTATED input.
  // Default-OFF: no hooks (or no rewrite) ⇒ `rewritten` stays undefined and the
  // executed call is byte-identical to the pre-hook path. The wrapper object
  // (`{ value }`) lets a hook legitimately rewrite to a falsy value.
  let rewritten: { value: unknown } | undefined
  const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier, {
    ...(config.admissibility ?? {}),
    onInputMutation: (next) => {
      rewritten = { value: next }
    },
  })
  if (gated) return gated
  // SECURITY: the rewrite is applied AFTER the permission / HARD_DENY gates ran
  // on the original input. A hook is operator-authored local code at the trust
  // level of the permission config itself, so this is intentional (the model
  // and untrusted content cannot reach it). See hooks.ts `emit` security note.
  const effectiveCall: ToolUseBlock = rewritten ? { ...call, input: rewritten.value } : call
  const ctx = buildToolContext({
    config,
    workingState,
    collabMode: collab,
    toolCallId: effectiveCall.id,
  })
  // ADR-0062 rule #3 — cap-as-instruction enforcement (DEFAULT-OFF).
  // Before executing the tool, check whether the model IGNORED the last
  // nextAction hint for this (toolName, targetPath) pair. When ignored, emit
  // a `tool_progress` system-reminder to the stream (so the UI/recorder sees
  // it) and prepend the reminder text to this result's output (so the model
  // reads it in the tool_result content). The check is a single Map.get —
  // zero allocation when absent. capEnforcer absent ⇒ `check` is never
  // called, byte-identical to the pre-enforcement path.
  const capReminder = config.capEnforcer?.check(effectiveCall.name, effectiveCall.input)
  if (capReminder !== undefined) handleCapReminder(config, effectiveCall, capReminder)
  // ADR-0223 — stuck-detector ticked execute(). Default-OFF byte-identical
  // when `config.autoBackground?.detector` is absent (optional chain short-
  // circuits before allocation; finally runs unconditionally so a throwing
  // `execute()` cannot leak a tracker entry).
  const out = await executeWithStuckTracking(effectiveCall, config, ctx, onProgress)
  observeEffortClassifierToolFailure(config.effortClassifier, effectiveCall.name, out)
  // When a reminder was generated, prepend it as a `<system-reminder>` block
  // in the tool result output so the model reads the enforcement hint alongside
  // the tool output. `prependCapReminder` is extracted to keep complexity low.
  const finalOut = capReminder !== undefined ? prependCapReminder(out, capReminder) : out
  if (config.hooks) {
    await emitPostToolUseHooks(config, effectiveCall, finalOut)
  }
  return finalOut
}

/** ADR-0133 — fire `post_tool_use` (always) + `post_tool_use_failure` (only
 *  when ok:false). Extracted to keep `dispatchToolInner` under the biome
 *  complexity cap. Two channels (not one combined) because:
 *    1. `post_tool_use` is the audit/observability symmetry channel — every
 *       tool call fires it exactly once, success or failure, so a metrics
 *       consumer sees the COMPLETE outcome series.
 *    2. `post_tool_use_failure` is the RECOVERY channel — a host may wire it
 *       to inject `promptHook` ("the bash exit code 1 is from a missing
 *       package; suggest installing") that the loop folds into the next
 *       LLM turn. Audit hooks should NOT pay this cost on success.
 *  Order: `post_tool_use` FIRST (mirrors today's symmetry), failure SECOND
 *  (so a failure handler that emits a `promptHook` sees the result after
 *  post-side processing). Try/catch on the failure emit protects dispatch's
 *  no-throw contract — a misbehaving failure hook cannot turn a normal tool
 *  error into a dispatch-level throw. */
const emitPostToolUseHooks = async (
  config: AgentConfig,
  effectiveCall: ToolUseBlock,
  finalOut: DispatchResult,
): Promise<void> => {
  if (!config.hooks) return
  await config.hooks.emit({
    type: "post_tool_use",
    name: effectiveCall.name,
    // R2 fix: forward the EXECUTED input so audit/observability hooks have
    // pre/post symmetry. The pre hook saw `effectiveCall.input` (possibly
    // rewritten); post sees the same value — what the tool actually ran with.
    input: effectiveCall.input,
    ok: finalOut.ok,
    output: finalOut.preview,
  })
  if (finalOut.ok) return
  try {
    await config.hooks.emit({
      type: "post_tool_use_failure",
      name: effectiveCall.name,
      input: effectiveCall.input,
      error: finalOut.preview,
    })
  } catch (e) {
    // The HookBus already isolates throwing HANDLERS; this catch is the
    // belt-and-braces for a future bus implementation that could itself
    // throw on a malformed event.
    const message = e instanceof QuantaError ? e.message : toError(e).message
    config.stream.emit({
      type: "error",
      message: `post_tool_use_failure hook threw: ${message}`,
    })
  }
}

/** Build the `handle_tool_call` span open-attrs. Status (and durationMs)
 *  fill in on close — at open time we only know the name + call_id. */
const toolSpanAttrs = (name: string, callId: string) =>
  attrs({
    [QUANTA_ATTRS.tool.name]: name,
    [QUANTA_ATTRS.tool.callId]: callId,
  })

/**
 * ADR-0078 Layer-1 source-class derivation. PR-2 self-audit fix: consults the
 * tool's DECLARED `classifySource(input)` method via the registry — no
 * `tool.name` / argument-field-name string matching. Pre-fix this was a
 * hard-coded `PATH_TOOL_NAMES` / `COMMAND_TOOL_NAMES` set that silently
 * skipped any custom tool whose name wasn't in the set (a leak surface that
 * directly contradicted the structural posture PR-1 established for
 * `Tool.isReadOnly()`). Now every file/command-touching tool DECLARES its
 * classifier; absence means the tool surfaces no path/cmd input and Layer-2
 * pattern matching is the only redaction (behavior-preserving for tools
 * that don't deal with paths/commands).
 *
 * The `label` rides into the `source_class_secret` placeholder so the user/
 * audit can see WHERE the redacted output came from; we derive it from the
 * tool's `extractShellCommand` (already a declared method) or — for path
 * tools — from a single canonical `path` field on the input. The latter is
 * intentionally narrow: the structural contract is that a tool declaring
 * `classifySource` for a path input also exposes `{path: string}` (current
 * convention; the `read` tool's schema enforces this). Tools wanting a
 * different label can expose `extractShellCommand` or future
 * `extractSourceLabel`.
 *
 * Never throws — a tool that throws inside `classifySource` is caught and
 * treated as `null` (Layer-2 only) so a tool-side bug cannot break dispatch.
 */
const deriveSourceClass = (
  call: ToolUseBlock,
  config: AgentConfig,
): { cls: SensitivityClass; label: string } | null => {
  const tool = config.registry.get(call.name)
  if (tool === undefined || tool.classifySource === undefined) return null
  let cls: SensitivityClass | null
  try {
    cls = tool.classifySource(call.input)
  } catch {
    // Tool-side bug must not break dispatch — treat as no source class.
    return null
  }
  if (cls === null) return null
  // Label derivation: prefer the tool's declared shell-command extractor
  // (already used by HARD_DENY); fall back to a `path` field on the input
  // for filesystem tools. A tool exposing neither still gets Layer-1 by
  // class but a generic label.
  const shellCmd = tool.extractShellCommand?.(call.input) ?? null
  const inputPath =
    call.input !== null && typeof call.input === "object" && "path" in call.input
      ? (call.input as { path: unknown }).path
      : null
  const label =
    typeof shellCmd === "string" && shellCmd.length > 0
      ? shellCmd
      : typeof inputPath === "string" && inputPath.length > 0
        ? inputPath
        : `<${call.name}>`
  return { cls, label }
}

/** Drive the registry through the relocatable effect boundary (ADR-0093 M1).
 *  The {@link LocalEffectChannel} owns the no-throw + duration contract that
 *  used to live in the inline try/catch below — it normalizes executor
 *  exceptions into `{ok:false, output:<msg>}` envelopes and measures
 *  `durationMs` channel-internal, so the orchestration plane here only has
 *  redaction + DispatchResult shaping to do. Adopting a SandboxEffectChannel /
 *  RemoteEffectChannel later swaps the channel constructor here ONLY — the
 *  surrounding redaction / failure / evidence flatten is substrate-agnostic.
 *
 *  Byte-identical to the prior inline try/catch: the channel's catch wording
 *  mirrors the QuantaError/toError(e).message path, and `durationMs` is still
 *  measured around `registry.run` (channel-entry → executor-return/throw). */
const execute = async (
  call: ToolUseBlock,
  config: AgentConfig,
  ctx: ToolContext,
  onProgress?: (message: string) => void,
): Promise<DispatchResult> => {
  const localChannel = new LocalEffectChannel({
    execute: (c, c2, op) => config.registry.run(c.name, c.input, c2, op),
  })
  // ADR-0121 wire: when `config.shadowCheckpoint` is configured AND
  // `config.shadowOdb` is wired (and mode !== "off"), wrap with the auto-
  // checkpoint policy. Otherwise this returns `localChannel` UNCHANGED → the
  // entire dispatch path is byte-identical for any caller that did not opt
  // into ADR-0121. `resolveTool` delegates to the registry's `get` so the
  // policy's destructiveness oracle classifies the call via the same registry
  // the executor consults.
  const channel = wireCheckpointedEffectChannel(localChannel, config, (name) =>
    config.registry.get(name),
  )
  const { result, durationMs } = await channel.execute({ call, ctx }, onProgress)
  // The channel collapses BOTH "tool returned ok:false" and "executor threw"
  // into the same `{ok:false, output:<msg>}` envelope shape — the throw path
  // simply lacks `failure` and `evidence`. Handling them uniformly here keeps
  // the DispatchResult shape byte-identical to the prior try-success branch:
  // `evidenceOf({})` is empty and the typed-failure spread is conditional, so
  // a normalized-throw result yields exactly the same fields as the old catch.
  const { output: redacted, hits } = applyRedaction(result.output, call, config)
  // ADR-0287 — async-tool deferred-handle wire. When the tool's terminal
  // result carries a `deferred` marker (set by `defineToolAsync`), prepend
  // a stable `<deferred handle="..."/>` envelope so the LLM can branch on
  // the format. Absent ⇒ byte-identical (default-OFF).
  const output =
    result.deferred !== undefined
      ? `<deferred handle="${result.deferred.id}"/>\n${redacted}`
      : redacted
  // ADR-0062 rule #3 — record the nextAction hint in the session tracker so
  // a subsequent call to the same (tool, path) can be checked. DEFAULT-OFF:
  // absent enforcer ⇒ optional-chain is a no-op, byte-identical.
  config.capEnforcer?.record(call.name, call.input, result.nextAction)
  // ADR-0126 wire: ask the composer whether this tool result needs the
  // structured `contentBlocks` form (only when `result.images` is non-empty).
  // The composer returns the legacy STRING when no images are attached, in
  // which case we omit `contentBlocks` and the tool_result block is
  // byte-identical to the pre-feature path. The `output` text inside the
  // composed array is the POST-REDACTION string, so secret-redaction keeps
  // firing on every code path (image bytes are opaque base64 attachments
  // the tool's own policy gates upstream).
  const composed = composeToolResultContent({ ...result, output })
  const contentBlocks = typeof composed === "string" ? undefined : composed
  return {
    block: resultBlock(call.id, output, !result.ok, contentBlocks),
    ok: result.ok,
    preview: output,
    durationMs,
    ...evidenceOf(result),
    // absorb #2 (Cursor failure model): surface the tool's typed failure
    // reason verbatim when it classified one. Omitted when absent so
    // `exactOptionalPropertyTypes` never sees `undefined` and callers that
    // do not read `failure` stay byte-identical.
    ...(result.failure !== undefined ? { failure: result.failure } : {}),
    ...(hits.length > 0 ? { redactionHits: hits } : {}),
    // ADR-0062 rule #3 — forward the nextAction hint onto the DispatchResult
    // so consumers (stream emitters, recorders) can observe it. Omitted when
    // absent (exactOptionalPropertyTypes).
    ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
  }
}

/**
 * ADR-0078 application point #1 — tool result normalization. Applies
 * `redactSecrets({origin:"tool_result", sourceClass})` with the Layer-1
 * class derived from the call's input shape. When the host has opted out
 * via `config.redaction.disabled === true` (validated at startup) we
 * skip — the disabled mode is announced as a `<system-reminder>` so the
 * model is never silently unprotected.
 *
 * ADR-0399 application point #2 — OPTIONAL PII-redaction pass. Runs AFTER
 * the secret pass on the already-secret-masked text (so a secret placeholder
 * can never accidentally re-expose PII that was hiding inside the secret
 * span, and PII never accidentally rewrites a `[REDACTED:*]` token already
 * substituted by secret-redaction). Strict gate: `pii?.enabled === true`
 * — any other value (false / undefined / absent block) means OFF and the
 * scanner is never instantiated. Default-OFF: absent config ⇒ byte-identical
 * to the secret-only baseline. Orthogonal to the secret branch — the two
 * passes never cross-talk; either branch can be on with the other off.
 *
 * NOT in scope for ADR-0399: the async `src/security/secret-detection/`
 * module is detection-only (no splice) and cannot drop in here. Its wire
 * is a separate gate/tool ADR.
 */
const applyRedaction = (
  text: string,
  call: ToolUseBlock,
  config: AgentConfig,
): { output: string; hits: ReadonlyArray<RedactionHit> } => {
  let postSecret = text
  let hits: ReadonlyArray<RedactionHit> = []
  if (config.redaction?.disabled !== true) {
    const src = deriveSourceClass(call, config)
    const result = redactSecrets(text, {
      origin: "tool_result",
      ...(src !== null ? { sourceClass: src.cls, sourceLabel: src.label } : {}),
      ...(config.redaction?.whitelist !== undefined
        ? { whitelist: config.redaction.whitelist }
        : {}),
    })
    postSecret = result.text
    hits = result.hits
  }
  // PII pass — independent toggle. Strict `=== true` so any other shape
  // (false / undefined / missing block) keeps the byte-identical secret-only
  // path. The scanner is opts-in by call, no shared mutable state.
  const piiConfig = config.redaction?.pii
  if (piiConfig?.enabled === true) {
    const scanner = compositePiiScanner({
      ...(piiConfig.kinds !== undefined ? { kinds: piiConfig.kinds } : {}),
      ...(piiConfig.allowlist !== undefined ? { allowlist: piiConfig.allowlist } : {}),
      ...(piiConfig.redactionTemplate !== undefined
        ? { redactionTemplate: piiConfig.redactionTemplate }
        : {}),
    })
    postSecret = scanner.redactText(postSecret)
  }
  return { output: postSecret, hits }
}
