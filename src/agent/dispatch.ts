import type { ToolUseBlock } from "@/llm"
import {
  attrs,
  endSpan,
  getSpanSink,
  mergeAttrs,
  QUANTA_ATTRS,
  SPAN_NAMES,
  type Span,
  startSpan,
} from "@/observability"
import { type AutoModeClassifier, extractWriteEffects, type PermissionContext } from "@/permission"
import { redactSecrets } from "@/security"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, WorkingStateHandle } from "@/tool"
import { runAdmissibilityGate } from "./admissibility-gate"
import { emitCapReminderDecision } from "./decision-emit-phase3"
import { modeApprovalDenyReason, stackDenyReason } from "./deny-reason-wire"
import { execute } from "./dispatch/execute"
import {
  consultDedupGate,
  consultDispatchGuard,
  consultLocalizePhase,
  consultQuestionAvailability,
  consultTestScope,
} from "./dispatch/preflight-consults"
import { buildToolContext, maybeBuildInterruptRouter } from "./dispatch/tool-context"
import { deny, isSessionApprovalRequiredError } from "./dispatch-helpers"
import { checkDispatchAllowed } from "./dispatch-seam-guard"
import type { DispatchResult } from "./dispatch-types"
import { resolveCollaborationMode } from "./mode"
import {
  checkWriteEffects,
  fieldWriteEffects,
  isUnfenceableWriteTool,
  patchWriteEffects,
} from "./ownership-policy"
import { reproDoubtStep } from "./repro-doubt-guard"
import { toolGenAiAttrs, withActiveSpanScope } from "./session-resources"
import { redactThenPreview } from "./span-content-redact"
import type { AgentConfig } from "./types"

