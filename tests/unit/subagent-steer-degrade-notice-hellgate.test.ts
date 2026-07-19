/**
 * jul-18 subagent message-delivery — Item 1: steer delivery-receipt
 * observability wiring.
 *
 * `wireSteerPlane` (src/agent/optional-ports.ts) builds the steer plane's
 * finalization port. Its `onReceipt` sink was a NO-OP, so async steer
 * `SubagentDeliveryReceipt`s (degraded → queue, cancelled) were silently
 * discarded — an operator never saw a steer that fell back to the mailbox.
 * The fix routes `degraded`/`cancelled` receipts onto the existing GLOBAL
 * operator-notice bus (no new event type, no protocol cascade).
 *
 * This is a PURE WIRING pin driven through the REAL `wireSteerPlane`:
 *   1. degrade  → EXACTLY ONE warn notice (source:"subagent", reason in msg).
 *   2. applied  → ZERO notices (paired control — success is not an operator
 *                 signal; a multi-round steer would spam one per step).
 *   3. gates-off byte-identity → `wireSteerPlane` without `enableSteer` returns
 *                 the base identity (`===`), allocates no plane, emits nothing.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { wireSteerPlane } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"

// A minimal fake mailbox honoring `DeliveryMailboxPort.send` — the fallback path
// re-enqueues the retained envelope and reads back the message id.
const fakeMailbox = () => {
  let n = 0
  const sent: Array<{ from: string; to: string; body: string }> = []
  return {
    sent,
    send(init: { from: string; to: string; body: string }) {
      sent.push({ from: init.from, to: init.to, body: init.body })
      n += 1
      return { id: `msg-${n}` }
    },
  }
}

// Build the minimal base `wireSteerPlane` actually reads (`subagent` +
// `subagentMailbox`). Cast through Partial<AgentConfig> — the function only
// touches those two fields.
const steerBase = (mailbox: unknown): AgentConfig =>
  ({
    subagent: { enableSteer: true },
    subagentMailbox: mailbox,
  }) as unknown as AgentConfig

const notices: OperatorNotice[] = []

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  notices.length = 0
})

describe("steer delivery-receipt observability wiring (jul-18 Item 1)", () => {
  test("degrade → EXACTLY ONE warn notice with source:subagent + reason in message", () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const mailbox = fakeMailbox()
    const wired = wireSteerPlane(steerBase(mailbox))
    const plane = wired.subagent?.steerPlane
    if (plane === undefined) throw new Error("steer plane was not wired")

    plane.retention.retain("d1", { from: "childA", to: "childB", body: "hello peer" })
    plane.finalization.finalizeFallback("d1", "same_turn_budget_exhausted")

    const subWarns = notices.filter((n) => n.source === "subagent")
    expect(subWarns).toHaveLength(1)
    expect(subWarns[0]?.severity).toBe("warn")
    expect(subWarns[0]?.message).toContain("same_turn_budget_exhausted")
    // one mailbox fallback actually happened (the degrade is real, not spurious)
    expect(mailbox.sent).toHaveLength(1)
  })

  test("paired control: applied steer → ZERO notices (success is not an operator signal)", () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const mailbox = fakeMailbox()
    const wired = wireSteerPlane(steerBase(mailbox))
    const plane = wired.subagent?.steerPlane
    if (plane === undefined) throw new Error("steer plane was not wired")

    plane.retention.retain("d2", { from: "childA", to: "childB", body: "hi" })
    plane.finalization.finalizeApplied("d2", "turn-42")

    expect(notices).toHaveLength(0)
    // applied consumes the payload at the safe point — NO mailbox copy
    expect(mailbox.sent).toHaveLength(0)
  })

  test("cancelled → EXACTLY ONE info notice (session teardown of a pending steer is surfaced, not silent)", () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const mailbox = fakeMailbox()
    const wired = wireSteerPlane(steerBase(mailbox))
    const plane = wired.subagent?.steerPlane
    if (plane === undefined) throw new Error("steer plane was not wired")

    plane.retention.retain("d3", { from: "childA", to: "childB", body: "bye" })
    plane.finalization.finalizeCancelled("d3", "session_aborted")

    const subInfos = notices.filter((n) => n.source === "subagent")
    expect(subInfos).toHaveLength(1)
    expect(subInfos[0]?.severity).toBe("info")
    expect(subInfos[0]?.message).toContain("session_aborted")
    // cancelled ⇒ NO mailbox fallback (the child is gone; nothing to deliver)
    expect(mailbox.sent).toHaveLength(0)
  })

  test("gates-off byte-identity: no enableSteer ⇒ base identity, no plane, zero notices", () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const base = { subagentMailbox: fakeMailbox() } as unknown as AgentConfig
    const wired = wireSteerPlane(base)
    // no plane allocated → the onReceipt closure never exists
    expect(wired).toBe(base)
    expect(wired.subagent?.steerPlane).toBeUndefined()
    expect(notices).toHaveLength(0)
  })
})
