/**
 * HELLGATE — adversarial BudgetProbe adapter proofs (ADR-0274).
 *
 * Invariants:
 *   (i)   `createBudgetProbeFromLedger` adapts a duck-typed
 *         `{ snapshot(): { totalUsd } }` shape into the broadened
 *         `BudgetProbe { usdSoFar(); maxAllowed(); remaining() }` port
 *         WITHOUT importing `@/agent/budget-ledger` (slice fence).
 *   (ii)  `remaining()` is always `max(0, maxAllowed - usdSoFar)` — never
 *         negative; observability over a long-overrun session keeps the
 *         math sane.
 *   (iii) `maxUsd === 0` constructs a probe whose `remaining()` is
 *         permanently 0 (callers always trip the budget gate).
 *   (iv)  `maxUsd < 0` is invalid and rejected at the factory boundary —
 *         a `BudgetProbeError("invalid-budget")` is thrown so the
 *         programmer notices at construction, not at the first call.
 *   (v)   Ledger snapshot failure surfaces as
 *         `BudgetProbeError("ledger-unavailable")` from `usdSoFar()` —
 *         the pipeline's budget-gate catches at its boundary.
 *   (vi)  default-OFF — no file in `src/{agent,runner,apps}` imports
 *         `@/retrieval/budget-probe` at ship time. Pure leaf primitive.
 *   (vii) `BudgetProbeError` is a 3-arm closed discriminated union;
 *         exhaustive-switch at any consumer triggers TS `never` on a
 *         missing arm (the runtime mirror also throws on the default
 *         branch so a cast-through-`unknown` cannot ship silently).
 *
 * 12 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  type BudgetProbe,
  type BudgetProbeError,
  createBudgetProbeFromLedger,
  createStaticBudgetProbe,
} from "@/retrieval/budget-probe"
import { assertScanPopulation } from "../_shared/scan-population"

/** Minimal ledger duck — matches the documented bridge shape. */
const mockLedger = (totalUsd: number) => ({
  snapshot: () => ({ totalUsd }),
})

/** A ledger that throws on snapshot — used to trigger ledger-unavailable. */
const failingLedger = () => ({
  snapshot: (): { totalUsd: number } => {
    throw new Error("disk-corrupt")
  },
})

/** Source-text grep helper — split out to keep test complexity below 15. */
const IMPORT_PATTERN = /from\s+["']@\/retrieval\/budget-probe["']/

const safeStat = (path: string): ReturnType<typeof statSync> | undefined => {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

const safeReaddir = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir, { encoding: "utf8" }) as string[]
  } catch {
    return []
  }
}

const collectFromFile = (path: string, offenders: string[]): void => {
  if (!path.endsWith(".ts")) return
  const txt = readFileSync(path, "utf8")
  if (IMPORT_PATTERN.test(txt)) offenders.push(path)
}

const collectFromDir = (dir: string, offenders: string[]): void => {
  for (const name of safeReaddir(dir)) {
    const full = join(dir, name)
    const s = safeStat(full)
    if (s === undefined) continue
    if (s.isDirectory()) {
      collectFromDir(full, offenders)
      continue
    }
    collectFromFile(full, offenders)
  }
}

const collectOffenders = (roots: readonly string[]): readonly string[] => {
  const offenders: string[] = []
  for (const r of roots) collectFromDir(r, offenders)
  return offenders
}

/** The same traversal `collectFromDir` performs, returning what it VISITED
 *  rather than what offended — `safeReaddir` swallows a failed read and returns
 *  `[]`, so "no offender" and "no file opened" are otherwise the same answer. */
