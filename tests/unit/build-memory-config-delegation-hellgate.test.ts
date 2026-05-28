/**
 * ADR-0414 HELLGATE — CLI `buildMemoryConfig` is a THIN shim over the
 * factory's `resolveMemoryConfigFromEnv` (single source of truth).
 *
 * The structural defect this seals: the CLI surface used to re-read the
 * `QUANTA_MEMORY_*` tuning knobs (recallLimit / distill / consolidate /
 * selfEdit / recallTiers) into a verbatim copy of the factory's
 * `resolveMemoryConfig`. The ADR-0414 contract says memory assembly is
 * CENTRALIZED — so the env-read truth must live in exactly one place.
 *
 * Adversarial matrix (every assertion pins that the CLI shim's output is
 * BYTE-IDENTICAL to the factory helper for the SAME env + store, proving
 * the shim carries no independent env-read logic):
 *   - unset env + no store ⇒ undefined (key omitted)
 *   - store present + no knobs ⇒ truthy (possibly empty) block
 *   - recallLimit valid int / NaN / empty
 *   - distill / consolidate / selfEdit "off" literal (lowercase-only)
 *   - recallTiers comma list (parse + dedup)
 *   - combined knobs
 *   - QUANTA_MEMORY=off escape hatch (factory cascades, shim mirrors)
 *
 * Each case asserts `buildMemoryConfig(store)` deep-equals
 * `resolveMemoryConfigFromEnv(process.env, store)`. If a future edit
 * reintroduces a local env-read in the CLI shim that drifts from the
 * factory, this fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveMemoryConfigFromEnv } from "@/runner/assemble"
import { buildMemoryConfig, buildStore } from "../../src/apps/cli/internal"

/** Knobs this suite touches — saved + restored so it can never contaminate
 *  a sibling test (env-knob-branches.test.ts touches the same keys). */
const ENV_KEYS = [
  "QUANTA_MEMORY",
  "QUANTA_MEMORY_PATH",
  "QUANTA_MEMORY_RECALL_LIMIT",
  "QUANTA_MEMORY_RECALL_TIERS",
  "QUANTA_MEMORY_DISTILL",
  "QUANTA_MEMORY_CONSOLIDATE",
  "QUANTA_MEMORY_SELF_EDIT",
] as const

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** The invariant — for the current env, the CLI shim MUST equal the factory
 *  helper for both store states. Returns the shim output for extra spot
 *  asserts. */
const assertDelegated = (
  store: ReturnType<typeof buildStore>,
): ReturnType<typeof buildMemoryConfig> => {
  const fromShim = buildMemoryConfig(store)
  const fromFactory = resolveMemoryConfigFromEnv(process.env, store)
  expect(fromShim).toEqual(fromFactory)
  return fromShim
}

describe("buildMemoryConfig delegates to resolveMemoryConfigFromEnv (no copy-paste)", () => {
  test("unset env + no store → undefined (matches factory)", () => {
    expect(assertDelegated(undefined)).toBeUndefined()
  })

  test("store present + no knobs → truthy block (matches factory)", () => {
    process.env.QUANTA_MEMORY = "memory"
    const store = buildStore()
    expect(store).toBeDefined()
    expect(assertDelegated(store)).toBeDefined()
  })

  test("recallLimit valid int → carried, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "12"
    expect(assertDelegated(undefined)).toMatchObject({ recallLimit: 12 })
  })

  test("recallLimit NaN → omitted, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "not-a-number"
    expect(assertDelegated(undefined)?.recallLimit).toBeUndefined()
  })

  test("recallLimit empty string → omitted, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = ""
    expect(assertDelegated(undefined)?.recallLimit).toBeUndefined()
  })

  test("distill/consolidate/selfEdit 'off' (lowercase) → false trio, equals factory", () => {
    process.env.QUANTA_MEMORY_DISTILL = "off"
    process.env.QUANTA_MEMORY_CONSOLIDATE = "off"
    process.env.QUANTA_MEMORY_SELF_EDIT = "off"
    expect(assertDelegated(undefined)).toMatchObject({
      distill: false,
      consolidate: false,
      selfEditTools: false,
    })
  })

  test("distill 'OFF' (uppercase) → not opted out, equals factory", () => {
    process.env.QUANTA_MEMORY_DISTILL = "OFF"
    expect(assertDelegated(undefined)?.distill).toBeUndefined()
  })

  test("recallTiers comma list → parsed + dedup, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_TIERS = " Episodic , semantic , EPISODIC "
    expect(assertDelegated(undefined)).toMatchObject({ recallTiers: ["episodic", "semantic"] })
  })

  test("recallTiers all-invalid → omitted, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_TIERS = "rabbit,banana"
    expect(assertDelegated(undefined)?.recallTiers).toBeUndefined()
  })

  test("combined knobs → all carried, equals factory", () => {
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "7"
    process.env.QUANTA_MEMORY_DISTILL = "off"
    process.env.QUANTA_MEMORY_RECALL_TIERS = "semantic"
    expect(assertDelegated(undefined)).toMatchObject({
      recallLimit: 7,
      distill: false,
      recallTiers: ["semantic"],
    })
  })

  test("QUANTA_MEMORY=off + no knobs → undefined, equals factory (escape-hatch symmetry)", () => {
    process.env.QUANTA_MEMORY = "off"
    // store would be undefined under the escape hatch — pass it through.
    expect(assertDelegated(undefined)).toBeUndefined()
  })

  test("shim reads NO env independently — identical for store=undefined and a present store under same knobs", () => {
    // Under a sub-knob the factory returns a block for BOTH store states
    // (store only forces an empty block to stay truthy). Prove the shim
    // carries the same knob value regardless of which store it's handed.
    process.env.QUANTA_MEMORY = "memory"
    process.env.QUANTA_MEMORY_RECALL_LIMIT = "9"
    const store = buildStore()
    const withStore = assertDelegated(store)
    const withoutStore = assertDelegated(undefined)
    expect(withStore).toMatchObject({ recallLimit: 9 })
    expect(withoutStore).toMatchObject({ recallLimit: 9 })
  })
})
