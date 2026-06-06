/**
 * Stale-read-guard — the DEFAULT-OFF gate (ADR-0474).
 *
 * WHAT: a single pure predicate over an injected env record. `true` ⇒ the guard
 * is opted in for this deployment; the host consults this BEFORE recording read
 * mtimes, before the write-time check, and before the post-bash detector. When
 * the flag is unset the host does none of that ⇒ byte-identical to today.
 *
 * ADR: ADR-0474.
 * Slices imported: NONE.
 * NO-THROW: returns a boolean, never throws. Reads the INJECTED env record only
 * (never `process.env` directly) — mirrors `awaySummaryEnabled` (ADR-0465).
 */

import { gateOnStrict } from "@/shared"

/** The env var that opts a deployment into the stale-read guard. Value MUST be
 *  exactly `"1"`; any other value (incl. `"0"` / `"on"` / `"true"` / unset)
 *  keeps the guard OFF. */
export const STALE_READ_GUARD_ENV = "QUANTA_STALE_READ_GUARD"

/** Pure gate check via the canonical strict SSOT (`@/shared#gateOnStrict`) — only
 *  the exact `"1"` enables; `"0"`/`"true"`/`"on"` keep it OFF. */
export const staleReadGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  gateOnStrict(env, STALE_READ_GUARD_ENV)
