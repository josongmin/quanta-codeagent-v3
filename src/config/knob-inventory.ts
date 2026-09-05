/**
 * `@/config/knob-inventory.ts` — daemon/agent-side knob DECLARATION registry
 * (ADR-0503 P1, the non-CLI counterpart to `apps/cli/cli-knobs.ts`).
 *
 * These `QUANTA_*` knobs are read DIRECTLY (gateOn/env) at the composition root
 * (`@/host`), the assemble layer (`@/runner`), the daemon (`apps/web-daemon`),
 * observability, and the LLM factory — bypassing the typed `runtime-config`
 * struct. This file DECLARES them (envKey + kind + default + home) so they are
 * (a) non-orphan to the completeness ratchet (ADR-0503), (b) discoverable in
 * `--help` / `/knobs`. It is DECLARATION-ONLY: it does NOT change runtime
 * behavior — each knob is still read at its existing site. The `home` field
 * records where the knob's TYPED field ultimately belongs (read-routing = P4):
 *   - "runtime-config" : daemon/host VALUE or composition-root gate (the bulk)
 *   - "runner-knobs"   : would become an AgentConfig-mutating `@/runner/knobs` Knob
 *   - "bench"          : bench-only (resolveBenchKnobs surface)
 *
 * Slice note: PURE DATA — no imports, no env reads, zero work at import. Lives
 * in `@/config` (config slice; node:path + local only — no upward imports).
 *
 * Secrets are DELIBERATELY ABSENT (QUANTA_WEB_AUTH_TOKEN, QUANTA_LANCE_API_KEY,
 * QUANTA_QDRANT_API_KEY, QUANTA_CHATGPT_AUTH_SOURCE) — credentials are owned by
 * `@/auth` / the keyring, never the knob registry (see ratchet EXCEPTIONS).
 */

import { BENCH } from "./knob-inventory/bench"
import { CONST_KEYED } from "./knob-inventory/const-keyed"
import { DAEMON } from "./knob-inventory/daemon"
import { EXTRA } from "./knob-inventory/extra"
import { HOST } from "./knob-inventory/host"
import { RUNNER } from "./knob-inventory/runner"
import type { KnobDeclaration, KnobInventoryEntry, KnobReadAuthority } from "./knob-inventory/types"

export type {
  InventoryKind,
  KnobHome,
  KnobInventoryEntry,
  KnobReadAuthority,
} from "./knob-inventory/types"

const STARTUP_SEED = new Set<string>(["QUANTA_GOAL"])
const COMPOSITION_GATE = new Set<string>([
  "QUANTA_SPINNER_STALL",
  "QUANTA_BG_TURN",
  "QUANTA_WORKTREE_TOOL",
  "QUANTA_BROWSER_TOOL",
])

export const classifyKnobReadAuthority = (entry: KnobDeclaration): KnobReadAuthority => {
  if (STARTUP_SEED.has(entry.envKey)) return "startup-seed"
  if (COMPOSITION_GATE.has(entry.envKey)) return "composition-gate"
  if (entry.home === "bench") return "bench"
  if (entry.home === "runner-knobs") return "runner-knob"
  return "runtime-config"
}

export const withReadAuthority = (entry: KnobDeclaration): KnobInventoryEntry => ({
  ...entry,
  readAuthority: classifyKnobReadAuthority(entry),
})

export const KNOB_INVENTORY: readonly KnobInventoryEntry[] = [
  ...HOST,
  ...RUNNER,
  ...DAEMON,
  ...BENCH,
  ...EXTRA,
  ...CONST_KEYED,
].map(withReadAuthority)

export const allInventoryKnobs = (): readonly KnobInventoryEntry[] => KNOB_INVENTORY
export const inventoryKnob = (envKey: string): KnobInventoryEntry | undefined =>
  KNOB_INVENTORY.find((k) => k.envKey === envKey)
