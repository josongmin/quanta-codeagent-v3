/**
 * force_background — Phase 2 (the promoter) hellgate (ADR-0487).
 *
 * Seals the `forceBackground` scheduler method, the control-op router helper
 * (`forceBackground` in control-op-handler), and the model-facing
 * `subagent_force_background` tool: promote_now, moved_to_front (jump the
 * line), allowBurst +1 discipline (NEVER +2), and the no-throw outcome union.
 */

import { describe, expect, test } from "bun:test"
import {
  type BackgroundSchedulerSlice,
  forceBackground as routeForceBackground,
} from "@/agent/control-op-handler"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { subagentBgTools, subagentForceBackgroundTool } from "@/tool/subagent-bg"

const multiRunner = (): {
  runner: SubagentRunner
  resolveNext: () => boolean
  startedTasks: () => string[]
} => {
  const resolvers: Array<(out: SliceResult) => void> = []
  const started: string[] = []
  let head = 0
  const runner: SubagentRunner = (req: SubagentRequest) => {
    started.push(req.prompt)
    return new Promise<SliceResult>((res) => resolvers.push(res))
  }
  return {
    runner,
    resolveNext: () => {
      const r = resolvers[head]
      if (r === undefined) return false
      head += 1
      r({ ok: true, finalText: "done", turns: 1 })
      return true
    },
    startedTasks: () => [...started],
  }
}

const yieldMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let seq = 0
const idGen = (): string => {
  seq += 1
  return seq.toString(16).padStart(4, "0")
}

const mkSched = (maxConcurrent: number, runner: SubagentRunner) =>
  defaultBackgroundSubagentScheduler({ runner, maxConcurrent, admissionQueue: true, idGen })

const baseCtx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })
const drive = async <I>(
  tool: { execute: (input: I, ctx: ToolContext) => AsyncIterable<ToolEvent> },
  input: I,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input, baseCtx())) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no terminal result")
  return last
}

describe("force_background Phase 2 — A. promote_now (free slot)", () => {
  test("HELL-4: forceBackground on a queued handle with a free slot ⇒ promoted_now", () => {
    const { runner, startedTasks } = multiRunner()
    const sched = mkSched(2, runner)
    const r1 = sched.fork({ task: "r1" })
    sched.fork({ task: "r2" })
    const q = sched.fork({ task: "q" })
    expect(sched.poll(q)?.status).toBe("queued")
    // `cancel` frees a slot WITHOUT firing auto-drain (drain only runs in the
    // runner's finally on a natural completion). So a real free slot now
    // coexists with a queued entry — the explicit free-slot promote path.
    expect(sched.cancel(r1)).toBe(true)
    const running = (): number => sched.list().filter((h) => h.result.status === "running").length
    expect(running()).toBe(1) // only r2 — a genuine free slot
    expect(sched.poll(q)?.status).toBe("queued") // still queued (no drain)

    const outcome = sched.forceBackground(q)
    expect(outcome).toBe("promoted_now")
    expect(sched.poll(q)?.status).toBe("running")
    expect(startedTasks()).toContain("q")
    expect(running()).toBe(2) // r2 + q, cap respected (no burst)
  })
})

describe("force_background Phase 2 — B. moved_to_front (jump the line)", () => {
  test("HELL-5: no slot/no burst ⇒ moved_to_front; qLast runs BEFORE qFirst", async () => {
    const { runner, resolveNext } = multiRunner()
    const sched = mkSched(1, runner)
    sched.fork({ task: "r" })
    const qFirst = sched.fork({ task: "qFirst" })
    const qLast = sched.fork({ task: "qLast" })
    expect(sched.poll(qFirst)?.status).toBe("queued")
    expect(sched.poll(qLast)?.status).toBe("queued")

    // No free slot, no burst → re-order qLast to head.
    expect(sched.forceBackground(qLast)).toBe("moved_to_front")

    // Free the slot → qLast promotes BEFORE qFirst (jumped the line).
    resolveNext()
    await yieldMicrotasks()
    expect(sched.poll(qLast)?.status).toBe("running")
    expect(sched.poll(qFirst)?.status).toBe("queued")
  })
})

