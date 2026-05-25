/**
 * Playbook inline-trigger DISPATCH hellgate (ADR-0240).
 *
 * Pins the `startPlaybookAutoDispatch` orchestrator + the composition-root
 * `startPlaybookFromTrigger` bridge + the `adaptPlanQueueStoreToSink`
 * `PlanQueueStore` adapter — the slice that closes the ADR-0203 gap (the
 * inline-trigger watcher detected marker hits but the `onFire` callback was
 * caller-supplied and unwired in the composition root — so no actual
 * dispatch occurred).
 *
 * The 14 cases (closed-port memory watcher; no fs touch):
 *
 *  HELL-PBD-01  enabled:false ⇒ NOOP controller; no watcher started.
 *  HELL-PBD-02  enabled:true + sinkful + matching marker ⇒ ONE enqueue
 *               carrying `/play <name>`, source="inline_trigger", metadata
 *               with playbook/path/line/marker keys.
 *  HELL-PBD-03  enabled:true + NO sink ⇒ dispatchCount increments, but the
 *               outcome is `no-sink` (graceful degradation).
 *  HELL-PBD-04  registration WITHOUT a trigger ⇒ silently skipped (active
 *               count excludes it).
 *  HELL-PBD-05  multiple registrations fire INDEPENDENTLY — same fire on
 *               two playbooks with matching globs ⇒ two enqueues.
 *  HELL-PBD-06  glob mismatch on per-playbook trigger.watchGlob ⇒ no fire.
 *  HELL-PBD-07  orchestrator watchGlobs filter (broader gate) — fire that
 *               passes per-playbook glob but FAILS watchGlobs ⇒ outcome is
 *               `filtered`, no enqueue.
 *  HELL-PBD-08  sink rejection (typed ok:false) ⇒ outcome is sink-rejected
 *               with the rejection reason preserved; no throw.
 *  HELL-PBD-09  sink throwing ⇒ also surfaces as sink-rejected (no-throw
 *               public surface invariant).
 *  HELL-PBD-10  observer (onDispatch) sees EVERY attempt — including
 *               no-sink + filtered; throwing observer is swallowed.
 *  HELL-PBD-11  controller.stop() is idempotent + releases all handles.
 *  HELL-PBD-12  startPlaybookFromTrigger(undefined) returns NOOP controller.
 *  HELL-PBD-13  debounce window respected — second fire within window is
 *               coalesced (no second enqueue).
 *  HELL-PBD-14  adaptPlanQueueStoreToSink: real PlanQueueStore.enqueue is
 *               invoked with the playbook follow-up shape; throw surfaces
 *               as `{ok:false, reason}`.
 */

import { describe, expect, test } from "bun:test"
import type { FollowUp, PlanQueueStore } from "@/agent/plan-queue"
import {
  adaptPlanQueueStoreToSink,
  createMemoryWatcher,
  type DispatchResult,
  type PlaybookFollowUpInput,
  type PlaybookPlanQueueSink,
  type PlaybookRegistration,
  type PlaybookRegistry,
  startPlaybookAutoDispatch,
  startPlaybookFromTrigger,
} from "@/skill/playbook"

// ─── Tiny rig helpers ───────────────────────────────────────────────────────

const reg = (
  name: string,
  trigger: { commentMarker: string; watchGlob: string } | undefined,
): PlaybookRegistration =>
  trigger === undefined ? { name, frontmatter: {} } : { name, frontmatter: { trigger } }

const registry = (regs: PlaybookRegistration[]): PlaybookRegistry => ({
  list: () => regs,
})

interface RecordingSink {
  readonly sink: PlaybookPlanQueueSink
  readonly enqueued: PlaybookFollowUpInput[]
}

const recordingSink = (): RecordingSink => {
  const enqueued: PlaybookFollowUpInput[] = []
  return {
    enqueued,
    sink: {
      enqueue: (input) => {
        enqueued.push(input)
        return { ok: true }
      },
    },
  }
}

const rejectingSink = (reason: string): PlaybookPlanQueueSink => ({
  enqueue: () => ({ ok: false, reason }),
})

const throwingSink = (msg: string): PlaybookPlanQueueSink => ({
  enqueue: () => {
    throw new Error(msg)
  },
})

// ─── Cases ──────────────────────────────────────────────────────────────────

