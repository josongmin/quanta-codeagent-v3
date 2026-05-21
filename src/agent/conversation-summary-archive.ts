/**
 * ConversationSummaryArchive — sliding-window archive of per-compaction summaries
 * (Cursor absorption, ADR-0075).
 *
 * Today's compaction is OUT-OF-BAND: when `compactIfNeeded` returns
 * `compacted:true` the synthetic `<conversation summary>` user message replaces
 * the summarized prefix and that's it — the loop forgets the original prefix
 * existed and there is no after-the-fact record of which turns were folded into
 * which summary, when, or how big the summary was. Cursor's compactor keeps a
 * sliding `summaries[]` archive (fromTurnId..toTurnId + summary + ts + tokens)
 * so the UI can render a 1st-class "context history" surface AND a debug
 * inspector can ask "what was compacted, and when". This module is the pure
 * data structure for that archive.
 *
 * Slice contract:
 *   - Pure module (clock/IO 0): the caller supplies `ts` so tests are
 *     deterministic and the loop owns the time source.
 *   - No coupling to `@/stream` / `@/llm` / `@/session`: the archive is just
 *     a typed list. Event emission lives at the loop seam, not here.
 *   - Default-OFF (RFC §1.2): construction is explicit (`createArchive`). When
 *     `AgentConfig.compaction.archive !== true` the loop never builds one and
 *     the surface is byte-identical to pre-archive behavior.
 *
 * Why a separate module (vs. inlining in `compaction.ts`):
 *   - The archive grows ACROSS compactions — it is session-scoped state, not
 *     a per-compaction value. `compaction.ts` is stateless by design (each call
 *     decides on the messages it was given). Mixing the two would force
 *     `compactIfNeeded` to either take a mutable archive arg (couples the pure
 *     summarizer to an unrelated lifecycle) or return one (caller must always
 *     thread it). Pulling it out keeps `compactIfNeeded` pure and the archive
 *     ownership obvious (the loop).
 *   - Same pattern as `compaction-breaker.ts`: a small stateful collaborator
 *     the loop owns; pure module, deterministic, easy to test.
 *
 * `appendSummary` returns the archive in place (mutates `summaries`) so the
 * loop does not have to re-assign on every compaction. Callers that need
 * immutability can clone via `[...archive.summaries]`. There is intentionally
 * no eviction policy here — the archive grows monotonically per session; the
 * session itself is the natural retention boundary (RFC §6.3). A future
 * follow-up MAY add a soft cap, but the current absorption target is "expose
 * the summaries", not "manage retention" (out of scope, see LIMITATIONS in
 * ADR-0075).
 */

export interface ConversationSummaryEntry {
  /** Turn id of the first message folded into this summary (inclusive). When
   *  the loop has no per-turn-id mechanism the caller may pass the run's
   *  session id or a synthesized id — the archive itself does not interpret
   *  these strings, only stores them. */
  fromTurnId: string
  /** Turn id of the last message folded into this summary (inclusive). */
  toTurnId: string
  /** The summary text the summarizer LLM produced (already extracted from the
   *  synthetic `<conversation summary>` wrapper — the wrapper is a presentation
   *  detail of the synthetic user message, not part of the archive payload). */
  summary: string
  /** Caller-supplied wall-clock timestamp (epoch ms). The archive does NOT
   *  read `Date.now()` — keeping the module clock-free makes its tests
   *  deterministic and lets the loop's time source remain the single seam. */
  ts: number
  /** Estimated tokens of the summary (chars/4 heuristic, the same one
   *  `compaction.ts` uses). Stored verbatim from `CompactResult.summaryTokens`. */
  tokens: number
}

export interface ConversationSummaryArchive {
  /** Append-only list, oldest first. The loop owns the array; callers that
   *  need a snapshot should clone (`[...archive.summaries]`). */
  summaries: ConversationSummaryEntry[]
}

/** Construct an empty archive. Separate factory (vs. just `{summaries:[]}`) so
 *  the call site documents intent and a future invariant (e.g. version stamp)
 *  has one place to land. */
export const createArchive = (): ConversationSummaryArchive => ({ summaries: [] })

/**
 * Append a new summary entry. Mutates `archive.summaries` in place; the caller
 * keeps the same reference. Pure with respect to the entry: every field is
 * stored verbatim, no normalization, no clock read.
 *
 * The caller is responsible for keeping `fromTurnId`/`toTurnId` meaningful for
 * their context (subagents may use synthetic ids; the archive does not parse
 * them).
 */
export const appendSummary = (
  archive: ConversationSummaryArchive,
  entry: ConversationSummaryEntry,
): ConversationSummaryArchive => {
  archive.summaries.push(entry)
  return archive
}

/** Total estimated tokens across all archived summaries — useful for
 *  diagnostics ("archive size grew Nk tokens this session") and as a future
 *  hook for a soft cap. Pure read, no side effect. */
export const archivedTokens = (archive: ConversationSummaryArchive): number => {
  let n = 0
  for (const e of archive.summaries) n += e.tokens
  return n
}
