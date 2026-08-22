/**
 * QUANTA_WEB_AGENT_STATE — OUT-OF-BAND INBOUND port end-to-end.
 *
 * Drives the web-daemon's `createWebUserInputPort` through the FULL ask→answer
 * and ask→cancel lifecycles the way the server does: the agent calls `port(req)`
 * (the `request_user_input` seam), an inbound frame is resolved via the handle's
 * `resolve(promptId, …)` (the `message()` peek), or a disconnect drives
 * `cancelAll()` (the `close()` callback). Asserts the awaited outcome AND that
 * the request/resolve observations are forwarded to the agent-state sink (the
 * browser sees both halves of the loop).
 *
 * Sister to `request-user-input-e2e.test.ts` (the in-loop tool side); this
 * exercises the web seam that supplies the port.
 */

import { describe, expect, test } from "bun:test"
import { createWebUserInputPort } from "@/apps/web-daemon/web-user-input-port"
import type { AgentStateObservation } from "@/protocol/agent-state"

describe("web user-input port — end-to-end (QUANTA_WEB_AGENT_STATE)", () => {
  test("request → resolve(answer) yields {decision:'answer',text} + forwards both observations", async () => {
    const sink: AgentStateObservation[] = []
    const handle = createWebUserInputPort({ capture: (ev) => sink.push(ev) })

    // The agent asks (the `request_user_input` tool seam).
    const awaited = handle.port({
      promptId: "e2e-answer",
      prompt: "Which branch should I take?",
      choices: ["main", "dev"],
    })
    // The browser saw the request and can render the answer affordance.
    expect(sink[0]).toEqual({
      type: "plan_user_input_requested",
      promptId: "e2e-answer",
      prompt: "Which branch should I take?",
      choices: ["main", "dev"],
    })
    expect(handle.pendingCount()).toBe(1)

    // An inbound `planInputAnswer` frame resolves it (the server `message()` peek).
    const resolved = handle.resolve("e2e-answer", { decision: "answer", text: "dev" })
    expect(resolved).toBe(true)

    // The agent's await settles with the operator's reply.
    await expect(awaited).resolves.toEqual({ decision: "answer", text: "dev" })
    // The browser saw the resolve (clears its pending card).
    expect(sink[1]).toEqual({
      type: "plan_user_input_resolved",
      promptId: "e2e-answer",
      decision: "answer",
      text: "dev",
    })
    expect(handle.pendingCount()).toBe(0)
  })

  test("request → cancelAll (disconnect) yields {decision:'cancelled'} + no leaked resolver", async () => {
    const sink: AgentStateObservation[] = []
    const handle = createWebUserInputPort({ capture: (ev) => sink.push(ev) })

    const awaited = handle.port({ promptId: "e2e-cancel", prompt: "anything?" })
    expect(handle.pendingCount()).toBe(1)

    // The socket dropped before anyone answered (the server `close()` callback).
    handle.cancelAll()

    await expect(awaited).resolves.toEqual({ decision: "cancelled" })
    // Agent never hangs: cancelled is forwarded + the map is empty (no leak).
    expect(sink.at(-1)).toEqual({
      type: "plan_user_input_resolved",
      promptId: "e2e-cancel",
      decision: "cancelled",
    })
    expect(handle.pendingCount()).toBe(0)
  })
})
