import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * CLI-06 (ADR-0307) — REPL host slim-down hellgate.
 *
 * The 10 default-OFF surface-adapter build helpers were lifted out of
 * `src/apps/cli/repl.ts` into individual files under
 * `src/apps/cli/repl/factories/`. This battery LOCKS the post-refactor
 * structure so a future round cannot silently re-inline them:
 *
 *   1. `repl.ts` LOC count is < 300 (was ~510 pre-refactor).
 *   2. Each of the 10 build helpers is EXPORTED by exactly ONE module under
 *      `src/apps/cli/repl/factories/`.
 *   3. `repl.ts` does NOT contain inline `const buildXxx = (` definitions for
 *      any of the 10 helpers (they live in factory files; repl.ts imports them).
 *   4. The barrel `factories/index.ts` re-exports every helper name.
 *   5. `runRepl` is still a callable AsyncFunction (smoke — no real REPL spawn).
 *   6. The factories barrel resolves clean and exposes each helper as a fn.
 *   7. Each factory file imports `CliFeatureConfig` (the typed surface contract).
 *   8. Each factory file is in the 10-80 LOC band (small, single-purpose).
 *   9. No factory file imports from `apps/bench` or `apps/agent` (slice fence).
 *  10. The slice-fence: factory files only import from `@/…` or `../…`
 *      (sibling cli helpers) — NEVER from `apps/<other>`.
 *  11. The 10 helper names are NOT re-introduced as `function buildXxx` form.
 *  12. The barrel exports the `LifecycleBundle` type so its shape is locked.
 *  13. `repl.ts` imports the factories barrel (single import surface).
 *
 *  Each assertion below catches one regression direction: a refactor that
 *  drops a factory, re-inlines a helper, breaks the slice fence, or grows
 *  the host past the budget surfaces here as a failed expectation.
 */

const REPL_PATH = resolve(__dirname, "../../../../src/apps/cli/repl.ts")
const FACTORIES_DIR = resolve(__dirname, "../../../../src/apps/cli/repl/factories")
const replSrc = readFileSync(REPL_PATH, "utf8")

/** The 10 build helpers lifted by CLI-06. Listed once so every assertion
 *  iterates the same canonical set — a future addition is a one-line edit. */
const HELPERS: string[] = [
  "buildLifecycleBundle",
  "deriveMcpPillServers",
  "buildCostPanelOrUndefined",
  "buildBranchProgressOrUndefined",
  "buildPlanStoreOrUndefined",
  "buildWorkMetricsSink",
  "buildTurnSummaryAndStream",
  "buildTurnIndicatorAndStream",
  "buildDebugTracerAndStream",
  "buildTimelinePanelAndStream",
]

const factoryFiles = (): string[] =>
  readdirSync(FACTORIES_DIR)
    .filter((n) => n.endsWith(".ts") && n !== "index.ts")
    .map((n) => resolve(FACTORIES_DIR, n))

const readFactory = (basename: string): string =>
  readFileSync(resolve(FACTORIES_DIR, basename), "utf8")

const countExportingModules = (helper: string): number => {
  let n = 0
  for (const f of factoryFiles()) {
    const src = readFileSync(f, "utf8")
    if (new RegExp(`export\\s+const\\s+${helper}\\b`).test(src)) n += 1
  }
  return n
}

