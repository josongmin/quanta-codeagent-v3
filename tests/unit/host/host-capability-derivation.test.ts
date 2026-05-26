import { describe, expect, test } from "bun:test"
import { deriveCapabilityManifest } from "@/host/runtime"
import { createRuntimeContextBindingFromAgentConfigBase } from "@/host/runtime/internal/context-binding"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime/base"
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
    ...overrides,
  }) as RuntimeAgentConfigBase

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
})
