/**
 * Default {@link EmbedBatcher} adapter (ADR-0264).
 *
 * Wraps any object exposing `embed(texts): Promise<vectors>` (i.e. Axis D's
 * {@link EmbeddingPort} or any structural equivalent) with:
 *   - a `windowMs` accumulation window (timer-armed on first enqueue,
 *     cleared on flush; `windowMs === 0` schedules on `queueMicrotask`),
 *   - single-flight dedupe on identical text (in-batch AND cross-flush),
 *   - `maxBatchSize`-chunked parallel issuance (one provider call per chunk),
 *   - AbortSignal propagation (pre-enqueue → immediate `aborted`;
 *     post-enqueue → removed from pending, resolved with `aborted`),
 *   - config validation (`windowMs < 0` or `maxBatchSize < 1` → every
 *     `embed()` immediately resolves `config-invalid`, factory never throws).
 *
 * The slice is wire-shape only — no production caller is re-pointed.
 */
import { err, ok, type Result } from "@/shared"
import type { EmbedBatcher } from "./port"
import { createSingleFlight } from "./single-flight"
import type { BatchConfig, BatchError, EmbeddingVector } from "./types"

/** Structural seam — any object that can embed a batch of texts. Matches
 *  Axis D's `EmbeddingPort` without importing it (keeps the slice
 *  decoupled from the broader retrieval barrel). */
