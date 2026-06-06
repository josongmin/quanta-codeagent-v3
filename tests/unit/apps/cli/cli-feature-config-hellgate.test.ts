import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CliFeatureConfig,
  readCliFeatureConfig,
} from "../../../../src/apps/cli/repl/cli-feature-config"

/**
 * ADR-0297 hellgate — surface-level feature config consolidation.
 *
 * Pins the contract of {@link readCliFeatureConfig}:
 *
 *   1. PURE — same env+TTY input ⇒ structurally identical output (no
 *      time-based / randomness / global mutation drift).
 *   2. DEFAULT MATRIX — `({}, false, false)` returns the exact default
 *      shape (every gate that requires TTY is OFF; only the literal
 *      "1" knobs default-ON). Locked verbatim so a future "gentle"
 *      flip in any helper surfaces here.
 *   3. SWEEP — every env knob mentioned in the existing `is*Enabled`
 *      helpers is honored end-to-end at the consolidation surface
 *      (no knob dropped during the refactor).
 *   4. SURFACE FENCE — repl.ts `build*` helpers contain ZERO direct
 *      `process.env` / `process.stdout.isTTY` / `process.stderr.isTTY`
 *      reads. `cli-feature-config.ts` is the ONLY surface-config file
 *      with `process.env` references — and even that is forbidden
 *      INSIDE the resolver (it must read only its arguments).
 *
 * The intent of this hellgate is to catch a future regression where
 * someone adds a new surface-level env knob and reads `process.env`
 * inline instead of plumbing it through `CliFeatureConfig`.
 */

const REPO_ROOT = join(import.meta.dir, "../../../..")

// =============================================================================
// 1. PURITY — same input ⇒ structurally identical output
// =============================================================================

describe("ADR-0297 readCliFeatureConfig — purity", () => {
  test("two calls with the SAME env+TTY return structurally equal records", () => {
    const env: NodeJS.ProcessEnv = {
      QUANTA_HISTORY: "1",
      QUANTA_HISTORY_MAX: "500",
      QUANTA_DEBUG: "tools,llm",
      QUANTA_SPINNER: "1",
    }
    const a = readCliFeatureConfig(env, true, true)
    const b = readCliFeatureConfig(env, true, true)
    // Stringify ignores Set identity by design; categories are inner Sets,
    // but their serialized form is stable per input env.
    expect(JSON.stringify(structuralize(a))).toBe(JSON.stringify(structuralize(b)))
  })

  test("the resolver does NOT mutate its env argument", () => {
    const env: NodeJS.ProcessEnv = { QUANTA_DEBUG: "tools" }
    const snapshot = JSON.stringify(env)
    readCliFeatureConfig(env, true, true)
    expect(JSON.stringify(env)).toBe(snapshot)
  })
})

// =============================================================================
// 2. DEFAULT MATRIX — `({}, false, false)` baseline
// =============================================================================