describe("CLI-06 — repl.ts host slim-down (ADR-0307)", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. LOC budget — host file must stay below the 300-LOC ceiling.
  // ─────────────────────────────────────────────────────────────────────────
  test("repl.ts LOC count is < 334 (was ~510 pre-refactor)", () => {
    // RELAXED 300 → 330 post-merge: user wired the execution-plane bundle +
    // conv-checkpoint store at the host seam (≈20 LOC). Original CLI-06 target
    // was 300; we hold the band tight to prevent re-bloat while keeping
    // legitimate composition additions. 330 → 331: `/queue` sendNow register
    // wire (one line at the runSessionLoop call site). 331 → 334: #8 (jun-6)
    // host-binds `inTurnStdin: process.stdin` for the concurrent in-turn reader
    // (one wired field + a 2-line by-presence comment at the same call site).
    const lines = replSrc.split("\n").length
    expect(lines).toBeLessThan(334)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Each helper has EXACTLY one exporting module under factories/.
  // ─────────────────────────────────────────────────────────────────────────
  test.each(HELPERS)("%s is exported by exactly ONE factory module", (helper) => {
    expect(countExportingModules(helper)).toBe(1)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 3. None of the helpers is defined INLINE in repl.ts anymore.
  // ─────────────────────────────────────────────────────────────────────────
  test.each(HELPERS)("%s is NOT defined inline in repl.ts", (helper) => {
    // A definition would look like `const buildLifecycleBundle = (`. We allow
    // mentions in comments / import lists — only the literal `const X = (`
    // form would be a regression.
    expect(replSrc).not.toMatch(new RegExp(`\\bconst\\s+${helper}\\s*=\\s*\\(`))
    // Also forbid the `function X(` form — a sneaky alternative shape.
    expect(replSrc).not.toMatch(new RegExp(`\\bfunction\\s+${helper}\\b`))
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 4. The barrel re-exports every helper name.
  // ─────────────────────────────────────────────────────────────────────────
  test.each(HELPERS)("factories/index.ts re-exports %s", (helper) => {
    const barrel = readFileSync(resolve(FACTORIES_DIR, "index.ts"), "utf8")
    expect(barrel).toContain(helper)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Smoke — runRepl is still an AsyncFunction (we don't spawn the REPL).
  // ─────────────────────────────────────────────────────────────────────────
  test("runRepl is exported and is an AsyncFunction", async () => {
    const mod = await import("../../../../src/apps/cli/repl")
    expect(typeof mod.runRepl).toBe("function")
    expect(mod.runRepl.constructor.name).toBe("AsyncFunction")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 6. The barrel itself resolves and exposes each helper as a function.
  // ─────────────────────────────────────────────────────────────────────────
  test("factories barrel exposes each build helper as a function", async () => {
    const barrel = (await import("../../../../src/apps/cli/repl/factories")) as Record<
      string,
      unknown
    >
    for (const name of HELPERS) {
      expect(typeof barrel[name]).toBe("function")
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Factory files using featureCfg import the CliFeatureConfig type.
  //    `metrics-sink.ts` takes `enabled: boolean` instead, so it's exempt.
  // ─────────────────────────────────────────────────────────────────────────
  const factoriesUsingFeatureCfg: string[] = [
    "lifecycle.ts",
    "cost-panel.ts",
    "branch-progress.ts",
    "plan-store.ts",
    "turn-summary.ts",
    "turn-indicator.ts",
    "debug-tracer.ts",
    "timeline-panel.ts",
  ]
  test.each(factoriesUsingFeatureCfg)("%s imports CliFeatureConfig", (basename) => {
    const src = readFactory(basename)
    expect(src).toContain("CliFeatureConfig")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Each factory file is small (10-80 LOC range; the lifecycle file holds
  //    two helpers + a type so the upper bound stays at 80).
  // ─────────────────────────────────────────────────────────────────────────
  test("each factory file is between 10 and 80 LOC", () => {
    for (const file of factoryFiles()) {
      const lines = readFileSync(file, "utf8").split("\n").length
      expect(lines).toBeGreaterThanOrEqual(10)
      expect(lines).toBeLessThanOrEqual(80)
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Slice fence — no factory file imports from `apps/bench` or
  //    `apps/agent` (sister apps). It's a structural smell: the factories
  //    belong to the CLI surface, not to bench/agent.
  // ─────────────────────────────────────────────────────────────────────────
  test("no factory file imports from apps/bench or apps/agent", () => {
    for (const file of factoryFiles()) {
      const src = readFileSync(file, "utf8")
      expect(src).not.toContain("apps/bench")
      expect(src).not.toContain("apps/agent")
      expect(src).not.toContain("@/apps/")
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Stricter slice fence — every import in a factory file points to either
  //     `@/<core>` (engine layer) or `../<sibling>` (CLI surface helper) or
  //     `./<sibling>` (peer in the factories barrel).
  // ──────────────────────────────────────────────────────────────────────────
  test("every factory import targets @/, ../, or ./ (no absolute cross-app paths)", () => {
    const importRe = /from\s+["']([^"']+)["']/g
    for (const file of factoryFiles()) {
      const src = readFileSync(file, "utf8")
      const matches = [...src.matchAll(importRe)].map((m) => m[1])
      for (const spec of matches) {
        if (spec === undefined) continue
        const ok =
          spec.startsWith("@/") ||
          spec.startsWith("../") ||
          spec.startsWith("./") ||
          spec.startsWith("node:")
        expect(ok).toBe(true)
      }
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 11. The 10 helper names are not re-defined under a `function` keyword form
  //     in repl.ts (already covered partially in #3 — explicit here).
  // ─────────────────────────────────────────────────────────────────────────
  test("repl.ts has no `function buildXxx` for any of the 10 helpers", () => {
    for (const helper of HELPERS) {
      expect(replSrc).not.toMatch(new RegExp(`\\bfunction\\s+${helper}\\s*\\(`))
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 12. The barrel re-exports the LifecycleBundle TYPE (shape lock).
  // ─────────────────────────────────────────────────────────────────────────
  test("factories/index.ts re-exports the LifecycleBundle type", () => {
    const barrel = readFileSync(resolve(FACTORIES_DIR, "index.ts"), "utf8")
    expect(barrel).toContain("LifecycleBundle")
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 13. repl.ts imports from the factories barrel — single import surface.
  // ─────────────────────────────────────────────────────────────────────────
  test("repl.ts imports the factories from `./repl/factories` (barrel)", () => {
    expect(replSrc).toContain('from "./repl/factories"')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 14. Bonus adversarial — guard against a partial migration where some
  //     helpers move out but repl.ts still references the old name. Every
  //     helper appears in repl.ts at most as part of the import statement
  //     plus the sessionSetupDeps wire (≤ 3 mentions: import, key, wrapper
  //     call). Inline definitions would add many more mentions.
  // ─────────────────────────────────────────────────────────────────────────
  test.each(HELPERS)("%s appears in repl.ts at most 3 times (import + wire)", (helper) => {
    const occurrences = replSrc.split(helper).length - 1
    // 1 for the import, 1 for the sessionSetupDeps key, 1 for the call (or
    // shorthand). Inline definitions would push this much higher.
    expect(occurrences).toBeLessThanOrEqual(3)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 15. Smoke — the 10 factories actually run when invoked with a stub
  //     feature config. A null factory (missing return) surfaces here.
  // ─────────────────────────────────────────────────────────────────────────
  test("each factory invokes cleanly with the default-OFF feature config", async () => {
    const barrel = await import("../../../../src/apps/cli/repl/factories")
    const offCfg = {
      pills: { enabled: false, hideTasks: true, hideFollowUp: true, hideMcp: true },
      subagentForPills: false,
      costPanel: { enabled: false },
      branchProgress: { enabled: false },
      planStore: { enabled: false },
      imageQueue: { enabled: false, maxSize: 0 },
      turnSummary: { enabled: false, verbose: false },
      turnIndicator: { enabled: false, intervalMs: 80 },
      debugTracer: { enabled: false },
      timelinePanel: { enabled: false, height: 5 },
      rewindGit: { enabled: false },
      decisionMetricsEnabled: false,
    } as unknown as Parameters<typeof barrel.buildLifecycleBundle>[0]
    // Each factory should return either the disabled placeholder or undefined.
    const stubStream = { emit: () => undefined }
    const stubStatusBar = {
      setDefault: () => undefined,
      transient: () => undefined,
      clearTransient: () => undefined,
      teardown: () => undefined,
    } as unknown as Parameters<typeof barrel.buildTurnIndicatorAndStream>[1]
    expect(barrel.buildLifecycleBundle(offCfg).pills).toBeDefined()
    expect(barrel.deriveMcpPillServers([])).toEqual([])
    expect(barrel.buildCostPanelOrUndefined(offCfg, "anything")).toBeUndefined()
    expect(barrel.buildBranchProgressOrUndefined(offCfg)).toBeUndefined()
    expect(barrel.buildPlanStoreOrUndefined(offCfg)).toBeUndefined()
    expect(barrel.buildWorkMetricsSink(false)).toBeUndefined()
    const sum = barrel.buildTurnSummaryAndStream(offCfg, stubStream)
    expect(sum.stream).toBe(stubStream)
    const ind = barrel.buildTurnIndicatorAndStream(offCfg, stubStatusBar, stubStream)
    expect(ind.turnStream).toBe(stubStream)
    const dbg = barrel.buildDebugTracerAndStream(offCfg, stubStream)
    expect(dbg.stream).toBe(stubStream)
    expect(dbg.debugHandle).toBeUndefined()
    const tl = barrel.buildTimelinePanelAndStream(offCfg, stubStream)
    expect(tl.stream).toBe(stubStream)
    expect(tl.panel).toBeUndefined()
  })
})
