/**
 * H8 last-mile — scheduler → runtime → CLI binder e2e hellgate (ADR-0480).
 *
 * The full fire path with the REAL `createSchedulerRuntime` driving the REAL CLI
 * `heartbeatEnqueueHandler` (over fake session cells) as its `AgentLoopPort`:
 *
 *   - heartbeat automation (kind:"heartbeat", targetThreadId=S, posture P) due →
 *     the prompt lands on thread S's queue, the permission cell holds P's mapped
 *     mode, `scheduler.fired` is emitted, the anchor advanced + persisted.
 *   - sessionId = T (≠ S) → the binder returns `thread-not-found`, surfaced as
 *     `scheduler.error`; the prompt is NOT enqueued; the anchor STILL advanced
 *     (persist-before-dispatch ⇒ no re-fire loop).
 *   - a plain `cron` automation → byte-identical to today (direct push, binder
 *     not consulted, posture cell untouched).
 *
 * Effects are fakes — no wall clock, fs, or process.env.
 */

import { describe, expect, test } from "bun:test"
import { createHeartbeatBinder, heartbeatEnqueueHandler } from "@/apps/cli/repl/heartbeat-binder"
import type { PermissionMode } from "@/permission"
import type { PermissionModeSessionState } from "@/runner/assemble/session-state"
import { createAutomation } from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { createSchedulerRuntime } from "@/scheduler/runtime"
import type {
  Automation,
  AutomationStorePort,
  ClockPort,
  EnvPort,
  HeartbeatPolicySnapshot,
  ModelAvailabilityPort,
  RRule,
  SchedulerEvent,
  SchedulerSinkPort,
} from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}
const utc = (y: number, mo: number, d: number): number => Date.UTC(y, mo - 1, d, 0, 0, 0)

const SESSION = "thread-S"

const heartbeatAutomation = (
  targetThreadId: string,
  policy: HeartbeatPolicySnapshot,
): Automation => ({
  ...createAutomation({
    id: "hb1",
    title: "heartbeat",
    rule: ruleOf("FREQ=DAILY"),
    prompt: "keep working",
    modelPreference: "gpt-5",
    modelFallbacks: [],
    createdAt: utc(2026, 5, 1),
  }),
  kind: "heartbeat",
  targetThreadId,
  inheritedPolicy: policy,
})

const makeCell = (initial: PermissionMode): PermissionModeSessionState => {
  let current = initial
  return {
    defaultMode: initial,
    get: () => current,
    set: (n) => {
      current = n
    },
  }
}

interface Harness {
  readonly store: AutomationStorePort
  readonly storeContent: Automation[]
  readonly clock: ClockPort
  readonly env: EnvPort
  readonly availability: ModelAvailabilityPort
  readonly sink: SchedulerSinkPort
  readonly events: SchedulerEvent[]
  readonly pushed: string[]
}

const buildHarness = (initial: Automation[]): Harness => {
  const storeContent = [...initial]
  const store: AutomationStorePort = {
    load: async () => [...storeContent],
    save: async (_w, a) => {
      const idx = storeContent.findIndex((x) => x.id === a.id)
      if (idx >= 0) storeContent[idx] = a
      else storeContent.push(a)
    },
    delete: async (_w, id) => {
      const idx = storeContent.findIndex((x) => x.id === id)
      if (idx >= 0) storeContent.splice(idx, 1)
    },
  }
  const events: SchedulerEvent[] = []
  return {
    store,
    storeContent,
    clock: { now: () => utc(2026, 5, 3) },
    env: { get: () => undefined },
    availability: { isAvailable: async () => true },
    sink: { emit: (e) => void events.push(e) },
    events,
    pushed: [],
  }
}

