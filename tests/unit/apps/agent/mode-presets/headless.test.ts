/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — headless mode-preset
 * runner contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"headless" req.mode.
 *   2. Missing/empty `req.headless.prompt` throws.
 *   3. The assembled cfg has modePolicy.mode === "headless", auto/acceptEdits
 *      permission, and exactly ONE user message containing the prompt.
 *   4. RunOutcome.exitCode maps from outcome.reason:
 *        completed/aborted → 0, error → 1, max_turns/budget_exhausted → 2.
 *   5. Test is hermetic — no real LLM, no real stdin.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/headless"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const recordingStream: StreamPort = { emit: () => undefined }

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "headless",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: recordingStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
  },
  headless: { prompt: "fix the bug" },
  ...over,
})

const fakeOutcome = (reason: AgentOutcome["reason"], msgs: Message[] = []): AgentOutcome => ({
  reason,
  turns: 1,
  messages: msgs,
})

describe("headless.runMode — guard", () => {
  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "batch" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "headless"/)
  })

  test("rejects a missing prompt", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately stripping a required field for the negative test.
    const req = { ...baseReq(), headless: undefined } as any
    await expect(runMode(req)).rejects.toThrow(/req.headless.prompt is required/)
  })

  test("rejects an empty prompt", async () => {
    const req = baseReq({ headless: { prompt: "   " } })
    await expect(runMode(req)).rejects.toThrow(/req.headless.prompt is required/)
  })
})

describe("headless.runMode — single-user-message config", () => {
  test("builds a config with exactly one user message containing the prompt", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    const out = await runMode(baseReq({ seams, headless: { prompt: "do X please" } }))
    expect(out.exitCode).toBe(0)
    expect(cfgSeen?.modePolicy?.mode).toBe("headless")
    expect(cfgSeen?.modePolicy?.permission.kind).toBe("auto")
    expect(cfgSeen?.messages.length).toBe(1)
    const first = cfgSeen?.messages[0]
    expect(first?.role).toBe("user")
    if (first && Array.isArray(first.content)) {
      const txt = first.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("")
      expect(txt).toBe("do X please")
    }
  })
})

describe("headless.runMode — exit-code mapping", () => {
  test("reason=completed → exitCode 0", async () => {
    const seams = { runAgent: async () => fakeOutcome("completed") }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(0)
  })

  test("reason=error → exitCode 1", async () => {
    const seams = { runAgent: async () => fakeOutcome("error") }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(1)
  })

  test("reason=max_turns → exitCode 2", async () => {
    const seams = { runAgent: async () => fakeOutcome("max_turns") }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(2)
  })

  test("reason=budget_exhausted → exitCode 2", async () => {
    const seams = { runAgent: async () => fakeOutcome("budget_exhausted") }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(2)
  })
})
