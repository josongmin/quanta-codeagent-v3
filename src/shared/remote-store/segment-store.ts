/**
 * Append-free segmented log over a {@link RemoteBackend} + a base `key`.
 *
 * S3 objects are IMMUTABLE — there is no append, and rewriting a whole jsonl on
 * every event would be O(n²) PUTs of growing size. So each event/turn becomes
 * its OWN object at `<key>/events/<seq>.json`, and the log is reconstructed by
 * listing + concatenating in ascending seq order. `putSegment` therefore issues
 * EXACTLY one `backend.put` (the new segment) and never re-PUTs prior segments.
 *
 * The seq is zero-padded to 6 digits so the lexical key order from a backend
 * `list` matches numeric order for the common case; we still parse + numeric
 * sort defensively so a >6-digit seq can never silently misorder the log.
 */
import type { RemoteBackend } from "./backend"

const SEQ_PAD = 6

/** `<key>/events/<seq padded>.json` — the object path for one segment. */
const segmentPath = (key: string, seq: number): string =>
  `${key}/events/${String(seq).padStart(SEQ_PAD, "0")}.json`

const EVENTS_PREFIX = (key: string): string => `${key}/events/`

/** Parse the numeric seq out of a full segment key, or undefined if it isn't one. */
const seqOfKey = (key: string, fullKey: string): number | undefined => {
  const prefix = EVENTS_PREFIX(key)
  if (!fullKey.startsWith(prefix)) return undefined
  const rest = fullKey.slice(prefix.length)
  const m = /^(\d+)\.json$/.exec(rest)
  if (m === null) return undefined
  // `parseInt("")` is NaN, which the `isFinite` guard below already rejects —
  // the same answer the assertion's impossible branch would have crashed on.
  const n = Number.parseInt(m[1] ?? "", 10)
  return Number.isFinite(n) ? n : undefined
}

export interface SegmentStore {
  /** Write ONE immutable object for `seq`. Exactly one backend.put per call. */
  putSegment(seq: number, body: string): Promise<void>
  /** Seqs present under this key, ascending. */
  listSegments(): Promise<number[]>
  /** The body for `seq`, or undefined if absent. */
  getSegment(seq: number): Promise<string | undefined>
  /** All segment bodies, ascending by seq, newline-joined; each body verbatim.
   * When `expectedCount` is supplied, the immutable log must contain exactly
   * the contiguous sequence `0..expectedCount-1` before any body is returned. */
  concat(expectedCount?: number): Promise<string>
}

const assertExpectedSequence = (seqs: readonly number[], expectedCount: number): void => {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error(`[segment-store] invalid expected segment count: ${expectedCount}`)
  }
  if (seqs.length !== expectedCount) {
    throw new Error(
      `[segment-store] expected ${expectedCount} contiguous segments, found ${seqs.length}`,
    )
  }
  for (let i = 0; i < expectedCount; i++) {
    if (seqs[i] !== i) {
      throw new Error(
        `[segment-store] expected contiguous segment ${i}, found ${String(seqs[i])} — log is corrupt`,
      )
    }
  }
}

export const segmentStore = (backend: RemoteBackend, key: string): SegmentStore => {
  const listSegments = async (): Promise<number[]> => {
    const keys = await backend.list(EVENTS_PREFIX(key))
    const seqs: number[] = []
    for (const k of keys) {
      const s = seqOfKey(key, k)
      if (s !== undefined) seqs.push(s)
    }
    return seqs.sort((a, b) => a - b)
  }

  const getSegment = (seq: number): Promise<string | undefined> =>
    backend.get(segmentPath(key, seq))

  return {
    async putSegment(seq, body) {
      await backend.put(segmentPath(key, seq), body)
    },
    listSegments,
    getSegment,
    async concat(expectedCount) {
      const seqs = await listSegments()
      if (expectedCount !== undefined) assertExpectedSequence(seqs, expectedCount)
      const bodies = await Promise.all(seqs.map((s) => getSegment(s)))
      // A segment that was LISTED but whose get returns undefined did NOT
      // genuinely 404 (the backend `get` now reserves undefined for a real
      // not-found and THROWS on transport failure — see s3-backend FIX 2). So a
      // hole here means the object vanished between list and get = corruption.
      // Fail LOUDLY rather than splice the log shut and replay a silently
      // truncated transcript (fail-closed).
      for (let i = 0; i < seqs.length; i++) {
        if (bodies[i] === undefined) {
          throw new Error(
            `[segment-store] listed segment ${seqs[i]} (${key}) missing/unreadable on get — log is corrupt`,
          )
        }
      }
      return (bodies as string[]).join("\n")
    },
  }
}
