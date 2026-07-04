import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createOnConfirmReviewerPort } from "@/agent"
import { defaultModeVariantRegistry } from "@/agent/system-prompt"
import { defaultToolProfileResolver } from "@/agent/tool-profile"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import { deriveCapabilityManifest } from "@/host/runtime"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import type { LLMPort, StreamEvent } from "@/llm"
import { createIdentityModeSessionState, createToolProfileSessionState } from "@/runner/assemble"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime/base"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime/context"
import { ToolRegistry } from "@/tool"

const fakeToolRegistry = (count: number): ToolRegistry =>
  new ToolRegistry(
    Array.from({ length: count }, (_, index) => ({
      name: `tool-${index}`,
      description: "test",
      inputSchema: {} as never,
      execute: async function* () {
        yield* []
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })) as never,
  )

const makeBase = (overrides: Partial<RuntimeAgentConfigBase> = {}): RuntimeAgentConfigBase =>
  ({
    llm: {} as never,
    registry: fakeToolRegistry(0),
    stream: { emit: () => undefined },
    permission: { mode: "default" } as never,
    system: "system",
    cwd: "/tmp/test",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...overrides,
  }) as RuntimeAgentConfigBase

class ScriptedLLM implements LLMPort {
  private cursor = 0

  constructor(private readonly scripts: ReadonlyArray<readonly StreamEvent[]>) {}

  async *stream(): AsyncIterable<StreamEvent> {
    const events = this.scripts[this.cursor] ?? []
    this.cursor += 1
    for (const event of events) yield event
  }
}

const approvalTool = (runs: { count: number }) =>
  ({
    name: "bash",
    description: "approval test tool",
    inputSchema: z.object({ command: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    extractShellCommand: (input: { command: string }) => input.command,
    execute: async function* () {
      runs.count += 1
      yield {
        type: "result",
        result: { ok: true, output: "shell ok" },
      }
    },
  }) as const

describe("host runtime capability derivation", () => {
  test("public derivation freezes normalized host truth", () => {
    const manifest = deriveCapabilityManifest({
      approvals: false,
      tools: true,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: true,
    })

    expect(manifest).toEqual({
      approvals: "none",
      tools: true,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: true,
      transport: "inproc",
    })
    expect(Object.isFrozen(manifest)).toBe(true)
  })

  test("runtime session host describes capabilities from bound runtime features", async () => {
    const withoutApprovalBinding = createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
    const withoutApprovalHost = await withoutApprovalBinding
      .createRuntimeHost({
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    expect(withoutApprovalHost.describe().capabilityManifest).toEqual({
      approvals: "none",
      tools: false,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: false,
      shellSnapshot: false,
      transport: "inproc",
    })

    const withApprovalBinding = createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase({
        registry: fakeToolRegistry(1),
        onConfirm: async () => true,
        automationEngine: {} as never,
        shellSnapshot: {} as never,
      }),
    })
    const withApprovalHost = await withApprovalBinding
      .createRuntimeHost({
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    const manifest = withApprovalHost.describe().capabilityManifest
    expect(manifest).toEqual({
      approvals: "operator",
      tools: true,
      memory: false,
      artifacts: false,
      subagents: false,
      automation: true,
      shellSnapshot: true,
      transport: "inproc",
    })
    expect(Object.isFrozen(manifest)).toBe(true)
  })

  test("A2 — artifacts capability is TRUE iff the artifact store is wired onto the base", async () => {
    const describeManifest = async (base: RuntimeAgentConfigBase) => {
      const host = await createRuntimeContextBindingFromAgentConfigBase({ base })
        .createRuntimeHost({
          history: [],
          state: undefined,
          idMeta: undefined,
          shutdown: async () => undefined,
        })
        .createSessionHost({})
      return host.describe().capabilityManifest
    }

    // Store OFF (no registry) ⇒ artifacts:false (byte-identical default-OFF).
    const off = await describeManifest(makeBase())
    expect(off.artifacts).toBe(false)

    // Store ON (registry lifted onto the base) ⇒ artifacts:true. Mirrors the
    // adjacent memory/subagents presence pattern.
    const on = await describeManifest(
      makeBase({
        artifactRegistry: createArtifactRegistry({
          now: () => 1,
          idFactory: monotonicIdFactory("art"),
        }),
      }),
    )
    expect(on.artifacts).toBe(true)
    // No other capability flipped as a side-effect of wiring the registry.
    expect({ ...on, artifacts: false }).toEqual(off)
  })

  test("runtime session host surfaces approval requests and replays the approved action once", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "tool_use_start", id: "t1", name: "bash" },
        { type: "tool_use_delta", id: "t1", delta: '{"command":"touch /tmp/out.txt"}' },
        { type: "tool_use_end", id: "t1", input: { command: "touch /tmp/out.txt" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "tool_use_start", id: "t1", name: "bash" },
        { type: "tool_use_delta", id: "t1", delta: '{"command":"touch /tmp/out.txt"}' },
        { type: "tool_use_end", id: "t1", input: { command: "touch /tmp/out.txt" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    const toolRuns = { count: 0 }
    const surfaceConfirmCalls = { count: 0 }
    const confirmSlot = {
      current: async (_action: unknown) => {
        surfaceConfirmCalls.count += 1
        return true
      },
    }
    const base = {
      ...makeBase({
        llm,
        registry: new ToolRegistry([approvalTool(toolRuns)] as never),
        permission: { mode: "default" } as never,
        onConfirm: async (action) => await confirmSlot.current(action),
        admissibility: {
          reviewerPort: createOnConfirmReviewerPort({
            onConfirm: async (action) => await confirmSlot.current(action),
          }),
          defaultReviewer: "user",
        } as never,
      }),
      approvalProtocol: { confirmSlot },
    } as RuntimeAgentConfigBase
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })

    let session: Awaited<ReturnType<typeof runtime.createSession>> | undefined
    try {
      session = await runtime.createSession({ cwd: "/tmp/test", permissionMode: "default" })
      await session.input.append("write the file")

      const pending = await session.turn.run()
      expect(pending.turn?.approvalRequest).toEqual({
        approvalId: expect.any(String),
        reason: "terminal.needs_approval",
        requestedAt: expect.any(String),
      })
      expect(toolRuns.count).toBe(0)
      expect(surfaceConfirmCalls.count).toBe(0)

      const approvalId = pending.turn?.approvalRequest?.approvalId
      if (approvalId === undefined) throw new Error("approval id missing from pending turn")
      await session.approval.respond(approvalId, "approve")

      const completed = await session.turn.run()
      expect(completed.turn?.approvalRequest).toBeUndefined()
      expect(completed.turn?.outcome.reason).toBe("completed")
      expect(toolRuns.count).toBe(1)
      expect(surfaceConfirmCalls.count).toBe(0)
    } finally {
      await session?.close().catch(() => undefined)
      await runtime.close().catch(() => undefined)
    }
  })

  test("invalid identity mode is ignored and does not refresh the system prompt", async () => {
    const identityModeState = createIdentityModeSessionState({
      registry: defaultModeVariantRegistry(),
      defaultMode: "default",
    })
    const refreshCalls = { count: 0 }
    const host = await createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
      .createRuntimeHost({
        boot: {
          refreshSystemPrompt: () => {
            refreshCalls.count += 1
          },
          identityModeState,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    try {
      await host.setIdentityMode?.("bogus")
      expect(identityModeState.get()).toBe("default")
      expect(host.describe().identityMode).toBe("default")
      expect(refreshCalls.count).toBe(0)
    } finally {
      await host.close()
    }
  })

  test("valid identity mode updates authority state and refreshes exactly once", async () => {
    const identityModeState = createIdentityModeSessionState({
      registry: defaultModeVariantRegistry(),
      defaultMode: "default",
    })
    const refreshCalls = { count: 0 }
    const host = await createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
      .createRuntimeHost({
        boot: {
          refreshSystemPrompt: () => {
            refreshCalls.count += 1
          },
          identityModeState,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    try {
      await host.setIdentityMode?.("plan")
      expect(identityModeState.get()).toBe("plan")
      expect(host.describe().identityMode).toBe("plan")
      expect(refreshCalls.count).toBe(1)
    } finally {
      await host.close()
    }
  })

  test("onboarding identity mode updates authority state and refreshes exactly once", async () => {
    const identityModeState = createIdentityModeSessionState({
      registry: defaultModeVariantRegistry(),
      defaultMode: "default",
    })
    const refreshCalls = { count: 0 }
    const host = await createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
      .createRuntimeHost({
        boot: {
          refreshSystemPrompt: () => {
            refreshCalls.count += 1
          },
          identityModeState,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    try {
      await host.setIdentityMode?.("onboarding")
      expect(identityModeState.get()).toBe("onboarding")
      expect(identityModeState.getPromptMode()).toBe("default")
      expect(host.describe().identityMode).toBe("onboarding")
      expect(refreshCalls.count).toBe(1)
    } finally {
      await host.close()
    }
  })

  test("invalid tool profile is ignored", async () => {
    const toolProfileState = createToolProfileSessionState({
      resolver: defaultToolProfileResolver(),
      defaultName: "write",
    })
    const host = await createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
      .createRuntimeHost({
        boot: {
          refreshSystemPrompt: () => undefined,
          toolProfileState,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    try {
      await host.setToolProfile?.("bogus")
      expect(toolProfileState.get()).toBe("write")
      expect(host.describe().toolProfile).toBe("write")
    } finally {
      await host.close()
    }
  })

  test("valid tool profile updates authority state", async () => {
    const toolProfileState = createToolProfileSessionState({
      resolver: defaultToolProfileResolver(),
      defaultName: "write",
    })
    const host = await createRuntimeContextBindingFromAgentConfigBase({
      base: makeBase(),
    })
      .createRuntimeHost({
        boot: {
          refreshSystemPrompt: () => undefined,
          toolProfileState,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      .createSessionHost({})

    try {
      await host.setToolProfile?.("ask")
      expect(toolProfileState.get()).toBe("ask")
      expect(host.describe().toolProfile).toBe("ask")
    } finally {
      await host.close()
    }
  })
})