export interface UnderlyingEmbedder {
  embed(
    texts: readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<readonly EmbeddingVector[]>
}

export interface DefaultBatcherOptions {
  readonly embedder: UnderlyingEmbedder
  readonly config: BatchConfig
}

interface PendingEntry {
  readonly text: string
  readonly resolve: (r: Result<EmbeddingVector, BatchError>) => void
  /** Listener installed on the caller's signal; cleared after resolve. */
  cleanupAbort?: () => void
}

interface Deferred {
  readonly text: string
  readonly promise: Promise<Result<EmbeddingVector, BatchError>>
  readonly resolve: (r: Result<EmbeddingVector, BatchError>) => void
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const n = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push([...items.slice(i, i + n)])
  return out
}

const validateConfig = (c: BatchConfig): BatchError | null => {
  if (!Number.isFinite(c.windowMs) || c.windowMs < 0) {
    return { kind: "config-invalid", detail: `windowMs must be >= 0 (got ${c.windowMs})` }
  }
  if (!Number.isFinite(c.maxBatchSize) || c.maxBatchSize < 1) {
    return {
      kind: "config-invalid",
      detail: `maxBatchSize must be >= 1 (got ${c.maxBatchSize})`,
    }
  }
  return null
}

const makeDeferred = (text: string): Deferred => {
  let resolveFn!: (r: Result<EmbeddingVector, BatchError>) => void
  const promise = new Promise<Result<EmbeddingVector, BatchError>>((res) => {
    resolveFn = res
  })
  return { text, promise, resolve: resolveFn }
}

export const createDefaultBatcher = (opts: DefaultBatcherOptions): EmbedBatcher => {
  const configErr = validateConfig(opts.config)
  const { windowMs, maxBatchSize } = opts.config

  // Single-flight across flushes: a text currently being embedded by an
  // in-flight chunk does NOT get re-enqueued; new callers subscribe.
  const flight = createSingleFlight<Result<EmbeddingVector, BatchError>>()

  let pending: PendingEntry[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let microtaskArmed = false
  let flushing: Promise<void> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    microtaskArmed = false
  }

  const settleAll = (
    entries: readonly PendingEntry[],
    r: Result<EmbeddingVector, BatchError>,
  ): void => {
    for (const e of entries) {
      e.cleanupAbort?.()
      e.resolve(r)
    }
  }

  const resolveVectors = (
    texts: readonly string[],
    vectors: readonly EmbeddingVector[],
    defByText: ReadonlyMap<string, Deferred>,
  ): void => {
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]
      if (t === undefined) continue
      const d = defByText.get(t)
      if (d === undefined) continue
      const v = vectors[i]
      d.resolve(v === undefined ? err<BatchError>({ kind: "vector-missing", text: t }) : ok(v))
    }
  }

  const failChunk = (
    texts: readonly string[],
    detail: string,
    defByText: ReadonlyMap<string, Deferred>,
  ): void => {
    for (const t of texts) {
      const d = defByText.get(t)
      if (d !== undefined) d.resolve(err<BatchError>({ kind: "underlying-failed", detail }))
    }
  }

  const issueChunk = async (
    texts: readonly string[],
    defByText: ReadonlyMap<string, Deferred>,
  ): Promise<void> => {
    try {
      const vectors = await opts.embedder.embed(texts)
      resolveVectors(texts, vectors, defByText)
    } catch (e) {
      failChunk(texts, e instanceof Error ? e.message : String(e), defByText)
    }
  }

  const groupByText = (batch: readonly PendingEntry[]): Map<string, PendingEntry[]> => {
    const byText = new Map<string, PendingEntry[]>()
    for (const e of batch) {
      const arr = byText.get(e.text)
      if (arr === undefined) byText.set(e.text, [e])
      else arr.push(e)
    }
    return byText
  }

  /** Per unique text: register a deferred as the single-flight promise
   *  ONLY if no flight already exists. Otherwise subscribe. Returns the
   *  deferreds we own (need to issue) and the subscriber promises (need
   *  to await for clean-drain semantics). */
  const setupFlights = (
    byText: ReadonlyMap<string, readonly PendingEntry[]>,
  ): { newDeferreds: Deferred[]; subscriberPromises: Array<Promise<void>> } => {
    const newDeferreds: Deferred[] = []
    const subscriberPromises: Array<Promise<void>> = []
    for (const [text, entries] of byText) {
      const def = makeDeferred(text)
      let took = false
      const subscribed = flight.run(text, async () => {
        took = true
        return def.promise
      })
      if (took) newDeferreds.push(def)
      subscriberPromises.push(
        subscribed.then((r) => {
          settleAll(entries, r)
        }),
      )
    }
    return { newDeferreds, subscriberPromises }
  }

  const doFlush = async (): Promise<void> => {
    clearTimer()
    if (pending.length === 0) return
    const batch = pending
    pending = []

    const byText = groupByText(batch)
    const { newDeferreds, subscriberPromises } = setupFlights(byText)

    // Issue chunks ONLY for texts whose flight we own; others piggy-back
    // on an in-flight chunk from a previous flush.
    const newTexts = newDeferreds.map((d) => d.text)
    const defByText = new Map<string, Deferred>(newDeferreds.map((d) => [d.text, d]))
    const chunks = chunk(newTexts, maxBatchSize)

    await Promise.all(chunks.map((texts) => issueChunk(texts, defByText)))

    // Wait for subscriber settlement so flush() callers see a clean drain.
    await Promise.all(subscriberPromises)
  }

  const runFlush = (): Promise<void> => {
    if (flushing !== null) return flushing
    const p = doFlush().finally(() => {
      flushing = null
      // If new entries arrived during the flush, arm again.
      if (pending.length > 0) armTimer()
    })
    flushing = p
    return p
  }

  function armTimer(): void {
    if (windowMs === 0) {
      if (microtaskArmed) return
      microtaskArmed = true
      queueMicrotask(() => {
        if (!microtaskArmed) return // cancelled by flush()
        microtaskArmed = false
        void runFlush()
      })
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void runFlush()
    }, windowMs)
  }

  const embed = (
    text: string,
    callOpts?: { signal?: AbortSignal },
  ): Promise<Result<EmbeddingVector, BatchError>> => {
    if (configErr !== null) return Promise.resolve(err<BatchError>(configErr))

    const sig = callOpts?.signal
    if (sig?.aborted === true) {
      return Promise.resolve(err<BatchError>({ kind: "aborted" }))
    }

    return new Promise<Result<EmbeddingVector, BatchError>>((resolve) => {
      const entry: PendingEntry = { text, resolve }
      if (sig !== undefined) {
        const onAbort = (): void => {
          const idx = pending.indexOf(entry)
          if (idx !== -1) pending.splice(idx, 1)
          entry.cleanupAbort?.()
          resolve(err<BatchError>({ kind: "aborted" }))
        }
        sig.addEventListener("abort", onAbort, { once: true })
        entry.cleanupAbort = () => {
          sig.removeEventListener("abort", onAbort)
        }
      }
      pending.push(entry)
      armTimer()
    })
  }

  const flush = (): Promise<void> => {
    if (pending.length === 0 && flushing === null) return Promise.resolve()
    clearTimer()
    return runFlush()
  }

  const pendingCount = (): number => pending.length

  return { embed, flush, pending: pendingCount }
}
