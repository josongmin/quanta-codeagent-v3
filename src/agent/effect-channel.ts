/**
 * EffectChannel — relocatable effect boundary (SOTA++ structural keystone, M1).
 *
 * # Why this exists
 *
 * quanta's loop currently couples *deciding* to act (orchestration: permission,
 * HITL, plan-exit, hook) with *performing* the act (effect: `registry.run`).
 * In [dispatch.ts] today, `execute(call, config, ctx, onProgress)` calls
 * `config.registry.run(...)` directly inside the dispatch function. Effects
 * are pinned to the same process as the loop.
 *
 * Cursor's structural lesson — the one transferable architectural move from
 * the cursor.com/cursor-agent-exec split — is that **the engine never executes
 * effects itself; it asks the client over a typed `ExecServerMessage`/
 * `ExecClientMessage` oneof on the same bidi stream**. That single boundary
 * makes execution **relocatable**: the same loop runs against an in-process
 * executor, a sandboxed subprocess, or a remote worker, without the loop ever
 * knowing.
 *
 * `EffectChannel` is that boundary, made explicit and typed:
 *
 *     [Orchestration plane]                        [Effect plane]
 *     dispatch / admissibility-gate  ──ToolRequest──►  EffectChannel
 *                                    ◄─ToolResultEnvelope─
 *
 *  Implementations:
 *    - {@link LocalEffectChannel} — in-process executor (M1 default; what we ship)
 *    - SandboxEffectChannel       — wraps Local + applies SandboxPolicy (Phase 2)
 *    - RemoteEffectChannel        — sends to a worker / PtyHost (future)
 *
 *  All three plug into the same call site. The orchestration plane never
 *  branches on substrate.
 *
 * # Default-OFF
 *
 * Nothing in the current dispatch path imports this file. Adopting the
 * channel is a follow-up: wrap `dispatch.ts`'s `execute()` body in a
 * `LocalEffectChannel(executor)` where `executor.execute(call, ctx, op)` is
 * `config.registry.run(call.name, call.input, ctx, op)`. The channel's
 * normalization mirrors `execute()`'s existing try/catch contract exactly
 * (executor throws → `{ok:false, output: message}`), so the swap is
 * byte-identical for the registry-throw path. The current redaction / typed-
 * failure / evidence flattening stays in the *orchestration plane* — i.e.
 * `dispatchToolInner` wraps the channel's envelope into a `DispatchResult`.
 * That separation is the whole point: the channel returns a raw `ToolResult`
 * + duration; dispatch decides what to do with it.
 *
 * # Contract
 *
 *  1. **No-throw.** `execute()` NEVER throws. Executor exceptions (Error or
 *     non-Error) are caught and normalized into `{ ok:false, output: <msg> }`
 *     ToolResults. This matches `dispatch.ts`'s existing no-throw contract
 *     (AUDIT-FIX) so the streaming engine's allSettled assumption is preserved.
 *  2. **Pre-flight abort.** If `req.ctx.signal.aborted` at entry, the
 *     executor is NOT invoked and a `{ ok:false, output:"aborted..." }`
 *     envelope is returned. Consistent with the loop's cooperative cancel.
 *  3. **`exactOptionalPropertyTypes`.** Optional fields (`execId`) are
 *     OMITTED from the envelope when absent on the request, never set to
 *     `undefined`. The condition-set pattern is used at the construction
 *     site so `tsc` never sees `field: undefined`.
 *  4. **Pure passthrough.** `req.call` and `req.ctx` reach the executor by
 *     reference (no clone, no augmentation). The channel does not inspect
 *     the input or context — those are the orchestration plane's concern.
 *  5. **Duration.** `durationMs` is a non-negative integer (Math.max+round).
 *     Measured from channel entry to executor return / throw.
 *
 * # What this file is NOT
 *
 * - It is NOT a tool registry. The channel is plane-clean: it imports nothing
 *   from `@/tool` registry or `@/permission`. It receives a `ToolExecutor` by
 *   DI so tests can pass a fake. Production wiring is the orchestration
 *   plane's job.
 * - It is NOT where redaction / typed-failure surfacing / evidence flattening
 *   happens. Those are dispatch-layer concerns that consume the envelope.
 * - It is NOT a streaming primitive. Progress events are forwarded via the
 *   existing `onProgress` callback (same shape as `registry.run`), not a new
 *   AsyncIterable. A future BiDi/server-stream variant can wrap this; today's
 *   keystone preserves the existing call shape so adoption is mechanical.
 */

