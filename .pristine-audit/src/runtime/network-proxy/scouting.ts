/**
 * jun-6 exfil-rail (c) — exfil-SCOUTING sequence detector (pure, RFC §4.3).
 *
 * WHAT: a read-only aggregate over the proxy's EXISTING append-only
 *       {@link DecisionLogEntry} log (`LoopbackEgressProxy.decisionLog()`). It
 *       counts DISTINCT non-allowlisted hosts that were DENIED and, when that
 *       count reaches a CONFIGURABLE threshold K, emits an advisory
 *       {@link ScoutingSignal} — the deterministic "Exfil Scouting" rail behind
 *       the verbatim classifier taxonomy line.
 *
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.3 + §7 (false-positive disc.).
 * SLICES IMPORTED: `./types` (the existing log entry shape) only — pure, no I/O.
 *
 * NO new interception: the proxy already records every deny (`record()`), and
 * `isHostAllowed` already defines "not in Environment". This is a pure
 * aggregate over that log — it never opens a socket.
 *
 * FALSE-POSITIVE DISCIPLINE (RFC §7 (c) — load-bearing):
 *   - K is a REQUIRED knob (`{ threshold }`) — there is NO hardcoded default
 *     (no-heuristics rule: K must be calibrated, not guessed). A caller that
 *     passes a non-positive / non-integer K gets `null` (inert), never a guess.
 *   - The signal is ADVISORY ONLY (a `classification` hint), never a hard
 *     auto-deny — the user's natural fix (allowlist the host) clears it.
 *   - We count DISTINCT hosts, so K denials of the SAME host (a retry loop, a
 *     flaky single endpoint) NEVER trips it; only a fan-out across ≥ K distinct
 *     unlisted endpoints — the actual scouting shape — does.
 *
 * DEFAULT-OFF: `detectScouting` is only CALLED when `QUANTA_EXFIL_SCOUTING=1`
 * (the `exfilScoutingEnabled` gate). When unset the function is never invoked
 * and the taxonomy prose line is omitted from the assembled classifier prompt,
 * so prompt bytes + behavior are identical.
 */

import type { DecisionLogEntry } from "./types"

/** The advisory exfil-scouting signal. `distinctDeniedHosts` is the count that
 *  met/exceeded the threshold; `sample` is a STABLE (first-seen order),
 *  de-duplicated list of the denied hosts for the surfaced warning. */
export interface ScoutingSignal {
  readonly kind: "exfil-scouting"
  readonly distinctDeniedHosts: number
  readonly sample: readonly string[]
}

/** Options. `threshold` (K) is REQUIRED — no default (see module header). */
export interface DetectScoutingOpts {
  /** K — the number of DISTINCT denied non-allowlisted hosts that trips the
   *  advisory signal. MUST be a positive integer (a configurable knob); any
   *  other value ⇒ the detector is inert (`null`). */
  readonly threshold: number
  /** Optional cap on the `sample` array length so a long probe burst does not
   *  produce an unbounded warning string. A non-positive / absent value ⇒ the
   *  full distinct set is sampled. */
  readonly sampleCap?: number
}

/**
 * Detect an exfil-scouting probe SEQUENCE in `log`.
 *
 * Returns a {@link ScoutingSignal} IFF the log contains at least `threshold`
 * DISTINCT hosts whose decision is `deny` (the proxy's terminal verdict for a
 * host that is neither on the base allowlist nor amended). Otherwise `null`.
 *
 * Pure + total: never throws, never reads a clock, never mutates the input.
 */
export const detectScouting = (
  log: readonly DecisionLogEntry[],
  opts: DetectScoutingOpts,
): ScoutingSignal | null => {
  const k = opts.threshold
  // No-heuristics: a non-positive / non-integer K is treated as "no detector"
  // (inert) rather than silently coerced to a guessed value.
  if (!Number.isInteger(k) || k <= 0) return null

  // Distinct denied hosts, first-seen order preserved (Set iteration order is
  // insertion order — deterministic for the stable `sample`).
  const denied = new Set<string>()
  for (const entry of log) {
    if (entry.decision === "deny") denied.add(entry.host)
  }

  if (denied.size < k) return null

  const all = Array.from(denied)
  const cap = opts.sampleCap
  const sample =
    typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? all.slice(0, cap) : all

  return Object.freeze({
    kind: "exfil-scouting" as const,
    distinctDeniedHosts: denied.size,
    sample: Object.freeze(sample),
  })
}
