/**
 * ADR-0281 + ADR-0413 + ADR-0556 — env → memory-auto slot projection helper.
 *
 * Co-located WITH the slice (rather than in `@/apps/agent`) so the
 * commit landing the slice is self-contained: the hellgate's
 * HELL-MAT-19 + HELL-MAT-22 cases can lock the env wire without
 * depending on the unified-agent surface being in the same commit.
 *
 * The composition root in `src/apps/agent/index.ts` re-exports this
 * helper (or calls it directly) — either route is byte-identical
 * because the function is pure of `process.env`.
 *
 * Reads ONE env knob:
 *
 *   - `QUANTA_MEMORY_AUTO`        — default ON (ADR-0413). Falsey set
 *                                   `0 / off / no / false` (case-insensitive,
 *                                   trim) ⇒ disabled (returns `null`).
 *                                   Any other value (incl. absent / "on" /
 *                                   "1" / "true") ⇒ enabled.
 *
 * ADR-0556 removed the two promotion knobs (`QUANTA_MEMORY_` threshold /
 * min-usage): the promotion gate they tuned fed a session-start injector that
 * selected nothing in practice, and the gate itself is gone from the
 * session-end consolidator. The returned `policy` is the constant
 * {@link DEFAULT_TRIGGER_POLICY} (kept only for `memory-factory.ts`, see
 * `./types.ts`).
 *
 * Default-ON (ADR-0413): a fresh install with no env knobs gets session-end
 * distillation + Phase-2 consolidation automatically. The legacy default-OFF
 * behavior is reachable via `QUANTA_MEMORY_AUTO=off`. The function is PURE
 * w.r.t. its input env view; no `process.env` reads.
 */

import { parseEnvFlag } from "@/shared"
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from "./types"

/** Return shape of {@link assembleMemoryAuto}. `null` ⇒ disabled. */
export interface MemoryAutoSlot {
  readonly enabled: true
  /** Constant since ADR-0556 — see `./types.ts`. */
  readonly policy: TriggerPolicy
}

/** Project an env view to a `MemoryAutoSlot` or `null`. ADR-0413: default ON. */
export const assembleMemoryAuto = (
  env: Readonly<Record<string, string | undefined>>,
): MemoryAutoSlot | null => {
  if (!parseEnvFlag(env.QUANTA_MEMORY_AUTO, /* defaultOn */ true)) return null
  return { enabled: true, policy: DEFAULT_TRIGGER_POLICY }
}