export type { DispatchResult } from "./dispatch-types"

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
  const captureContent = getSpanSink() !== null && (config.contentCaptureEnabled ?? false)
  const toolSpan: Span = startSpan(
    SPAN_NAMES.handleToolCall,
    mergeAttrs(
      toolSpanAttrs(call.name, call.id, captureContent, call.input),
      toolGenAiAttrs(call.name, call.id),
    ),
  )
  try {
    // Activate the `execute_tool` span in async context so the legacy
    // `recordAttrs(handle_tool_call, …)` emit sites fired DURING dispatch — the
    // HITL tier/handoff decisions (admissibility-gate) and the apply_patch op
    // trace — nest under THIS tool span instead of orphaning as flat sink rows
    // with no parent. Concurrent tool dispatches get INDEPENDENT refs (each is a
    // sibling under the shared turn), so their nested emits never cross-link.
    // No-op wrap when no sink is active (byte-identical default-OFF).
    const out = await withActiveSpanScope(false, toolSpan, () =>
      dispatchToolInner(call, config, permission, onProgress, autoClassifier, workingState),
    )
    // Map `ok` ⇒ "success", non-ok ⇒ "error". A "blocked" outcome would
    // need the admissibility-gate to signal it explicitly; today the gate
    // returns a non-ok DispatchResult, so we surface it as "error" — the
    // `quanta.tool.call.status` enum union includes "blocked" but the seam
    // has no signal channel for it yet. Future work can refine.
    endSpan(
      toolSpan,
      out.ok ? "ok" : "error",
      toolCloseAttrs(out.ok ? "success" : "error", captureContent, out.preview),
    )
    return out
  } catch (e) {
    if (isSessionApprovalRequiredError(e)) {
      endSpan(toolSpan, "error", toolCloseAttrs("error", captureContent))
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
    const message = e instanceof QuantaError ? e.message : toError(e).message
    const redactedMessage = redactSecrets(message, { origin: "tool_result" }).text
    endSpan(toolSpan, "error", toolCloseAttrs("error", captureContent, redactedMessage))
    return deny(
      call.id,
      `Tool dispatch failed for ${call.name}: ${redactedMessage}`,
      "dispatch-error",
    )
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

/** repro-doubt guard (jun-20) — advance the per-run stuck counter on every tool
 *  dispatch and, when the agent has re-run the test `stuckRuns` times since its
 *  last edit, prepend the one-shot {@link REPRO_DOUBT_STEER} as a system-reminder.
 *  DEFAULT-OFF byte-identical: absent `reproDoubt`/`reproDoubtState` ⇒ early return
 *  with no allocation. State is advanced by reassigning `config.reproDoubtState`
 *  (the config object persists across the run — same channel as `attachReproDoubt`),
 *  mirroring how `localizePhaseState` is carried. The steer reuses
 *  {@link prependCapReminder}'s system-reminder framing so the model reads it
 *  alongside the test output it just produced. */
const applyReproDoubtSteer = (
  out: DispatchResult,
  config: AgentConfig,
  toolName: string,
  command: string | undefined,
): DispatchResult => {
  const cfg = config.reproDoubt
  const state = config.reproDoubtState
  if (cfg === undefined || state === undefined) return out
  // `command` (the extracted shell command, undefined for non-shell tools) lets
  // the guard count a `bash` as a test re-run ONLY when it looks test-like —
  // plain investigation (ls/cat/grep) no longer trips the stuck streak.
  const r = reproDoubtStep(state, toolName, cfg, command)
  config.reproDoubtState = r.state
  return r.steer === undefined ? out : prependCapReminder(out, r.steer)
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

/** ADR-0036 L4 — plan-collaboration-mode dispatch block. A MUTATING tool (not
 *  `isReadOnly`) in `plan` posture routes through the fail-closed seam guard
 *  (`MUTATING_TOOL_TABLE` lookup; fails-closed via UnknownToolError on any tool
 *  missing from the table — the "no silent mutating bypass" invariant). A
 *  read-only tool is unconditionally allowed (the registry `isReadOnly()` is the
 *  runtime SSOT). Returns a deny when blocked, else null. Byte-identical for the
 *  `default` collaboration mode (returns null immediately). */
const consultPlanModeSeam = (
  call: ToolUseBlock,
  config: AgentConfig,
  collab: ReturnType<typeof resolveCollaborationMode>,
): DispatchResult | null => {
  if (collab !== "plan" || config.registry.isReadOnly(call.name)) return null
  const seamDecision = checkDispatchAllowed({ collaborationMode: collab }, { name: call.name })
  if (seamDecision.ok) return null
  return deny(
    call.id,
    seamDecision.reason.message,
    "mode-blocked",
    // C6: same conceptual deny as the admissibility-gate `denyIfModeBlocked`
    // (`layer:"mode"`/`pillar:"approval"`), fired earlier on the collaboration
    // path. Categorical safeReason (the typed error `message` already surfaces
    // mode+tool on `content`, never input).
    modeApprovalDenyReason("tool blocked in plan collaboration mode"),
  )
}

type PreAdmissibilityConsult = (
  call: ToolUseBlock,
  config: AgentConfig,
  collab: ReturnType<typeof resolveCollaborationMode>,
) => DispatchResult | null

const PRE_ADMISSIBILITY_CONSULTS: readonly PreAdmissibilityConsult[] = [consultPlanModeSeam]

/** The uniform pre-flight consults, in canonical order (dedup → localize-phase →
 *  test-scope → dispatch-guard → question-availability). Each is default-OFF
 *  (returns null unless its feature is wired), consulted BEFORE the admissibility
 *  gate so a rejected call never burns permission/HITL/hook work. Adding a
 *  pre-flight = one array entry, not a new inline `if (short) return short` (OCP).
 *
 *  `consultQuestionAvailability` (RFC-05 E5) is the pre-DISPATCH half of the
 *  one-reader-two-sites contract: it resolves the SAME reader/predicate the
 *  model-spec projection (`buildUserInputBlock`) uses, so a STALE
 *  `request_user_input` handle cannot bypass a later posture change — spec
 *  visibility and dispatch admission never diverge. */
const PRE_FLIGHT_CONSULTS: readonly ((
  call: ToolUseBlock,
  config: AgentConfig,
) => DispatchResult | null)[] = [
  consultDedupGate,
  consultLocalizePhase,
  consultTestScope,
  consultDispatchGuard,
  consultQuestionAvailability,
]

/** §20.4 (ticket-12) — subagent FS ownership ENFORCEMENT. After the admissibility
 *  gate, before execute: a child carrying an enforced owned/forbidden policy is
 *  HARD-blocked from writing outside its owned set / inside its forbidden set.
 *  Write-effects come from the leaf (path/file + LITERAL bash `sed -i`/redirect —
 *  best-effort, `$VAR`/computed shell targets are an accepted FN), patch tools,
 *  and field tools; unfenceable writers are fail-closed first (see
 *  `isUnfenceableWriteTool`). All re-canonicalized symlink-safe. Default-OFF: no
 *  policy / `enforced !== true` ⇒
 *  returns null (byte-identical). */
const consultOwnership = (
  call: ToolUseBlock,
  config: AgentConfig,
  shellCommand: string | null,
  isReadOnly: boolean,
): DispatchResult | null => {
  if (config.ownershipPolicy?.enforced !== true) return null
  // FAIL-CLOSED: write-capable tools whose FS targets are not statically knowable
  // at dispatch (lsp_rename_apply's server-computed edits, shadow_rewind's whole
  // snapshot, mcp_read_resource's server-derived blob path) cannot be proven
  // in-bounds — deny rather than silently pass (or under-report to a misleading
  // anchor). All are GATED, so a default fenced subagent is unaffected.
  if (isUnfenceableWriteTool(call.name)) {
    return deny(
      call.id,
      `subagent ownership boundary: '${call.name}' writes to targets not statically knowable at dispatch — unfenceable under ownership enforcement, denied`,
      "ownership-policy-denied",
      stackDenyReason("unfenceable write under subagent ownership fence"),
    )
  }
  const own = checkWriteEffects(
    [
      // top-level `path`/`file` + shell targets (circumvention leaf) …
      ...extractWriteEffects(call.name, call.input, shellCommand, config.cwd, isReadOnly),
      // … UNION the patch-carrying tools' targets (inside `input.patch`), which
      // the leaf cannot see — closes the apply_patch/apply_patch_structured false
      // fence (a fenced subagent otherwise escapes its owned set via apply_patch).
      ...patchWriteEffects(call.name, call.input, config.cwd),
      // … and the field-carrying structured writers (image_gen `outputPath`,
      // shadow_restore_partial `paths[]`) whose targets the leaf also can't read.
      ...fieldWriteEffects(call.name, call.input, config.cwd),
    ],
    config.ownershipPolicy,
    config.cwd,
  )
  if (own.allowed) return null
  return deny(
    call.id,
    `subagent ownership boundary: ${own.reason === "forbidden" ? "forbidden path" : "path not in owned set"} — ${own.path}`,
    "ownership-policy-denied",
    stackDenyReason("subagent ownership boundary violated"),
  )
}

type PostAdmissibilityConsult = (
  call: ToolUseBlock,
  config: AgentConfig,
  shellCommand: string | null,
  isReadOnly: boolean,
) => DispatchResult | null

const POST_ADMISSIBILITY_CONSULTS: readonly PostAdmissibilityConsult[] = [consultOwnership]

/**
 * Walk a consult registry in order and return the FIRST non-null
 * short-circuit, or `null` when every consult admitted the call.
 *
 * UNIT because dispatch has THREE consult registries (pre-admissibility,
 * pre-flight, post-admissibility) whose walks were three byte-identical
 * `for … if (short) return short` copies differing only in the arguments each
 * consult takes. The generic `run` callback carries that difference, so the
 * FIRST-WINS + do-not-evaluate-the-rest contract — the part that is actually
 * security-relevant, since a later consult must never override an earlier
 * deny — is stated exactly once.
 */
const firstConsult = <T>(
  consults: readonly T[],
  run: (consult: T) => DispatchResult | null,
): DispatchResult | null => {
  for (const consult of consults) {
    const short = run(consult)
    if (short) return short
  }
  return null
}

/** The SSOT pre-execute gate's outcome: either it short-circuited the call, or
 *  it admitted it — possibly with a `pre_tool_use` hook rewrite of the args. */
type AdmissibilityOutcome =
  | { readonly kind: "short"; readonly result: DispatchResult }
  | { readonly kind: "admit"; readonly rewritten: { readonly value: unknown } | undefined }

/**
 * Run the SSOT pre-execute gate (see admissibility-gate.ts for the canonical
 * order) and report BOTH of its channels.
 *
 * UNIT because the gate has a RETURN channel (a deny) and a CALLBACK channel
 * (`onInputMutation`, the Cursor `updated_input` parity rewrite), and the two
 * have to be read together: a rewrite captured off a call the gate then denied
 * must never reach `execute`. Folding both into one discriminated outcome makes
 * that impossible to get wrong, and removes the mutable `let rewritten` the
 * caller previously had to keep alive across the await. The wrapper object
 * (`{ value }`) lets a hook legitimately rewrite to a falsy value.
 *
 * Default-OFF: no hooks (or no rewrite) ⇒ `rewritten` stays undefined and the
 * executed call is byte-identical to the pre-hook path.
 */
const runPreExecuteGate = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  action: Parameters<typeof runAdmissibilityGate>[3],
  autoClassifier: AutoModeClassifier | undefined,
): Promise<AdmissibilityOutcome> => {
  let rewritten: { value: unknown } | undefined
  const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier, {
    ...(config.admissibility ?? {}),
    // ALBB-11 (ADR-0407) — the approval-state-machine is a cross-cutting
    // observability port wired onto TOP-LEVEL `config` (observability-wire.ts),
    // NOT the `admissibility` sub-bundle. Thread it into the gate opts at this
    // single seam so reviewer escalations attribute `request`/`settle` to the
    // Objective / Run Ledger. Presence-gated ⇒ absent (default-OFF /
    // `QUANTA_OBSERVABILITY` off) is byte-identical legacy.
    ...(config.approvalStateMachine !== undefined
      ? { approvalStateMachine: config.approvalStateMachine }
      : {}),
    onInputMutation: (next) => {
      rewritten = { value: next }
    },
  })
  if (gated) return { kind: "short", result: gated }
  return { kind: "admit", rewritten }
}

/**
 * Build the tool-execution context for the (possibly rewritten) call, together
 * with the interrupt router that must be disposed after execute.
 *
 * UNIT because the router and the context are one resource with two halves:
 * the router is created ONLY to be threaded into `ctx.interrupt`, and the
 * caller needs the handle back for exactly one reason — to `dispose()` it in a
 * `finally`. Returning them as a pair makes "you built it, you must release it"
 * a single hand-off instead of two loose locals.
 *
 * jun-6 (RFC jun-6-tool-interrupt-behavior) — for a `block` tool with the knob
 * ON, run over a derived suppressible signal + a critical-section seam so the
 * tool's atomic FS-write window finishes whole before a withheld ESC lands.
 * ABSENT (knob off / `cancel` tool) ⇒ ctx threads the raw signal, no seam
 * (byte-identical).
 */
const buildInterruptAwareContext = (
  config: AgentConfig,
  effectiveCall: ToolUseBlock,
  collabMode: ReturnType<typeof resolveCollaborationMode>,
  workingState: WorkingStateHandle | undefined,
): {
  readonly ctx: ToolContext
  readonly interruptHandle: ReturnType<typeof maybeBuildInterruptRouter>
} => {
  const interruptHandle = maybeBuildInterruptRouter(config, effectiveCall.name)
  const ctx = buildToolContext({
    config,
    workingState,
    collabMode,
    toolCallId: effectiveCall.id,
    ...(interruptHandle !== undefined
      ? {
          interrupt: {
            signal: interruptHandle.signal,
            criticalSection: interruptHandle.router.seam,
          },
        }
      : {}),
  })
  return { ctx, interruptHandle }
}

/**
 * The POST-execute chain: observe the failure for the effort classifier, then
 * layer the two system-reminder steers onto the result and fire the post hooks.
 *
 * UNIT because every step here transforms an ALREADY-PRODUCED result and none
 * of them can change WHETHER the tool ran — the opposite of the gate chain
 * above it. They also compose in a fixed order that matters: the cap reminder
 * is prepended first (ADR-0062 rule #3, so the model reads the enforcement hint
 * alongside the tool output), the repro-doubt steer second (jun-20, reusing the
 * same system-reminder framing), and the hooks last so a `post_tool_use`
 * consumer sees the FINAL text the model will read.
 */
const finalizeDispatchResult = async (args: {
  readonly out: DispatchResult
  readonly config: AgentConfig
  readonly effectiveCall: ToolUseBlock
  readonly capReminder: string | undefined
  readonly shellCommand: string | null
}): Promise<DispatchResult> => {
  const { config, effectiveCall, capReminder } = args
  observeEffortClassifierToolFailure(config.effortClassifier, effectiveCall.name, args.out)
  // When a reminder was generated, prepend it as a `<system-reminder>` block in
  // the tool result output so the model reads the enforcement hint alongside
  // the tool output.
  const cappedOut = capReminder !== undefined ? prependCapReminder(args.out, capReminder) : args.out
  // repro-doubt: advance the stuck counter + (once per streak) prepend the
  // doubt steer. Default-OFF byte-identical when the knob is unset.
  const finalOut = applyReproDoubtSteer(
    cappedOut,
    config,
    effectiveCall.name,
    args.shellCommand ?? undefined,
  )
  if (config.hooks) {
    await emitPostToolUseHooks(config, effectiveCall, finalOut)
  }
  return finalOut
}

/** Span-free dispatch body (extracted so the outer wrap keeps a single control
 *  flow). Reads as a linear spine: unknown-tool guard → plan-mode seam → uniform
 *  pre-flight consults → action build → admissibility gate → ownership consult →
 *  build ctx → execute (stuck-tracked) → cap/repro-doubt/post-hook chain. Each
 *  gate is a pure `(call, config) => DispatchResult | null` consult; identical
 *  logic to the pre-extraction path. */
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

  // Every gate below, and everything after execution, is keyed by tool name. A registry
  // that presents a tool under an alias (a subagent tool namespace) gives them the tool's
  // own name; only the model-facing call keeps the alias (its result block carries the id,
  // not the name). Post-execution used the alias until round 11: provenance, post hooks,
  // edit repair and the cap tracker saw a name no table classifies.
  const policyName = registry.policyNameOf(call.name)
  const gateCall: ToolUseBlock = policyName === call.name ? call : { ...call, name: policyName }

  // Plan-mode seam consulted BEFORE the dedup/admissibility gates (dispatch-time,
  // stateless — a `default`⇒`plan` transition only affects later calls).
  const collab = resolveCollaborationMode(config)
  const preAdmissibilityShort = firstConsult(PRE_ADMISSIBILITY_CONSULTS, (consult) =>
    consult(gateCall, config, collab),
  )
  if (preAdmissibilityShort) return preAdmissibilityShort

  // Uniform pre-flights (dedup, localize-phase, test-scope, dispatch-guard) —
  // consulted in order, first non-null short-circuits before any gate work.
  const preFlightShort = firstConsult(PRE_FLIGHT_CONSULTS, (consult) => consult(gateCall, config))
  if (preFlightShort) return preFlightShort

  // S16: populate `shellCommand` from the registry so the permission policy
  // applies HARD_DENY uniformly to ANY tool that exposes a shell-command
  // surface (`extractShellCommand` method) — not just one named "bash".
  const shellCommand = registry.extractShellCommand(gateCall.name, gateCall.input)
  const action = {
    tool: gateCall.name,
    input: gateCall.input,
    isReadOnly: registry.isReadOnly(gateCall.name),
    ...(shellCommand !== null ? { shellCommand } : {}),
  }

  const admission = await runPreExecuteGate(gateCall, config, permission, action, autoClassifier)
  if (admission.kind === "short") return admission.result
  const postAdmissibilityShort = firstConsult(POST_ADMISSIBILITY_CONSULTS, (consult) =>
    consult(gateCall, config, shellCommand, action.isReadOnly),
  )
  if (postAdmissibilityShort) return postAdmissibilityShort
  // SECURITY: the rewrite is applied AFTER the permission / HARD_DENY gates ran
  // on the original input. A hook is operator-authored local code at the trust
  // level of the permission config itself, so this is intentional (the model
  // and untrusted content cannot reach it). See hooks.ts `emit` security note.
  const rewritten = admission.rewritten
  const effectiveCall: ToolUseBlock = rewritten ? { ...gateCall, input: rewritten.value } : gateCall
  // The router is disposed in the `finally` below so the upstream listener + any
  // armed watchdog are always released.
  const { ctx, interruptHandle } = buildInterruptAwareContext(
    config,
    effectiveCall,
    collab,
    workingState,
  )
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
  let out: DispatchResult
  try {
    out = await executeWithStuckTracking(effectiveCall, config, ctx, onProgress)
  } finally {
    // Always release the interrupt router's upstream listener + watchdog,
    // whether execute settled or threw. Idempotent + no-op when absent.
    interruptHandle?.router.dispose()
  }
  return finalizeDispatchResult({ out, config, effectiveCall, capReminder, shellCommand })
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
 *  fill in on close — at open time we only know the name + call_id + the input
 *  args. The input PREVIEW (truncated) is attached ONLY when a span sink is
 *  active so the operator can click the span and see WHAT was dispatched
 *  (the bash command, the edited path …); with no sink the `previewPayload`
 *  stringify never runs (default-OFF allocation-free). */
const toolSpanAttrs = (name: string, callId: string, captureContent: boolean, input?: unknown) =>
  attrs({
    [QUANTA_ATTRS.tool.name]: name,
    [QUANTA_ATTRS.tool.callId]: callId,
    // SECURITY: the tool input (bash command / apply_patch body / edited path) can
    // carry a secret. Attach it ONLY when the content-capture knob is on, and
    // REDACT-before-truncate (T-D1) — matching the LLM-sampling span path. Was a
    // raw `previewPayload` gated on sink-presence only = unredacted secret egress.
    ...(input !== undefined && captureContent
      ? { [QUANTA_ATTRS.tool.input]: redactThenPreview(input) }
      : {}),
  })

/** Build the close-attrs for a `handle_tool_call` span: the terminal status,
 *  plus a REDACTED, truncated preview of the tool OUTPUT when the content-capture
 *  knob is on. Keeps the two `endSpan` sites (success / error) consistent. */
const toolCloseAttrs = (status: "success" | "error", captureContent: boolean, output?: unknown) =>
  attrs({
    [QUANTA_ATTRS.tool.status]: status,
    ...(output !== undefined && captureContent
      ? { [QUANTA_ATTRS.tool.output]: redactThenPreview(output) }
      : {}),
  })

/**
 * DIP port (H1, jul-4 hexagonal audit F3) — the tool-DISPATCH seam as an injectable port.
 *
 * `dispatchTool` is the gate + execute + permission + hooks chokepoint: the single most
 * behavior/security-critical seam in the loop. Yet it was the ONLY driven collaborator reached by a
 * HARD import (stream-callbacks.ts) while `llm`/`stream`/`registry` were all inverted as ports. This
 * alias lets the composition root inject a substitute (replay / dry-run / policy-wrapped) exactly
 * like the other ports, closing the last DIP hole. The default binding stays `dispatchTool`, so an
 * unset port is byte-identical.
 */
export type DispatchPort = typeof dispatchTool

/**
 * Resolve the active dispatch port — the injected {@link DispatchPort} if the composition wired one,
 * else the default `dispatchTool`. The ONE place the default binding lives, so every call site is a
 * single `resolveDispatchPort(config)(...)` and the substitution is unit-testable (H1).
 */
export const resolveDispatchPort = (config: {
  readonly dispatchPort?: DispatchPort
}): DispatchPort => config.dispatchPort ?? dispatchTool