describe("force_background Phase 2 — C. allowBurst cap discipline", () => {
  test("HELL-6: burst promotes +1 over cap; a 2nd burst degrades to moved_to_front (never +2)", () => {
    const { runner } = multiRunner()
    const sched = mkSched(2, runner)
    sched.fork({ task: "r1" })
    sched.fork({ task: "r2" })
    const q1 = sched.fork({ task: "q1" })
    const q2 = sched.fork({ task: "q2" })
    const running = (): number => sched.list().filter((h) => h.result.status === "running").length
    expect(running()).toBe(2)

    // First burst: 2 running + 1 = 3 (maxConcurrent + 1).
    expect(sched.forceBackground(q1, { allowBurst: true })).toBe("promoted_now")
    expect(running()).toBe(3)

    // Second burst while STILL over-cap: refused → moved_to_front, NEVER +2.
    expect(sched.forceBackground(q2, { allowBurst: true })).toBe("moved_to_front")
    expect(running()).toBe(3) // never 4
  })
})

describe("force_background Phase 2 — D. no-throw outcomes", () => {
  test("HELL-7: bogus ⇒ not_found; running ⇒ already_running; done ⇒ already_running", async () => {
    const { runner, resolveNext } = multiRunner()
    const sched = mkSched(2, runner)
    const r1 = sched.fork({ task: "r1" })
    sched.fork({ task: "r2" })
    expect(sched.forceBackground("bg-deadbeef")).toBe("not_found")
    expect(sched.forceBackground(r1)).toBe("already_running")
    // Drive r1 to terminal.
    resolveNext()
    await yieldMicrotasks()
    expect(sched.poll(r1)?.status).toBe("completed")
    expect(sched.forceBackground(r1)).toBe("already_running")
  })
})

describe("force_background Phase 2 — E. control-op router helper", () => {
  test("scheduler_absent when no scheduler; passes through outcome otherwise; never throws", () => {
    expect(routeForceBackground(undefined, "x")).toBe("scheduler_absent")
    const { runner } = multiRunner()
    const sched = mkSched(1, runner)
    sched.fork({ task: "r" })
    const q = sched.fork({ task: "q" })
    expect(routeForceBackground(sched, q)).toBe("moved_to_front")
    // A buggy stub that throws collapses to not_found, never propagates.
    const throwing: BackgroundSchedulerSlice = {
      forceBackground: () => {
        throw new Error("boom")
      },
    }
    expect(routeForceBackground(throwing, "x")).toBe("not_found")
  })
})

describe("force_background Phase 2 — F. model-facing tool", () => {
  test("tool maps outcomes: moved_to_front ok:true; not_found ok:false; queue_disabled ok:false", async () => {
    const { runner } = multiRunner()
    const sched = mkSched(1, runner)
    sched.fork({ task: "r" })
    const q = sched.fork({ task: "q" })
    const tool = subagentForceBackgroundTool(sched)

    const moved = await drive(tool, { id: q })
    expect(moved.ok).toBe(true)
    expect(moved.output).toContain("moved_to_front")

    const missing = await drive(tool, { id: "bg-nope" })
    expect(missing.ok).toBe(false)
    expect(missing.output).toContain("not_found")

    // Queue-disabled scheduler ⇒ tool reports queue_disabled (ok:false).
    const offSched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 1 })
    const offTool = subagentForceBackgroundTool(offSched)
    const off = await drive(offTool, { id: "bg-x" })
    expect(off.ok).toBe(false)
    expect(off.output).toContain("queue_disabled")
  })

  test("subagentBgTools appends the promote tool ONLY when forceBackground:true", () => {
    const { runner } = multiRunner()
    const sched = mkSched(1, runner)
    const names3 = subagentBgTools(sched).map((t) => t.name)
    expect(names3).not.toContain("subagent_force_background")
    expect(names3.length).toBe(3)
    const names4 = subagentBgTools(sched, { forceBackground: true }).map((t) => t.name)
    expect(names4).toContain("subagent_force_background")
    expect(names4.length).toBe(4)
  })
})
