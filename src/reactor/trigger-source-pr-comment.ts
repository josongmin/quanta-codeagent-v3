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

import { errMessage } from "@/shared"
import type { GhCliPort, GhCliResult } from "./trigger-source-ci"
import type { ClockPort, ProactiveTrigger, TriggerSourcePort } from "./types"

/**
 * `<owner>/<repo>` shape gate (audit L9 H6). The slug is interpolated raw into
 * a `gh api repos/<slug>/…` path; without this gate a hostile/misconfigured
 * `repoSlug` like `"foo/bar/comments?per_page=1&x="` or one containing `../`
 * rewrites the GitHub REST endpoint (path traversal / query injection at the
 * network boundary). We allow only `word.-` segments separated by a single
 * `/`, which is a superset of every legal GitHub `owner/repo` and a strict
 * subset of anything that could escape the intended path segment.
 */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/
const isValidRepoSlug = (slug: string): boolean =>
  typeof slug === "string" && REPO_SLUG_RE.test(slug)
/** PR / issue number gate (audit L9 H6) — a positive 32-bit-safe integer.
 *  Anything else (float, NaN, negative, `1/comments?x=`) is refused before it
 *  reaches the path. */
const isValidPrNumber = (n: number): boolean =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER
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

      // Boundary gate (audit L9 H6): never interpolate an unvalidated slug /
      // number into the gh-api path. A bad value collapses to an empty poll
      // (same degrade contract as a gh failure) and surfaces via `onError` so
      // the misconfiguration is observable, not silently injecting.
      if (!isValidRepoSlug(opts.repoSlug)) {
        opts.onError?.(`reactor.pr_comment.invalid_repo_slug: ${String(opts.repoSlug)}`)
        return []
      }
      if (!isValidPrNumber(opts.prNumber)) {
        opts.onError?.(`reactor.pr_comment.invalid_pr_number: ${String(opts.prNumber)}`)
        return []
      }

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
        if (
          !(await safeSaveWatermark(
            opts.watermarkStore,
            opts.watermarkKey,
            watermark,
            opts.onError,
          ))
        )
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
      // every poll. We keep each fresh row paired with its (validated) stamp so
      // the watermark math below operates on the SAME stamp that gated the row.
      const fresh: { readonly row: GhCommentRow; readonly stamp: string }[] = []
      for (const row of rows) {
        const stamp = row.updated_at ?? row.created_at
        if (typeof stamp !== "string" || stamp.length === 0) continue
        if (stamp <= watermark) continue
        fresh.push({ row, stamp })
      }
      if (fresh.length === 0) return []
      if (signal !== undefined && signal.aborted) return []

      // Build triggers FIRST, tracking two stamps that drive an idempotency-safe
      // watermark:
      //   • maxEmittedStamp  — the latest comment we actually surfaced.
      //   • minDroppedStamp  — the earliest comment we could NOT surface (no
      //                        html_url evidence anchor).
      // A dropped row is a hole the single monotonic cursor cannot skip over: if
      // the watermark moved past it, that comment would be lost FOREVER (the
      // reactor never revisits stamps ≤ watermark). That is NOT the documented
      // at-most-once-on-crash tradeoff — the comment was received cleanly. So we
      // cap the watermark strictly BELOW the earliest hole.
      const triggers: ProactiveTrigger[] = []
      let maxEmittedStamp: string | undefined
      let minDroppedStamp: string | undefined
      for (const { row, stamp } of fresh) {
        const url = row.html_url
        if (typeof url !== "string" || url.length === 0) {
          // Hole: leave the watermark behind this row so the next poll re-fetches
          // it (the comment may gain an html_url, or the misconfiguration is at
          // least re-observed) instead of silently skipping it forever.
          if (minDroppedStamp === undefined || stamp < minDroppedStamp) minDroppedStamp = stamp
          continue
        }
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
        if (maxEmittedStamp === undefined || stamp > maxEmittedStamp) maxEmittedStamp = stamp
      }

      // Watermark = the latest EMITTED stamp that is still strictly before the
      // earliest hole. Everything at-or-before this stamp is acked; the hole and
      // anything after it stays unacked so the next poll reconsiders it. With no
      // hole this is simply the max emitted stamp (the common case). With no
      // emitted row before the hole, the watermark does not move at all.
      let nextWatermark: string | undefined
      if (maxEmittedStamp !== undefined) {
        if (minDroppedStamp === undefined || maxEmittedStamp < minDroppedStamp) {
          nextWatermark = maxEmittedStamp
        } else {
          // Earliest hole precedes our latest emit — advance only as far as the
          // newest emitted stamp that is strictly before the hole.
          for (const { row, stamp } of fresh) {
            const url = row.html_url
            if (typeof url !== "string" || url.length === 0) continue
            if (stamp >= minDroppedStamp) continue
            if (nextWatermark === undefined || stamp > nextWatermark) nextWatermark = stamp
          }
        }
      }

      // Advance the watermark BEFORE returning so a consumer that drops an
      // EMITTED trigger doesn't see the same comment again on the next poll. (If
      // the consumer crashes before processing an emitted trigger, that comment
      // is lost — the documented at-most-once tradeoff; the cron watcher SHOULD
      // pass a durable store and accept it.) A row we never emitted (the hole)
      // is explicitly excluded from this advance above.
      if (nextWatermark !== undefined && nextWatermark > watermark) {
        if (
          !(await safeSaveWatermark(
            opts.watermarkStore,
            opts.watermarkKey,
            nextWatermark,
            opts.onError,
          ))
        )
          return []
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
    onError?.(`reactor.pr_comment.watermark.load failed (${key}): ${errMessage(error)}`)
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
    onError?.(`reactor.pr_comment.watermark.save failed (${key}): ${errMessage(error)}`)
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
