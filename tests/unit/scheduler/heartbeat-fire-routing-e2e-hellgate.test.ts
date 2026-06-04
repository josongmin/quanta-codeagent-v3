/**
 * H8 e2e — the runtime fire ROUTES a heartbeat onto its target thread + posture,
 * while a cron automation stays byte-identical (no thread/policy on the enqueue).
 *
 * Drives the REAL `createSchedulerRuntime().tickOnce()` against a due automation
 * and captures the exact `enqueueUserMessage` opts the agent loop receives.
 */

import { describe, expect, test } from "bun:test"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import type {
  AgentLoopPort,
  Automation,
  AutomationStorePort,
  ClockPort,
  EnvPort,
  HeartbeatPolicySnapshot,
  ModelAvailabilityPort,
} from "@/scheduler/types"

const ruleOf = (s: string) => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}
const FIRED_AT = Date.UTC(2026, 4, 3)
const POLICY: HeartbeatPolicySnapshot = {
  approvalPolicy: "on-request",
  sandboxPolicy: "read-only",
  collaborationMode: "pair",
}

const due = (over?: Partial<Automation>): Automation => ({
  ...createAutomation({
    id: "a1",
    title: "t",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "tick",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: Date.UTC(2026, 4, 1),
  }),
  ...over,
})

type EnqOpts = Parameters<AgentLoopPort["enqueueUserMessage"]>[1]

const run = async (automation: Automation): Promise<EnqOpts[]> => {
  let current = automation
  const captured: EnqOpts[] = []
  const store: AutomationStorePort = {
    load: async () => [current],
    save: async (_w, a) => {
      current = a
    },
    delete: async () => {},
  }
  const loop: AgentLoopPort = {
    enqueueUserMessage: async (_m, opts) => void captured.push(opts),
  }
  const clock: ClockPort = { now: () => FIRED_AT }
  const env: EnvPort = { get: () => undefined }
  const availability: ModelAvailabilityPort = { isAvailable: async () => true }
  const rt = createSchedulerRuntime({ store, availability, clock, env, agentLoop: loop, workspace: "/w" })
  await rt.tickOnce()
  return captured
}

describe("H8 — heartbeat fire routing", () => {
  test("a heartbeat fire carries targetThreadId + inheritedPolicy on the enqueue", async () => {
    const opts = await run(
      due({ kind: "heartbeat", targetThreadId: "thread-42", inheritedPolicy: POLICY }),
    )
    expect(opts.length).toBe(1)
    expect(opts[0]?.targetThreadId).toBe("thread-42")
    expect(opts[0]?.inheritedPolicy).toEqual(POLICY)
    expect(opts[0]?.modelOverride).toBe("gpt-5")
  })

  test("a cron automation is byte-identical: NO targetThreadId / inheritedPolicy", async () => {
    const opts = await run(due())
    expect(opts.length).toBe(1)
    expect(opts[0]?.targetThreadId).toBeUndefined()
    expect(opts[0]?.inheritedPolicy).toBeUndefined()
    // Only the legacy modelOverride is present.
    expect(Object.keys(opts[0] ?? {})).toEqual(["modelOverride"])
  })

  test("a heartbeat with NO targetThreadId degrades safely to a fresh fire (no routing)", async () => {
    // Defense-in-depth: validation rejects this at creation, but if a malformed
    // row reaches the fire path it must still fire (prompt runs) WITHOUT inventing
    // a thread route — the opts carry no targetThreadId.
    const opts = await run(due({ kind: "heartbeat", inheritedPolicy: POLICY }))
    expect(opts.length).toBe(1)
    expect(opts[0]?.targetThreadId).toBeUndefined()
  })
})
