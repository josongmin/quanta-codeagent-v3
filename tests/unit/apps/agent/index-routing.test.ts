/**
 * RFC may-22-unified-agent-runtime / Phase 4 — `runMain` routing contract.
 *
 * Pins:
 *  1. The dispatched mode-preset matches `--mode`.
 *  2. An AgentArgsError is mapped to stderr + exit 64 (EX_USAGE).
 *  3. `--help` short-circuits BEFORE any dispatcher is loaded.
 *  4. The dispatcher's `runMode` is awaited and its `exitCode` is forwarded.
 *
 * All effectful surfaces (stdout/stderr/exit/dispatcher) are injected; no
 * real `process.exit` or dynamic `import()` is hit.
 */
import { describe, expect, test } from "bun:test"
import { type ModeDispatcher, runMain, toAssembleRequest } from "@/../src/apps/agent/index"
import type { RunMode } from "@/agent"
import { pinHermeticBootCredential } from "../../../_support/boot-credential"

type Capture = {
  stdout: string
  stderr: string
  exitCode: number | undefined
  dispatcherLoadCount: number
  loadedModes: RunMode[]
  runModeCalls: number
}

const makeHarness = (
  outcomeExit: number,
): { deps: Parameters<typeof runMain>[0]; cap: Capture } => {
  const cap: Capture = {
    stdout: "",
    stderr: "",
    exitCode: undefined,
    dispatcherLoadCount: 0,
    loadedModes: [],
    runModeCalls: 0,
  }
  const dispatcher: ModeDispatcher = {
    runMode: async () => {
      cap.runModeCalls++
      return { exitCode: outcomeExit }
    },
  }
  return {
    cap,
    deps: {
      stdout: (s) => {
        cap.stdout += s
      },
      stderr: (s) => {
        cap.stderr += s
      },
      exit: (c) => {
        cap.exitCode = c
      },
      loadDispatcher: async (m) => {
        cap.dispatcherLoadCount++
        cap.loadedModes.push(m)
        return dispatcher
      },
    },
  }
}

// This suite builds a REAL boot port, so it must satisfy provider selection.
// It brings its own credential rather than borrowing the operator's — see the
// helper for the 13 cases this was silently hiding on a clean checkout.
pinHermeticBootCredential()

describe("runMain — routing", () => {
  test("--mode interactive routes to interactive dispatcher and forwards exitCode", async () => {
    const { deps, cap } = makeHarness(0)
    await runMain({ ...deps, argv: ["--mode", "interactive"] })
    expect(cap.loadedModes).toEqual(["interactive"])
    expect(cap.runModeCalls).toBe(1)
    expect(cap.exitCode).toBe(0)
  })

  test("--mode batch routes to batch dispatcher and forwards exitCode 2", async () => {
    const { deps, cap } = makeHarness(2)
    await runMain({
      ...deps,
      argv: ["--mode", "batch", "--corpus", "/x"],
    })
    expect(cap.loadedModes).toEqual(["batch"])
    expect(cap.exitCode).toBe(2)
  })

  test("AgentArgsError → stderr (with usage) + exit 64", async () => {
    const { deps, cap } = makeHarness(0)
    await runMain({ ...deps, argv: ["--unknown"] })
    expect(cap.exitCode).toBe(64)
    expect(cap.stderr).toContain("unknown flag '--unknown'")
    // formatHelp banner included in stderr after the error message.
    expect(cap.stderr).toContain("USAGE")
    // No dispatcher should have loaded.
    expect(cap.dispatcherLoadCount).toBe(0)
    expect(cap.runModeCalls).toBe(0)
  })

  test("--help short-circuits BEFORE any dispatcher load", async () => {
    const { deps, cap } = makeHarness(0)
    await runMain({ ...deps, argv: ["--help"] })
    expect(cap.stdout).toContain("USAGE")
    expect(cap.dispatcherLoadCount).toBe(0)
    expect(cap.runModeCalls).toBe(0)
    // help path does not call exit(); the entry simply returns.
    expect(cap.exitCode).toBeUndefined()
  })
})

describe("toAssembleRequest — projection", () => {
  test("strips help; preserves mode + dials + mode-specific fields", () => {
    const req = toAssembleRequest({
      mode: "batch",
      dials: { maxTurns: 7 },
      corpus: "/c",
      instance: "x",
      help: false,
    })
    expect(req.mode).toBe("batch")
    expect(req.dials).toEqual({ maxTurns: 7 })
    expect(req.corpus).toBe("/c")
    expect(req.instance).toBe("x")
  })

  test("omits undefined optional fields (exactOptionalPropertyTypes safe)", () => {
    const req = toAssembleRequest({
      mode: "interactive",
      dials: {},
      help: false,
    })
    expect(Object.hasOwn(req, "model")).toBe(false)
    expect(Object.hasOwn(req, "prompt")).toBe(false)
    expect(Object.hasOwn(req, "exhaustion")).toBe(false)
  })

  test("P26 — lifts outputFormat/includePartial when present", () => {
    const req = toAssembleRequest({
      mode: "headless",
      dials: {},
      prompt: "task",
      outputFormat: "stream-json",
      includePartial: true,
      help: false,
    })
    expect(req.outputFormat).toBe("stream-json")
    expect(req.includePartial).toBe(true)
  })

  test("P26 — omits outputFormat/includePartial when absent (byte-identical)", () => {
    const req = toAssembleRequest({
      mode: "headless",
      dials: {},
      prompt: "task",
      help: false,
    })
    expect(Object.hasOwn(req, "outputFormat")).toBe(false)
    expect(Object.hasOwn(req, "includePartial")).toBe(false)
  })
})
