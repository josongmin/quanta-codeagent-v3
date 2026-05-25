/**
 * ADR-0281 + ADR-0282 — env → `TriggerPolicy` projection helper.
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
 *   - `QUANTA_MEMORY_AUTO`        — "on" enables the slice; any other
 *                                   value (incl. absent / "1" / "true")
 *                                   ⇒ disabled (returns `null`).
 *   - `QUANTA_MEMORY_THRESHOLD`   — promote threshold (default 0.7).
 *                                   Invalid number ⇒ default.
 *   - `QUANTA_MEMORY_MIN_USAGE`   — minimum usageCount gate (default 1).
 *                                   Invalid int OR negative ⇒ default.
 *
 * Default-OFF: when `QUANTA_MEMORY_AUTO !== "on"`, returns `null`
 * (slot omitted at host plug site ⇒ byte-identical legacy). The
 * function is PURE w.r.t. its input env view; no `process.env` reads.
 *
 * The return shape carries the resolved `TriggerPolicy` only — the
 * host wires the concrete `MemoryAutoTrigger` / `CrossSessionInjector`
 * because those need a `Phase1Port` (LLM seam) + stage1 stores the
 * surface owns.
 */

import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from "./types"

/** Return shape of {@link assembleMemoryAuto}. `null` ⇒ disabled. */
export interface MemoryAutoSlot {
  readonly enabled: true
  readonly policy: TriggerPolicy
}

/** Project an env view to a `MemoryAutoSlot` or `null` (default-OFF). */
export const assembleMemoryAuto = (
  env: Readonly<Record<string, string | undefined>>,
): MemoryAutoSlot | null => {
  if (env.QUANTA_MEMORY_AUTO !== "on") return null
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
