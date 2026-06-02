/**
 * Knob: `memory-mode` — ADR-0432 self-edit memory extras (per-thread mode,
 * line-level citations, budget-aware write-guard).
 *
 * Default-OFF. Folds three INDEPENDENT, default-OFF axes into the
 * `AgentConfig.memory` block; `buildToolingCore` (`tooling.ts`) then threads
 * them into `memoryTools(deps)` as `threadMode` / `lineCitations` /
 * `writeGuardMinRemainingPercent`. The write-guard's live `remainingPercent()`
 * is injected at the assembler from the `BudgetMeter` (ADR-0138) — this knob
 * only carries the static 0..100 THRESHOLD, never a meter (hexagonal boundary).
 *
 * Three envs, three axes (the knob's parsed value carries whichever axes
 * resolved; any unresolved axis is omitted ⇒ that field stays absent ⇒ that
 * axis is byte-identical legacy behaviour):
 *   - `QUANTA_MEMORY_MODE`            : enabled | disabled | read-only
 *   - `QUANTA_MEMORY_WRITE_GUARD_PCT` : 0..100 integer (write-guard threshold)
 *   - `QUANTA_MEMORY_LINE_CITATIONS`  : "1" ⇒ on (any other ⇒ off)
 *
 * The framework hands `parse` the SINGLE raw value of `envKey`
 * (`QUANTA_MEMORY_MODE`), so the knob surface covers the MODE axis; the guard +
 * citation axes resolve through the same exported helpers in the env-read
 * factory path (`resolveMemoryConfigFromEnv`) — one source of truth, no
 * divergence. Pure helpers live in `../memory-mode-parse` (no registry
 * side-effect, and OUTSIDE the per-knob slice-fence dir) so the factory
 * imports them without populating the registry or tripping the sibling fence.
 *
 * Domain (INACTIVE — `parse` returns `undefined`, knob falls through):
 *   - `QUANTA_MEMORY_MODE` absent / set to anything other than the three literals
 */

import type { AgentConfig } from "@/agent"
import { type MemoryModeValue, parseMemoryThreadMode } from "../memory-mode-parse"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

export {
  type MemoryModeValue,
  type MemoryThreadMode,
  parseMemoryLineCitations,
  parseMemoryThreadMode,
  parseMemoryWriteGuardPct,
  projectMemoryModeValue,
} from "../memory-mode-parse"

// Runtime knob — applies to the interactive / batch agent surfaces, NOT the
// SWE-bench matrix (memory mode is not a benchmark sweep axis; keeping it off
// `bench` leaves the curated `AXIS_ON_VALUES` sweep table closed).
const SURFACES: readonly Surface[] = ["cli", "agent-interactive", "agent-batch"]

const parseMemoryMode = (raw: string | undefined): MemoryModeValue | undefined => {
  const threadMode = parseMemoryThreadMode(raw)
  if (threadMode === undefined) return undefined
  return { threadMode }
}

const applyMemoryMode = (
  cfg: AgentConfig,
  value: MemoryModeValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  const prev = cfg.memory ?? {}
  return {
    ...cfg,
    memory: {
      ...prev,
      ...(value.threadMode !== undefined ? { threadMode: value.threadMode } : {}),
      ...(value.lineCitations !== undefined ? { lineCitations: value.lineCitations } : {}),
      ...(value.writeGuardMinRemainingPercent !== undefined
        ? { writeGuardMinRemainingPercent: value.writeGuardMinRemainingPercent }
        : {}),
    },
  }
}

export const memoryModeKnob: Knob<MemoryModeValue> = {
  id: "memory-mode",
  envKey: "QUANTA_MEMORY_MODE",
  category: "agent",
  surfaces: SURFACES,
  parse: parseMemoryMode,
  apply: applyMemoryMode,
  describe:
    "Self-edit memory mode (enabled|disabled|read-only) + line citations + budget write-guard",
  source: "ADR-0432 / Codex codex_memories_extension",
}

registerKnob(memoryModeKnob)
