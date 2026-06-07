/**
 * C2 last-mile (jun-6-progress-renderer.md) — the missing PRODUCER bridge for
 * structured mid-turn progress.
 *
 * The `communicate_update` tool, the `progress_update` AgentEvent variant, the
 * `ProgressSink` / `ProgressUpdateMirror` duck-typed mirror, the dispatch seam,
 * AND both surface renderers (`stdout.ts renderProgressUpdate` +
 * `jsonl-recorder`) are all LANDED. The one severed link is the producer:
 * nobody constructed a `ProgressSink` and assigned it to
 * `AgentConfig.progressSink`, so `ctx.progressSink` was always `undefined` and
 * the tool's `emitProgress` early-returned — the renderer was dead code waiting
 * for a producer.
 *
 * This module is that producer, a BYTE-FOR-BYTE clone of the already-landed
 * `createPassiveVcsStreamSink` / `maybeWireVcsEventSink` pattern
 * (`agent-config-assembler.ts:473-503`): the exact "duck-typed mirror → host
 * adapter → existing AgentEvent stream" shape. It lives in `@/host/runtime`
 * (the composition layer) so `@/tool` stays a leaf and never imports `@/stream`
 * — the slice fence the C2 RFC §8.5 mandated.
 *
 * Env discipline: like every other `maybeWire*` helper, the wire reads its gate
 * off the injected `AssemblerEnv` view (never the `process.env` global), so the
 * module stays `process.env`-free and below `src/apps/**`.
 */

import type { AgentConfig } from "@/agent"
import { gateOn } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import type { ProgressSink, ProgressUpdateMirror } from "@/tool"
import type { AssemblerEnv } from "./agent-config-assembler"

/**
 * Build the host adapter that turns a {@link ProgressUpdateMirror} (the
 * snake_case tool payload) into a render-only `progress_update`
 * {@link AgentEvent} (camelCase) on the EXISTING stream — the exact mirror of
 * `createPassiveVcsStreamSink`. The snake→camel transform IS the proto↔zod
 * boundary the C2 RFC §4.3 documented (`current_step` is the model-facing
 * contract; `currentStep` is the wire-internal AgentEvent).
 *
 * `exactOptionalPropertyTypes`-safe: the optional terminal fields are
 * conditionally spread so the emitted event carries no `undefined` keys
 * (matches the tool's own `emitProgress` discipline). `turn?` is intentionally
 * OMITTED — the assembler has no turn index; a future turn-aware caller can set
 * it for UI coalescing.
 *
 * `emit` is NO-THROW by contract (identical to `createPassiveVcsStreamSink`): a
 * dead stream must never poison the turn that called `communicate_update` — a
 * progress report is best-effort observability. Exported so a hellgate can
 * assert the mirror→AgentEvent mapping directly.
 */
export const createProgressStreamSink = (stream: StreamPort): ProgressSink => ({
  emit(update: ProgressUpdateMirror): void {
    const ev: AgentEvent = {
      type: "progress_update",
      currentStep: update.current_step,
      ...(update.final_summary !== undefined ? { finalSummary: update.final_summary } : {}),
      ...(update.completed_subtitle !== undefined
        ? { completedSubtitle: update.completed_subtitle }
        : {}),
    }
    try {
      stream.emit(ev)
    } catch {
      // NO-THROW boundary: best-effort observability, a broken stream must never
      // break the turn that produced the progress update.
    }
  },
})

/**
 * Wire the structured-progress sink onto `cfg` so the `communicate_update`
 * tool's `ctx.progressSink?.emit` forwards its typed mirror onto the existing
 * AgentEvent stream. OPT-IN (`QUANTA_PROGRESS_UPDATE=1`) — the SAME gate the
 * tool registration uses (`agent-arg-builder.ts:616`), so one flip both (a)
 * registers the tool and (b) wires the producer; the chain is complete in one
 * knob. Off by default for every surface (this assembler is shared by
 * bench/eval + web-daemon, so a default-ON would change their event stream +
 * SWE-bench reproducibility — the same reasoning `maybeWireVcsEventSink` cites).
 * Caller-override-safe (ADR-0332): a pre-set slot is preserved. Absent gate ⇒
 * slot stays unset ⇒ the dispatch seam omits the ctx field, the tool's emit is
 * a no-op, and the run is byte-identical (default-OFF). The sink emits onto
 * `cfg.stream` — the SAME stream the loop's other AgentEvents ride, so it
 * reaches `StdoutStream`, `jsonl-recorder`, `sse`, and `tee` with no per-adapter
 * change.
 */
export const maybeWireProgressSink = (cfg: AgentConfig, env: AssemblerEnv): void => {
  if (!gateOn(env, "QUANTA_PROGRESS_UPDATE")) return
  if (cfg.progressSink !== undefined) return
  cfg.progressSink = createProgressStreamSink(cfg.stream)
}
