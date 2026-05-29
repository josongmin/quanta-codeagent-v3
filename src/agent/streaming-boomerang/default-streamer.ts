/**
 * Default streaming boomerang implementation (ADR-0251).
 *
 * Wraps a producer function (host's bridge to the actual agent loop)
 * into a {@link StreamingBoomerang} whose `spawn` returns a single-pass
 * AsyncIterable.
 *
 * Architecture:
 *
 *   producer (host)  ──enqueue/done/fail──►  Channel  ──asyncIterator──►  consumer
 *                                              │
 *                                  cancel  ◄───┴───  AbortSignal observed by both
 *
 * The Channel is a SINGLE-SLOT mailbox + signal. The producer waits for
 * the consumer to take the slot before placing the next chunk — this is
 * the back-pressure mechanism. The consumer waits for the producer when
 * the mailbox is empty.
 *
 * Cancellation contract (sealed by HELL-SB-04/05/12/15):
 *   - Consumer `break` / `return` / `throw` → iterator.return() fires.
 *   - Consumer's `AbortSignal` fires (via spec.parentSignal) → iterator
 *     finishes with a terminal `cancelled` chunk + cleanup.
 *   - BOTH paths converge on `cancelChannel()` which:
 *       1. flips the internal AbortController (consumer side);
 *       2. resolves any pending producer `enqueue` so the producer
 *          unblocks;
 *       3. awaits the producer's settle promise (so no zombie); the
 *          producer is expected to observe `handle.cancelled` and
 *          return promptly.
 *
 * Plane-clean: imports ONLY this slice's types + AbortController/Signal.
 * No `@/agent/loop`, no `@/llm`, no `@/tool`. Pure structural code.
 */

import { errMessage } from "@/shared"
import type { StreamingBoomerang, StreamingBoomerangSpec } from "./port"
import {
  type BoomerangChunk,
  type BoomerangChunkErrorKind,
  type BoomerangProgressChunk,
  type ChunkProducerHandle,
  StreamingBoomerangError,
} from "./types"
/** A producer body the streamer drives. The body is invoked with one
 *  {@link ChunkProducerHandle}; it MUST call exactly one terminal handle
 *  (`done` or `fail`) before returning. Throwing escapes as a terminal
 *  `error` chunk with `errorKind:"runner-error"`. */
export type ChunkProducer = (handle: ChunkProducerHandle) => Promise<void>

export interface DefaultStreamerOpts {
  /** The producer the streamer wraps. */
  readonly producer: ChunkProducer
  /** Optional spec validator hook — return `null` for valid, or an
   *  `errorMessage` for an `invalid-spec` chunk. When absent, only the
   *  built-in empty-prompt check is applied. */
  readonly validate?: (spec: StreamingBoomerangSpec) => string | null
}

/** Internal single-slot channel with explicit close. */
interface ClosableChannel {
  push(chunk: BoomerangProgressChunk): Promise<void>
  pushTerminal(chunk: BoomerangChunk): Promise<void>
  take(): Promise<BoomerangChunk | null>
  cancel(): void
  close(): void
  readonly cancelled: AbortSignal
}

/** Construct an in-memory single-slot channel. Pure: no IO, no timer. */
const makeClosableChannel = (): ClosableChannel => {
  let slot: BoomerangChunk | null = null
  let slotIsTerminal = false
  let resolveProducerWait: (() => void) | null = null
  let resolveConsumerWait: (() => void) | null = null

  const closedCtrl = new AbortController()
  const cancelledCtrl = new AbortController()

  const wakeConsumer = (): void => {
    if (resolveConsumerWait !== null) {
      const fn = resolveConsumerWait
      resolveConsumerWait = null
      fn()
    }
  }
  const wakeProducer = (): void => {
    if (resolveProducerWait !== null) {
      const fn = resolveProducerWait
      resolveProducerWait = null
      fn()
    }
  }

  const close = (): void => {
    if (!closedCtrl.signal.aborted) closedCtrl.abort()
    wakeConsumer()
    wakeProducer()
  }

  const cancel = (): void => {
    if (cancelledCtrl.signal.aborted) return
    cancelledCtrl.abort()
    wakeProducer()
  }

  const pushInternal = async (chunk: BoomerangChunk, terminal: boolean): Promise<void> => {
    while (slot !== null && !closedCtrl.signal.aborted && !cancelledCtrl.signal.aborted) {
      await new Promise<void>((resolve) => {
        resolveProducerWait = resolve
      })
    }
    if (closedCtrl.signal.aborted || cancelledCtrl.signal.aborted) return
    slot = chunk
    slotIsTerminal = terminal
    wakeConsumer()
  }

  return {
    push: (chunk) => pushInternal(chunk, false),
    pushTerminal: (chunk) => pushInternal(chunk, true),
    async take(): Promise<BoomerangChunk | null> {
      while (slot === null && !closedCtrl.signal.aborted) {
        await new Promise<void>((resolve) => {
          resolveConsumerWait = resolve
        })
      }
      if (slot === null) return null
      const out = slot
      slot = null
      const wasTerminal = slotIsTerminal
      slotIsTerminal = false
      wakeProducer()
      if (wasTerminal) {
        close()
      }
      return out
    },
    cancel,
    close,
    get cancelled() {
      return cancelledCtrl.signal
    },
  }
}

/** Spec validation (built-in): empty prompt → operational invalid-spec. */
const validateSpecBuiltin = (spec: StreamingBoomerangSpec): string | null => {
  if (spec.prompt === "") return "prompt is empty"
  return null
}

