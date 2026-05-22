/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — ci-bot mode-preset runner
 * contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"ci-bot" req.mode.
 *   2. Missing `req.ciBot.pr` throws.
 *   3. `buildCiBotWiring` produces a restricted ToolRegistry (git tools only;
 *      no `bash`, no `write_file`).
 *   4. `runMode` calls gh pr view BEFORE runAgent (PR context fetched into the
 *      first user message) and gh pr comment AFTER runAgent.
 *   5. The assembled cfg has modePolicy.mode === "ci-bot" + gitWrite=branch-only.
 *   6. Test is hermetic — no real `gh`, no real LLM.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { buildCiBotWiring, runMode } from "@/../src/apps/agent/mode-presets/ci-bot"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const recordingStream: StreamPort = { emit: () => undefined }

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "ci-bot",
  base: {
    llm: fakeLlm,
    // ci-bot owns its registry; this one is a placeholder the preset replaces.
    registry: undefined as unknown as AgentConfig["registry"],
    stream: recordingStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
  },
  ciBot: { pr: "owner/repo#42" },
  ...over,
})

const fakeOutcome = (
  reason: AgentOutcome["reason"],
  text = "ci-bot summary text",
): AgentOutcome => ({
  reason,
  turns: 2,
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text }] },
  ],
})

const okGh = async () => ({ stdout: '{"title":"x"}', stderr: "", exitCode: 0 })

describe("ci-bot.runMode — guard", () => {
  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "headless" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "ci-bot"/)
  })

  test("rejects a missing pr", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately stripping a required field for the negative test.
    const req = { ...baseReq(), ciBot: undefined } as any
    await expect(runMode(req)).rejects.toThrow(/req.ciBot.pr is required/)
  })
})

describe("buildCiBotWiring — restricted tool surface", () => {
  test("registry contains git tools but NEITHER bash NOR write_file", () => {
    const wiring = buildCiBotWiring({ ghRun: okGh })
    const names = wiring.tools.specs().map((s) => s.name)
    expect(names).toContain("git_diff")
    expect(names).toContain("git_status")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("write_file")
    expect(wiring.tools.has("bash")).toBe(false)
    expect(wiring.tools.has("git_diff")).toBe(true)
  })

  test("ghRun seam is used in place of the real gh", async () => {
    let argsSeen: string[] | undefined
    const wiring = buildCiBotWiring({
      ghRun: async (a) => {
        argsSeen = a
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const result = await wiring.gh(["pr", "view", "1"])
    expect(result.stdout).toBe("ok")
    expect(argsSeen).toEqual(["pr", "view", "1"])
  })
})

describe("ci-bot.runMode — gh + runAgent flow", () => {
  test("calls gh pr view BEFORE runAgent, gh pr comment AFTER", async () => {
    const ghCalls: string[][] = []
    let runAgentCalledAfterView = false
    const seams = {
      ghRun: async (args: string[]) => {
        ghCalls.push(args)
        return { stdout: '{"title":"t"}', stderr: "", exitCode: 0 }
      },
      runAgent: async () => {
        // gh pr view must already have run.
        runAgentCalledAfterView = ghCalls.some((a) => a[0] === "pr" && a[1] === "view")
        return fakeOutcome("completed")
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(runAgentCalledAfterView).toBe(true)
    // gh pr view first, gh pr comment second
    expect(ghCalls[0]?.[0]).toBe("pr")
    expect(ghCalls[0]?.[1]).toBe("view")
    expect(ghCalls[ghCalls.length - 1]?.[0]).toBe("pr")
    expect(ghCalls[ghCalls.length - 1]?.[1]).toBe("comment")
    expect(out.exitCode).toBe(0)
  })

  test("PR context from gh pr view is folded into the agent's first user message", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      ghRun: async () => ({ stdout: "PR-JSON-PAYLOAD", stderr: "", exitCode: 0 }),
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams }))
    const firstMsg = cfgSeen?.messages[0]
    expect(firstMsg?.role).toBe("user")
    const txt =
      firstMsg && Array.isArray(firstMsg.content)
        ? firstMsg.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("")
        : ""
    expect(txt).toContain("PR-JSON-PAYLOAD")
    expect(txt).toContain("owner/repo#42")
  })

  test("assembled cfg has modePolicy.mode === ci-bot, gitWrite=branch-only", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      ghRun: okGh,
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    await runMode(baseReq({ seams }))
    expect(cfgSeen?.modePolicy?.mode).toBe("ci-bot")
    expect(cfgSeen?.modePolicy?.gitWrite.kind).toBe("branch-only")
    expect(cfgSeen?.modePolicy?.output.kind).toBe("github-check")
  })

  test("error reason maps to exitCode 1", async () => {
    const seams = {
      ghRun: okGh,
      runAgent: async () => fakeOutcome("error"),
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(1)
  })

  test("aborted reason maps to exitCode 130", async () => {
    const seams = {
      ghRun: okGh,
      runAgent: async () => fakeOutcome("aborted"),
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(130)
  })
})
