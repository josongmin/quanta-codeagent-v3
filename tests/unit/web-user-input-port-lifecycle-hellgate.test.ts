/**
 * QUANTA_WEB_AGENT_STATE — `createWebUserInputPort` lifecycle hellgate.
 *
 * The web-daemon's OUT-OF-BAND INBOUND port (mirror of the agent-state OUTBOUND
 * tap) lets a browser ANSWER a paused agent's `request_user_input` prompt. The
 * LOAD-BEARING invariant: a pending resolver MUST NOT leak and the agent's
 * `await` MUST NOT hang forever. This battery nails that contract:
 *
 *   - `resolve(id, outcome)` settles the awaiting promise with that outcome;
 *   - `cancelAll()` settles EVERY pending request with `{decision:"cancelled"}`
 *     AND leaves `pendingCount() === 0` (no leak);
 *   - a DOUBLE-resolve is a no-op: the 2nd `resolve` returns `false` and the
 *     promise settled exactly once (RED-ON-INJECTION: a port that double-settles
 *     fails the `settleCount === 1` teeth below);
 *   - `resolve(unknownId)` returns `false`;
 *   - `capture` is called for the request (`plan_user_input_requested`) AND the
 *     resolve (`plan_user_input_resolved`) with the exact shapes;
 *   - a THROWING `capture` does not break the request/resolve lifecycle.
 */

import { describe, expect, test } from "bun:test"
import { createWebUserInputPort } from "@/apps/web-daemon/web-user-input-port"
import type { AgentStateObservation } from "@/protocol/agent-state"

const req = (promptId: string, prompt = "pick one", choices?: readonly string[]) => ({
  promptId,
  prompt,
  ...(choices !== undefined ? { choices } : {}),
})

