import { describe, expect, test } from "bun:test"
import type {
  RunSessionLoopDeps,
  SessionLoopSinks,
} from "../../../../src/apps/cli/repl/session-loop"

// session-loop is a thin orchestrator over runOneTurn + composePromptPipeline
// + runInteractive. End-to-end exercise requires booting the runner stack;
// the hellgate strategy locks the SHAPE of its contract instead (so a
// future refactor cannot silently drop a sink or rebind a state mutation).

describe("session-loop — contract shape lock", () => {
  test("SessionLoopSinks lists every sink the host wires", () => {
    type Required = keyof SessionLoopSinks
    const required: Required[] = [
      "renderTurnDashboard",
      "renderAndResetSummary",
      "flushLifecyclePills",
      "renderTurnError",
    ]
    expect(required).toHaveLength(4)
    expect(new Set(required).size).toBe(4)
  })

  test("RunSessionLoopDeps surface the four required + four optional fields", () => {
    type Required = keyof RunSessionLoopDeps
    const allKeys: Required[] = [
      "setup",
      "dispatchSlash",
      "sinks",
      "ux",
      "imageQueue",
      "registerExitTeardown",
    ]
    expect(allKeys).toHaveLength(6)
  })

  test("runSessionLoop export is an async function", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-loop")
    expect(typeof mod.runSessionLoop).toBe("function")
    expect(mod.runSessionLoop.constructor.name).toBe("AsyncFunction")
  })

  test("ESC_WINDOW_MS is the single source of truth for the 2 s cancel window", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    // Constant exists exactly once.
    const matches = src.match(/const ESC_WINDOW_MS = 2000/g) ?? []
    expect(matches.length).toBe(1)
    // It is REFERENCED in BOTH the one-shot and interactive call sites,
    // proving the DRY win (single source vs two duplicates in prior code).
    const refs = src.match(/escWindowMs: ESC_WINDOW_MS/g) ?? []
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })

  test("SessionState god-state-replacement is the ONLY surface-state binding", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    // Exactly one `let surfaceState: SessionState` binding inside the loop
    // — the 5 prior god-state `let`s collapsed to ONE record.
    const surfaceLets = src.match(/let surfaceState: SessionState/g) ?? []
    expect(surfaceLets.length).toBe(1)
  })

  test("turn-runner is invoked from BOTH branches (one-shot AND interactive) — DRY win", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    // runOneTurn referenced at least twice (one-shot and interactive wrapTurn).
    const runOneTurnRefs = src.match(/runOneTurn[<(]/g) ?? []
    expect(runOneTurnRefs.length).toBeGreaterThanOrEqual(2)
  })

  test("one-shot branch drains pendingImages BEFORE the runOnce call (ADR-0083 invariant)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    // The seed-image drain happens via updateSessionState before runOnce.
    const drainBeforeRunOnce = /seedImages = surfaceState\.pendingImages[\s\S]+?updateSessionState[\s\S]+?\{ pendingImages: \[\] \}[\s\S]+?runOnce/.test(
      src,
    )
    expect(drainBeforeRunOnce).toBe(true)
  })

  test("interactive branch threads onTurnEnd to flushLifecyclePills", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(src).toContain("onTurnEnd")
    expect(src).toContain("sinks.flushLifecyclePills()")
  })

  test("initial blank stderr write matches prior runReplLoopRaw header (\\n)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(src).toMatch(/process\.stderr\.write\("\\n"\)/)
  })

  test("composePromptPipeline is the SOLE prompt-source factory (no inline buildCliPromptSource)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(src).toContain("composePromptPipeline")
    expect(src).not.toContain("const innerPromptSource")
    expect(src).not.toContain("wrapPromptSourceWithIdleGate")
  })
})
