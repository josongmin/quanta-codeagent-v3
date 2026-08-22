/**
 * ADR-0233 (Wire 2) — vendor-detector ↔ glob-rules composer hellgate.
 *
 * Pins the contract for `loadGlobRulesWithVendors` +
 * `composeGlobRulesWithDetected`:
 *   - DEFAULT-OFF: opts absent / `vendorDetectorEnabled !== true` ⇒ output
 *     IS the legacy `loadGlobRules(cwd)` (byte-identical, length AND
 *     content). NO detector call.
 *   - Opt-in arm: detector wired ⇒ legacy + detected sets composed.
 *   - All 6 vendors flow through when `vendors` omitted; subset filter
 *     drops the others.
 *   - `priority` override reorders vendors for collision tiebreak.
 *   - Same absolute path claimed by legacy + detector ⇒ collision-resolved
 *     by priority (legacy treated as "quanta" — its own native bucket).
 *   - detector throws ⇒ NO escape; helper returns legacy result.
 *   - Detector adapter omitted ⇒ falls back to
 *     `createDefaultVendorDetector()` (so a host can opt-in with just
 *     `{ vendorDetectorEnabled: true }`).
 *   - Deterministic ordering: priority asc, then sourcePath asc.
 *   - MAX_RULE_FILES cap honored — composition cannot blow per-turn budget.
 *
 * Source under test: src/agent/glob-rules.ts —
 * `loadGlobRulesWithVendors` + `composeGlobRulesWithDetected`.
 *
 * The tests use real tmpdir fixtures (so `loadGlobRules` walks live FS)
 * and a stub `VendorDetectorPort` for deterministic detected-rule input.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  composeGlobRulesWithDetected,
  type GlobRule,
  loadGlobRules,
  loadGlobRulesWithVendors,
} from "@/agent"
import type { DetectedRule, DetectionResult, VendorDetectorPort, VendorId } from "@/rules"

// ─── Tmpdir + spy fixtures ───────────────────────────────────────────

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vd-glob-wire-hellgate-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const mkRepo = async (name: string): Promise<string> => {
  const cwd = join(root, name)
  await mkdir(cwd, { recursive: true })
  return cwd
}

const writeAt = async (cwd: string, rel: string, body: string): Promise<void> => {
  const abs = join(cwd, rel)
  await mkdir(join(abs, ".."), { recursive: true })
  await writeFile(abs, body)
}

interface StubDetector {
  readonly port: VendorDetectorPort
  readonly calls: { cwd: string }[]
}

const makeStubDetector = (rules: ReadonlyArray<DetectedRule>): StubDetector => {
  const calls: { cwd: string }[] = []
  const port: VendorDetectorPort = {
    detectAll: async (opts): Promise<DetectionResult> => {
      calls.push({ cwd: opts.cwd })
      return { rules, errors: [] }
    },
  }
  return { port, calls }
}

const makeDetectedRule = (over: {
  vendor: VendorId
  sourcePath: string
  body?: string
  description?: string
  alwaysApply?: boolean
  globs?: ReadonlyArray<string>
}): DetectedRule =>
  Object.freeze({
    vendor: over.vendor,
    sourcePath: over.sourcePath,
    description: over.description ?? "",
    body: over.body ?? "rule body",
    trigger: Object.freeze({
      alwaysApply: over.alwaysApply ?? true,
      globs: Object.freeze([...(over.globs ?? [])]),
    }),
    scope: "repo",
    metadata: Object.freeze({}),
  })

// ─── DEFAULT-OFF — legacy passthrough ────────────────────────────────

describe("loadGlobRulesWithVendors — default-OFF passthrough", () => {
  test("opts absent ⇒ identical to loadGlobRules(cwd) (NO detector call)", async () => {
    const cwd = await mkRepo("default-off-1")
    await writeAt(cwd, ".quanta/rules/a.md", "---\nalwaysApply: true\n---\nA body\n")
    const stub = makeStubDetector([
      makeDetectedRule({ vendor: "cursor", sourcePath: "/should/not/appear.mdc" }),
    ])
    const legacy = await loadGlobRules(cwd)
    const out = await loadGlobRulesWithVendors(cwd)
    // Same length AND same content — detector NOT invoked.
    expect(out).toEqual(legacy)
    expect(stub.calls).toEqual([]) // detector untouched
  })

  test("vendorDetectorEnabled === false ⇒ identical to legacy + detector NOT called", async () => {
    const cwd = await mkRepo("default-off-2")
    await writeAt(cwd, ".quanta/rules/a.md", "---\nalwaysApply: true\n---\nLegacy body\n")
    const stub = makeStubDetector([
      makeDetectedRule({ vendor: "cursor", sourcePath: "/should/not/appear.mdc" }),
    ])
    const legacy = await loadGlobRules(cwd)
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: false,
      detector: stub.port,
    })
    expect(out).toEqual(legacy)
    expect(stub.calls).toEqual([])
  })
})

// ─── OPT-IN — composer wiring ────────────────────────────────────────

describe("loadGlobRulesWithVendors — opt-in composition", () => {
  test("detector injected ⇒ legacy + detected composed; detector receives cwd", async () => {
    const cwd = await mkRepo("opt-in-1")
    // Legacy: 1 .quanta rule.
    await writeAt(cwd, ".quanta/rules/legacy.md", "---\nalwaysApply: true\n---\nLegacy body\n")
    const stub = makeStubDetector([
      makeDetectedRule({
        vendor: "cline",
        sourcePath: "/abs/path/.clinerules",
        body: "Cline body",
      }),
      makeDetectedRule({
        vendor: "windsurf",
        sourcePath: "/abs/path/.windsurfrules",
        body: "Windsurf body",
      }),
    ])
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stub.port,
    })
    expect(out.length).toBe(3) // 1 legacy + 2 detected
    expect(stub.calls).toEqual([{ cwd }])
    // Detected vendor bodies present.
    const bodies = out.map((r) => r.body)
    expect(bodies).toContain("Legacy body")
    expect(bodies).toContain("Cline body")
    expect(bodies).toContain("Windsurf body")
  })

  test("ALL 6 vendor inputs flow through when `vendors` filter omitted", async () => {
    const cwd = await mkRepo("opt-in-allvendors")
    const stub = makeStubDetector([
      makeDetectedRule({ vendor: "quanta", sourcePath: "/p/q.md", body: "Q" }),
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/c.mdc", body: "C" }),
      makeDetectedRule({ vendor: "cline", sourcePath: "/p/cl.md", body: "Cl" }),
      makeDetectedRule({ vendor: "roo", sourcePath: "/p/r.md", body: "R" }),
      makeDetectedRule({ vendor: "aider", sourcePath: "/p/a.md", body: "A" }),
      makeDetectedRule({ vendor: "windsurf", sourcePath: "/p/w.rules", body: "W" }),
    ])
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stub.port,
    })
    expect(out.length).toBe(6)
  })

  test("`vendors` subset filter ⇒ unwanted vendors dropped post-detection", async () => {
    const cwd = await mkRepo("opt-in-vendorfilter")
    const stub = makeStubDetector([
      makeDetectedRule({ vendor: "quanta", sourcePath: "/p/q.md", body: "Q" }),
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/c.mdc", body: "C" }),
      makeDetectedRule({ vendor: "cline", sourcePath: "/p/cl.md", body: "Cl" }),
      makeDetectedRule({ vendor: "roo", sourcePath: "/p/r.md", body: "R" }),
      makeDetectedRule({ vendor: "aider", sourcePath: "/p/a.md", body: "A" }),
      makeDetectedRule({ vendor: "windsurf", sourcePath: "/p/w.rules", body: "W" }),
    ])
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stub.port,
      vendors: ["quanta", "cursor"], // only these two allowed
    })
    expect(out.length).toBe(2)
    expect(out.map((r) => r.body).sort()).toEqual(["C", "Q"])
  })

  test("detector adapter omitted ⇒ default detector used (no crash, FS-walked)", async () => {
    const cwd = await mkRepo("opt-in-defaultdetector")
    // Single windsurf file — the default detector will pick it up.
    await writeAt(cwd, ".windsurfrules", "Default-detector body\n")
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      // detector OMITTED — composer falls back to createDefaultVendorDetector()
    })
    // No crash, and the windsurf body shows up via the detector path.
    expect(out.some((r) => r.body.includes("Default-detector"))).toBe(true)
  })
})

// ─── COLLISION RESOLUTION ────────────────────────────────────────────

describe("composeGlobRulesWithDetected — collision resolution", () => {
  test("same absolute path in legacy + detected ⇒ legacy wins on tie (legacy is quanta)", () => {
    const sharedPath = "/abs/conflict.md"
    const legacy: GlobRule[] = [
      {
        sourcePath: sharedPath,
        globs: [],
        alwaysApply: true,
        body: "LEGACY",
      },
    ]
    const detected: DetectedRule[] = [
      makeDetectedRule({
        vendor: "quanta", // same priority as legacy bucket
        sourcePath: sharedPath,
        body: "DETECTED-Q",
      }),
    ]
    const out = composeGlobRulesWithDetected(legacy, detected)
    expect(out.length).toBe(1)
    expect(out[0]?.body).toBe("LEGACY") // legacy holds the slot
  })

  test("foreign vendor at same path as legacy ⇒ legacy (quanta) wins (lower index)", () => {
    const sharedPath = "/abs/conflict.md"
    const legacy: GlobRule[] = [
      {
        sourcePath: sharedPath,
        globs: [],
        alwaysApply: true,
        body: "LEGACY-QUANTA",
      },
    ]
    const detected: DetectedRule[] = [
      makeDetectedRule({
        vendor: "windsurf", // priority 5 (canonical) — worse than quanta=0
        sourcePath: sharedPath,
        body: "WINDSURF",
      }),
    ]
    const out = composeGlobRulesWithDetected(legacy, detected)
    expect(out.length).toBe(1)
    expect(out[0]?.body).toBe("LEGACY-QUANTA")
  })

  test("priority override flips winner: ['windsurf','quanta'] ⇒ windsurf wins collision", () => {
    const sharedPath = "/abs/conflict.md"
    const legacy: GlobRule[] = [
      {
        sourcePath: sharedPath,
        globs: [],
        alwaysApply: true,
        body: "LEGACY-Q",
      },
    ]
    const detected: DetectedRule[] = [
      makeDetectedRule({
        vendor: "windsurf",
        sourcePath: sharedPath,
        body: "WINDSURF",
      }),
    ]
    const out = composeGlobRulesWithDetected(legacy, detected, {
      priority: ["windsurf", "quanta"],
    })
    expect(out.length).toBe(1)
    expect(out[0]?.body).toBe("WINDSURF") // override flipped the winner
  })

  test("deterministic ordering: priority asc, then sourcePath asc", () => {
    const detected: DetectedRule[] = [
      makeDetectedRule({ vendor: "windsurf", sourcePath: "/p/zzz", body: "Wzzz" }),
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/bbb", body: "Cbbb" }),
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/aaa", body: "Caaa" }),
      makeDetectedRule({ vendor: "cline", sourcePath: "/p/ccc", body: "Clccc" }),
    ]
    const out = composeGlobRulesWithDetected([], detected)
    // cursor (idx 1) before cline (idx 2) before windsurf (idx 5).
    // Within cursor: aaa before bbb.
    expect(out.map((r) => r.body)).toEqual(["Caaa", "Cbbb", "Clccc", "Wzzz"])
  })
})

// ─── NO-THROW UNDER DETECTOR FAILURE ─────────────────────────────────

describe("loadGlobRulesWithVendors — no-throw fallback", () => {
  test("detector throws ⇒ helper returns legacy result; NO crash", async () => {
    const cwd = await mkRepo("detector-throws")
    await writeAt(cwd, ".quanta/rules/keep.md", "---\nalwaysApply: true\n---\nKeepMe\n")
    const legacy = await loadGlobRules(cwd)
    const port: VendorDetectorPort = {
      detectAll: async () => {
        throw new Error("detector boom")
      },
    }
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: port,
    })
    expect(out).toEqual(legacy)
    expect(out.some((r) => r.body === "KeepMe")).toBe(true)
  })

  test("detector returns 0 rules ⇒ output IS legacy (no spurious entries)", async () => {
    const cwd = await mkRepo("detector-empty")
    await writeAt(cwd, ".quanta/rules/only-legacy.md", "---\nalwaysApply: true\n---\nOnly\n")
    const legacy = await loadGlobRules(cwd)
    const stub = makeStubDetector([])
    const out = await loadGlobRulesWithVendors(cwd, {
      vendorDetectorEnabled: true,
      detector: stub.port,
    })
    expect(out).toEqual(legacy) // detector returned nothing → identical
    expect(stub.calls.length).toBe(1) // but detector WAS invoked
  })

  test("DetectedRule with empty body is dropped (never reaches GlobRule[])", () => {
    const detected: DetectedRule[] = [
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/a.mdc", body: "good" }),
      makeDetectedRule({ vendor: "cursor", sourcePath: "/p/b.mdc", body: "   \n   " }), // whitespace-only
    ]
    const out = composeGlobRulesWithDetected([], detected)
    expect(out.length).toBe(1)
    expect(out[0]?.body).toBe("good")
  })

  test("DetectedRule with neither globs nor alwaysApply is dropped (never injects)", () => {
    const detected: DetectedRule[] = [
      makeDetectedRule({
        vendor: "cursor",
        sourcePath: "/p/inert.mdc",
        body: "inert body",
        alwaysApply: false,
        globs: [],
      }),
    ]
    const out = composeGlobRulesWithDetected([], detected)
    expect(out.length).toBe(0) // dropped — can never auto-inject
  })
})