describe("playbook inline-trigger dispatch hellgate (ADR-0240)", () => {
  test("HELL-PBD-01: enabled:false ⇒ NOOP controller; no watcher started", () => {
    const watcher = createMemoryWatcher()
    const ctrl = startPlaybookAutoDispatch({
      enabled: false,
      watcher,
      registry: registry([reg("fix-it", { commentMarker: "QUANTA!", watchGlob: "**/*.ts" })]),
      threadId: "t1",
    })
    expect(ctrl.active()).toBe(0)
    expect(ctrl.dispatchCount()).toBe(0)
    expect(watcher.active()).toBe(0)
    expect(watcher.fire("/src/x.ts", "// fix QUANTA!")).toBe(false)
    ctrl.stop()
  })

  test("HELL-PBD-02: enabled:true + sinkful + marker ⇒ ONE enqueue with full metadata", () => {
    const watcher = createMemoryWatcher()
    const sink = recordingSink()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("fix-it", { commentMarker: "QUANTA!", watchGlob: "**/*.ts" })]),
      planQueueSink: sink.sink,
      threadId: "session-42",
    })
    expect(ctrl.active()).toBe(1)
    expect(watcher.fire("/src/x.ts", "ok\n// fix this QUANTA!\nmore")).toBe(true)
    expect(sink.enqueued).toHaveLength(1)
    const fu = sink.enqueued[0]
    if (fu === undefined) throw new Error("unreachable")
    expect(fu.threadId).toBe("session-42")
    expect(fu.text).toBe("/play fix-it")
    expect(fu.source).toBe("inline_trigger")
    expect(fu.metadata).toEqual({
      playbook: "fix-it",
      path: "/src/x.ts",
      line: "2",
      marker: "QUANTA!",
    })
    expect(ctrl.dispatchCount()).toBe(1)
    ctrl.stop()
  })

  test("HELL-PBD-03: enabled:true + NO sink ⇒ outcome=no-sink, dispatchCount++", () => {
    const watcher = createMemoryWatcher()
    const seen: DispatchResult[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("plan-a", { commentMarker: "FIRE!", watchGlob: "**/*.py" })]),
      threadId: "t1",
      onDispatch: (r) => {
        seen.push(r)
      },
    })
    expect(watcher.fire("/src/a.py", "x = 1 # FIRE!")).toBe(true)
    expect(ctrl.dispatchCount()).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ kind: "no-sink", playbook: "plan-a" })
    ctrl.stop()
  })

  test("HELL-PBD-04: registration WITHOUT trigger ⇒ silently skipped", () => {
    const watcher = createMemoryWatcher()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([
        reg("no-trigger", undefined),
        reg("wired", { commentMarker: "GO!", watchGlob: "**/*.md" }),
      ]),
      threadId: "t1",
    })
    expect(ctrl.active()).toBe(1)
    ctrl.stop()
  })

  test("HELL-PBD-05: multiple registrations fire independently on overlapping globs", () => {
    const watcher = createMemoryWatcher()
    const sink = recordingSink()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([
        reg("a", { commentMarker: "MARK!", watchGlob: "**/*.ts" }),
        reg("b", { commentMarker: "MARK!", watchGlob: "**/*.ts" }),
      ]),
      planQueueSink: sink.sink,
      threadId: "t1",
    })
    expect(ctrl.active()).toBe(2)
    expect(watcher.fire("/src/y.ts", "// MARK!")).toBe(true)
    expect(sink.enqueued).toHaveLength(2)
    const names = new Set(sink.enqueued.map((e) => e.metadata.playbook))
    expect(names).toEqual(new Set(["a", "b"]))
    ctrl.stop()
  })

  test("HELL-PBD-06: per-playbook glob mismatch ⇒ no fire", () => {
    const watcher = createMemoryWatcher()
    const sink = recordingSink()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("py-only", { commentMarker: "MARK!", watchGlob: "**/*.py" })]),
      planQueueSink: sink.sink,
      threadId: "t1",
    })
    expect(watcher.fire("/src/x.ts", "// MARK!")).toBe(false)
    expect(sink.enqueued).toHaveLength(0)
    expect(ctrl.dispatchCount()).toBe(0)
    ctrl.stop()
  })

  test("HELL-PBD-07: orchestrator watchGlobs filter — pass per-playbook but fail orch ⇒ filtered", () => {
    const watcher = createMemoryWatcher()
    const sink = recordingSink()
    const seen: DispatchResult[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("any", { commentMarker: "MARK!", watchGlob: "**/*" })]),
      planQueueSink: sink.sink,
      watchGlobs: ["src/**/*"],
      threadId: "t1",
      onDispatch: (r) => {
        seen.push(r)
      },
    })
    expect(watcher.fire("tests/foo.ts", "// MARK!")).toBe(true)
    expect(sink.enqueued).toHaveLength(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ kind: "filtered", playbook: "any", path: "tests/foo.ts" })
    ctrl.stop()
  })

  test("HELL-PBD-08: sink rejection (typed ok:false) ⇒ sink-rejected; no throw", () => {
    const watcher = createMemoryWatcher()
    const seen: DispatchResult[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("plan-x", { commentMarker: "GO!", watchGlob: "**/*.ts" })]),
      planQueueSink: rejectingSink("queue-full"),
      threadId: "t1",
      onDispatch: (r) => {
        seen.push(r)
      },
    })
    expect(() => watcher.fire("/src/x.ts", "// GO!")).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      kind: "sink-rejected",
      playbook: "plan-x",
      reason: "queue-full",
    })
    ctrl.stop()
  })

  test("HELL-PBD-09: sink THROWING ⇒ also sink-rejected (no-throw invariant)", () => {
    const watcher = createMemoryWatcher()
    const seen: DispatchResult[] = []
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("plan-y", { commentMarker: "RUN!", watchGlob: "**/*.ts" })]),
      planQueueSink: throwingSink("boom"),
      threadId: "t1",
      onDispatch: (r) => {
        seen.push(r)
      },
    })
    expect(() => watcher.fire("/src/x.ts", "// RUN!")).not.toThrow()
    expect(seen).toHaveLength(1)
    const r = seen[0]
    if (r === undefined) throw new Error("unreachable")
    expect(r.kind).toBe("sink-rejected")
    if (r.kind === "sink-rejected") expect(r.reason).toBe("boom")
    ctrl.stop()
  })

  test("HELL-PBD-10: observer sees every attempt; throwing observer is swallowed", () => {
    const watcher = createMemoryWatcher()
    const seen: DispatchResult[] = []
    let throws = 0
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("p", { commentMarker: "GO!", watchGlob: "**/*.ts" })]),
      threadId: "t1",
      onDispatch: (r) => {
        seen.push(r)
        throws++
        throw new Error("observer-fault")
      },
    })
    expect(() => watcher.fire("/src/x.ts", "// GO!")).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(throws).toBe(1)
    ctrl.stop()
  })

  test("HELL-PBD-11: controller.stop() is idempotent + stops handles", () => {
    const watcher = createMemoryWatcher()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([
        reg("a", { commentMarker: "M!", watchGlob: "**/*" }),
        reg("b", { commentMarker: "M!", watchGlob: "**/*" }),
      ]),
      threadId: "t1",
    })
    expect(ctrl.active()).toBe(2)
    expect(watcher.active()).toBe(2)
    ctrl.stop()
    expect(ctrl.active()).toBe(0)
    expect(watcher.active()).toBe(0)
    expect(() => ctrl.stop()).not.toThrow()
    expect(ctrl.active()).toBe(0)
  })

  test("HELL-PBD-12: startPlaybookFromTrigger(undefined) returns NOOP controller", () => {
    const ctrl = startPlaybookFromTrigger(undefined)
    expect(ctrl.active()).toBe(0)
    expect(ctrl.dispatchCount()).toBe(0)
    expect(() => ctrl.stop()).not.toThrow()
  })

  test("HELL-PBD-13: debounce window respected — fast retrigger is coalesced", () => {
    let t = 1_000_000
    const watcher = createMemoryWatcher(() => t)
    const sink = recordingSink()
    const ctrl = startPlaybookAutoDispatch({
      enabled: true,
      watcher,
      registry: registry([reg("p", { commentMarker: "GO!", watchGlob: "**/*.ts" })]),
      planQueueSink: sink.sink,
      threadId: "t1",
      debounceMs: 200,
    })
    expect(watcher.fire("/src/x.ts", "// GO!")).toBe(true)
    t += 50
    expect(watcher.fire("/src/x.ts", "// GO!")).toBe(false)
    expect(sink.enqueued).toHaveLength(1)
    t += 300
    expect(watcher.fire("/src/x.ts", "// GO!")).toBe(true)
    expect(sink.enqueued).toHaveLength(2)
    ctrl.stop()
  })

  test("HELL-PBD-14: adaptPlanQueueStoreToSink — store.enqueue invoked; throw → {ok:false}", () => {
    const calls: Parameters<PlanQueueStore["enqueue"]>[0][] = []
    const okStore = {
      enqueue: (input: Parameters<PlanQueueStore["enqueue"]>[0]) => {
        calls.push(input)
        return { id: "fu-test-1", collapsed: false }
      },
    } as unknown as PlanQueueStore
    const okSink = adaptPlanQueueStoreToSink(okStore)
    const result = okSink.enqueue({
      threadId: "session-1",
      text: "/play foo",
      source: "inline_trigger",
      metadata: { playbook: "foo", path: "/x.ts", line: "3", marker: "GO!" },
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const c = calls[0] as Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">
    expect(c.threadId).toBe("session-1")
    expect(c.text).toBe("/play foo")
    expect(c.source).toBe("inline_trigger")
    expect(c.pausedReason).toBe("other")
    expect(c.arrivedDuringTurn).toBe(0)
    expect(c.urgent).toBe(false)
    expect(c.metadata).toEqual({ playbook: "foo", path: "/x.ts", line: "3", marker: "GO!" })

    const badStore = {
      enqueue: () => {
        throw new Error("queue-down")
      },
    } as unknown as PlanQueueStore
    const badSink = adaptPlanQueueStoreToSink(badStore)
    const bad = badSink.enqueue({
      threadId: "t1",
      text: "/play x",
      source: "inline_trigger",
      metadata: {},
    })
    expect(bad).toEqual({ ok: false, reason: "queue-down" })
  })
})