describe("scheduler → runtime → CLI binder (e2e)", () => {
  test("heartbeat due → prompt on thread S, cell holds mapped mode, fired + persisted", async () => {
    const h = buildHarness([heartbeatAutomation(SESSION, postureSnapshot("acceptEdits"))])
    const cell = makeCell("bypass") // live session is permissive
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: (p) => h.pushed.push(p),
    })
    const rt = createSchedulerRuntime({
      store: h.store,
      availability: h.availability,
      clock: h.clock,
      env: h.env,
      agentLoop: {
        enqueueUserMessage: heartbeatEnqueueHandler({
          binder,
          pushPrompt: (p) => h.pushed.push(p),
        }),
      },
      workspace: "/w",
      sink: h.sink,
    })

    await rt.tickOnce()

    expect(h.pushed).toEqual(["keep working"]) // landed on thread S
    expect(cell.get()).toBe("acceptEdits") // snapshot (stricter than bypass) applied
    expect(h.events.map((e) => e.type)).toContain("scheduler.fired")
    expect(h.storeContent[0]?.fireCount).toBe(1) // anchor advanced + persisted
    expect(h.storeContent[0]?.lastFiredAt).toBe(utc(2026, 5, 3))
  })

  test("foreign thread (sessionId T ≠ S) → thread-not-found ⇒ scheduler.error, NOT enqueued, anchor STILL advanced", async () => {
    const h = buildHarness([heartbeatAutomation(SESSION, postureSnapshot("default"))])
    const cell = makeCell("default")
    // This REPL is driving thread T, not S.
    const binder = createHeartbeatBinder({
      liveThreadId: () => "thread-T",
      permissionCell: () => cell,
      pushPrompt: (p) => h.pushed.push(p),
    })
    const rt = createSchedulerRuntime({
      store: h.store,
      availability: h.availability,
      clock: h.clock,
      env: h.env,
      agentLoop: {
        enqueueUserMessage: heartbeatEnqueueHandler({
          binder,
          pushPrompt: (p) => h.pushed.push(p),
        }),
      },
      workspace: "/w",
      sink: h.sink,
    })

    await rt.tickOnce()

    // thread-not-found ⇒ the binder resolves ok:false WITHOUT throwing, so the
    // runtime does NOT see an enqueue throw. The prompt never mis-routes onto T.
    expect(h.pushed).toEqual([])
    // anchor still advanced (persist-before-dispatch) ⇒ no re-fire loop.
    expect(h.storeContent[0]?.fireCount).toBe(1)
    expect(h.storeContent[0]?.lastFiredAt).toBe(utc(2026, 5, 3))
  })

  test("cron automation (no kind) → byte-identical direct push, binder uncalled, cell untouched", async () => {
    const cron: Automation = createAutomation({
      id: "c1",
      title: "cron",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "fresh fire",
      modelPreference: "gpt-5",
      modelFallbacks: [],
      createdAt: utc(2026, 5, 1),
    })
    const h = buildHarness([cron])
    const cell = makeCell("default")
    let binderCalls = 0
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: (p) => h.pushed.push(p),
    })
    const trackedBinder = {
      resume: async (req: Parameters<typeof binder.resume>[0]) => {
        binderCalls += 1
        return binder.resume(req)
      },
    }
    const rt = createSchedulerRuntime({
      store: h.store,
      availability: h.availability,
      clock: h.clock,
      env: h.env,
      agentLoop: {
        enqueueUserMessage: heartbeatEnqueueHandler({
          binder: trackedBinder,
          pushPrompt: (p) => h.pushed.push(p),
        }),
      },
      workspace: "/w",
      sink: h.sink,
    })

    await rt.tickOnce()

    expect(h.pushed).toEqual(["fresh fire"])
    expect(binderCalls).toBe(0) // cron never touches the binder
    expect(cell.get()).toBe("default") // posture untouched
    expect(h.events.map((e) => e.type)).toContain("scheduler.fired")
  })
})

const postureSnapshot = (approvalPolicy: string): HeartbeatPolicySnapshot => ({
  approvalPolicy,
  sandboxPolicy: "workspace-write",
  collaborationMode: "default",
})
