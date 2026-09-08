/**
 * G-F5 composition-root rail — `box up` / `pool` must call
 * `withResolvedFamilyBootstrap(`, and fresh family setup must refuse a declaring
 * family with no payload. Call/structural patterns, not bare identifiers.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../..")
const BOX = join(ROOT, "src/apps/bench/commands/box.ts")
const POOL = join(ROOT, "src/apps/bench/commands/pool.ts")
const SETUP = join(ROOT, "src/apps/bench/remote/box-session/family-box-setup.ts")
const RESOLVE = join(ROOT, "src/apps/bench/remote/box-session/family-bootstrap-resolve.ts")

const RESOLVE_CALL = /withResolvedFamilyBootstrap\s*\(/
const FRESH_REFUSE = /provision path carried none/
const WARM_REFUSE = /attach path carried none/
const OWNER_LOOKUP = /familyRemoteBootstrap\s*\(/

type Check = {
  readonly hits: number
  readonly failures: readonly string[]
}

const requireHit = (ok: boolean, hits: number, failures: string[], message: string): number => {
  if (ok) return hits + 1
  failures.push(message)
  return hits
}

export const checkGf5CompositionContract = (files: {
  readonly box: string
  readonly pool: string
  readonly setup: string
  readonly resolve: string
}): Check => {
  const failures: string[] = []
  let hits = 0
  hits = requireHit(
    RESOLVE_CALL.test(files.box),
    hits,
    failures,
    "withResolvedFamilyBootstrap( missing from box up",
  )
  hits = requireHit(
    RESOLVE_CALL.test(files.pool),
    hits,
    failures,
    "withResolvedFamilyBootstrap( missing from pool provision",
  )
  hits = requireHit(
    FRESH_REFUSE.test(files.setup),
    hits,
    failures,
    "fresh setupBoxForFamily lost the declared-but-missing refuse",
  )
  hits = requireHit(
    WARM_REFUSE.test(files.setup),
    hits,
    failures,
    "warm ensureWarmBoxFamilyBootstrap lost the declared-but-missing refuse",
  )
  hits = requireHit(
    OWNER_LOOKUP.test(files.resolve),
    hits,
    failures,
    "family-bootstrap-resolve lost familyRemoteBootstrap( lookup",
  )
  return { hits, failures }
}

describe("G-F5 composition-root ratchet", () => {
  const files = {
    box: readFileSync(BOX, "utf8"),
    pool: readFileSync(POOL, "utf8"),
    setup: readFileSync(SETUP, "utf8"),
    resolve: readFileSync(RESOLVE, "utf8"),
  }

  test("anti-vacuum: box, pool, fresh refuse, warm refuse, owner lookup", () => {
    const check = checkGf5CompositionContract(files)
    expect(check.hits).toBeGreaterThanOrEqual(5)
  })

  test("live sources satisfy the composition contract", () => {
    const check = checkGf5CompositionContract(files)
    expect(check.failures).toEqual([])
  })

  test("red-on-injection: dropping box up resolve fails", () => {
    const mutated = files.box.replace(RESOLVE_CALL, "identityConfig(")
    expect(mutated).not.toBe(files.box)
    const check = checkGf5CompositionContract({ ...files, box: mutated })
    expect(check.failures.some((f) => f.includes("box up"))).toBe(true)
  })

  test("red-on-injection: dropping pool resolve fails", () => {
    const mutated = files.pool.replace(RESOLVE_CALL, "identityConfig(")
    expect(mutated).not.toBe(files.pool)
    const check = checkGf5CompositionContract({ ...files, pool: mutated })
    expect(check.failures.some((f) => f.includes("pool"))).toBe(true)
  })

  test("red-on-injection: dropping fresh refuse fails", () => {
    const mutated = files.setup.replace(FRESH_REFUSE, "silently skip the pin")
    expect(mutated).not.toBe(files.setup)
    const check = checkGf5CompositionContract({ ...files, setup: mutated })
    expect(check.failures.some((f) => f.includes("fresh"))).toBe(true)
  })
})
