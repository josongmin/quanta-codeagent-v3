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
import type { KnobInventoryEntry } from "./knob-inventory/types"

// Contract types + per-home knob entries moved to ./knob-inventory/ (god-module
// split). Re-export the contract so importers of @/config/knob-inventory stay
// byte-compatible.
export type { InventoryKind, KnobHome, KnobInventoryEntry } from "./knob-inventory/types"

/** Full knob inventory — per-home sub-registries concatenated in declaration
 *  order (identical to the prior single array). */
export const KNOB_INVENTORY: readonly KnobInventoryEntry[] = [
  ...HOST,
  ...RUNNER,
  ...DAEMON,
  ...BENCH,
  ...EXTRA,
  ...CONST_KEYED,
]

export const allInventoryKnobs = (): readonly KnobInventoryEntry[] => KNOB_INVENTORY
export const inventoryKnob = (envKey: string): KnobInventoryEntry | undefined =>
  KNOB_INVENTORY.find((k) => k.envKey === envKey)
