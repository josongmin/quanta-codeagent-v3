import type { ToolResultBlock, ToolUseBlock } from "@/llm"
import {
  type AutoModeClassifier,
  evaluate,
  evaluateAuto,
  type HITLTier,
  hardDenyReason,
  inferToolTier,
  type PermissionContext,
} from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext } from "@/tool"
import { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
import type { AgentConfig } from "./types"

export interface DispatchResult {
  block: ToolResultBlock
  ok: boolean
  preview: string
  /** Wall time of the tool execution in ms (RFC-0002 §5.2 evidence). Set for
   *  every executed tool; absent only on pre-execute deny short-circuits. */
  durationMs?: number
  /** Bounded tail of the tool's stderr, when the ToolResult exposes one
   *  (shell-class tools). Omitted — never null — for tools without stderr. */
  stderrTail?: string
  /** Process exit code for shell-class tools, when the ToolResult exposes it. */
  exitCode?: number
  /** Path to a persisted full log, only when the tool actually wrote one. */
  fullLogPath?: string
}

/** Max chars of stderr retained on the dispatch result (RFC-0002 §5.2). */
const STDERR_TAIL_CAP = 2000

/** Duck-read RFC-0002 §5.2 tool evidence a tool may attach to its ToolResult.
 *  `ToolResult` only declares `ok`/`output`; shell-class tools may carry
 *  `stderr`/`exitCode`/`fullLogPath` as extra props. Read defensively and
 *  conditional-set so `exactOptionalPropertyTypes` never sees `undefined`. */
const evidenceOf = (
  result: unknown,
): Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> => {
  const r = result as Record<string, unknown>
  const out: Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> = {}
  if (typeof r.stderr === "string" && r.stderr.length > 0) {
    out.stderrTail = r.stderr.slice(-STDERR_TAIL_CAP)
  }
  if (typeof r.exitCode === "number") out.exitCode = r.exitCode
  if (typeof r.fullLogPath === "string" && r.fullLogPath.length > 0) {
    out.fullLogPath = r.fullLogPath
  }
  return out
}

const resultBlock = (id: string, content: string, isError: boolean): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
})

const deny = (id: string, content: string, preview: string): DispatchResult => ({
  block: resultBlock(id, content, true),
  ok: false,
  preview,
})

/** Emit pre_tool_use hook, returning a hook-denied result or null to proceed. */
const runPreToolUseHook = async (
  call: ToolUseBlock,
  config: AgentConfig,
): Promise<DispatchResult | null> => {
  if (!config.hooks) return null
  const hookDeny = await config.hooks.emit({
    type: "pre_tool_use",
    name: call.name,
    input: call.input,
  })
  if (hookDeny) return deny(call.id, `Hook denied: ${hookDeny.deny}`, "hook-denied")
  return null
}

const HANDOFF_SUFFIX = ". Agent cannot proceed without explicit human takeover."

/**
 * HITL 4-tier gate (Codex hitl-audit.md). Returns:
 *   - a short-circuit {@link DispatchResult} for handoff / declined /
 *     always-confirm denials,
 *   - `null` when HITL approved the call (skip mode policy, emit hook + proceed),
 *   - `"fallthrough"` when the tier is "pre-approval-ok" (defer to mode policy).
 */
const runHitlGate = async (
  call: ToolUseBlock,
  config: AgentConfig,
  action: { tool: string; input: unknown; isReadOnly: boolean },
): Promise<DispatchResult | null | "fallthrough"> => {
  // HARD_DENY hits ARE the hand-off-required tier (security boundary crossing
  // — no mode authorizes them). Phrase as a handoff demand.
  const denyReason = hardDenyReason(action)
  if (denyReason !== null) {
    return deny(call.id, `Action requires human handoff: ${denyReason}${HANDOFF_SUFFIX}`, "handoff")
  }

  const tool = config.registry.get(call.name)
  // Unknown tool was already rejected upstream; this is defensive.
  const tier: HITLTier = tool
    ? inferToolTier(tool, call.input)
    : action.isReadOnly
      ? "none"
      : "pre-approval-ok"

  if (tier === "hand-off-required") {
    return deny(
      call.id,
      `Action requires human handoff: ${call.name} is classified hand-off-required${HANDOFF_SUFFIX}`,
      "handoff",
    )
  }
  if (tier === "always-confirm") {
    if (!config.onConfirm) {
      return deny(
        call.id,
        `Permission denied: ${call.name} requires explicit confirmation (always-confirm tier) but no confirm handler is wired.`,
        "denied",
      )
    }
    const approved = await config.onConfirm(action)
    if (!approved) {
      return deny(
        call.id,
        `User declined: ${call.name} requires explicit confirmation (always-confirm tier).`,
        "declined",
      )
    }
    return null
  }
  if (tier === "none") return null
  return "fallthrough"
}

