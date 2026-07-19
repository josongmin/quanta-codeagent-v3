/**
 * Ticket 04 (S4) — mid-turn token usage on the wire state view. The kernel
 * already accumulates `usage` events into `state.lastTokenUsage`; historically
 * `toSessionStateView` dropped it. This projects it, GATED on
 * `QUANTA_SESSION_FULL_FIDELITY` (default-OFF ⇒ absent ⇒ byte-identical).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createKernelSessionState } from "../../../src/kernel/session"
import { projectSessionHostTurnEvent } from "../../../src/kernel/session/session-host-turn-event-projection"
import { toSessionStateView } from "../../../src/kernel/session/state"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ tools: true })

const prior = process.env.QUANTA_SESSION_FULL_FIDELITY
afterEach(() => {
  if (prior === undefined) delete process.env.QUANTA_SESSION_FULL_FIDELITY
  else process.env.QUANTA_SESSION_FULL_FIDELITY = prior
})

const stateAfterUsage = () => {
  const initial = createKernelSessionState({
    sessionId: "s4",
    permissionMode: "default",
    capabilityManifest: manifest,
  })
  const projected = projectSessionHostTurnEvent({
    state: initial,
    commandId: "c1",
    emittedAt: "2026-07-16T00:00:00.000Z",
    event: { type: "usage", promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  })
  return projected.state
}

describe("S4 — SessionStateView.lastTokenUsage projection", () => {
  test("gate OFF (default): the state view has NO lastTokenUsage even after a usage event", () => {
    delete process.env.QUANTA_SESSION_FULL_FIDELITY
    const state = stateAfterUsage()
    // The kernel state STILL holds it (behavior unchanged upstream)…
    expect(state.lastTokenUsage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    })
    // …but the WIRE view omits it (byte-identical default-OFF).
    expect(toSessionStateView(state)).not.toHaveProperty("lastTokenUsage")
  })

  test("gate ON: the state view carries lastTokenUsage after a usage event", () => {
    process.env.QUANTA_SESSION_FULL_FIDELITY = "1"
    const state = stateAfterUsage()
    const view = toSessionStateView(state)
    expect(view.lastTokenUsage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
  })

  test("gate ON but NO usage yet: still absent (only present once usage arrives)", () => {
    process.env.QUANTA_SESSION_FULL_FIDELITY = "1"
    const initial = createKernelSessionState({
      sessionId: "s4",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    expect(toSessionStateView(initial)).not.toHaveProperty("lastTokenUsage")
  })
})
