/**
 * ADR-0092 (C1) — IDE mode-preset runner contract.
 *
 * Pins the runtime wiring of the `ide` cell (the matrix/preset coverage lives
 * in anti-regression-invariants.test.ts; THIS file proves the runner actually
 * assembles + dispatches):
 *   1. `runMode` rejects a non-"ide" req.mode.
 *   2. The assembled cfg carries modePolicy.mode === "ide" with the
 *      reviewer-backed permission lever (ide + interactive are the only two).
 *   3. branch_search is default-ON (ADR-0084): N=3, tsc+lint, worktree.
 *   4. A caller-supplied `req.base.branchSearch` is preserved (not overridden).
 *   5. RunOutcome.exitCode routes through the canonical `exitCodeForOutcome`.
 *   6. Hermetic — the `runAgent` seam is faked, no real LLM/loop.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/ide"
import type { AgentConfig, AgentOutcome, BranchSearchConfig } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const recordingStream: StreamPort = { emit: () => undefined }

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "ide",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: recordingStream,
    permission: { mode: "default" } as PermissionContext,
    messages: [{ role: "user", content: [{ type: "text", text: "edit this" }] }] as Message[],
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
  },
  ...over,
})

const fakeOutcome = (reason: AgentOutcome["reason"]): AgentOutcome => ({
  reason,
  turns: 1,
  messages: [],
})

describe("ide.runMode — guard", () => {
  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "batch" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "ide"/)
  })
})

describe("ide.runMode — config assembly", () => {
  test("modePolicy.mode === 'ide' with reviewer-backed permission + structured output", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(0)
    expect(cfgSeen?.modePolicy?.mode).toBe("ide")
    expect(cfgSeen?.modePolicy?.permission.kind).toBe("reviewer-backed")
    expect(cfgSeen?.modePolicy?.output.kind).toBe("structured")
  })

  test("branch_search is default-ON: N=3, tsc+lint, worktree", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams }))
    expect(cfgSeen?.branchSearch?.defaultN).toBe(3)
    expect(cfgSeen?.branchSearch?.defaultVerifierKinds).toEqual(["tsc", "lint"])
    expect(cfgSeen?.branchSearch?.isolation).toBe("worktree")
  })

  test("caller-supplied branchSearch overrides the ide default", async () => {
    const override: BranchSearchConfig = {
      defaultN: 7,
      defaultVerifierKinds: ["tsc"],
      timeoutPerBranchMs: 1000,
      isolation: "in-process",
    }
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams, base: { ...baseReq().base, branchSearch: override } }))
    expect(cfgSeen?.branchSearch?.defaultN).toBe(7)
    expect(cfgSeen?.branchSearch?.isolation).toBe("in-process")
  })
})

describe("ide.runMode — exit-code mapping (canonical table)", () => {
  test("reason=completed → exitCode 0", async () => {
    const seams = { runAgent: async () => fakeOutcome("completed") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(0)
  })

  test("reason=error → exitCode 1", async () => {
    const seams = { runAgent: async () => fakeOutcome("error") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(1)
  })

  test("reason=aborted → exitCode 130", async () => {
    const seams = { runAgent: async () => fakeOutcome("aborted") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(130)
  })
})
