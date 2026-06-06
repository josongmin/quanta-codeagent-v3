/**
 * Rate-limit notice surface (P27 — ratelimit snapshot render).
 *
 * Bridges the `ratelimit_snapshot` AgentEvent into the existing {@link StatusBar}
 * `transient` seam so a "한도 reached · resets 3h" notice is surfaced IN-PLACE on
 * the bottom status row — NOT as a stdout line (the line-oriented monitor ignores
 * the event; see `@/stream/adapters/stdout`). The recorder likewise skips it
 * (`@/stream/adapters/jsonl-recorder`) — this is a transient, non-accounting UI
 * signal, the same class as `output_progress`.
 *
 * Default-OFF byte-identical contract:
 *   - The notice is gated by `QUANTA_RATELIMIT_NOTICE`
 *     ({@link isRatelimitNoticeEnabled}). When unset / falsy the caller installs
 *     NO tee port, so the upstream emit path is byte-identical and the stdout
 *     adapter's EMPTY `ratelimit_snapshot` case stays the only observer.
 *   - Even when enabled, the notice fires ONLY on the snapshot's OWN reached
 *     signal — `proactiveDelayMs(snapshot) > 0` from the slice's
 *     `policy.ts` (the provider literally reporting a quota window with
 *     `remaining <= 0`). NO quanta-invented percent / threshold lives here.
 *
 * Slice-isolation: imports the pure parse/policy/notice from
 * `@/llm/ratelimit-snapshot` and the local `StatusBar` only. No `@/agent`.
 */

import { type RateLimitSnapshot, snapshotToNotice } from "@/llm/ratelimit-snapshot"
import { ratelimitNoticeWanted } from "@/shared"
import type { StreamPort } from "@/stream"
import type { StatusBar } from "./status-bar"

/** Truthy/falsy gate. P27 is DEFAULT-OFF, so — unlike the spinner — UNSET is
 *  also OFF: the operator must opt in. Delegates to the SHARED
 *  `ratelimitNoticeWanted` SSOT predicate (`@/shared`) so this CLI render gate
 *  and the core loop's snapshot-CAPTURE gate (`session-bootstrap`, which builds
 *  the snapshot store/header-hook when this is on even with proactive OFF) read
 *  ONE definition — `QUANTA_RATELIMIT_NOTICE` alone both captures AND renders. */
export const isRatelimitNoticeEnabled = (env: NodeJS.ProcessEnv): boolean =>
  ratelimitNoticeWanted(env.QUANTA_RATELIMIT_NOTICE)

/** Transient notice dwell time (ms). The status-bar auto-reverts to its
 *  default text after this window. 4 s is long enough to read a short notice
 *  without lingering over the live spinner. (Same magnitude class as the
 *  status-bar's own 2 s transient default — a documented UI dwell, not a
 *  policy threshold.) */
const NOTICE_TTL_MS = 4000

/** Reconstruct a {@link RateLimitSnapshot} from the wire event's numeric
 *  fields. The event mirrors the snapshot structurally (slice isolation —
 *  see `@/stream/types`), carrying only numbers + the type tag. A field absent
 *  on the wire stays absent on the snapshot (conditional spread) so a partial
 *  payload never fabricates a `0`. */
const eventToSnapshot = (e: {
  readonly requestsRemaining?: number
  readonly requestsResetMs?: number
  readonly tokensRemaining?: number
  readonly tokensResetMs?: number
  readonly observedAt: number
}): RateLimitSnapshot => ({
  ...(e.requestsRemaining !== undefined ? { requestsRemaining: e.requestsRemaining } : {}),
  ...(e.requestsResetMs !== undefined ? { requestsResetMs: e.requestsResetMs } : {}),
  ...(e.tokensRemaining !== undefined ? { tokensRemaining: e.tokensRemaining } : {}),
  ...(e.tokensResetMs !== undefined ? { tokensResetMs: e.tokensResetMs } : {}),
  observedAt: e.observedAt,
})

