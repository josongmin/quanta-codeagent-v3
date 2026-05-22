/**
 * ADR-0092 (C1) — DAEMON mode-preset runner contract.
 *
 * Pins the runtime wiring of the `daemon` cell (matrix coverage is in
 * anti-regression-invariants.test.ts; THIS file proves the runner assembles +
 * dispatches a single scheduled-service task):
 *   1. `runMode` rejects a non-"daemon" req.mode.
 *   2. modePolicy.mode === "daemon" with auto permission + branch-only git
 *      (daemon + ci-bot are the only two branch-only modes) + structured output.
 *   3. branch_search default-ON (ADR-0084): N=3, tsc+lint+lsp_diag, worktree.
 *   4. A caller-supplied `req.base.branchSearch` is preserved.
 *   5. RunOutcome.exitCode routes through the canonical `exitCodeForOutcome`.
 *   6. Hermetic — the `runAgent` seam is faked.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/daemon"
import type { AgentConfig, AgentOutcome, BranchSearchConfig } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const recordingStream: StreamPort = { emit: () => undefined }

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "daemon",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: recordingStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [{ role: "user", content: [{ type: "text", text: "nightly review" }] }] as Message[],
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

describe("daemon.runMode — guard", () => {
  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "headless" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "daemon"/)
  })
})

describe("daemon.runMode — config assembly", () => {
  test("modePolicy.mode === 'daemon' with auto permission + branch-only git + structured output", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(0)
    expect(cfgSeen?.modePolicy?.mode).toBe("daemon")
    expect(cfgSeen?.modePolicy?.permission.kind).toBe("auto")
    expect(cfgSeen?.modePolicy?.gitWrite.kind).toBe("branch-only")
    expect(cfgSeen?.modePolicy?.output.kind).toBe("structured")
  })

  test("branch_search is default-ON: N=3, tsc+lint+lsp_diag, worktree", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams }))
    expect(cfgSeen?.branchSearch?.defaultN).toBe(3)
    expect(cfgSeen?.branchSearch?.defaultVerifierKinds).toEqual(["tsc", "lint", "lsp_diag"])
    expect(cfgSeen?.branchSearch?.isolation).toBe("worktree")
  })

  test("caller-supplied branchSearch overrides the daemon default", async () => {
    const override: BranchSearchConfig = {
      defaultN: 5,
      defaultVerifierKinds: ["lint"],
      timeoutPerBranchMs: 2000,
      isolation: "worktree",
    }
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams, base: { ...baseReq().base, branchSearch: override } }))
    expect(cfgSeen?.branchSearch?.defaultN).toBe(5)
    expect(cfgSeen?.branchSearch?.defaultVerifierKinds).toEqual(["lint"])
  })
})

describe("daemon.runMode — exit-code mapping (canonical table)", () => {
  test("reason=completed → exitCode 0", async () => {
    const seams = { runAgent: async () => fakeOutcome("completed") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(0)
  })

  test("reason=error → exitCode 1", async () => {
    const seams = { runAgent: async () => fakeOutcome("error") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(1)
  })

  test("reason=budget_exhausted → exitCode 2", async () => {
    const seams = { runAgent: async () => fakeOutcome("budget_exhausted") }
    expect((await runMode(baseReq({ seams }))).exitCode).toBe(2)
  })
})