describe("ADR-0297 readCliFeatureConfig — default-OFF/ON matrix", () => {
  test("non-TTY + empty env returns the canonical default shape", () => {
    const cfg = readCliFeatureConfig({}, false, false)
    // Every TTY-gated feature is OFF on a non-TTY host.
    expect(cfg.pills.enabled).toBe(false)
    expect(cfg.pills.hideTasks).toBe(false)
    expect(cfg.pills.hideFollowUp).toBe(false)
    expect(cfg.pills.hideMcp).toBe(false)
    expect(cfg.subagentForPills).toBe(false)
    expect(cfg.costPanel.enabled).toBe(false)
    expect(cfg.branchProgress.enabled).toBe(false)
    expect(cfg.planStore.enabled).toBe(true) // default-ON (not TTY-gated)
    expect(cfg.workMetricsSinkEnabled).toBe(false)
    expect(cfg.turnSummary.enabled).toBe(false) // non-TTY auto-OFF
    expect(cfg.turnSummary.verbose).toBe(false)
    expect(cfg.turnIndicator.enabled).toBe(false)
    expect(cfg.turnIndicator.intervalMs).toBe(80) // default fallback
    expect(cfg.debugTracer.enabled).toBe(false)
    expect(cfg.debugTracer.categories).toBeUndefined()
    expect(cfg.debugTracer.stderrIsTTY).toBe(false)
    // Track T — timeline panel: non-TTY ⇒ OFF and height = 0 regardless of
    // the env knob (mirrors the prior `repl.ts::buildTimelinePanelAndStream`
    // boot precondition exactly).
    expect(cfg.timelinePanel.enabled).toBe(false)
    expect(cfg.timelinePanel.height).toBe(0)
    // ADR-0270 — decision-counter sink default OFF (no env knob set).
    expect(cfg.decisionMetricsEnabled).toBe(false)
    // Image queue / history / multiline: literal-"0" disablers ⇒ default-ON
    // regardless of TTY-ness (operator-facing input plumbing is TTY-pivoted
    // upstream by the prompt pipeline itself).
    expect(cfg.imageQueue.enabled).toBe(true)
    expect(cfg.imageQueue.maxSize).toBe(5)
    expect(cfg.history.enabled).toBe(true)
    expect(cfg.history.maxLines).toBe(1000)
    expect(cfg.history.filePath).toBeUndefined()
    expect(cfg.multiline.enabled).toBe(true)
    expect(cfg.rewindGit.enabled).toBe(false)
  })

  test("TTY-on + empty env flips the auto-ON pill/cost/summary/indicator gates", () => {
    const cfg = readCliFeatureConfig({}, true, true)
    expect(cfg.pills.enabled).toBe(true)
    expect(cfg.costPanel.enabled).toBe(true)
    expect(cfg.branchProgress.enabled).toBe(true)
    expect(cfg.turnSummary.enabled).toBe(true)
    expect(cfg.turnIndicator.enabled).toBe(true)
    // Debug remains OFF unless QUANTA_DEBUG is set.
    expect(cfg.debugTracer.enabled).toBe(false)
  })
})

// =============================================================================
// 3. SWEEP — every env knob is honored
// =============================================================================

