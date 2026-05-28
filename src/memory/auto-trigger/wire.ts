/**
 * ADR-0281 + ADR-0282 + ADR-0413 — env → `TriggerPolicy` projection helper.
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
 * Reads three env knobs and produces a small typed config object the
 * host plugs into its session-start / session-end hooks:
 *
 *   - `QUANTA_MEMORY_AUTO`        — default ON (ADR-0413). Falsey set
 *                                   `0 / off / no / false` (case-insensitive,
 *                                   trim) ⇒ disabled (returns `null`).
 *                                   Any other value (incl. absent / "on" /
 *                                   "1" / "true") ⇒ enabled.
 *   - `QUANTA_MEMORY_THRESHOLD`   — promote threshold (default 0.7).
 *                                   Invalid number ⇒ default.
 *   - `QUANTA_MEMORY_MIN_USAGE`   — minimum usageCount gate (default 1).
 *                                   Invalid int OR negative ⇒ default.
 *
 * Default-ON (ADR-0413): a fresh install with no env knobs gets cross-
 * session memory automatically. The legacy default-OFF behavior is
 * reachable via `QUANTA_MEMORY_AUTO=off`. The function is PURE w.r.t.
 * its input env view; no `process.env` reads.
 *
 * The return shape carries the resolved `TriggerPolicy` only — the
 * host wires the concrete `MemoryAutoTrigger` / `CrossSessionInjector`
 * because those need a `Phase1Port` (LLM seam) + stage1 stores the
 * surface owns.
 */

import { parseEnvFlag } from "@/runner/assemble/env-flag"
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from "./types"

/** Return shape of {@link assembleMemoryAuto}. `null` ⇒ disabled. */
export interface MemoryAutoSlot {
  readonly enabled: true
  readonly policy: TriggerPolicy
}

/** Project an env view to a `MemoryAutoSlot` or `null`. ADR-0413: default ON. */
export const assembleMemoryAuto = (
  env: Readonly<Record<string, string | undefined>>,
): MemoryAutoSlot | null => {
  if (!parseEnvFlag(env.QUANTA_MEMORY_AUTO, /* defaultOn */ true)) return null
  const rawT = env.QUANTA_MEMORY_THRESHOLD
  const rawU = env.QUANTA_MEMORY_MIN_USAGE
  const parsedT = rawT === undefined ? DEFAULT_TRIGGER_POLICY.promoteThreshold : Number(rawT)
  const parsedU = rawU === undefined ? DEFAULT_TRIGGER_POLICY.minUsageCount : Number(rawU)
  const promoteThreshold = Number.isFinite(parsedT)
    ? parsedT
    : DEFAULT_TRIGGER_POLICY.promoteThreshold
  const minUsageCount =
    Number.isFinite(parsedU) && parsedU >= 0
      ? Math.floor(parsedU)
      : DEFAULT_TRIGGER_POLICY.minUsageCount
  return {
    enabled: true,
    policy: { promoteThreshold, minUsageCount },
  }
}
