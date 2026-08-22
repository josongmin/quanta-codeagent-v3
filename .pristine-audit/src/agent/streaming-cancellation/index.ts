/**
 * ADR-0177 — Streaming cancellation + cleanup barrel.
 *
 * Closed-port primitive: typed cancel cause + cleanup orchestration +
 * partial-result salvage wrap around the LLM stream. Default-OFF — callers
 * opt in by wiring the controller's `toAbortSignal()` into existing
 * `StreamInput.signal` threading; without that wire, behaviour is
 * byte-identical to the pre-feature path.
 */

export {
  createCancellationController,
  type DefaultControllerOpts,
  fromAbortSignal,
  toAbortSignal,
} from "./default"
export {
  type CancellableStream,
  type CancellableStreamOpts,
  cancellableStream,
} from "./llm-stream-cancel"
export {
  type CancellationCause,
  type CancellationController,
  CancellationError,
  type CancellationOutcome,
  type CancellationSignal,
  type CleanupHandler,
  type PartialResult,
} from "./types"
