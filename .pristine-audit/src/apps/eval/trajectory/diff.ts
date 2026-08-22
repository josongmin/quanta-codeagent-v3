/**
 * Structural diff between two `TrajectoryEvent` streams. Used by
 * `trajectory/replay.ts` to decide whether a replay matches the original.
 *
 * Design choices (each is a contract — change deliberately):
 *
 *   1. PROJECTION over EQUALITY. We project each event to a tuple of
 *      `(kind, key)` where `key` strips fields the producer cannot pin
 *      deterministically across runs (timestamps, monotonic ns, span ids,
 *      assistant token streams, llm usage numbers, exact stdout). The diff
 *      operates on the projected sequence.
 *   2. SEQUENCE-AWARE. We do a longest-common-subsequence pass on the
 *      projections so a single inserted/missing event reports as a small
 *      diff, not a cascading misalignment.
 *   3. NO LLM. Diff is deterministic and unit-testable. Subjective replay
 *      quality lives in `compare/pairwise-judge.ts`.
 *
 * What "matches" means here: every `tool_call` (name + input shape),
 * `tool_result` (name + ok), `turn_start`, `error`, and `session_end.reason`
 * appears in the same relative order in both sequences. Differences in
 * `assistant_text` content, llm token counts, or wall-clock are ignored —
 * provider non-determinism would falsely fail otherwise.
 */
import type { TrajectoryEvent, TrajectoryKind } from "@/shared"

/** Kinds that contribute to the structural projection. Anything else (e.g.
 *  `assistant_text` deltas, `llm_request`/`llm_usage`, sandbox/verify) is
 *  intentionally elided — those are too noisy to compare across runs. */
const COMPARED_KINDS: ReadonlySet<TrajectoryKind> = new Set<TrajectoryKind>([
  "turn_start",
  "tool_call",
  "tool_result",
  "error",
  "recovery",
  "session_end",
])

/** Stable key for ONE projected event. Lower is more abstract — the more we
 *  collapse, the more robust replay equality becomes, at the cost of letting
 *  some real divergences slip past. The current mix has held up against
 *  provider drift in synthetic fixtures; revisit if a known regression
 *  escapes. */
const projectKey = (e: TrajectoryEvent): string => {
  switch (e.kind) {
    case "turn_start":
      return "turn_start"
    case "tool_call": {
      const name = (e.data.name as string | undefined) ?? "?"
      // Keys-only fingerprint of input: same shape ⇒ same key. Values are
      // intentionally ignored (path strings, query text, etc. are noisy).
      const input = e.data.input
      const shape =
        typeof input === "object" && input !== null
          ? Object.keys(input as Record<string, unknown>)
              .sort()
              .join(",")
          : "_"
      return `tool_call:${name}[${shape}]`
    }
    case "tool_result": {
      const name = (e.data.name as string | undefined) ?? "?"
      const ok = e.data.ok === true ? "ok" : "err"
      return `tool_result:${name}:${ok}`
    }
    case "error":
      return "error"
    case "recovery": {
      const reason = (e.data.reason as string | undefined) ?? "?"
      return `recovery:${reason}`
    }
    case "session_end": {
      const reason = (e.data.reason as string | undefined) ?? "?"
      return `session_end:${reason}`
    }
    default:
      // Should not reach here because of the COMPARED_KINDS filter; defend
      // for future enum additions.
      return `other:${String(e.kind)}`
  }
}

/** Project both streams to their comparable key sequence. */
export const projectStream = (events: readonly TrajectoryEvent[]): readonly string[] =>
  events.filter((e) => COMPARED_KINDS.has(e.kind)).map(projectKey)

export interface DiffSummary {
  /** True when EVERY key matches in order (no insertions, no deletions). */
  matched: boolean
  /** |A| - |LCS| + |B| - |LCS| (sum of insertions + deletions). */
  divergedEvents: number
  /** Length of original projected sequence. */
  originalLength: number
  /** Length of replay projected sequence. */
  replayLength: number
  /** First ≤5 divergence keys for quick triage. */
  firstDivergences: readonly string[]
}

/** O(n·m) LCS — fine for our scale (typical synthetic run < 200 events). */
const lcsLength = (a: readonly string[], b: readonly string[]): number => {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 0
  // Use a single row + previous-cell to keep memory linear.
  let prev = new Array<number>(m + 1).fill(0)
  let curr = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const aPrev = a[i - 1]
      const bPrev = b[j - 1]
      const top = prev[j] ?? 0
      const left = curr[j - 1] ?? 0
      const diag = prev[j - 1] ?? 0
      curr[j] = aPrev === bPrev ? diag + 1 : Math.max(top, left)
    }
    ;[prev, curr] = [curr, prev]
    curr.fill(0)
  }
  return prev[m] ?? 0
}

/** Walk both sequences in lockstep; record the first ≤5 keys where they
 *  disagree. This is approximate (it doesn't reconstruct the LCS itself) but
 *  cheap and good enough for triage. */
const firstFiveDivergences = (a: readonly string[], b: readonly string[]): readonly string[] => {
  const out: string[] = []
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n && out.length < 5; i++) {
    if (a[i] !== b[i]) out.push(`#${i}: ${a[i] ?? "_"} vs ${b[i] ?? "_"}`)
  }
  if (a.length !== b.length && out.length < 5) {
    out.push(`length: ${a.length} vs ${b.length}`)
  }
  return out
}

export const diffStreams = (
  original: readonly TrajectoryEvent[],
  replay: readonly TrajectoryEvent[],
): DiffSummary => {
  const a = projectStream(original)
  const b = projectStream(replay)
  const lcs = lcsLength(a, b)
  const diverged = a.length - lcs + (b.length - lcs)
  return {
    matched: a.length === b.length && diverged === 0,
    divergedEvents: diverged,
    originalLength: a.length,
    replayLength: b.length,
    firstDivergences: firstFiveDivergences(a, b),
  }
}
