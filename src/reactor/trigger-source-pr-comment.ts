/**
 * ADR-0132 Stage 1 (Phase A) — PR comment trigger source.
 *
 * Polls `gh api repos/<owner>/<repo>/issues/<n>/comments?since=<watermark>`
 * and emits a {@link ProactiveTrigger} of reason `pr_comment` per NEW
 * comment. Watermark advances to the latest seen `updated_at` (ISO-8601 UTC)
 * so subsequent polls skip comments we've already surfaced.
 *
 * Closed ports: `GhCliPort` (subprocess) + `ClockPort` (initial watermark) +
 * `WatermarkStore` (persistent across process restarts; tests pass an
 * in-memory impl).
 *
 * [[no-heuristics-only-validated]]: a comment exists ⇔ gh returned it. We
 * never infer comments from titles or notifications; the JSON is the truth.
 */

import type { GhCliPort, GhCliResult } from "./trigger-source-ci"
import type { ClockPort, ProactiveTrigger, TriggerSourcePort } from "./types"

/**
 * Watermark store — a tiny KV. Production binds a file-backed impl
 * (`.quanta/reactor-watermarks.json`); tests use a Map wrapper.
 *
 * Watermark format: ISO-8601 UTC timestamp string. Compare lexicographically
 * — ISO-8601 sorts as time (the universal property the GH API depends on).
 */
export interface WatermarkStore {
  load(key: string): Promise<string | undefined>
  save(key: string, value: string): Promise<void>
}

export interface PrCommentTriggerOpts {
  readonly ghCliPort: GhCliPort
  readonly clockPort: ClockPort
  readonly repoCwd: string
  /** `<owner>/<repo>` slug. Passed verbatim to `gh api`. */
  readonly repoSlug: string
  /** Issue / PR number. */
  readonly prNumber: number
  /** Watermark store key — distinct per workspace to avoid cross-talk. */
  readonly watermarkKey: string
  readonly watermarkStore: WatermarkStore
  /** Optional degraded-path sink. Trigger-source failures still collapse to
   *  empty arrays, but callers can observe watermark-store faults. */
  readonly onError?: (message: string) => void
}

/**
 * Sub-set of the gh-api comment JSON. Extra fields tolerated.
 */
interface GhCommentRow {
  readonly id?: number
  readonly user?: { readonly login?: string }
  readonly body?: string
  readonly html_url?: string
  readonly created_at?: string
  readonly updated_at?: string
}

export const createPrCommentTriggerSource = (opts: PrCommentTriggerOpts): TriggerSourcePort => {
  return {
    async poll(pollOpts): Promise<readonly ProactiveTrigger[]> {
      const signal = pollOpts?.signal
      if (signal !== undefined && signal.aborted) return []

      // First poll: seed the watermark with "now" so we don't backfill the
      // entire comment history at first sight (a fresh process should react
      // only to NEW activity).
      const loaded = await safeLoadWatermark(opts.watermarkStore, opts.watermarkKey, opts.onError)
      if (!loaded.ok) return []
      if (signal !== undefined && signal.aborted) return []
      const existing = loaded.value
      const watermark = existing ?? new Date(opts.clockPort.now()).toISOString()
      if (existing === undefined) {
        // Seed and short-circuit: nothing is "newer than now".
        if (!(await safeSaveWatermark(opts.watermarkStore, opts.watermarkKey, watermark, opts.onError)))
          return []
        return []
      }
      if (signal !== undefined && signal.aborted) return []

      const path = `repos/${opts.repoSlug}/issues/${opts.prNumber}/comments?since=${encodeURIComponent(watermark)}`
      const res = await safeRun(opts.ghCliPort, ["api", path], opts.repoCwd, signal)
      if (res === undefined || res.exitCode !== 0) return []
      if (signal !== undefined && signal.aborted) return []

      const rows = safeJsonArray<GhCommentRow>(res.stdout)
      if (rows === undefined || rows.length === 0) return []

      // Filter rows STRICTLY newer than the watermark. GH's `since` is
      // inclusive, so without this filter we'd re-fire the watermark comment
      // every poll.
      const fresh: GhCommentRow[] = []
      let maxStamp = watermark
      for (const row of rows) {
        const stamp = row.updated_at ?? row.created_at
        if (typeof stamp !== "string" || stamp.length === 0) continue
        if (stamp <= watermark) continue
        fresh.push(row)
        if (stamp > maxStamp) maxStamp = stamp
      }
      if (fresh.length === 0) return []
      if (signal !== undefined && signal.aborted) return []

      // Advance the watermark BEFORE returning so a consumer that drops the
      // trigger doesn't see the same comment again on the next poll. (If the
      // consumer crashes before processing, the comment is lost — same
      // tradeoff as the CI source's in-memory dedup. The cron watcher SHOULD
      // pass a durable store and accept this at-most-once semantics.)
      if (!(await safeSaveWatermark(opts.watermarkStore, opts.watermarkKey, maxStamp, opts.onError)))
        return []

      const triggers: ProactiveTrigger[] = []
      for (const row of fresh) {
        const url = row.html_url
        if (typeof url !== "string" || url.length === 0) continue
        const author = row.user?.login ?? "unknown"
        const bodySnippet = clampSnippet(row.body ?? "")
        triggers.push(
          Object.freeze({
            reason: "pr_comment" as const,
            evidence: Object.freeze({ kind: "url" as const, value: url }),
            simulatedMessage: `New PR comment from @${author}: ${bodySnippet}`,
            abortSignal: new AbortController().signal,
          }),
        )
      }
      return triggers
    },
  }
}

/** Body snippet cap — keep simulated messages bounded so a 50KB comment
 *  doesn't poison the next turn's context window. The agent can still fetch
 *  the full body via the URL evidence anchor. */
const SNIPPET_MAX_CHARS = 280
const clampSnippet = (body: string): string => {
  const trimmed = body.trim().replace(/\s+/g, " ")
  if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

/** In-memory watermark store — exported for tests + as a sane default for
 *  ephemeral process use cases. Production cron watcher should pass a
 *  file-backed implementation. */
export const createInMemoryWatermarkStore = (): WatermarkStore => {
  const m = new Map<string, string>()
  return {
    load: async (key) => m.get(key),
    save: async (key, value) => {
      m.set(key, value)
    },
  }
}

const safeRun = async (
  port: GhCliPort,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GhCliResult | undefined> => {
  try {
    return await port.run(args, cwd, signal)
  } catch {
    return undefined
  }
}

const safeLoadWatermark = async (
  store: WatermarkStore,
  key: string,
  onError?: (message: string) => void,
): Promise<{ ok: true; value: string | undefined } | { ok: false }> => {
  try {
    return { ok: true, value: await store.load(key) }
  } catch (error) {
    onError?.(
      `reactor.pr_comment.watermark.load failed (${key}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return { ok: false }
  }
}

const safeSaveWatermark = async (
  store: WatermarkStore,
  key: string,
  value: string,
  onError?: (message: string) => void,
): Promise<boolean> => {
  try {
    await store.save(key, value)
    return true
  } catch (error) {
    onError?.(
      `reactor.pr_comment.watermark.save failed (${key}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

const safeJsonArray = <T>(raw: string): readonly T[] | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as readonly T[]) : undefined
  } catch {
    return undefined
  }
}