describe("createWebUserInputPort — lifecycle hellgate (QUANTA_WEB_AGENT_STATE)", () => {
  test("resolve delivers the answer outcome to the awaiting promise", async () => {
    const captured: AgentStateObservation[] = []
    const h = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    const promise = h.port(req("p1"))
    expect(h.pendingCount()).toBe(1)
    const ok = h.resolve("p1", { decision: "answer", text: "blue" })
    expect(ok).toBe(true)
    await expect(promise).resolves.toEqual({ decision: "answer", text: "blue" })
    expect(h.pendingCount()).toBe(0)
  })

  test("resolve delivers the cancelled outcome to the awaiting promise", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const promise = h.port(req("p2"))
    expect(h.resolve("p2", { decision: "cancelled" })).toBe(true)
    await expect(promise).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(0)
  })

  test("cancelAll resolves ALL pending with cancelled AND leaves pendingCount()===0 (no leak)", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const a = h.port(req("a"))
    const b = h.port(req("b"))
    const c = h.port(req("c"))
    expect(h.pendingCount()).toBe(3)
    h.cancelAll()
    // CRITICAL: no leaked resolver after cancelAll.
    expect(h.pendingCount()).toBe(0)
    await expect(a).resolves.toEqual({ decision: "cancelled" })
    await expect(b).resolves.toEqual({ decision: "cancelled" })
    await expect(c).resolves.toEqual({ decision: "cancelled" })
  })

  test("cancelAll on an empty port is a no-op (idempotent)", () => {
    const h = createWebUserInputPort({ capture: () => {} })
    expect(() => h.cancelAll()).not.toThrow()
    h.cancelAll()
    expect(h.pendingCount()).toBe(0)
  })

  test("double-resolve: 2nd resolve returns false and the promise settles ONCE (red-on-injection teeth)", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    let settleCount = 0
    let settledWith: unknown
    const promise = h.port(req("dup")).then((o) => {
      settleCount += 1
      settledWith = o
      return o
    })
    expect(h.resolve("dup", { decision: "answer", text: "first" })).toBe(true)
    // Second resolve must be a NO-OP (entry deleted before invoke).
    expect(h.resolve("dup", { decision: "answer", text: "second" })).toBe(false)
    // And a racing cancel after a resolve must also be a no-op.
    h.cancelAll()
    await promise
    // RED-ON-INJECTION: a port that double-settles makes settleCount > 1 here.
    expect(settleCount).toBe(1)
    expect(settledWith).toEqual({ decision: "answer", text: "first" })
    expect(h.pendingCount()).toBe(0)
  })

  test("resolve(unknownId) returns false", () => {
    const h = createWebUserInputPort({ capture: () => {} })
    expect(h.resolve("never-asked", { decision: "answer", text: "x" })).toBe(false)
  })

  test("capture is called for the request + resolve with the exact observation shapes", async () => {
    const captured: AgentStateObservation[] = []
    const h = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    const promise = h.port(req("q1", "which color?", ["red", "blue"]))
    // The request observation fires synchronously on port().
    expect(captured).toEqual([
      {
        type: "plan_user_input_requested",
        promptId: "q1",
        prompt: "which color?",
        choices: ["red", "blue"],
      },
    ])
    h.resolve("q1", { decision: "answer", text: "red" })
    await promise
    expect(captured[1]).toEqual({
      type: "plan_user_input_resolved",
      promptId: "q1",
      decision: "answer",
      text: "red",
    })
  })

  test("capture omits choices when the prompt offers none", () => {
    const captured: AgentStateObservation[] = []
    const h = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    void h.port(req("q2", "free text?"))
    expect(captured[0]).toEqual({
      type: "plan_user_input_requested",
      promptId: "q2",
      prompt: "free text?",
    })
    // No `choices` key when absent (exact shape).
    expect("choices" in (captured[0] as Record<string, unknown>)).toBe(false)
  })

  test("cancelled resolve emits a resolved observation WITHOUT a text field", async () => {
    const captured: AgentStateObservation[] = []
    const h = createWebUserInputPort({ capture: (ev) => captured.push(ev) })
    const promise = h.port(req("q3"))
    h.resolve("q3", { decision: "cancelled" })
    await promise
    expect(captured[1]).toEqual({
      type: "plan_user_input_resolved",
      promptId: "q3",
      decision: "cancelled",
    })
    expect("text" in (captured[1] as Record<string, unknown>)).toBe(false)
  })

  test("NO-THROW: a throwing capture does not break request or resolve", async () => {
    const h = createWebUserInputPort({
      capture: () => {
        throw new Error("hostile sink")
      },
    })
    // port() must still park a pending request despite the throwing capture.
    let promise: Promise<unknown> | undefined
    expect(() => {
      promise = h.port(req("boom"))
    }).not.toThrow()
    expect(h.pendingCount()).toBe(1)
    // resolve() must still settle the promise despite the throwing resolve-capture.
    expect(() => h.resolve("boom", { decision: "answer", text: "ok" })).not.toThrow()
    await expect(promise).resolves.toEqual({ decision: "answer", text: "ok" })
    expect(h.pendingCount()).toBe(0)
  })

  test("cancelTurn settles only that turn; sibling turn stays pending", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const a = h.port({ promptId: "a", prompt: "t1", turnId: "turn-1" })
    const b = h.port({ promptId: "b", prompt: "t2", turnId: "turn-2" })
    expect(h.cancelTurn("turn-1")).toBe(1)
    expect(h.pendingCount()).toBe(1)
    await expect(a).resolves.toEqual({ decision: "cancelled" })
    expect(h.resolve("a", { decision: "answer", text: "late" })).toBe(false)
    expect(h.resolve("b", { decision: "answer", text: "ok" })).toBe(true)
    await expect(b).resolves.toEqual({ decision: "answer", text: "ok" })
    expect(h.pendingCount()).toBe(0)
  })

  test("originating abort signal settles that request only", async () => {
    const h = createWebUserInputPort({ capture: () => {} })
    const ac = new AbortController()
    const a = h.port({ promptId: "sig-a", prompt: "t1", turnId: "t1", signal: ac.signal })
    const b = h.port({ promptId: "sig-b", prompt: "t2", turnId: "t2" })
    ac.abort()
    await expect(a).resolves.toEqual({ decision: "cancelled" })
    expect(h.pendingCount()).toBe(1)
    expect(h.resolve("sig-b", { decision: "answer", text: "kept" })).toBe(true)
    await expect(b).resolves.toEqual({ decision: "answer", text: "kept" })
  })
})