const visitedUnder = (dir: string, out: string[] = []): string[] => {
  for (const name of safeReaddir(dir)) {
    const full = join(dir, name)
    const s = safeStat(full)
    if (s === undefined) continue
    if (s.isDirectory()) {
      visitedUnder(full, out)
      continue
    }
    if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("budget-probe hellgate (12 cases)", () => {
  test("HELL-BP-01 createBudgetProbeFromLedger reads usdSoFar from ledger snapshot", () => {
    const probe = createBudgetProbeFromLedger(mockLedger(0.42), { maxUsd: 5 })
    expect(probe.usdSoFar()).toBeCloseTo(0.42, 10)
  })

  test("HELL-BP-02 maxAllowed returns the configured maxUsd verbatim", () => {
    const probe = createBudgetProbeFromLedger(mockLedger(0), { maxUsd: 12.5 })
    expect(probe.maxAllowed()).toBe(12.5)
  })

  test("HELL-BP-03 remaining = maxAllowed - usdSoFar", () => {
    const probe = createBudgetProbeFromLedger(mockLedger(3), { maxUsd: 10 })
    expect(probe.remaining()).toBeCloseTo(7, 10)
  })

  test("HELL-BP-04 remaining clamps to 0 when usdSoFar exceeds maxAllowed", () => {
    const probe = createBudgetProbeFromLedger(mockLedger(15), { maxUsd: 10 })
    expect(probe.remaining()).toBe(0)
  })

  test("HELL-BP-05 createStaticBudgetProbe returns configurable values verbatim", () => {
    const probe = createStaticBudgetProbe({ usdSoFar: 1.25, maxAllowed: 4 })
    expect(probe.usdSoFar()).toBe(1.25)
    expect(probe.maxAllowed()).toBe(4)
    expect(probe.remaining()).toBeCloseTo(2.75, 10)
  })

  test("HELL-BP-06 ledger snapshot throws -> BudgetProbeError('ledger-unavailable')", () => {
    const probe = createBudgetProbeFromLedger(failingLedger(), { maxUsd: 5 })
    let caught: unknown
    try {
      probe.usdSoFar()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    const err = caught as { name?: string; kind?: BudgetProbeError["kind"] }
    expect(err.name).toBe("BudgetProbeError")
    expect(err.kind).toBe("ledger-unavailable")
  })

  test("HELL-BP-07 maxUsd === 0 -> remaining permanently 0 (always budget-exceeded)", () => {
    const probe = createBudgetProbeFromLedger(mockLedger(0), { maxUsd: 0 })
    expect(probe.remaining()).toBe(0)
    expect(probe.maxAllowed()).toBe(0)
    // Even with zero spend so far, a zero budget means the gate trips.
    expect(probe.usdSoFar() >= probe.maxAllowed()).toBe(true)
  })

  test("HELL-BP-08 maxUsd < 0 -> factory throws BudgetProbeError('invalid-budget')", () => {
    let caught: unknown
    try {
      createBudgetProbeFromLedger(mockLedger(0), { maxUsd: -1 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    const err = caught as { name?: string; kind?: BudgetProbeError["kind"] }
    expect(err.name).toBe("BudgetProbeError")
    expect(err.kind).toBe("invalid-budget")
  })

  test("HELL-BP-09 default-OFF — no agent/runner/apps imports @/retrieval/budget-probe", () => {
    const roots = ["src/agent", "src/runner", "src/apps"]
    const repoRoot = join(import.meta.dir, "..", "..", "..")
    const absRoots = roots.map((r) => join(repoRoot, r))
    for (const [index, root] of absRoots.entries()) {
      const repoRelativeRoot = roots[index]
      if (repoRelativeRoot === undefined) throw new Error(`missing root identity for ${root}`)
      assertScanPopulation(visitedUnder(root), root, {
        // A committed scan identity must survive clones and linked worktrees.
        // Absolute roots made the same scan appear stale + unpinned whenever
        // verification ran outside the checkout that authored the baseline.
        id: `tests/unit/retrieval/budget-probe-hellgate.test.ts#${repoRelativeRoot}`,
        collectable: (n) => n.endsWith(".ts"),
      })
    }
    const offenders = collectOffenders(absRoots)
    expect(offenders).toEqual([])
  })

  test("HELL-BP-10 concurrent usdSoFar() returns identical values (no race)", async () => {
    let calls = 0
    const ledger = {
      snapshot: () => {
        calls += 1
        return { totalUsd: 7.5 }
      },
    }
    const probe = createBudgetProbeFromLedger(ledger, { maxUsd: 100 })
    const results = await Promise.all(Array.from({ length: 50 }, async () => probe.usdSoFar()))
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe(7.5)
    expect(calls).toBe(50)
  })

  test("HELL-BP-11 1000 usdSoFar() calls finish in < 500 ms (perf sanity)", () => {
    // Conservative ceiling — the adapter is a 3-line read; the budget here
    // is dominated by the test harness, not the probe code. 500ms keeps a
    // wide margin while still catching an accidental O(n^2) regression.
    const probe = createBudgetProbeFromLedger(mockLedger(0.01), { maxUsd: 5 })
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) probe.usdSoFar()
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(500)
  })

  test("HELL-BP-12 BudgetProbeError 3-arm closed union (exhaustive switch)", () => {
    // Compile-time exhaustiveness — if a 4th arm ships without an arm here,
    // `assertNever` fails to type-check.
    const handle = (e: BudgetProbeError): string => {
      switch (e.kind) {
        case "ledger-unavailable":
          return "L"
        case "invalid-budget":
          return "I"
        case "budget-exceeded":
          return "B"
        default: {
          const _exhaustive: never = e
          return _exhaustive
        }
      }
    }
    expect(handle({ kind: "ledger-unavailable", cause: new Error("x") })).toBe("L")
    expect(handle({ kind: "invalid-budget", reason: "negative maxUsd" })).toBe("I")
    expect(handle({ kind: "budget-exceeded", maxUsd: 1, usdSoFar: 2 })).toBe("B")
    // Probe surface compatibility — a BudgetProbe is also a pipeline-shape probe.
    const probe: BudgetProbe = createStaticBudgetProbe({ usdSoFar: 0, maxAllowed: 1 })
    expect(typeof probe.usdSoFar).toBe("function")
    expect(typeof probe.maxAllowed).toBe("function")
    expect(typeof probe.remaining).toBe("function")
  })
})
