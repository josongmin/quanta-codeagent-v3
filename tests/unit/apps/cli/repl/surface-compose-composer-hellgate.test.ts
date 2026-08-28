import { afterEach, describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createSurfaceState } from "@/apps/cli/repl/surface-compose"
import { composeSurfaceWires } from "@/apps/cli/repl/surface-compose/composer"
import type { RuntimeSideConversationResult } from "@/sdk/runtime"
import {
  cleanupHermeticQuantaHomes,
  hermeticQuantaHomeEnv,
} from "../../../../_support/hermetic-quanta-home"
import { makeFakeSessionSetup } from "../_cli-fakes"

const sideResult: RuntimeSideConversationResult = {
  outcome: { reason: "completed", turns: 1, messages: [] },
  answerText: "side answer",
  inputTokens: 0,
  outputTokens: 0,
  toolsAvailable: 0,
}

afterEach(cleanupHermeticQuantaHomes)

/** `env = {}` is NOT hermetic: `quantaHomeDirFrom({})` resolves to the
 *  developer's real `~/.quanta`, and the composed surface both READS a persisted
 *  `/model` pick from there at boot and would WRITE one on a set. Every case here
 *  gets a scratch home instead (see the helper's header for the measurement). */
const compose = (env: NodeJS.ProcessEnv = {}) => {
  const setup = makeFakeSessionSetup()
  const convStore = defaultConversationCheckpointStore()
  const state = createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })
  return {
    setup,
    convStore,
    wires: composeSurfaceWires(setup, state, hermeticQuantaHomeEnv(env), { convStore }),
  }
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

  test("goal pursuit alone wires one live-turn holder without the conversation-action queue", () => {
    const { wires } = compose({ QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_GOAL_ENFORCE: "1" })
    expect(wires.runtimeFacadeCompose.activeTurnRef).toBeDefined()
    expect(wires.runtimeFacadeCompose.conversationActionPort).toBeUndefined()
  })

  test("conversation actions and goal pursuit share exactly one live-turn holder", () => {
    const { wires } = compose({
      QUANTA_CONVERSATION_ACTIONS: "1",
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_GOAL_ENFORCE: "1",
    })
    expect(wires.conversationActions).toBeDefined()
    expect(wires.runtimeFacadeCompose.activeTurnRef).toBe(wires.conversationActions?.activeTurnRef)
    expect(wires.runtimeFacadeCompose.conversationActionPort).toBe(wires.conversationActions?.port)
  })

  test("default-off surface does not allocate a live-turn holder", () => {
    const { wires } = compose()
    expect(wires.runtimeFacadeCompose.activeTurnRef).toBeUndefined()
  })
})
