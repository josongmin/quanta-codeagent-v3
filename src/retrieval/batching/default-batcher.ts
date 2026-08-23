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
import { err, errMessage, ok, type Result } from "@/shared"
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

/** The in-flight window and its timer. */
const batcherState = (opts: DefaultBatcherOptions) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and every link mutates in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    pending: [] as PendingEntry[],
    timer: null as ReturnType<typeof setTimeout> | null,
    microtaskArmed: false,
    flushing: null as Promise<void> | null,
  }
  const configErr = validateConfig(opts.config)
  const { windowMs, maxBatchSize } = opts.config

  // Single-flight across flushes: a text currently being embedded by an
  // in-flight chunk does NOT get re-enqueued; new callers subscribe.
  const flight = createSingleFlight<Result<EmbeddingVector, BatchError>>()

  const clearTimer = (): void => {
    if (mut.timer !== null) {
      clearTimeout(mut.timer)
      mut.timer = null
    }
    mut.microtaskArmed = false
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
  return { opts, configErr, windowMs, maxBatchSize, flight, clearTimer, settleAll, mut }
}

/** Chunking: group by text, issue a chunk, and settle or fail it. */
const batcherChunks = (ctx: ReturnType<typeof batcherState>) => {
  const { opts, flight, settleAll } = ctx

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
      failChunk(texts, errMessage(e), defByText)
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
  return { resolveVectors, failChunk, issueChunk, groupByText, setupFlights }
}

/** The flush paths and the public embed entry point. */
const batcherFlush = (ctx: ReturnType<typeof batcherState> & ReturnType<typeof batcherChunks>) => {
  const {
    configErr,
    windowMs,
    maxBatchSize,
    clearTimer,
    mut,
    issueChunk,
    groupByText,
    setupFlights,
  } = ctx

  const doFlush = async (): Promise<void> => {
    clearTimer()
    if (mut.pending.length === 0) return
    const batch = mut.pending
    mut.pending = []

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
    if (mut.flushing !== null) return mut.flushing
    const p = doFlush().finally(() => {
      mut.flushing = null
      // If new entries arrived during the flush, arm again.
      if (mut.pending.length > 0) armTimer()
    })
    mut.flushing = p
    return p
  }

  function armTimer(): void {
    if (windowMs === 0) {
      if (mut.microtaskArmed) return
      mut.microtaskArmed = true
      queueMicrotask(() => {
        if (!mut.microtaskArmed) return // cancelled by flush()
        mut.microtaskArmed = false
        void runFlush()
      })
      return
    }
    if (mut.timer !== null) return
    mut.timer = setTimeout(() => {
      mut.timer = null
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
          const idx = mut.pending.indexOf(entry)
          if (idx !== -1) mut.pending.splice(idx, 1)
          entry.cleanupAbort?.()
          resolve(err<BatchError>({ kind: "aborted" }))
        }
        sig.addEventListener("abort", onAbort, { once: true })
        entry.cleanupAbort = () => {
          sig.removeEventListener("abort", onAbort)
        }
      }
      mut.pending.push(entry)
      armTimer()
    })
  }

  const flush = (): Promise<void> => {
    if (mut.pending.length === 0 && mut.flushing === null) return Promise.resolve()
    clearTimer()
    return runFlush()
  }

  const pendingCount = (): number => mut.pending.length

  return { doFlush, runFlush, embed, flush, pendingCount }
}

/** Assemble the chained builders. */
export const createDefaultBatcher = (opts: DefaultBatcherOptions): EmbedBatcher => {
  const p0 = batcherState(opts)
  const p1 = batcherChunks({ ...p0 })
  const p2 = batcherFlush({ ...p0, ...p1 })
  const { embed, flush, pendingCount } = { ...p0, ...p1, ...p2 }
  return { embed, flush, pending: pendingCount }
}