/**
 * Pre-execution gates that can short-circuit a call into a deny tool_result
 * (the model recovers — same contract as the permission-deny path). Returns a
 * {@link DispatchResult} to short-circuit, or `null` to proceed to execute.
 *
 * Order: plan-mode block → HITL tier (when enabled) → permission → confirm →
 * hook deny. Plan mode is checked first so a blocked mutating tool never even
 * hits permission/execute (RFC §13 Q3). All gates are skipped when
 * unconfigured, so the default path is byte-for-byte unchanged.
 *
 * HITL (Codex hitl-audit.md): when `config.hitl?.enabled === true`, the gate
 * resolves the effective tier and routes:
 *   - hand-off-required ⇒ deny with "human handoff required" message (cannot
 *     be skipped by ANY mode, including bypass).
 *   - always-confirm ⇒ ALWAYS call onConfirm (cannot be skipped by
 *     acceptEdits/bypass); deny if onConfirm absent or declined.
 *   - pre-approval-ok ⇒ existing mode policy applies (no change).
 *   - none ⇒ allow (mirrors the read-only fast path).
 */
/** Mode-based permission decision (legacy path). SOTA++ Tier 1 (ADR-0011):
 *  "auto" mode routes to the session-scoped LLM classifier; all other modes
 *  use the synchronous policy verbatim. */
const runModePolicy = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  action: { tool: string; input: unknown; isReadOnly: boolean },
  autoClassifier?: AutoModeClassifier,
): Promise<DispatchResult | null> => {
  const decision =
    permission.mode === "auto" && autoClassifier
      ? await evaluateAuto(action, permission, autoClassifier)
      : evaluate(action, permission)
  if (decision.kind === "deny") {
    // When the HITL gate is enabled the HARD_DENY branch is already handled
    // upstream; any remaining policy denial keeps the legacy "Permission
    // denied" wording (e.g. classifier "deny" verdict in auto mode).
    return deny(call.id, `Permission denied: ${decision.reason}`, "denied")
  }
  if (decision.kind === "ask") {
    const approved = config.onConfirm ? await config.onConfirm(action) : false
    if (!approved) return deny(call.id, `User declined: ${decision.reason}`, "declined")
  }
  return null
}

const runGates = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  action: { tool: string; input: unknown; isReadOnly: boolean },
  autoClassifier?: AutoModeClassifier,
): Promise<DispatchResult | null> => {
  const effectiveMode = resolveAgentMode(config.mode, config.planMode)
  if (isMutatingToolBlockedInMode(effectiveMode, action)) {
    return deny(call.id, modeBlockReason(effectiveMode, call.name), `${effectiveMode}-blocked`)
  }

  if (config.hitl?.enabled === true) {
    const hitlResult = await runHitlGate(call, config, action)
    if (hitlResult !== "fallthrough") {
      // null ⇒ HITL approved, skip mode policy and emit hook + proceed.
      // non-null ⇒ short-circuit deny.
      return hitlResult ?? runPreToolUseHook(call, config)
    }
  }

  const policyResult = await runModePolicy(call, config, permission, action, autoClassifier)
  if (policyResult) return policyResult
  return runPreToolUseHook(call, config)
}

/** Run one tool call end to end: gates → execute → normalize errors.
 *  Tool/permission/plan/hook failures become error tool_results (the model
 *  recovers); only the loop's own fatal conditions propagate. */
export const dispatchTool = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  onProgress?: (message: string) => void,
  autoClassifier?: AutoModeClassifier,
): Promise<DispatchResult> => {
  const { registry } = config

  if (!registry.has(call.name)) {
    return deny(call.id, `Unknown tool: ${call.name}`, "unknown tool")
  }

  const action = {
    tool: call.name,
    input: call.input,
    isReadOnly: registry.isReadOnly(call.name),
  }

  const gated = await runGates(call, config, permission, action, autoClassifier)
  if (gated) return gated

  // SOTA++ subagent absorption (ADR-0011): propagate this agent's recursion
  // depth so the `Agent` tool can enforce `maxDepth`. Absent ⇒ omitted (the
  // tool duck-reads it as 0), so the default path is byte-identical.
  const ctx: ToolContext = {
    cwd: config.cwd,
    signal: config.signal,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
  }
  const out = await execute(call, config, ctx, onProgress)
  if (config.hooks) {
    await config.hooks.emit({
      type: "post_tool_use",
      name: call.name,
      ok: out.ok,
      output: out.preview,
    })
  }
  return out
}

/** Drive the registry, normalizing thrown errors into an error tool_result. */
const execute = async (
  call: ToolUseBlock,
  config: AgentConfig,
  ctx: ToolContext,
  onProgress?: (message: string) => void,
): Promise<DispatchResult> => {
  const startedAt = performance.now()
  try {
    const result = await config.registry.run(call.name, call.input, ctx, onProgress)
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    return {
      block: resultBlock(call.id, result.output, !result.ok),
      ok: result.ok,
      preview: result.output,
      durationMs,
      ...evidenceOf(result),
    }
  } catch (e) {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    const message = e instanceof QuantaError ? e.message : toError(e).message
    return { block: resultBlock(call.id, message, true), ok: false, preview: message, durationMs }
  }
}
