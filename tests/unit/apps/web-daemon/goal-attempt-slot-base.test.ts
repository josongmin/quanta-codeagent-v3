/**
 * GOAL-08 — the web daemon's per-session config base carries the host-owned
 * attributed-attempt slot whenever it carries the objective authority, so a
 * web goal turn (autonomous or user-requested) is claimed → begun → settled
 * exactly like the CLI. Without the slot a web goal turn would be unattributed
 * (no budget movement, no receipt, no hard-cap consumption).
 */

import { describe, expect, test } from "bun:test"
import { createCanvasUsageSource } from "@/apps/web-daemon/canvas-usage-source"
import { buildAgentConfigBase } from "@/apps/web-daemon/runtime-factory/agent-config-base"
import { resolveWebLivePosture } from "@/apps/web-daemon/runtime-factory/session-collaborators"
import { wireSessionObservability } from "@/apps/web-daemon/runtime-factory/session-observability"
import { isObjectiveAttemptSlot } from "@/host/runtime/internal/context-binding/objective-settlement"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const CWD = "/tmp/quanta-web-goal-slot"

class StubLLM implements LLMPort {
  readonly model = "stub-model"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const buildBase = async (env: Record<string, string | undefined>) => {
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  const observability = wireSessionObservability(env, CWD, objective)
  const { permission } = await resolveWebLivePosture(env)
  const base = await buildAgentConfigBase({
    env,
    llm: new StubLLM(),
    artifactRegistry: undefined,
    askUserTools: [],
    mcpTools: [],
    permission,
    cwd: CWD,
    abort: new AbortController(),
    subagent: undefined,
    skills: undefined,
    planStore: undefined,
    usageHolder: createCanvasUsageSource(),
    canvasToolDiff: undefined,
    agentState: undefined,
    subagentSource: undefined,
    userInput: undefined,
    controlRequest: undefined,
    follower: undefined,
    observability,
    ...(objective !== undefined ? { objective } : {}),
  })
  return base as typeof base & { objectiveAttemptSlot?: unknown }
}

describe("GOAL-08 — web base composes the attributed-attempt slot with the objective", () => {
  test("objective present ⇒ a real attempt slot on the base", async () => {
    const base = await buildBase({ QUANTA_OBJECTIVE_TOOLS: "1" })
    expect(base.objective).toBeDefined()
    expect(isObjectiveAttemptSlot(base.objectiveAttemptSlot)).toBe(true)
  })
  test("objective absent ⇒ no slot (byte-identical default)", async () => {
    const base = await buildBase({})
    expect(base.objective).toBeUndefined()
    expect(base.objectiveAttemptSlot).toBeUndefined()
  })
})