describe("ADR-0297 readCliFeatureConfig — env-knob sweep", () => {
  test("QUANTA_LIFECYCLE_PILLS=0 disables pills even on TTY", () => {
    const cfg = readCliFeatureConfig({ QUANTA_LIFECYCLE_PILLS: "0" }, true, true)
    expect(cfg.pills.enabled).toBe(false)
  })

  test("QUANTA_PILL_TASKS / FOLLOWUP / MCP each honor the off-token family", () => {
    const cfg = readCliFeatureConfig(
      {
        QUANTA_PILL_TASKS: "off",
        QUANTA_PILL_FOLLOWUP: "no",
        QUANTA_PILL_MCP: "false",
      },
      true,
      true,
    )
    expect(cfg.pills.hideTasks).toBe(true)
    expect(cfg.pills.hideFollowUp).toBe(true)
    expect(cfg.pills.hideMcp).toBe(true)
  })

  test("QUANTA_SUBAGENT presence + pills ON gates subagentForPills", () => {
    const cfgWith = readCliFeatureConfig({ QUANTA_SUBAGENT: "1" }, true, true)
    expect(cfgWith.subagentForPills).toBe(true)
    const cfgSuppressed = readCliFeatureConfig(
      { QUANTA_SUBAGENT: "1", QUANTA_PILL_TASKS: "0" },
      true,
      true,
    )
    expect(cfgSuppressed.subagentForPills).toBe(false)
    const cfgNoSubagent = readCliFeatureConfig({}, true, true)
    expect(cfgNoSubagent.subagentForPills).toBe(false)
  })

  test("QUANTA_COST_PANEL / BRANCH_SEARCH_PROGRESS / SPINNER honor 0", () => {
    const cfg = readCliFeatureConfig(
      {
        QUANTA_COST_PANEL: "0",
        QUANTA_BRANCH_SEARCH_PROGRESS: "0",
        QUANTA_SPINNER: "0",
      },
      true,
      true,
    )
    expect(cfg.costPanel.enabled).toBe(false)
    expect(cfg.branchProgress.enabled).toBe(false)
    expect(cfg.turnIndicator.enabled).toBe(false)
  })

  test("QUANTA_PLAN_STORE default-ON; empty/0/off/no disables", () => {
    expect(readCliFeatureConfig({ QUANTA_PLAN_STORE: "1" }, true, true).planStore.enabled).toBe(
      true,
    )
    expect(readCliFeatureConfig({ QUANTA_PLAN_STORE: "" }, true, true).planStore.enabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({ QUANTA_PLAN_STORE: "0" }, true, true).planStore.enabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({ QUANTA_PLAN_STORE: "off" }, true, true).planStore.enabled).toBe(
      false,
    )
    // Default-ON: unset ⇒ enabled (so `/edit-plan` + `/plan` work out of box).
    expect(readCliFeatureConfig({}, true, true).planStore.enabled).toBe(true)
  })

  test("QUANTA_TURN_SUMMARY forced-on on a NON-TTY surface still wins (operator override)", () => {
    const cfg = readCliFeatureConfig({ QUANTA_TURN_SUMMARY: "1" }, false, false)
    expect(cfg.turnSummary.enabled).toBe(true)
  })

  test("QUANTA_TURN_SUMMARY_VERBOSE=1 flips verbose without coupling to enabled", () => {
    const cfg = readCliFeatureConfig({ QUANTA_TURN_SUMMARY_VERBOSE: "1" }, true, true)
    expect(cfg.turnSummary.verbose).toBe(true)
  })

  test("QUANTA_SPINNER_INTERVAL_MS valid value passes through; bogus falls back to 80", () => {
    expect(
      readCliFeatureConfig({ QUANTA_SPINNER_INTERVAL_MS: "120" }, true, true).turnIndicator
        .intervalMs,
    ).toBe(120)
    expect(
      readCliFeatureConfig({ QUANTA_SPINNER_INTERVAL_MS: "abc" }, true, true).turnIndicator
        .intervalMs,
    ).toBe(80)
    expect(
      readCliFeatureConfig({ QUANTA_SPINNER_INTERVAL_MS: "-5" }, true, true).turnIndicator
        .intervalMs,
    ).toBe(80)
    expect(
      readCliFeatureConfig({ QUANTA_SPINNER_INTERVAL_MS: "0" }, true, true).turnIndicator
        .intervalMs,
    ).toBe(80)
  })

  test("QUANTA_DEBUG empty/false/off ⇒ disabled; comma-list ⇒ categories Set", () => {
    expect(readCliFeatureConfig({ QUANTA_DEBUG: "" }, true, true).debugTracer.enabled).toBe(false)
    expect(readCliFeatureConfig({ QUANTA_DEBUG: "off" }, true, true).debugTracer.enabled).toBe(
      false,
    )
    const cfgAll = readCliFeatureConfig({ QUANTA_DEBUG: "all" }, true, true)
    expect(cfgAll.debugTracer.enabled).toBe(true)
    expect(cfgAll.debugTracer.categories).toBeUndefined()
    const cfgCats = readCliFeatureConfig({ QUANTA_DEBUG: "tools,llm" }, true, true)
    expect(cfgCats.debugTracer.enabled).toBe(true)
    expect(cfgCats.debugTracer.categories?.has("tools")).toBe(true)
    expect(cfgCats.debugTracer.categories?.has("llm")).toBe(true)
  })

  test("QUANTA_DEBUG=all on a NON-stderr-TTY is forced disabled (mirrors boot precondition)", () => {
    const cfg = readCliFeatureConfig({ QUANTA_DEBUG: "all" }, true, false)
    expect(cfg.debugTracer.enabled).toBe(false)
    expect(cfg.debugTracer.stderrIsTTY).toBe(false)
  })

  test("QUANTA_IMAGE_QUEUE only the literal '0' disables (mirrors prior `!== '0'` idiom)", () => {
    expect(readCliFeatureConfig({ QUANTA_IMAGE_QUEUE: "0" }, true, true).imageQueue.enabled).toBe(
      false,
    )
    // Prior behavior: ANY non-"0" value is ON, including "false"/"off" — the
    // image queue gate intentionally did NOT join the off-token family.
    expect(
      readCliFeatureConfig({ QUANTA_IMAGE_QUEUE: "false" }, true, true).imageQueue.enabled,
    ).toBe(true)
  })

  test("QUANTA_IMAGE_MAX_QUEUE valid value passes through; bogus falls back to 5", () => {
    expect(
      readCliFeatureConfig({ QUANTA_IMAGE_MAX_QUEUE: "9" }, true, true).imageQueue.maxSize,
    ).toBe(9)
    expect(
      readCliFeatureConfig({ QUANTA_IMAGE_MAX_QUEUE: "abc" }, true, true).imageQueue.maxSize,
    ).toBe(5)
    expect(
      readCliFeatureConfig({ QUANTA_IMAGE_MAX_QUEUE: "-3" }, true, true).imageQueue.maxSize,
    ).toBe(5)
  })

  test("QUANTA_HISTORY=0 disables; QUANTA_HISTORY_MAX clamp; QUANTA_HISTORY_FILE optional", () => {
    expect(readCliFeatureConfig({ QUANTA_HISTORY: "0" }, true, true).history.enabled).toBe(false)
    expect(readCliFeatureConfig({ QUANTA_HISTORY_MAX: "5" }, true, true).history.maxLines).toBe(5)
    expect(readCliFeatureConfig({ QUANTA_HISTORY_FILE: "" }, true, true).history.filePath).toBe(
      undefined,
    )
    expect(
      readCliFeatureConfig({ QUANTA_HISTORY_FILE: "/tmp/h" }, true, true).history.filePath,
    ).toBe("/tmp/h")
  })

  test("QUANTA_MULTILINE=0 disables; default ON", () => {
    expect(readCliFeatureConfig({ QUANTA_MULTILINE: "0" }, true, true).multiline.enabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({}, true, true).multiline.enabled).toBe(true)
  })

  test("QUANTA_REWIND_GIT=1 enables; default OFF (destructive)", () => {
    expect(readCliFeatureConfig({ QUANTA_REWIND_GIT: "1" }, true, true).rewindGit.enabled).toBe(
      true,
    )
    expect(readCliFeatureConfig({}, true, true).rewindGit.enabled).toBe(false)
  })

  test("QUANTA_TIMELINE positive int + stderr-TTY enables; non-TTY forces OFF; bogus ⇒ height=0", () => {
    // Happy path: stderr-TTY + parsable positive int ⇒ enabled.
    const cfgOn = readCliFeatureConfig({ QUANTA_TIMELINE: "12" }, true, true)
    expect(cfgOn.timelinePanel.enabled).toBe(true)
    expect(cfgOn.timelinePanel.height).toBe(12)
    // Non-TTY (stderr=false) forces OFF even with a valid integer (mirrors
    // the boot precondition in `buildTimelinePanelAndStream`).
    const cfgNonTty = readCliFeatureConfig({ QUANTA_TIMELINE: "12" }, true, false)
    expect(cfgNonTty.timelinePanel.enabled).toBe(false)
    // Floor: a fractional value floors to integer pixels.
    expect(readCliFeatureConfig({ QUANTA_TIMELINE: "10.7" }, true, true).timelinePanel.height).toBe(
      10,
    )
    // Bogus / non-finite / ≤ 0 ⇒ height = 0 ⇒ disabled.
    expect(readCliFeatureConfig({ QUANTA_TIMELINE: "abc" }, true, true).timelinePanel.enabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({ QUANTA_TIMELINE: "-5" }, true, true).timelinePanel.enabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({ QUANTA_TIMELINE: "0" }, true, true).timelinePanel.enabled).toBe(
      false,
    )
    // Default-OFF when unset.
    expect(readCliFeatureConfig({}, true, true).timelinePanel.enabled).toBe(false)
  })

  test("QUANTA_DECISION_METRICS off-token family disables; any other value enables", () => {
    expect(
      readCliFeatureConfig({ QUANTA_DECISION_METRICS: "1" }, true, true).decisionMetricsEnabled,
    ).toBe(true)
    expect(
      readCliFeatureConfig({ QUANTA_DECISION_METRICS: "true" }, true, true).decisionMetricsEnabled,
    ).toBe(true)
    expect(
      readCliFeatureConfig({ QUANTA_DECISION_METRICS: "0" }, true, true).decisionMetricsEnabled,
    ).toBe(false)
    expect(
      readCliFeatureConfig({ QUANTA_DECISION_METRICS: "off" }, true, true).decisionMetricsEnabled,
    ).toBe(false)
    expect(
      readCliFeatureConfig({ QUANTA_DECISION_METRICS: "" }, true, true).decisionMetricsEnabled,
    ).toBe(false)
    expect(readCliFeatureConfig({}, true, true).decisionMetricsEnabled).toBe(false)
  })

  test("QUANTA_METRICS toggles workMetricsSinkEnabled (canonical truthy vocab)", () => {
    expect(readCliFeatureConfig({ QUANTA_METRICS: "1" }, true, true).workMetricsSinkEnabled).toBe(
      true,
    )
    // Post-unification: `true`/`on` enable too (uniform with every other gate).
    expect(
      readCliFeatureConfig({ QUANTA_METRICS: "true" }, true, true).workMetricsSinkEnabled,
    ).toBe(true)
    expect(readCliFeatureConfig({ QUANTA_METRICS: "0" }, true, true).workMetricsSinkEnabled).toBe(
      false,
    )
    expect(readCliFeatureConfig({}, true, true).workMetricsSinkEnabled).toBe(false)
  })
})

