/**
 * H16 — runtime-config → `DreamPolicy` projection helper.
 *
 * Co-located WITH the slice (mirrors `auto-trigger/wire.ts`) so the slice
 * commit is self-contained: the hellgate can lock the config wire without
 * the unified-agent surface being present.
 *
 * Reads the three resolved auto-dream knobs (already validated by
 * `@/shared/runtime-config`) and produces a `DreamSlot` or `null`:
 *
 *   - `autoDream` (`QUANTA_AUTO_DREAM`)        — gate; false ⇒ `null` (OFF).
 *   - `autoDreamSessions` (`QUANTA_AUTO_DREAM_SESSIONS`) — default 5.
 *   - `autoDreamHours` (`QUANTA_AUTO_DREAM_HOURS`)       — default 24.
 *
 * Default-OFF: `null` when the gate is off. The composition root constructs
 * `CrossSessionDreamTrigger` with `slot.policy` ONLY when this returns a slot.
 * Pure — no `process.env`, no clock, no I/O.
 */

import { DEFAULT_DREAM_POLICY, type DreamPolicy } from "./types"

/** The three already-validated auto-dream config values. `undefined` for a
 *  threshold ⇒ use the documented default. */
export interface DreamConfigView {
  readonly autoDream: boolean
  readonly autoDreamSessions: number | undefined
  readonly autoDreamHours: number | undefined
}

/** Return shape of {@link assembleDreamPolicy}. `null` ⇒ disabled. */
export interface DreamSlot {
  readonly enabled: true
  readonly policy: DreamPolicy
}

/** Project the resolved config view to a `DreamSlot` or `null`. Default-OFF. */
export const assembleDreamPolicy = (cfg: DreamConfigView): DreamSlot | null => {
  if (!cfg.autoDream) return null
  return {
    enabled: true,
    policy: {
      sessionsThreshold: cfg.autoDreamSessions ?? DEFAULT_DREAM_POLICY.sessionsThreshold,
      hoursThreshold: cfg.autoDreamHours ?? DEFAULT_DREAM_POLICY.hoursThreshold,
    },
  }
}
