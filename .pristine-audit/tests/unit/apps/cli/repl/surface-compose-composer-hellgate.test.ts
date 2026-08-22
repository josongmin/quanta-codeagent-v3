import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import type { RuntimeSideConversationResult } from "@/sdk/runtime"
import { makeFakeSessionSetup } from "../_cli-fakes"

const sideResult: RuntimeSideConversationResult = {
  outcome: { reason: "completed", turns: 1, messages: [] },
  answerText: "side answer",
  inputTokens: 0,
  outputTokens: 0,
  toolsAvailable: 0,
}

const compose = (env: NodeJS.ProcessEnv = {}) => {
  const setup = makeFakeSessionSetup()
  const convStore = defaultConversationCheckpointStore()
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  return { setup, convStore, wires: composeSurfaceWires(setup, state, env, { convStore }) }
}

describe("REPL surface composer — live composition root", () => {
  test("default-off root retains shared session holders and late-binds side chat", async () => {
    const { setup, convStore, wires } = compose()
    expect(wires.convStore).toBe(convStore)
    expect(wires.convCheckpointWire).toBeNull()
    expect(wires.convCheckpointSlot).toBeUndefined()
    expect(wires.runtimeFacadeCompose.objective).toBe(wires.objectiveStore)
    expect(wires.runtimeFacadeCompose.onPromptAssembled).toBe(setup.contextUsageHolder.sink)
    expect(wires.promptAssembledSink).toBe(setup.contextUsageHolder.sink)
    expect(wires.contextUsageView()).toBeUndefined()

    const side = wires.slashCtx.side?.()
    expect(side?.isWired()).toBe(false)
    expect(await side?.start({ question: "before", signal: setup.abort.signal })).toBe("not-wired")

    wires.setSideConversationStart(async () => sideResult)
    expect(side?.isWired()).toBe(true)
    expect(await side?.start({ question: "after", signal: setup.abort.signal })).toBe(sideResult)
  })

  test("enabled root shares the same conversation checkpoint wire and mode store", () => {
    const { wires } = compose({ QUANTA_CHECKPOINT_CONV: "on", QUANTA_MODE_CYCLE: "1" })
    const convCheckpointWire = wires.convCheckpointWire
    expect(convCheckpointWire).not.toBeNull()
    if (convCheckpointWire === null) throw new Error("checkpoint wire should be enabled")
    expect(wires.convCheckpointSlot?.wire).toBe(convCheckpointWire)
    expect(wires.modeCycleStore).toBeDefined()
    expect(wires.slashCtx.composerEdit).toBeDefined()
    expect(wires.slashCtx.textInbox).toBe(wires.textInbox)
  })
})
