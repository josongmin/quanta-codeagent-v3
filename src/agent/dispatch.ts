import type { ToolUseBlock } from "@/llm"
import type { AutoModeClassifier, PermissionContext } from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, ToolResult, WorkingStateHandle } from "@/tool"
import { runAdmissibilityGate } from "./admissibility-gate"
import { DedupGate } from "./dispatch-dedup"
import { deny, resultBlock } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
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
const consultDedupGate = (
  call: ToolUseBlock,
  config: AgentConfig,
): DispatchResult | null => {
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
  const { registry } = config

  if (!registry.has(call.name)) {
    return deny(call.id, `Unknown tool: ${call.name}`, "unknown tool")
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
  const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier)
  if (gated) return gated

  // Subagent absorption (ADR-0011): propagate this agent's recursion
  // depth so the `Agent` tool can enforce `maxDepth`. Absent ⇒ omitted (the
  // tool duck-reads it as 0), so the default path is byte-identical.
  // Phase 6 (ADR-0021): propagate the session-scoped WorkingState handle so
  // tools that want to read/mutate L3 via the context seam (rather than a
  // closure-captured handle) have a real path. Absent ⇒ omitted.
  const ctx: ToolContext = {
    cwd: config.cwd,
    signal: config.signal,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    ...(workingState !== undefined ? { workingState } : {}),
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
