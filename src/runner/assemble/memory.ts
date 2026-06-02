import type { AgentConfig } from "@/agent"
import type { PersistentStorePort } from "@/memory"

/**
 * Surface-agnostic memory-config assembly. No env reads — caller passes the
 * resolved knobs as plain typed fields. Every conditional spread is preserved
 * verbatim from the prior `internal.ts` block so the assembled `memory` shape
 * is byte-identical (respecting `exactOptionalPropertyTypes`).
 */

/** Parse a raw `QUANTA_MEMORY_RECALL_TIERS`-style string ("episodic,semantic")
 *  → dedup'd valid tiers, or `undefined`. Pure (no env access). */
export const parseRecallTiers = (
  raw: string | undefined,
): ("episodic" | "semantic")[] | undefined => {
  if (raw === undefined) return undefined
  const seen = new Set<"episodic" | "semantic">()
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase()
    if (t === "episodic" || t === "semantic") seen.add(t)
  }
  return seen.size > 0 ? [...seen] : undefined
}

/** Inputs to {@link buildMemoryConfigCore}. Each field mirrors a prior env
 *  knob exactly (`undefined` = unset = "use built-in default"). The CLI shim
 *  parses `process.env.*` into these fields; Web/Tauri surfaces map their
 *  own settings. */
export interface MemoryConfigAssembleInput {
  store: PersistentStorePort | undefined
  /** `QUANTA_MEMORY_RECALL_LIMIT` parsed → finite integer; non-finite skipped. */
  recallLimit?: number | undefined
  /** `QUANTA_MEMORY_DISTILL === "off"` → false; any other value omits the key. */
  distill?: boolean | undefined
  /** `QUANTA_MEMORY_CONSOLIDATE === "off"` → false. */
  consolidate?: boolean | undefined
  /** `QUANTA_MEMORY_SELF_EDIT === "off"` → false. */
  selfEditTools?: boolean | undefined
  /** Pre-parsed list from {@link parseRecallTiers}. */
  recallTiers?: ("episodic" | "semantic")[] | undefined
  /** ADR-0432 — pre-parsed `QUANTA_MEMORY_MODE` (enabled|disabled|read-only). */
  threadMode?: "enabled" | "disabled" | "read-only" | undefined
  /** ADR-0432 — pre-parsed `QUANTA_MEMORY_LINE_CITATIONS` (true iff "1"). */
  lineCitations?: boolean | undefined
  /** ADR-0432 — pre-parsed `QUANTA_MEMORY_WRITE_GUARD_PCT` (integer 0..100). */
  writeGuardMinRemainingPercent?: number | undefined
}

/**
 * Build the `memory` tuning block. Returns `undefined` when there is no store
 * AND no flag set, so the config key is omitted entirely and current behavior
 * is preserved exactly.
 */
export const buildMemoryConfigCore = (
  input: MemoryConfigAssembleInput,
): AgentConfig["memory"] | undefined => {
  const block = {
    ...(input.recallLimit !== undefined && Number.isFinite(input.recallLimit)
      ? { recallLimit: input.recallLimit }
      : {}),
    ...(input.distill === false ? { distill: false } : {}),
    ...(input.consolidate === false ? { consolidate: false } : {}),
    ...(input.selfEditTools === false ? { selfEditTools: false } : {}),
    ...(input.recallTiers ? { recallTiers: input.recallTiers } : {}),
    // ADR-0432 default-OFF extras: each key is omitted unless explicitly set,
    // so absent envs ⇒ byte-identical block (no behaviour change).
    ...(input.threadMode !== undefined ? { threadMode: input.threadMode } : {}),
    ...(input.lineCitations !== undefined ? { lineCitations: input.lineCitations } : {}),
    ...(input.writeGuardMinRemainingPercent !== undefined
      ? { writeGuardMinRemainingPercent: input.writeGuardMinRemainingPercent }
      : {}),
  }
  if (!input.store && Object.keys(block).length === 0) return undefined
  return block
}