/** Drive the producer body in the background; centralize error capture
 *  + final close. Returns a settle promise the wrapper awaits in the
 *  cleanup path. */
const driveProducer = (channel: ClosableChannel, producer: ChunkProducer): Promise<void> => {
  const handle: ChunkProducerHandle = {
    enqueue: async (chunk) => {
      await channel.push(chunk)
    },
    fail: async (errorKind, message) => {
      await channel.pushTerminal({ kind: "error", errorKind, errorMessage: message })
    },
    done: async (value) => {
      await channel.pushTerminal({ kind: "result", value })
    },
    cancelled: channel.cancelled,
  }
  return (async () => {
    try {
      await producer(handle)
    } catch (err) {
      const message = errMessage(err)
      await channel
        .pushTerminal({
          kind: "error",
          errorKind: "runner-error",
          errorMessage: message,
        })
        .catch(() => {})
    } finally {
      channel.close()
    }
  })()
}

/** Build the consumer-facing AsyncIterable. The iterator is single-pass.
 *  `return()` is honored: it cancels the channel and awaits the
 *  producer's settle promise (no zombie). */
const buildIterable = (
  channel: ClosableChannel,
  producerSettled: Promise<void>,
  parentSignal: AbortSignal | undefined,
): AsyncIterable<BoomerangChunk> => {
  let consumed = false
  let cleanupDone = false

  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return
    cleanupDone = true
    channel.cancel()
    channel.close()
    try {
      await producerSettled
    } catch {
      // Producer settle errors are swallowed in cleanup — the consumer
      // is gone, there is nowhere to surface them.
    }
  }

  // Bridge: parent signal abort → cancel channel + push terminal
  // `cancelled` chunk (so an in-flight consumer sees one final chunk
  // before `done`).
  const onParentAbort = (): void => {
    void channel
      .pushTerminal({
        kind: "error",
        errorKind: "cancelled",
        errorMessage: "parent signal aborted",
      })
      .catch(() => {})
    channel.cancel()
  }
  let parentDetach: (() => void) | undefined
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      void channel
        .pushTerminal({
          kind: "error",
          errorKind: "cancelled",
          errorMessage: "parent signal already aborted at spawn()",
        })
        .catch(() => {})
      channel.cancel()
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true })
      parentDetach = (): void => parentSignal.removeEventListener("abort", onParentAbort)
    }
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<BoomerangChunk> {
      if (consumed) {
        return {
          next: () => Promise.resolve({ value: undefined, done: true }),
        }
      }
      consumed = true
      return {
        next: async (): Promise<IteratorResult<BoomerangChunk>> => {
          const chunk = await channel.take()
          if (chunk === null) {
            if (parentDetach !== undefined) parentDetach()
            await cleanup()
            return { value: undefined, done: true }
          }
          return { value: chunk, done: false }
        },
        return: async (): Promise<IteratorResult<BoomerangChunk>> => {
          if (parentDetach !== undefined) parentDetach()
          await cleanup()
          return { value: undefined, done: true }
        },
        throw: async (err): Promise<IteratorResult<BoomerangChunk>> => {
          if (parentDetach !== undefined) parentDetach()
          await cleanup()
          if (err !== undefined) throw err
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/** Build a tiny single-chunk error iterable for operational invalid-spec.
 *  No producer is invoked; the iterator yields one `error` chunk then
 *  done. */
const makeImmediateErrorIterable = (
  errorKind: BoomerangChunkErrorKind,
  message: string,
): AsyncIterable<BoomerangChunk> => {
  return {
    [Symbol.asyncIterator](): AsyncIterator<BoomerangChunk> {
      let yielded = false
      return {
        next: async (): Promise<IteratorResult<BoomerangChunk>> => {
          if (!yielded) {
            yielded = true
            return {
              value: { kind: "error", errorKind, errorMessage: message },
              done: false,
            }
          }
          return { value: undefined, done: true }
        },
        return: async (): Promise<IteratorResult<BoomerangChunk>> => {
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/** Build the default streamer. Default-OFF — the host never calls this
 *  automatically; callers wire it into AgentConfig explicitly. */
export const defaultStreamer = (opts: DefaultStreamerOpts): StreamingBoomerang => {
  const producer = opts.producer
  const customValidate = opts.validate

  return {
    spawn(spec: StreamingBoomerangSpec): AsyncIterable<BoomerangChunk> {
      // Programmer-bug surface — non-string prompt past type assertion.
      // The type system says `prompt: string`; this guard catches forced
      // casts (e.g. `prompt: 42 as any`) and throws StreamingBoomerangError.
      if (typeof spec.prompt !== "string") {
        throw new StreamingBoomerangError(
          "invalid-spec-runtime",
          `prompt must be a string, got ${typeof spec.prompt}`,
        )
      }
      // Operational invalid-spec — single-chunk error iterable.
      const builtinFail = validateSpecBuiltin(spec)
      const customFail = customValidate !== undefined ? customValidate(spec) : null
      const failMessage = builtinFail ?? customFail
      if (failMessage !== null) {
        return makeImmediateErrorIterable("invalid-spec", failMessage)
      }
      // Happy path: build channel + drive producer.
      const channel = makeClosableChannel()
      const producerSettled = driveProducer(channel, producer)
      return buildIterable(channel, producerSettled, spec.parentSignal)
    },
  }
}
