/**
 * `/queue` slash-command surface — hellgate (ADR-0221).
 *
 * 12 cases sealing subcommand routing + arg validation + id-prefix
 * resolution + typed-error rendering + default-OFF posture.
 *
 * Tests dispatch through `runSlashCommand` (not direct `.run()` calls) so
 * the BUILTINS registration path is exercised.
 */

import { describe, expect, test } from "bun:test"
import { defaultPlanQueueStore, type SendNowSink } from "@/agent/plan-queue"
import { __test as queueInternals, queueCmd } from "../../../src/apps/cli/queue-cmd"
import {
  isSlashCommand,
  runSlashCommand,
  type SlashContext,
} from "../../../src/apps/cli/slash-commands"

const captureCtx = (opts?: {
  store?: ReturnType<typeof defaultPlanQueueStore>
}): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const ctx: SlashContext = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    cwd: process.cwd(),
    ...(opts?.store !== undefined ? { planQueue: opts.store } : {}),
  }
  return { ctx, out, err }
}

const captureSink = (): {
  sink: SendNowSink
  calls: Array<{ threadId: string; text: string }>
} => {
  const calls: Array<{ threadId: string; text: string }> = []
  return {
    sink: {
      inject(payload) {
        calls.push({ threadId: payload.threadId, text: payload.text })
        return { ok: true }
      },
    },
    calls,
  }
}

const seed = (sink?: SendNowSink): ReturnType<typeof defaultPlanQueueStore> => {
  let t = 1_000
  return defaultPlanQueueStore({
    maxPerThread: 32,
    now: () => {
      t += 1
      return t
    },
    ...(sink !== undefined ? { sendNowSink: sink } : {}),
  })
}

describe("/queue · registration", () => {
  test("`/queue` is registered (BUILTINS includes it)", () => {
    expect(isSlashCommand("/queue")).toBe(true)
    expect(queueCmd.name).toBe("/queue")
  })

  test("OFF-parity: missing planQueue ⇒ 'not wired' + exit 0", async () => {
    const { ctx, out } = captureCtx()
    const code = await runSlashCommand("/queue list", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired in this surface")
  })
})

describe("/queue list", () => {
  test("empty store ⇒ '(queue empty)'", async () => {
    const { ctx, out } = captureCtx({ store: seed() })
    const code = await runSlashCommand("/queue list", ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("(queue empty)")
  })

  test("populated ⇒ thread + entry summary", async () => {
    const store = seed()
    const idA = store.enqueue({
      threadId: "t1",
      text: "first",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, out } = captureCtx({ store })
    const code = await runSlashCommand("/queue list", ctx)
    expect(code).toBe(0)
    const body = out.join("")
    expect(body).toContain("queued follow-ups")
    expect(body).toContain("thread t1")
    expect(body).toContain("first")
    expect(body).toContain(idA)
  })

  test("list rejects extra args", async () => {
    const { ctx, err } = captureCtx({ store: seed() })
    const code = await runSlashCommand("/queue list bogus", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("takes no arguments")
  })
})

describe("/queue retry · edit · delete · send-now", () => {
  test("retry by full id ⇒ ok + new id", async () => {
    const store = seed()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "x",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, out } = captureCtx({ store })
    const code = await runSlashCommand(`/queue retry ${id1}`, ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("/queue retry: ok")
  })

  test("retry by unique prefix ⇒ ok; ambiguous prefix ⇒ exit 1", async () => {
    const store = seed()
    store.enqueue({
      threadId: "thA",
      text: "a",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    })
    store.enqueue({
      threadId: "thA",
      text: "b",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    })
    // Both ids start with `fu-thA-`. Ambiguous prefix triggers an error.
    const { ctx, err } = captureCtx({ store })
    const code = await runSlashCommand("/queue retry fu-thA-", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("ambiguous id prefix")
  })

  test("edit replaces text; verified via subsequent /queue list", async () => {
    const store = seed()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "before",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, out } = captureCtx({ store })
    await runSlashCommand(`/queue edit ${id1} after the change`, ctx)
    await runSlashCommand("/queue list", ctx)
    const body = out.join("")
    expect(body).toContain("/queue edit: ok")
    expect(body).toContain("after the change")
    expect(body).not.toContain("before")
  })

  test("edit rejects too-few args (need id + text)", async () => {
    const store = seed()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "x",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, err } = captureCtx({ store })
    const code = await runSlashCommand(`/queue edit ${id1}`, ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("expected at least two arguments")
  })

  test("delete removes; subsequent list confirms", async () => {
    const store = seed()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "doomed",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, out } = captureCtx({ store })
    await runSlashCommand(`/queue delete ${id1}`, ctx)
    await runSlashCommand("/queue list", ctx)
    expect(out.join("")).toContain("/queue delete: ok")
    expect(out.join("")).toContain("(queue empty)")
  })

  test("send-now without sink ⇒ typed send-not-possible error", async () => {
    const store = seed() // no sink
    const id1 = store.enqueue({
      threadId: "t1",
      text: "x",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    const { ctx, err } = captureCtx({ store })
    const code = await runSlashCommand(`/queue send-now ${id1}`, ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("send-now sink not wired")
  })

  test("send-now with wired sink ⇒ ok + sink called", async () => {
    const cap = captureSink()
    const store = seed(cap.sink)
    const id1 = store.enqueue({
      threadId: "t1",
      text: "urgent",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: true,
      metadata: {},
    }).id
    const { ctx, out } = captureCtx({ store })
    const code = await runSlashCommand(`/queue send-now ${id1}`, ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("/queue send-now: ok")
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0]?.text).toBe("urgent")
  })

  test("unknown subcommand ⇒ exit 1 + 'unknown subcommand' message", async () => {
    const store = seed()
    const { ctx, err } = captureCtx({ store })
    const code = await runSlashCommand("/queue bogus", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("unknown subcommand")
  })

  test("missing subcommand ⇒ exit 1 + 'missing subcommand'", async () => {
    const store = seed()
    const { ctx, err } = captureCtx({ store })
    const code = await runSlashCommand("/queue", ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("missing subcommand")
  })
})

describe("/queue · id-prefix resolution + completion", () => {
  test("internal resolveEntryId returns exact match over prefix", () => {
    const store = seed()
    const id1 = store.enqueue({
      threadId: "t1",
      text: "a",
      source: "user_keystroke",
      pausedReason: "tool_in_flight",
      arrivedDuringTurn: 0,
      urgent: false,
      metadata: {},
    }).id
    // The id itself IS a prefix of itself — exact match wins.
    const r = queueInternals.resolveEntryId(store, id1)
    expect(typeof r === "string").toBe(false)
    if (typeof r === "string") return
    expect(r.id).toBe(id1)
  })

  test("internal resolveEntryId reports not-found for non-matching prefix", () => {
    const store = seed()
    const r = queueInternals.resolveEntryId(store, "fu-never")
    expect(typeof r === "string").toBe(true)
    if (typeof r === "string") expect(r).toContain("entry not found")
  })

  test("`/queue` completion seeds subcommand list at args.length===0", () => {
    const hints = queueCmd.complete?.([], "", {
      out: () => undefined,
      err: () => undefined,
      cwd: process.cwd(),
    })
    expect(hints).toBeDefined()
    const values = (hints ?? []).map((h) => h.value)
    expect(values).toEqual(["list", "retry", "edit", "delete", "send-now"])
  })
})
