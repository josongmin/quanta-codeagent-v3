/**
 * RFC-01 A3 — attention producer LEAF units (천공카드: leaf, no build).
 *
 * Covers the pure producer pieces:
 *   - `questionOwnerFor` — explicit spawnedAsTaskId → owner; NO inference.
 *   - `bindBrokerUserInputPort` — publishes synchronously, maps every
 *     QuestionOutcome arm, cancels on abort in finally.
 *   - `buildUserInputBlock` gating — registers the tool when EITHER the legacy
 *     userInputPort OR the broker is wired; absent both ⇒ undefined (OFF
 *     byte-identical).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildUserInputBlock } from "@/agent/tier1"
import { bindBrokerUserInputPort, questionOwnerFor } from "@/agent/user-question"
import { createUserQuestionBroker } from "@/session/user-question"

describe("questionOwnerFor — explicit correlation only", () => {
  test("undefined spawnedAsTaskId ⇒ root owner", () => {
    expect(questionOwnerFor(undefined)).toEqual({ kind: "root" })
  })
  test("present spawnedAsTaskId ⇒ exact task owner (no inference)", () => {
    expect(questionOwnerFor("task_x")).toEqual({ kind: "task", taskId: "task_x" })
  })
})

describe("bindBrokerUserInputPort — the producer adapter", () => {
  test("publishes synchronously before settling, with the bound owner + preview", async () => {
    const broker = createUserQuestionBroker()
    const port = bindBrokerUserInputPort(broker, { kind: "task", taskId: "task_a" })
    const p = port({ promptId: "pid", prompt: "hello?" })
    // Synchronous publish: visible immediately, before any await.
    const pending = broker.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.owner).toEqual({ kind: "task", taskId: "task_a" })
    expect(pending[0]?.preview).toBe("hello?")
    const rid = pending[0]?.requestId
    if (!rid) throw new Error("no rid")
    broker.answer(rid, { text: "world" }, broker.revision())
    expect(await p).toEqual({ decision: "answer", text: "world" })
  })

  test("declined ⇒ cancelled outcome", async () => {
    const broker = createUserQuestionBroker()
    const port = bindBrokerUserInputPort(broker, { kind: "root" })
    const p = port({ promptId: "pid", prompt: "q" })
    const rid = broker.listPending()[0]?.requestId
    if (!rid) throw new Error("no rid")
    broker.decline(rid, broker.revision())
    expect(await p).toEqual({ decision: "cancelled" })
  })

  test("broker cancel ⇒ cancelled outcome", async () => {
    const broker = createUserQuestionBroker()
    const port = bindBrokerUserInputPort(broker, { kind: "root" })
    const p = port({ promptId: "pid", prompt: "q" })
    const rid = broker.listPending()[0]?.requestId
    if (!rid) throw new Error("no rid")
    broker.cancel(rid, "superseded", broker.revision())
    expect(await p).toEqual({ decision: "cancelled" })
  })

  test("abort signal cancels the pending in finally (no leak)", async () => {
    const broker = createUserQuestionBroker()
    const ac = new AbortController()
    const port = bindBrokerUserInputPort(broker, { kind: "task", taskId: "t" }, ac.signal)
    const p = port({ promptId: "pid", prompt: "q" })
    expect(broker.listPending()).toHaveLength(1)
    ac.abort()
    expect(await p).toEqual({ decision: "cancelled" })
    expect(broker.listPending()).toHaveLength(0)
  })

  test("choices + multiline are forwarded into the broker request preview path", async () => {
    const broker = createUserQuestionBroker()
    const port = bindBrokerUserInputPort(broker, { kind: "root" })
    const p = port({ promptId: "pid", prompt: "pick", choices: ["a", "b"], multiline: true })
    expect(broker.listPending()).toHaveLength(1)
    broker.cancelAll("teardown")
    await p
  })
})

describe("buildUserInputBlock — registration gating", () => {
  const cfg = (over: Partial<AgentConfig>): AgentConfig => over as AgentConfig

  test("neither port nor broker ⇒ undefined (OFF byte-identical)", () => {
    expect(buildUserInputBlock(cfg({}))).toBeUndefined()
  })
  test("legacy userInputPort present ⇒ registered", () => {
    expect(
      buildUserInputBlock(cfg({ userInputPort: async () => ({ decision: "cancelled" }) })),
    ).toBeDefined()
  })
  test("questionBroker present ⇒ registered", () => {
    expect(buildUserInputBlock(cfg({ questionBroker: createUserQuestionBroker() }))).toBeDefined()
  })
})
