/**
 * Bench knob inventory — DERIVED, not hand-maintained.
 *
 * The `BENCH` array is `ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)`: each entry
 * is generated from the ONE authored `KnobSchema` for that knob (the SSOT in
 * `@/config/knob-schema/schemas`), so a new bench knob is declared exactly once
 * (as a schema) and the inventory follows automatically — no parallel literal to
 * drift. Both the schemas and the leaf-clean `deriveInventoryEntry` live under
 * `@/config/knob-schema`, a config-side LEAF (no `@/runner` import), so this
 * stays a forward `config → config` edge (no fence violation).
 *
 * ORDER: follows `ALL_BENCH_SCHEMAS` (envKey order), proven byte-identical to the
 * pre-derive hand-written literal by the derive-parity suite.
 */

import type { KnobInventoryEntry } from "./types"
import { deriveInventoryEntry } from "@/config/knob-schema/derive-inventory"
import { ALL_BENCH_SCHEMAS } from "@/config/knob-schema/schemas"

export const BENCH: readonly KnobInventoryEntry[] = ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)
