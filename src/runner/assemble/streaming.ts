import { join } from "node:path"
import type { StructuredLogger } from "@/observability"
import type { RunContext } from "@/shared"
import {
  type AssistantTextPainter,
  JsonlRecorder,
  StdoutStream,
  type StreamPort,
  TeeStream,
} from "@/stream"

/**
 * Surface-agnostic streaming/observability wiring (RFC-0002 §5.4/§8).
 *
 * Default OFF → byte-identical to today (plain {@link StdoutStream}, no
 * {@link RunContext}). When `observeDir` is set: a `runId` tags a RunContext
 * and the stdout stream is fanned out to a {@link JsonlRecorder}.
 *
 * Pure relocation of the prior `internal.ts#buildStreaming` block — same
 * effects, same logging keys.
 */

export interface StreamingAssembleInput {
  /** Observe-dir from `--observe-dir <d>` / `QUANTA_OBSERVE_DIR`. Absent ⇒
   *  plain stdout stream + no RunContext (byte-identical). */
  observeDir?: string | undefined
  slog: StructuredLogger
  /** Pre-minted `runId` for cross-process correlation. Optional — caller may
   *  prefer to mint it inside this builder (the default) and read the value
   *  back from the returned `RunContext`. */
  runId?: string | undefined
  /** Optional assistant-text painter (e.g. inline markdown highlighter).
   *  When absent, the StdoutStream writes deltas verbatim — byte-identical
   *  to the pre-painter path. Surfaces that paint (CLI) inject it here;
   *  recorders / Web surfaces leave it undefined. */
  painter?: AssistantTextPainter | undefined
}

export interface StreamingResult {
  stream: StreamPort
  run: RunContext | undefined
}

export const buildStreamingCore = (input: StreamingAssembleInput): StreamingResult => {
  const stream: StreamPort = new StdoutStream(
    input.painter !== undefined ? { painter: input.painter } : {},
  )
  if (!input.observeDir) return { stream, run: undefined }
  const runId = input.runId ?? crypto.randomUUID()
  const run: RunContext = { runId }
  const recorder = new JsonlRecorder(join(input.observeDir, runId, "session.jsonl"), { ctx: run })
  input.slog.debug("observe.on", { dir: input.observeDir, runId })
  return { stream: new TeeStream([stream, recorder]), run }
}
