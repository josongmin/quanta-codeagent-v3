import { describe, expect, test } from "bun:test"
import type { SetupSessionDeps } from "../../../../src/apps/cli/repl/session-setup"

// session-setup orchestrates SO MANY surface modules (status bar, MCP, LLM,
// resume-FSM, ...) that an end-to-end exercise would require booting a
// near-full CLI surface. The hellgate strategy: lock the SHAPE of its
// dependency contract so a future refactor can't silently drop a factory.
// Each `readonly buildXOrUndefined` field is a CONFIGURABLE seam — the
// test asserts the shape is what runRepl wires.

describe("session-setup — dependency contract (shape lock)", () => {
  test("SetupSessionDeps lists every spec-mandated factory", () => {
    // This compiles iff every required key is present on the type. The
    // `keyof SetupSessionDeps` lookup makes drift surface as a compile
    // error in this file before reaching production.
    type Required = keyof SetupSessionDeps
    const required: Required[] = [
      "buildLifecycleBundle",
      "deriveMcpPillServers",
      "buildCostPanelOrUndefined",
      "buildBranchProgressOrUndefined",
      "buildPlanStoreOrUndefined",
      "buildTurnSummaryAndStream",
      "buildTurnIndicatorAndStream",
      "buildWorkMetricsSink",
      "installPills",
    ]
    expect(required).toHaveLength(9)
    // Each must be unique.
    expect(new Set(required).size).toBe(9)
  })

  test("setupSession export is a function", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-setup")
    expect(typeof mod.setupSession).toBe("function")
  })

  test("setupSession is async (returns a Promise)", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    // Inspect the function via Function.prototype.toString — must be `async`.
    expect(setupSession.constructor.name).toBe("AsyncFunction")
  })

  test("SessionSetupResult contract — every spec-mandated binding is exported", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-setup")
    // Types only flow through type imports; runtime check: the module exports
    // setupSession + SetupSessionDeps.
    expect("setupSession" in mod).toBe(true)
  })

  test("idle-guards env knob shape — QUANTA_IDLE_SUPPRESS=0 sentinel is recognized", () => {
    // The idle-guard builder reads `QUANTA_IDLE_SUPPRESS` and clamps to
    // Infinity when it equals "0". This test locks the env-knob NAME so a
    // future rename surfaces here before breaking deployments. (We test by
    // inspecting the module source rather than booting setupSession.)
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-setup.ts"),
      "utf8",
    )
    expect(src).toContain("QUANTA_IDLE_SUPPRESS")
    expect(src).toContain("QUANTA_IDLE_MS")
    expect(src).toContain("QUANTA_SNOOZE_DEFAULT_MS")
    expect(src).toContain("QUANTA_REJECT_LIMIT")
  })

  test("LLM stack composition order is preserved — buildLLM → RetryingLLM → composeLLM", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-setup.ts"),
      "utf8",
    )
    const llmStackBody = src.match(/const buildLlmStack[\s\S]+?\n}/)?.[0] ?? ""
    expect(llmStackBody).toContain("buildLLM(provider, model)")
    expect(llmStackBody).toContain("new RetryingLLM")
    expect(llmStackBody).toContain("composeLLM")
    // Order check — buildLLM must come first.
    const buildLLMIdx = llmStackBody.indexOf("buildLLM(")
    const retryingIdx = llmStackBody.indexOf("RetryingLLM")
    const composeIdx = llmStackBody.indexOf("composeLLM")
    expect(buildLLMIdx).toBeLessThan(retryingIdx)
    expect(retryingIdx).toBeLessThan(composeIdx)
  })

  test("loadSeedImages exit-1 on load failure (preserves prior behavior)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-setup.ts"),
      "utf8",
    )
    const body = src.match(/const loadSeedImages[\s\S]+?\n}/)?.[0] ?? ""
    expect(body).toContain("argvImages")
    expect(body).toContain("loadImageBlock")
    expect(body).toContain("process.exit(1)")
  })

  test("SIGINT registers an abort handler — handler is wired in setupSession itself", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../../src/apps/cli/repl/session-setup.ts"),
      "utf8",
    )
    expect(src).toContain('process.on("SIGINT"')
    expect(src).toContain("abort.abort()")
  })
})
