/**
 * UUX-2-17 (jul-10 W4) — the daemon side of ask_user chip structure.
 *
 * The web user-input port's `plan_user_input_requested` observation (and the
 * `plan.input.requested` wire message projected from it) must carry the
 * OPTIONAL `choiceDetails` alongside the label-only `choices`, so the browser
 * can render description subtext under each chip. Absent details ⇒ the
 * observation and the wire frame are byte-identical to the pre-fix shape
 * (label-only clients / senders unaffected).
 *
 * (The full request/resolve lifecycle is pinned by
 * tests/unit/web-user-input-port-lifecycle-hellgate.test.ts — this file only
 * pins the NEW passthrough.)
 */

import { describe, expect, it } from "bun:test"
import { type AgentStateObservation, agentStateObservationToMessage } from "@/protocol/agent-state"
import { createWebUserInputPort } from "./web-user-input-port"

describe("web-user-input-port — choiceDetails passthrough (UUX-2-17)", () => {
  it("the requested observation carries choiceDetails when the caller provides them", async () => {
    const captured: AgentStateObservation[] = []
    const handle = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    const pending = handle.port({
      promptId: "p1",
      prompt: "How to integrate?",
      choices: ["merge", "rebase"],
      choiceDetails: [{ label: "merge" }, { label: "rebase", description: "replay commits" }],
    })
    expect(captured[0]).toEqual({
      type: "plan_user_input_requested",
      promptId: "p1",
      prompt: "How to integrate?",
      choices: ["merge", "rebase"],
      choiceDetails: [{ label: "merge" }, { label: "rebase", description: "replay commits" }],
    })
    handle.resolve("p1", { decision: "cancelled" })
    await pending
  })

  it("no choiceDetails ⇒ the observation is byte-identical to the pre-fix shape", async () => {
    const captured: AgentStateObservation[] = []
    const handle = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    const pending = handle.port({ promptId: "p2", prompt: "q", choices: ["a"] })
    expect(captured[0]).toEqual({
      type: "plan_user_input_requested",
      promptId: "p2",
      prompt: "q",
      choices: ["a"],
    })
    expect(Object.hasOwn(captured[0] ?? {}, "choiceDetails")).toBe(false)
    handle.resolve("p2", { decision: "cancelled" })
    await pending
  })

  it("the wire projection carries choiceDetails onto plan.input.requested (and omits it when absent)", () => {
    const withDetails = agentStateObservationToMessage(
      {
        type: "plan_user_input_requested",
        promptId: "p3",
        prompt: "q",
        choices: ["a", "b"],
        choiceDetails: [{ label: "a", description: "first" }, { label: "b" }],
      },
      { emittedAt: 7 },
    )
    expect(withDetails).toEqual({
      kind: "plan.input.requested",
      promptId: "p3",
      prompt: "q",
      choices: ["a", "b"],
      choiceDetails: [{ label: "a", description: "first" }, { label: "b" }],
      emittedAt: 7,
    })

    const without = agentStateObservationToMessage(
      { type: "plan_user_input_requested", promptId: "p4", prompt: "q", choices: ["a"] },
      { emittedAt: 7 },
    )
    expect(Object.hasOwn(without, "choiceDetails")).toBe(false)
  })
})
