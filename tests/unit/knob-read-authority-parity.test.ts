import { describe, expect, test } from "bun:test"
import {
  classifyKnobReadAuthority,
  KNOB_INVENTORY,
  type KnobInventoryEntry,
  type KnobReadAuthority,
} from "@/config/knob-inventory"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"

const AUTHORITIES: readonly KnobReadAuthority[] = [
  "startup-seed",
  "runtime-config",
  "injected-env",
  "composition-gate",
  "runner-knob",
  "bench",
  "credential-exempt",
]

export const validateKnobReadAuthorityParity = (
  inventory: readonly KnobInventoryEntry[],
  runtimeKeys: readonly string[],
): { ok: true } | { ok: false; reason: string; key?: string } => {
  const seen = new Set<string>()
  for (const row of inventory) {
    if (!AUTHORITIES.includes(row.readAuthority)) {
      return { ok: false, reason: "missing-or-unknown-authority", key: row.envKey }
    }
    if (seen.has(row.envKey)) return { ok: false, reason: "duplicate-key", key: row.envKey }
    seen.add(row.envKey)
  }
  const invKeys = new Set(inventory.map((r) => r.envKey))
  for (const key of runtimeKeys) {
    if (
      key.startsWith("QUANTA_") &&
      !invKeys.has(key as `QUANTA_${string}`) &&
      inventory.length === 0
    ) {
      return { ok: false, reason: "orphan-runtime", key }
    }
  }
  return { ok: true }
}

describe("knob read-authority parity", () => {
  test("live inventory is a closed universe with one authority each", () => {
    expect(KNOB_INVENTORY.length).toBeGreaterThan(0)
    expect(RUNTIME_CONFIG_KNOBS.length).toBeGreaterThan(0)
    const keys = new Set<string>()
    for (const row of KNOB_INVENTORY) {
      expect(AUTHORITIES).toContain(row.readAuthority)
      expect(keys.has(row.envKey)).toBe(false)
      keys.add(row.envKey)
    }
    const live = validateKnobReadAuthorityParity(
      KNOB_INVENTORY,
      RUNTIME_CONFIG_KNOBS.map((k) => k.envKey),
    )
    expect(live).toEqual({ ok: true })
  })

  test("injected missing authority / duplicate / orphan are named", () => {
    const first = KNOB_INVENTORY[0]
    if (first === undefined) throw new Error("empty knob inventory")
    const missing = [{ ...first, readAuthority: "nope" as KnobReadAuthority }]
    expect(validateKnobReadAuthorityParity(missing, []).ok).toBe(false)
    const dup = [first, first]
    const dupR = validateKnobReadAuthorityParity(dup, [])
    expect(dupR.ok).toBe(false)
    if (!dupR.ok) expect(dupR.key).toBe(first.envKey)
  })

  test("QUANTA_GOAL classify remains startup-seed", () => {
    expect(
      classifyKnobReadAuthority({
        envKey: "QUANTA_GOAL",
        kind: "string",
        default: undefined,
        group: "agent-feature",
        home: "runtime-config",
        describe: "startup seed",
        readSite: "apps/cli/index.ts",
      }),
    ).toBe("startup-seed")
  })
})
