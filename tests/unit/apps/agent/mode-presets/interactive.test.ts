/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — interactive mode-preset
 * runner contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"interactive" req.mode.
 *   2. With `seams.runAgent` stub, the real REPL is NEVER invoked.
 *   3. With `seams.runRepl` stub, the REPL is delegated to the stub.
 *   4. Returned RunOutcome carries `exitCode` (and `outcome?` when runAgent fires).
 *   5. The assembled config (visible via seams.runAgent's captured cfg) has
 *      modePolicy.mode === "interactive" and reviewer-backed permission.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/interactive"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = {
  model: "test",
  stream: async function* () {
    yield { type: "message_stop", stop_reason: "end_turn" as const }
  },
} as unknown as LLMPort

const recordingStream: StreamPort = { emit: () => undefined }

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "interactive",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: recordingStream,
    permission: { mode: "default" } as PermissionContext,
    messages: [],
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

describe("interactive.runMode — guard", () => {
  test("source uses the runtime SDK instead of @/runner#runInteractive", () => {
    const src = readFileSync(
      new URL("../../../../../src/apps/agent/mode-presets/interactive.ts", import.meta.url),
      "utf8",
    )
    expect(src).toContain('from "@/sdk/runtime"')
    expect(src).not.toContain("createLegacyRunnerSessionHost(")
    expect(src).not.toContain("runInteractive(")
    expect(src).not.toContain("buildInteractiveOptionalDeps")
  })

  test("rejects a wrong req.mode", async () => {
    const req = { ...baseReq(), mode: "headless" as const }
    await expect(runMode(req)).rejects.toThrow(/req.mode must be "interactive"/)
  })
})

describe("interactive.runMode — hermetic via seams.runAgent", () => {
  test("uses seams.runAgent and skips the real REPL", async () => {
    let cfgSeen: AgentConfig | undefined
    const seams = {
      runAgent: async (cfg: AgentConfig) => {
        cfgSeen = cfg
        return fakeOutcome("completed")
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(0)
    expect(out.outcome?.reason).toBe("completed")
    expect(cfgSeen).toBeDefined()
    expect(cfgSeen?.modePolicy?.mode).toBe("interactive")
    expect(cfgSeen?.modePolicy?.permission.kind).toBe("reviewer-backed")
    expect(cfgSeen?.budgetMeter).toBeDefined()
  })

  test("maps reason=error to exitCode=1", async () => {
    const seams = { runAgent: async () => fakeOutcome("error") }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(1)
  })

  test("verify axis WIRING: QUANTA_VERIFY_AFTER_EDIT=1 threads verify-after-edit into cfg.system", async () => {
    // Proves the GENERAL-surface verify knob is not inert: with no pre-built
    // base.system the interactive fallback composes the GENERAL profile + the knob,
    // so cfg.system carries [R-VERIFY-AFTER-EDIT]. OFF (unset) ⇒ absent (byte-identical).
    const prev = process.env.QUANTA_VERIFY_AFTER_EDIT
    const capture = async (): Promise<string> => {
      let seen: AgentConfig | undefined
      const req = baseReq({
        seams: {
          runAgent: async (cfg: AgentConfig) => {
            seen = cfg
            return fakeOutcome("completed")
          },
        },
      })
      delete (req.base as { system?: string }).system // force the fallback path (?? fires)
      await runMode(req)
      return String(seen?.system)
    }
    try {
      process.env.QUANTA_VERIFY_AFTER_EDIT = "1"
      expect(await capture()).toContain("[R-VERIFY-AFTER-EDIT]")
      delete process.env.QUANTA_VERIFY_AFTER_EDIT
      expect(await capture()).not.toContain("[R-VERIFY-AFTER-EDIT]")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_VERIFY_AFTER_EDIT
      else process.env.QUANTA_VERIFY_AFTER_EDIT = prev
    }
  })

  test("createRuntimeFromAgentConfigBase preserves the live optional session slots", async () => {
    const systemSource = { get: () => "SYS", set: () => undefined }
    const toolProfileState = { get: () => "write", set: () => undefined } as never
    const identityModeState = { get: () => "review", set: () => undefined } as never
    const focusChain = {
      tracker: {
        tickTurn: () => undefined,
        getInjection: () => undefined,
        setTodos: () => undefined,
        peekInjection: () => undefined,
        getDriftWarning: () => undefined,
        markDone: () => undefined,
        markDropped: () => undefined,
        clearTurnState: () => undefined,
      },
      reinjectEveryN: 3,
    } as never
    const stage1OutputsStore = { put: () => undefined } as never
    const granularRegistry = { register: () => undefined } as never
    const base = {
      llm: fakeLlm,
      registry: new ToolRegistry(defaultTools),
      stream: recordingStream,
      permission: { mode: "default" } as PermissionContext,
      messages: [],
      system: "SYS",
      systemSource,
      cwd: "/tmp",
      maxTurns: 5,
      signal: new AbortController().signal,
      sessionId: "interactive-test-session",
      planMode: false,
      sessionCtx: "ctx",
      stage1OutputsStore,
      toolProfileState,
      identityModeState,
      focusChain,
      granularRegistry,
    } as unknown as RuntimeAgentConfigBase

    const { runtimeContext, runtime } = await createRuntimeFromAgentConfigBase({
      base,
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })

    expect(runtimeContext.toolProfileState()).toBe(toolProfileState)
    expect(runtimeContext.identityModeState()).toBe(identityModeState)
    expect(runtimeContext.focusChain()).toBe(focusChain)
    await runtime.close()
  })
})

describe("interactive.runMode — REPL delegate", () => {
  test("invokes seams.runRepl when no seams.runAgent is set", async () => {
    let called = 0
    const seams = {
      runRepl: async () => {
        called += 1
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(called).toBe(1)
    expect(out.exitCode).toBe(0)
    expect(out.outcome).toBeUndefined()
  })

  test("converts AbortError to exitCode 130", async () => {
    const seams = {
      runRepl: async () => {
        const e = new Error("aborted") as Error & { code?: string }
        e.name = "AbortError"
        throw e
      },
    }
    const out = await runMode(baseReq({ seams }))
    expect(out.exitCode).toBe(130)
  })

  test("re-throws non-abort errors", async () => {
    const seams = {
      runRepl: async () => {
        throw new Error("fatal config error")
      },
    }
    await expect(runMode(baseReq({ seams }))).rejects.toThrow(/fatal config error/)
  })
})