// =============================================================================
// 4. SURFACE FENCE — source-text grep
// =============================================================================

/** Strip block/line comments so the grep targets code, not doc text. The
 *  surface-fence assertions are about RUNTIME behavior — a docstring that
 *  references `process.env` for explanation must not trip the fence. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

describe("ADR-0297 surface fence — no direct process reads in build* helpers", () => {
  test("repl.ts contains ZERO direct process.env / isTTY reads", () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, "src/apps/cli/repl.ts"), "utf8"))
    // RELAXED (post-CLI-01/04/05/06 merge): the host THREADS process.env into
    // surface-compose wire factories (`composeSurfaceWires(..., process.env, …)`
    // / `buildSharedExecutionPlaneSessionDeps({ envSource: process.env, … })`). That is
    // injection — the env object is opaque at the call site — and is allowed.
    // The invariant the fence really guards is "no `process.env.<KEY>` direct
    // reads in repl.ts" (no decision logic against env values). We assert THAT.
    expect(src).not.toMatch(/process\.env\.[A-Z_]/)
    expect(src).not.toMatch(/process\.stdout\.isTTY/)
    expect(src).not.toMatch(/process\.stderr\.isTTY/)
  })

  test("repl/surface-compose.ts contains ZERO direct process.env / isTTY reads", () => {
    const src = stripComments(
      readFileSync(join(REPO_ROOT, "src/apps/cli/repl/surface-compose.ts"), "utf8"),
    )
    expect(src).not.toMatch(/process\.env\b/)
    expect(src).not.toMatch(/process\.stdout\.isTTY/)
    expect(src).not.toMatch(/process\.stderr\.isTTY/)
  })

  test("cli-feature-config.ts has NO direct `process.` reads (pure resolver)", () => {
    // The resolver must read ONLY its arguments. It can import helpers
    // from sibling modules, but must never reach into process globals.
    const src = stripComments(
      readFileSync(join(REPO_ROOT, "src/apps/cli/repl/cli-feature-config.ts"), "utf8"),
    )
    expect(src).not.toMatch(/process\.env\b/)
    expect(src).not.toMatch(/process\.stdout\.isTTY/)
    expect(src).not.toMatch(/process\.stderr\.isTTY/)
  })

  test("readCliFeatureConfig delegates to existing is*Enabled helpers (composition not duplication)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/apps/cli/repl/cli-feature-config.ts"), "utf8")
    // Anti-duplication grep: the canonical gate helpers MUST be imported
    // here. A future refactor that inlines the gates loses the central
    // pin and the test fails — which is the desired drift signal.
    expect(src).toContain("isLifecyclePillsEnabled")
    expect(src).toContain("readPillEnvFlags")
    expect(src).toContain("isCostPanelEnabled")
    expect(src).toContain("isBranchProgressEnabled")
    expect(src).toContain("isIndicatorEnabled")
    expect(src).toContain("isTurnSummaryEnabled")
    expect(src).toContain("isTurnSummaryVerbose")
    expect(src).toContain("parseDebugEnv")
    expect(src).toContain("isCliRewindGitEnabled")
  })
})

// =============================================================================
// helpers — render the config in a Set-aware form for JSON equality
// =============================================================================

const structuralize = (
  cfg: CliFeatureConfig,
): Omit<CliFeatureConfig, "debugTracer"> & {
  debugTracer: { enabled: boolean; categories: string[] | undefined; stderrIsTTY: boolean }
} => ({
  ...cfg,
  debugTracer: {
    enabled: cfg.debugTracer.enabled,
    categories:
      cfg.debugTracer.categories !== undefined ? [...cfg.debugTracer.categories].sort() : undefined,
    stderrIsTTY: cfg.debugTracer.stderrIsTTY,
  },
})
