/**
 * Pillar A — DERIVE the inventory entry (and the default-OFF proof) from a
 * knob's single {@link AnyKnobSchema} (the SSOT).
 *
 * This is the LEAF-CLEAN half of the derive split: it depends ONLY on the
 * config-side schema spine (`./contracts`) and the inventory entry shape
 * (`@/config/knob-inventory/types`) — NO `@/runner`, NO `@/agent`. That is what
 * lets `src/config/knob-inventory/bench.ts` be
 * `ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)` without a config→runner
 * back-edge (fence violation). The registry-`Knob` derive (`deriveKnob`), which
 * needs the runner `AgentConfig`/`Knob` types, stays in
 * `@/runner/batch/eval/kernel/derive`.
 *
 * Pure functions, zero side effects, no `registerKnob`, no env/fs reads.
 *
 * @see ./contracts — the `KnobSchema` spine.
 * @see ./schemas — the authored bench `KnobSchema[]`.
 * @see @/config/knob-inventory/types — the inventory entry shape we reproduce.
 */

import type { KnobInventoryEntry } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "./contracts"

/**
 * `true` iff the knob is OFF by default — derived from `schema.default` being
 * falsy/undefined, NOT a hand-maintained allow-list. This is the default-OFF
 * proof a ratchet can read: a feature whose default is `undefined`/`false`/`0`/
 * `""` is byte-identical to the baseline when unset.
 *
 * NB: this treats `0` and `""` as OFF. Every bench knob whose "active" domain
 * excludes `0`/`""` (the integer knobs reject `<1`, the string knobs reject
 * empty) is therefore default-OFF, matching the existing inventory defaults
 * (`undefined`/`false`).
 */
export const isDefaultOff = (schema: AnyKnobSchema): boolean => {
  const d = schema.default
  return d === undefined || d === false || d === 0 || d === ""
}

/**
 * Derive the inventory `home` from the schema's surfaces. A knob that applies
 * ONLY to the bench surface lives under the `bench` home; a knob that also
 * applies to cli/agent surfaces is a runner-knobs feature surfaced to bench.
 * This mirrors the existing bench.ts split (pure-bench ⇒ `"bench"`; repo-map /
 * hooks / working-state / closeout / multi-voter ⇒ `"runner-knobs"`).
 */
export const deriveHome = (schema: AnyKnobSchema): KnobInventoryEntry["home"] => {
  // Escape hatch: a few cross-surface knobs are filed under `bench` in the
  // current inventory; pin that byte-identically when declared.
  if (schema.inventoryHome !== undefined) return schema.inventoryHome as KnobInventoryEntry["home"]
  const onlyBench = schema.surfaces.length === 1 && schema.surfaces[0] === "bench"
  return onlyBench ? "bench" : "runner-knobs"
}

/**
 * Derive the inventory `default` cell from a schema. The inventory uses a
 * KIND-LEVEL off convention that the typed `KnobSchema.default` cannot always
 * express: a `bool` knob whose value type is a richer object (e.g. repo-map's
 * `{ enabled: true }`) has NO falsy `T`, so its schema default is `undefined`,
 * but the inventory records `false`. Rule (matches bench.ts):
 *   - `bool` kind ⇒ the off-default is `false` (undefined/false ⇒ false);
 *   - `int`/`string`/`enum` kind ⇒ the schema default passes through verbatim.
 */
export const deriveInventoryDefault = (schema: AnyKnobSchema): KnobInventoryEntry["default"] => {
  // Escape hatch: when the inventory's literal default cell can't be inferred from
  // the kind convention (a `bool` recorded as `undefined`, not `false`), the
  // schema pins it explicitly. `"inventoryDefault" in schema` distinguishes an
  // intentional `undefined` override from an unset field.
  if ("inventoryDefault" in schema) {
    return schema.inventoryDefault as KnobInventoryEntry["default"]
  }
  if (schema.kind === "bool") {
    return schema.default === undefined ? false : (schema.default as boolean)
  }
  // int / float / enum / string pass through verbatim.
  return schema.default as KnobInventoryEntry["default"]
}

/**
 * Derive a {@link KnobInventoryEntry} from a {@link AnyKnobSchema}. Produces the
 * EXACT shape the per-home inventory sub-registries hold, so the derived value
 * can be proven deep-equal to the current hand-written entry (parity test).
 *
 * Field mapping:
 *   - `envKey`     ← schema.envKey (typed `QUANTA_${string}` by the entry shape)
 *   - `kind`       ← schema.kind (1:1; `KnobKind` includes `"float"` — see bench-gap-3.ts)
 *   - `default`    ← derived (see {@link deriveInventoryDefault})
 *   - `group`      ← `"bench"` (these are bench-domain schemas)
 *   - `home`       ← derived from surfaces (see {@link deriveHome})
 *   - `describe`   ← schema.describe (the inventory describe IS the SSOT describe)
 *   - `readSite`   ← schema.readSite
 */
export const deriveInventoryEntry = (schema: AnyKnobSchema): KnobInventoryEntry => ({
  envKey: schema.envKey as KnobInventoryEntry["envKey"],
  kind: schema.kind,
  default: deriveInventoryDefault(schema),
  group: "bench",
  home: deriveHome(schema),
  describe: schema.describe,
  readSite: schema.readSite,
})
