/**
 * Recording `LLMPort` adapter (ADR-0192).
 *
 * Wraps an inner `LLMPort` so every `stream()` call is captured into a
 * `ReplayStore` after the stream completes. Events flow to the caller in
 * real-time — the recorder is on the side, never a buffer in front.
 *
 * On `inner.stream` throwing mid-stream, we still write a `partial: true`
 * record holding everything we did capture. That's deliberate: a real bug-
 * reproduction cassette must include the failing turn, even if the model
 * died half-way through.
 */

import { createHash } from "node:crypto"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"
import { defaultHashRequest } from "./jsonl-store"
import type { RecordedInteraction, ReplayStore } from "./types"

export interface RecordingLlmOpts {
  /** The real adapter doing the actual provider work. */
  readonly inner: LLMPort
  /** Where to append recorded interactions. */
  readonly store: ReplayStore
  /**
   * Optional scrub pass run BEFORE `store.append`. Sibling of ADR-0171 PII
   * redaction: callers wire their redactor in so secrets / PII never reach
   * disk. The scrubber may return a fresh `RecordedInteraction` or mutate +
   * return the input — we treat the return value as authoritative.
   */
  readonly scrubber?: (record: RecordedInteraction) => RecordedInteraction
  /** Override the request → id hash. Defaults to the JSONL store's stable
   *  sorted-key SHA-256. Useful for tests / shared id between recorder and
   *  store. */
  readonly hashRequest?: (req: StreamInput) => string
  /** Override `Date.now` for deterministic `recordedAt` in tests. */
  readonly now?: () => number
  /**
   * Optional per-call context threaded in from the bench harness so each
   * recorded turn carries instance/run/attempt labels. Metadata-only — does
   * NOT affect the request hash (cassette key unchanged).
   */
  readonly callCtx?: {
    readonly instanceId?: string
    readonly runId?: string
    readonly attempt?: number
  }
  /**
   * Optional DEBUG drain, called once per turn at commit. Returns the keyed
   * debug slices accumulated for that turn (or `undefined` for none), attached
   * as `metadata.debug`. Metadata-only — does NOT affect the request hash, so
   * debug enrichment can never invalidate a cassette match. The bench harness
   * wires the process-scoped debug sink here; generic callers leave it unset.
   */
  readonly debugDrain?: () => Record<string, unknown> | undefined
}

/** Best-effort debug drain: a throwing drainer must never sink a successful
 *  turn, so failure collapses to `undefined` (no `debug` key). */
function safeDrain(
  drain: (() => Record<string, unknown> | undefined) | undefined,
): Record<string, unknown> | undefined {
  if (drain === undefined) return undefined
  try {
    return drain()
  } catch {
    return undefined
  }
}

export function recordingLlmPort(opts: RecordingLlmOpts): LLMPort {
  const now = opts.now ?? Date.now
  const hashFn = opts.hashRequest ?? ((req: StreamInput) => defaultHashRequest(req, "exact"))

  const stripEphemeralRequest = (input: StreamInput): StreamInput => {
    const {
      signal: _signal,
      turnTimingCapture: _turnTimingCapture,
      onChunk: _onChunk,
      onCheckpoint: _onCheckpoint,
      responsesContinuation: _responsesContinuation,
      ...rest
    } = input
    return rest
  }

  const port: LLMPort = {
    ...(opts.inner.model !== undefined ? { model: opts.inner.model } : {}),
    ...(opts.inner.provider !== undefined ? { provider: opts.inner.provider } : {}),
    ...(opts.inner.surfaceId !== undefined ? { surfaceId: opts.inner.surfaceId } : {}),
    ...(opts.inner.transportId !== undefined ? { transportId: opts.inner.transportId } : {}),
    ...(opts.inner.authMode !== undefined ? { authMode: opts.inner.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      const startedAt = now()
      const captured: StreamEvent[] = []
      const inner = opts.inner.stream(input)
      // We delay `id` computation until after `now` is sampled so a custom
      // hash that includes time can do so; the default hash ignores it.
      let writeError: Error | null = null

      async function commit(partial: boolean): Promise<void> {
        const durationMs = now() - startedAt
        let id: string
        try {
          id = hashFn(input)
        } catch {
          // Hash failures collapse to a degenerate-but-stable fallback id so
          // append never aborts. Using a content-free constant would collide
          // every miss; SHA-256 of stringified input length+timestamp is
          // best-effort uniqueness.
          id = createHash("sha256")
            .update(`fallback:${startedAt}:${captured.length}`)
            .digest("hex")
            .slice(0, 16)
        }
        const model = opts.inner.model ?? "unknown"
        // Drain debug slices (metadata-only, replay-neutral).
        const debug = safeDrain(opts.debugDrain)
        const baseRecord: RecordedInteraction = {
          id,
          request: stripEphemeralRequest(input),
          events: captured.slice(),
          metadata: {
            recordedAt: startedAt,
            model,
            durationMs,
            ...(partial ? { partial: true } : {}),
            ...(partial && writeError !== null ? { error: writeError.message } : {}),
            ...(opts.callCtx?.instanceId !== undefined
              ? { instanceId: opts.callCtx.instanceId }
              : {}),
            ...(opts.callCtx?.runId !== undefined ? { runId: opts.callCtx.runId } : {}),
            ...(opts.callCtx?.attempt !== undefined ? { attempt: opts.callCtx.attempt } : {}),
            ...(debug !== undefined ? { debug } : {}),
          },
        }
        const finalRecord = opts.scrubber !== undefined ? opts.scrubber(baseRecord) : baseRecord
        await opts.store.append(finalRecord)
      }

      async function commitBestEffort(partial: boolean): Promise<void> {
        try {
          await commit(partial)
        } catch {
          // Recording is a sidecar after a successful live turn. Never let a
          // cassette/scrubber failure flip the already-successful stream into
          // a surfaced LLM failure.
        }
      }

      async function* iterate(): AsyncIterable<StreamEvent> {
        try {
          for await (const ev of inner) {
            captured.push(ev)
            yield ev
          }
        } catch (err) {
          writeError = err instanceof Error ? err : new Error(String(err))
          await commit(true).catch(() => {
            // Swallow append failure — original error is the more important
            // signal to surface.
          })
          throw writeError
        }
        await commitBestEffort(false)
      }

      return iterate()
    },
  }
  return port
}
