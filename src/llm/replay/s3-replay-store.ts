/**
 * S3-segment-backed {@link ReplayStore} (ADR-0192 store, durable-store backend).
 *
 * A DROP-IN for {@link jsonlReplayStore}: identical `append/match/load/save/
 * reset` semantics and the SAME content-hash matching (`defaultHashRequest`,
 * reused verbatim — not reimplemented), so a cassette recorded through the
 * jsonl store and through this store are equivalent and interchangeable under
 * `recordingLlmPort` / `replayLlmPort`.
 *
 * Persistence shape — one immutable segment per interaction:
 *   each `append(record)` → ONE `segmentStore.putSegment(seq, JSON.stringify
 *   (record))` at the next monotonic seq. There is no whole-cassette rewrite
 *   (S3 objects are immutable; rewriting on every turn is O(n²) PUTs). `load()`
 *   reconstructs the log via `concat()` (ascending seq, newline-joined) and
 *   parses one record per line — byte-identical to how the jsonl store parses
 *   its on-disk lines, which is why a jsonl-recorded line and an s3 segment
 *   body are the same `JSON.stringify(record)` string.
 *
 * Layering: imports the sibling replay modules (same slice) and the downward
 * `@/shared/remote-store` durable layer. It MUST NOT import `apps/bench`.
 */

import type { SegmentStore } from "@/shared/remote-store"
import type { StreamInput } from "../types"
import { defaultHashRequest } from "./jsonl-store"
import type { MatchPolicy, RecordedInteraction, ReplayMatchOpts, ReplayStore } from "./types"

export interface S3ReplayStoreOpts {
  /** Segment log this cassette lives in (`segmentStore(backend, key)`). */
  readonly store: SegmentStore
  /**
   * Cap `match` to the FIRST `limit` recorded interactions — anything that
   * would only match index `>= limit` MISSES. Mirrors {@link jsonlReplayStore}
   * exactly (fork-at-N without a mutator). Absent ⇒ whole cassette eligible;
   * `0` ⇒ nothing replays; negative is clamped to `0`.
   */
  readonly limit?: number
  /** Default match policy when callers don't override per-call. Default
   *  `"exact"` — same as the jsonl store. */
  readonly defaultPolicy?: MatchPolicy
  /** Override request → hash. Defaults to the SHARED `defaultHashRequest` so
   *  matching is byte-identical to the jsonl store. Test doubles can replace
   *  it with a deterministic identity to make collisions inspectable. */
  readonly hashRequest?: (req: StreamInput, policy: MatchPolicy) => string
  /** Invoked once per malformed segment body during `load`. No-op by default
   *  (mirrors `jsonlReplayStore.onMalformed`). */
  readonly onMalformed?: (line: string, error: Error) => void
}

export function s3ReplayStore(opts: S3ReplayStoreOpts): ReplayStore {
  const hashFn = opts.hashRequest ?? defaultHashRequest
  const defaultPolicy: MatchPolicy = opts.defaultPolicy ?? "exact"

  // Authoritative in-memory mirror once loaded — same design as the jsonl
  // store (its `cached` array is the source of truth after first read). The
  // segment log is the durable backing; reads go through the cache so a single
  // adapter instance sees its own appends/saves coherently.
  let cached: RecordedInteraction[] | null = null
  // Highest seq written so far + 1 ⇒ the seq the NEXT append claims. Tracked so
  // a re-opened adapter resumes AFTER existing segments rather than clobbering
  // seq 0. Computed on first load from `concat()`'s line count.
  let nextSeq = 0
  const used = new Set<number>() // indexes into `cached`

  async function ensureLoaded(): Promise<RecordedInteraction[]> {
    if (cached !== null) return cached
    // This adapter owns a zero-based append log. Bind concat's second LIST to
    // the first observed count so a leading/interior hole or concurrent stale
    // tail cannot be compacted into a different sequence identity.
    const expectedCount = (await opts.store.listSegments()).length
    const joined = await opts.store.concat(expectedCount)
    const out: RecordedInteraction[] = []
    if (joined.length > 0) {
      for (const line of joined.split("\n")) {
        if (line.length === 0) continue
        try {
          out.push(JSON.parse(line) as RecordedInteraction)
        } catch (err) {
          opts.onMalformed?.(line, err as Error)
        }
      }
    }
    cached = out
    // Malformed records remain occupied durable segments even when omitted
    // from the match cache. Resume after the segment count, not parsed count,
    // so a later append never overwrites malformed evidence in place.
    nextSeq = expectedCount
    return cached
  }

  return {
    async append(record: RecordedInteraction): Promise<void> {
      const list = await ensureLoaded()
      const seq = nextSeq
      // EXACTLY one putSegment ⇒ exactly one backend.put — no re-PUT of priors.
      // Body is `JSON.stringify(record)` (newline-free), the same string the
      // jsonl store writes as one line, so concat()+split round-trips it.
      await opts.store.putSegment(seq, JSON.stringify(record))
      nextSeq = seq + 1
      // Keep the cache coherent so subsequent matches see the just-recorded
      // entry exactly once (mirrors jsonl's post-append push).
      list.push(record)
    },

    async match(
      request: StreamInput,
      matchOpts?: ReplayMatchOpts,
    ): Promise<RecordedInteraction | null> {
      const policy: MatchPolicy = matchOpts?.policy ?? defaultPolicy
      const key = hashFn(request, policy)
      const list = await ensureLoaded()
      const bound =
        opts.limit !== undefined ? Math.min(list.length, Math.max(0, opts.limit)) : list.length
      for (let i = 0; i < bound; i++) {
        if (used.has(i)) continue
        const rec = list[i]
        if (rec === undefined) continue
        // Rehash each candidate under the active policy — records on disk may
        // have been hashed under a different policy (identical to jsonl).
        if (hashFn(rec.request, policy) === key) {
          used.add(i)
          return rec
        }
      }
      return null
    },

    async load(): Promise<ReadonlyArray<RecordedInteraction>> {
      const list = await ensureLoaded()
      return list.slice()
    },

    async save(records: ReadonlyArray<RecordedInteraction>): Promise<void> {
      // Curation overwrite. S3 `put` is last-writer-wins, so re-PUT seq i for
      // every supplied record. NOTE: because the durable backend exposes no
      // delete, a `save` that SHRINKS the cassette cannot physically remove the
      // now-orphaned higher-seq segments; the in-memory cache below is the
      // authoritative window for this adapter instance (a fresh cold re-open
      // over a shrunk log would over-read the stale tail). The normal recording
      // flow uses `append`; `save` is for tooling that curates to a fresh key.
      for (let i = 0; i < records.length; i++) {
        await opts.store.putSegment(i, JSON.stringify(records[i]))
      }
      cached = records.slice()
      nextSeq = records.length
      used.clear()
    },

    reset(): void {
      used.clear()
    },
  }
}