import type { ToolUseBlock } from "@/llm"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, ToolResult } from "@/tool"

/** A single tool execution request crossing the effect boundary.
 *
 *  Carries the model-emitted tool call, the per-tool context (cwd / signal /
 *  duck-typed seams from the orchestration plane), and an OPTIONAL correlation
 *  id surfaced verbatim on the result envelope. */
export interface ToolRequest {
  /** The tool_use block to execute, as emitted by the model (after any
   *  `pre_tool_use` hook rewrite — that mutation happens in the orchestration
   *  plane BEFORE the request reaches the channel). */
  readonly call: ToolUseBlock
  /** Per-tool context: required {cwd, signal}, optional duck-typed seams. */
  readonly ctx: ToolContext
  /** OPTIONAL per-exec correlation id (mirrors Cursor `ExecServerMessage.
   *  exec_id`). Surfaced verbatim on {@link ToolResultEnvelope.execId} so the
   *  caller can correlate envelope→span / envelope→trace. Absent ⇒ omitted on
   *  the envelope (exactOptionalPropertyTypes). */
  readonly execId?: string
}

/** Envelope returned by an {@link EffectChannel}. Never carries a thrown error
 *  — executor exceptions normalize into `result.ok === false`. */
export interface ToolResultEnvelope {
  /** The (possibly normalized) tool result. */
  readonly result: ToolResult
  /** Wall time of the execution, non-negative integer milliseconds. */
  readonly durationMs: number
  /** Echo of {@link ToolRequest.execId} when set. OMITTED otherwise. */
  readonly execId?: string
}

/** Executor port — the registry-level function the channel delegates to.
 *
 *  Decouples the channel from `@/tool` registry and `@/permission`: tests pass
 *  a fake `ToolExecutor`; production wraps `registry.run` into one at the
 *  dispatch seam. Shape mirrors `registry.run(name, input, ctx, onProgress)`
 *  so adoption is a one-line wrap. */
export interface ToolExecutor {
  execute(
    call: ToolUseBlock,
    ctx: ToolContext,
    onProgress?: (message: string) => void,
  ): Promise<ToolResult>
}

/** The relocatable effect boundary. */
export interface EffectChannel {
  /** Execute a single tool call. NEVER throws (see file-level contract §1). */
  execute(req: ToolRequest, onProgress?: (message: string) => void): Promise<ToolResultEnvelope>
}

/** In-process effect channel — the M1 default.
 *
 *  Delegates to an injected {@link ToolExecutor}. Imports nothing from
 *  `@/tool` registry or `@/permission` — the executor is the only seam to
 *  whatever actually runs the tool. */
export class LocalEffectChannel implements EffectChannel {
  constructor(private readonly executor: ToolExecutor) {}

  async execute(
    req: ToolRequest,
    onProgress?: (message: string) => void,
  ): Promise<ToolResultEnvelope> {
    const startedAt = performance.now()

    // Contract §2: cooperative pre-flight abort. An already-aborted signal
    // never invokes the executor — return a synthetic ok:false envelope so
    // the orchestration plane handles the cancellation uniformly. We match
    // the loop's wording ("aborted") so dispatch-side log scrapes still work.
    if (req.ctx.signal.aborted) {
      return finalize({ ok: false, output: "Tool execution aborted before start" }, startedAt, req)
    }

    try {
      const result = await this.executor.execute(req.call, req.ctx, onProgress)
      return finalize(result, startedAt, req)
    } catch (e) {
      // Contract §1: no-throw. Executor exceptions normalize. Use QuantaError
      // message when available (preserves typed-error context), else toError
      // (handles non-Error throws like `throw "string"`).
      const message = e instanceof QuantaError ? e.message : toError(e).message
      return finalize({ ok: false, output: message }, startedAt, req)
    }
  }
}

/** Build the result envelope. `execId` set via condition-spread so it is
 *  OMITTED (not `field: undefined`) when absent on the request. */
const finalize = (result: ToolResult, startedAt: number, req: ToolRequest): ToolResultEnvelope => {
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
  return {
    result,
    durationMs,
    ...(req.execId !== undefined ? { execId: req.execId } : {}),
  }
}
