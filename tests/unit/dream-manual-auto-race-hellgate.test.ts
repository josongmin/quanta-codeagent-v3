/**
 * ★ HELLGATE — H16 cross-session dream: manual `/dream` racing the auto
 * session-end pass on the SHARED trigger / state / lock (single process).
 *
 * The composition root backs BOTH the auto `onSessionEnd` hook AND the `/dream`
 * slash command with the SAME `CrossSessionDreamTrigger` instance (same
 * `holderId`, same `InMemoryDreamState`, same `InMemoryLock`). The cross-process
 * dream-lock keys on the per-PROCESS holderId and is RE-ENTRANT for that holder,
 * so without an in-process guard BOTH passes would re-acquire the lock and
 * DOUBLE-RUN the consolidate pipeline (a lost-update / wasted-work / torn-state
 * hazard). These cases drive the interleaving and pin single-flight: exactly one
 * pass consolidates, the other observes `locked`, the counter is reset once.
 */

import { describe, expect, test } from "bun:test"
import { InMemoryLock } from "@/auth/lock-in-memory"
import {
  CrossSessionDreamTrigger,
  type DreamConsolidatePort,
  type DreamWriteTargetPort,
  InMemoryDreamState,
} from "@/memory"

const policy = { sessionsThreshold: 1, hoursThreshold: 24 }

/** A consolidate port that BLOCKS until `release()` so two passes can be pinned
 *  in-flight at once. Counts invocations. */
const gatedConsolidate = (kind: "no_op" | "write" = "no_op") => {
  let consolidations = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const port: DreamConsolidatePort = {
    async consolidate() {
      consolidations += 1
      await gate
      return kind === "no_op"
        ? { kind: "no_op" as const }
        : { kind: "write" as const, content: "consolidated" }
    },
  }
  return {
    port,
    release,
    get consolidations(): number {
      return consolidations
    },
  }
}

const makeTrigger = (consolidate: DreamConsolidatePort, writeCount: { n: number }) => {
  const state = new InMemoryDreamState()
  const lock = new InMemoryLock({ now: () => 0 })
  const writeTarget: DreamWriteTargetPort = {
    targetPath: "/team/CONSOLIDATED.md",
    async write(content: string) {
      writeCount.n += 1
      return content.length
    },
  }
  const trigger = new CrossSessionDreamTrigger({
    state,
    consolidate,
    writeTarget,
    lock,
    now: () => 0,
    policy,
  })
  return { trigger, state }
}

describe("H16 dream — manual /dream vs auto onSessionEnd (shared instance)", () => {
  test("dream() ∥ onSessionEnd() ⇒ consolidate runs EXACTLY once (no double-run)", async () => {
    const g = gatedConsolidate("no_op")
    const writeCount = { n: 0 }
    const { trigger } = makeTrigger(g.port, writeCount)
    const a = trigger.dream()
    const b = trigger.onSessionEnd()
    g.release()
    const [ra, rb] = await Promise.all([a, b])
    expect(g.consolidations).toBe(1)
    expect([ra.kind, rb.kind].sort()).toEqual(["locked", "no_op"])
  })

  test("auto ∥ manual with a WRITE pass ⇒ team-target written exactly once", async () => {
    const g = gatedConsolidate("write")
    const writeCount = { n: 0 }
    const { trigger, state } = makeTrigger(g.port, writeCount)
    const a = trigger.onSessionEnd()
    const b = trigger.dream()
    g.release()
    const results = await Promise.all([a, b])
    expect(g.consolidations).toBe(1)
    expect(writeCount.n).toBe(1) // no torn / double write to the team target
    const completed = results.filter((r) => r.kind === "completed")
    const locked = results.filter((r) => r.kind === "locked")
    expect(completed.length).toBe(1)
    expect(locked.length).toBe(1)
    // Counter reset exactly once (the completed pass), not double-decremented.
    expect(state.read().sessionsSinceLastDream).toBe(0)
  })

  test("after a race resolves, a fresh dream() can fire again (guard released)", async () => {
    const g = gatedConsolidate("no_op")
    const writeCount = { n: 0 }
    const { trigger } = makeTrigger(g.port, writeCount)
    const a = trigger.dream()
    const b = trigger.onSessionEnd()
    g.release()
    await Promise.all([a, b])
    expect(g.consolidations).toBe(1)
    // A subsequent SEQUENTIAL dream must NOT be wedged "locked" forever — the
    // in-process guard cleared in `finally`.
    const second = await trigger.dream()
    expect(second.kind).toBe("no_op")
    expect(g.consolidations).toBe(2)
  })

  test("three concurrent passes ⇒ still exactly one consolidate", async () => {
    const g = gatedConsolidate("no_op")
    const writeCount = { n: 0 }
    const { trigger } = makeTrigger(g.port, writeCount)
    const passes = [trigger.dream(), trigger.onSessionEnd(), trigger.dream()]
    g.release()
    const results = await Promise.all(passes)
    expect(g.consolidations).toBe(1)
    expect(results.filter((r) => r.kind === "locked").length).toBe(2)
  })
})