/** Humanize a relative reset delay (ms) into a compact `resets …` suffix.
 *  Uses ONLY the provider-reported, already-band-resolved `*ResetMs` value
 *  the slice parsed — no clock read here. A non-finite / negative input is
 *  dropped (returns ""), so a junk reset never paints. */
const formatReset = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ""
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return ` · resets ${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return ` · resets ${totalMin}m`
  const hours = Math.round(totalMin / 60)
  return ` · resets ${hours}h`
}

/** The empty-window predicate — the EXACT `remaining <= 0` check `policy.ts`
 *  derives its proactive backoff from. This is the provider literally telling us
 *  a quota window is OUT; it is the slice's already-computed "reached" signal,
 *  NOT a quanta-invented percent. A snapshot reaches the surface ONLY when this
 *  reports at least one empty window. */
interface EmptyWindows {
  readonly tokensEmpty: boolean
  readonly requestsEmpty: boolean
  readonly any: boolean
}
const emptyWindows = (s: RateLimitSnapshot): EmptyWindows => {
  const tokensEmpty = s.tokensRemaining !== undefined && s.tokensRemaining <= 0
  const requestsEmpty = s.requestsRemaining !== undefined && s.requestsRemaining <= 0
  return { tokensEmpty, requestsEmpty, any: tokensEmpty || requestsEmpty }
}

/** Build the notice line for a snapshot the provider reports empty. The reset
 *  suffix uses the TIGHTEST empty-window reset — the same `min`-of-empty-windows
 *  the policy already binds on (a window with headroom is not the binding cap,
 *  so its reset is ignored). */
const renderReachedNotice = (s: RateLimitSnapshot, empty: EmptyWindows): string => {
  const notice = snapshotToNotice(s)
  let resetMs: number | undefined
  if (empty.tokensEmpty && notice.tokensResetMs !== undefined) resetMs = notice.tokensResetMs
  if (empty.requestsEmpty && notice.requestsResetMs !== undefined) {
    resetMs =
      resetMs === undefined ? notice.requestsResetMs : Math.min(resetMs, notice.requestsResetMs)
  }
  const what =
    empty.tokensEmpty && empty.requestsEmpty
      ? "한도 reached"
      : empty.tokensEmpty
        ? "토큰 한도"
        : "요청 한도"
  return `⚠ ${what}${formatReset(resetMs)}`
}

/**
 * Build a {@link StreamPort} that paints a transient rate-limit notice.
 *
 * Sips ONLY `ratelimit_snapshot` events; everything else is a no-op (this is a
 * UX surface, not a recorder). The "surface?" decision is delegated ENTIRELY to
 * the slice's already-computed reached signal — the empty-window predicate
 * (`remaining <= 0`) that `policy.ts::proactiveDelayMs` derives its backoff from.
 * A malformed snapshot (NaN / negative / missing) was already graceful-skipped
 * to `undefined`-fields by the slice parser, so {@link emptyWindows} reports no
 * empty window and nothing paints. All render work is wrapped in try/catch so a
 * faulty / throwing `statusBar.transient` can never poison the tee'd recorder
 * path (tee isolation hellgate).
 */
export const buildRatelimitNoticePort = (
  statusBar: StatusBar,
  ttlMs = NOTICE_TTL_MS,
): StreamPort => ({
  emit: (event): void => {
    if (event.type !== "ratelimit_snapshot") return
    try {
      const snapshot = eventToSnapshot(event)
      const empty = emptyWindows(snapshot)
      // THE gate: surface ONLY when the provider itself reports a window out
      // (`remaining <= 0`) — the same reached signal B3's reactive backoff and
      // `policy.ts`'s proactive backoff both honor. NOT a new percent.
      if (!empty.any) return
      statusBar.transient(renderReachedNotice(snapshot, empty), ttlMs)
    } catch {
      // Intentional: a render failure must not surface as an emit error (a
      // tee'd recorder would otherwise track it as a degraded record).
    }
  },
})
