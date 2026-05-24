import type { ToolUseBlock } from "@/llm"
import { attrs, endSpan, QUANTA_ATTRS, SPAN_NAMES, type Span, startSpan } from "@/observability"
import {
  type AutoModeClassifier,
  gitWriteProtectReason,
  type PermissionContext,
} from "@/permission"
import { type RedactionHit, redactSecrets, type SensitivityClass } from "@/security"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, ToolResult, WorkingStateHandle } from "@/tool"
import { composeToolResultContent } from "@/tool/image/compose"
import { runAdmissibilityGate } from "./admissibility-gate"
import { wireCheckpointedEffectChannel } from "./checkpoint-wiring"
import { DedupGate } from "./dispatch-dedup"
import { deny, resultBlock } from "./dispatch-helpers"
import { checkDispatchAllowed } from "./dispatch-seam-guard"
import type { DispatchResult } from "./dispatch-types"
import { LocalEffectChannel } from "./effect-channel"
import { decideLocalizePhase } from "./localize-phase-guard"
import { resolveCollaborationMode } from "./mode"
import { planStoreToMutator } from "./plan/mutator-adapter"
import { runPlanExitFlow } from "./plan-exit-flow"
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

/** Run one tool call end to end: gates → execute → normalize errors.
 *  Tool/permission/plan/hook failures become error tool_results (the model
 *  recovers); only the loop's own fatal conditions propagate.
 *
 *  `workingState` is the optional session-scoped Codex memory L3 handle
 *  (ADR-0021). When the agent loop has built one (`AgentConfig.workingState?.
 *  enabled === true`) it is passed here so `ctx.workingState` is populated on
 *  the {@link ToolContext} forwarded to every tool. Absent ⇒ the field is
 *  OMITTED on `ctx` (exactOptionalPropertyTypes: never `undefined`), so
 *  callers without the opt-in are byte-identical. The closure pattern
 *  `createUpdateWorkingStateTool(handle)` continues to work — `ctx.workingState`
 *  is the second seam so future tools (or callers that don't capture via
 *  closure) can read the same handle. */
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

  // Subagent absorption (ADR-0011): propagate this agent's recursion
  // depth so the `Agent` tool can enforce `maxDepth`. Absent ⇒ omitted (the
  // tool duck-reads it as 0), so the default path is byte-identical.
  // Phase 6 (ADR-0021): propagate the session-scoped WorkingState handle so
  // tools that want to read/mutate L3 via the context seam (rather than a
  // closure-captured handle) have a real path. Absent ⇒ omitted.
  // ADR-0086 plan-exit bridge: when a port is wired, expose a requester that
  // runs the flow (mode-guard + feedback-iff-changes invariant enforced by
  // `runPlanExitFlow`). PlanExitOutcome is structurally the @/tool
  // PlanExitToolOutcome, so it crosses the slice boundary by value. Absent ⇒
  // omitted (the `request_plan_exit` tool is not registered anyway).
  const planExitPort = config.planExitPort
  // `runPlanExitFlow` takes the 2-mode CollaborationMode ("default" | "plan").
  // Use the shared `resolveCollaborationMode` projection so the plan-exit
  // flow agrees with the dispatch-seam guard about the active collab posture
  // (explicit `config.collaborationMode` wins, else 4-mode → 2-mode fallback).
  const collabMode = collab
  const requestPlanExit =
    planExitPort !== undefined
      ? (plan: string) => runPlanExitFlow(collabMode, plan, planExitPort)
      : undefined
  const ctx: ToolContext = {
    cwd: config.cwd,
    signal: config.signal,
    // ADR-0091 git-write-protection L3 wire: the `write`/`edit` tools call this
    // pure path-pattern detector with their resolved target BEFORE any fs op
    // and statically deny code-execution / policy-escape vectors (`.git/hooks`,
    // `.git/config{,.worktree}`, `.git/info/attributes`, `.vscode/**`). Wired
    // unconditionally — the matcher is pure (no I/O, no state, no config), so
    // exposing it cannot change behavior for any path the detector returns
    // `null` for (byte-identical for ordinary writes). `@/tool` consumes it via
    // the duck-typed `GitWriteGuard` seam so it never imports `@/permission`.
    gitWriteGuard: gitWriteProtectReason,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    ...(workingState !== undefined ? { workingState } : {}),
    ...(requestPlanExit !== undefined ? { requestPlanExit } : {}),
    // ADR-0081 L3 wire: forward the agent-level shell observer into every
    // tool's ToolContext. The bash tool conditionally hands it to runShell,
    // which only allocates events when this is present (`exactOptionalProperty
    // Types` honoured — never `onShellEvent: undefined`).
    ...(config.onShellEvent !== undefined ? { onShellEvent: config.onShellEvent } : {}),
    // ADR-0093 (draft) — PlanStore→PlanMutator adapter. Built fresh per
    // dispatch so the slice fence (@/tool never imports @/agent/plan) stays
    // intact: dispatch is in @/agent and is the only allowed translator.
    // Absent ⇒ 4 plan tools graceful-fail at ok:false (default-OFF).
    ...(config.planStore !== undefined
      ? { planMutator: planStoreToMutator(config.planStore) }
      : {}),
    // ADR-0095 (draft) — operator-side user-input requester. Surface
    // (CLI / IDE modal / RPC) supplies the answer/cancelled decision.
    ...(config.userInputPort !== undefined ? { requestUserInput: config.userInputPort } : {}),
  }
  // ADR-0062 rule #3 — cap-as-instruction enforcement (DEFAULT-OFF).
  // Before executing the tool, check whether the model IGNORED the last
  // nextAction hint for this (toolName, targetPath) pair. When ignored, emit
  // a `tool_progress` system-reminder to the stream (so the UI/recorder sees
  // it) and prepend the reminder text to this result's output (so the model
  // reads it in the tool_result content). The check is a single Map.get —
  // zero allocation when absent. capEnforcer absent ⇒ `check` is never
  // called, byte-identical to the pre-enforcement path.
  const capReminder = config.capEnforcer?.check(effectiveCall.name, effectiveCall.input)
  if (capReminder !== undefined) {
    config.stream.emit({
      type: "tool_progress",
      id: effectiveCall.id,
      name: effectiveCall.name,
      message: capReminder,
    })
  }
  const out = await execute(effectiveCall, config, ctx, onProgress)
  // When a reminder was generated, prepend it as a `<system-reminder>` block
  // in the tool result output so the model reads the enforcement hint alongside
  // the tool output. `prependCapReminder` is extracted to keep complexity low.
  const finalOut = capReminder !== undefined ? prependCapReminder(out, capReminder) : out
  if (config.hooks) {
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
  }
  return finalOut
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
  const { output, hits } = applyRedaction(result.output, call, config)
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
 */
const applyRedaction = (
  text: string,
  call: ToolUseBlock,
  config: AgentConfig,
): { output: string; hits: ReadonlyArray<RedactionHit> } => {
  if (config.redaction?.disabled === true) {
    return { output: text, hits: [] }
  }
  const src = deriveSourceClass(call, config)
  const result = redactSecrets(text, {
    origin: "tool_result",
    ...(src !== null ? { sourceClass: src.cls, sourceLabel: src.label } : {}),
    ...(config.redaction?.whitelist !== undefined ? { whitelist: config.redaction.whitelist } : {}),
  })
  return { output: result.text, hits: result.hits }
}
