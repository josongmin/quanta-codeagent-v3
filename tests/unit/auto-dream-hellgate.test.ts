/**
 * H16 — CROSS-SESSION auto-dream hellgate.
 *
 * Locks the contract of `CrossSessionDreamTrigger` (the cross-session glue
 * on top of the existing consolidate pipeline):
 *
 *   - fires after N sessions OR H hours (injected clock/counter — NO real
 *     Date.now(); time is passed in)
 *   - does NOT fire before either threshold
 *   - the dream-lock prevents concurrent runs (second caller skips → locked)
 *   - writes to the team target, NOT MEMORY.md
 *   - knob OFF (no policy) ⇒ counter never advances, never fires, no state I/O
 *   - a failed consolidate is handled (error recorded, no crash, counter kept)
 *
 * Harness: in-memory state store + fake consolidate/write/lock ports + a
 * deterministic injected clock. No disk, no Date.now().
 */

import { describe, expect, test } from "bun:test"
import { InMemoryLock } from "../../src/auth/lock-in-memory"
import {
  assembleDreamPolicy,
  CrossSessionDreamTrigger,
  DEFAULT_DREAM_POLICY,
  type DreamConsolidatePort,
  type DreamConsolidateResult,
  type DreamLockPort,
  type DreamPolicy,
  type DreamState,
  type DreamWriteTargetPort,
  FileDreamWriteTarget,
  INITIAL_DREAM_STATE,
  InMemoryDreamState,
  resolveDreamTeamPath,
} from "../../src/memory/dream"

// ─── Helpers ─────────────────────────────────────────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  let t = start
  return {
    now: (): number => t,
    set: (v: number): void => {
      t = v
    },
    advance: (ms: number): void => {
      t += ms
    },
  }
}

const POLICY: DreamPolicy = { sessionsThreshold: 3, hoursThreshold: 24 }

const mkConsolidate = (
  result: DreamConsolidateResult,
  opts: { calls?: { n: number } } = {},
): DreamConsolidatePort => ({
  consolidate: async () => {
    if (opts.calls) opts.calls.n += 1
    return result
  },
})

const mkWriteTarget = (
  targetPath = "/tmp/q/memory/team/cross-session.md",
): DreamWriteTargetPort & { written: string[] } => {
  const written: string[] = []
  return {
    targetPath,
    written,
    write: async (content: string): Promise<number> => {
      written.push(content)
      return Buffer.byteLength(content, "utf8")
    },
  }
}

/** Never-acquires lock — every tryAcquire returns would-wait (simulates a
 *  second concurrent process). */
const heldLock: DreamLockPort = {
  tryAcquire: async () => "would-wait",
  release: async () => {},
}

const mkTrigger = (overrides: {
  state?: InMemoryDreamState
  consolidate?: DreamConsolidatePort
  writeTarget?: DreamWriteTargetPort
  lock?: DreamLockPort
  now?: () => number
  policy?: DreamPolicy
  holderId?: string
}) =>
  new CrossSessionDreamTrigger({
    state: overrides.state ?? new InMemoryDreamState(),
    consolidate:
      overrides.consolidate ?? mkConsolidate({ kind: "consolidated", content: "knowledge" }),
    writeTarget: overrides.writeTarget ?? mkWriteTarget(),
    lock: overrides.lock ?? new InMemoryLock(mkClock()),
    now: overrides.now ?? mkClock().now,
    ...(overrides.policy !== undefined ? { policy: overrides.policy } : {}),
    ...(overrides.holderId !== undefined ? { holderId: overrides.holderId } : {}),
  })

// ─── Cases ───────────────────────────────────────────────────────────────

describe("auto-dream / cross-session trigger — hellgate", () => {
  test("1. does NOT fire before the sessions threshold", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    const state = new InMemoryDreamState()
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      consolidate: mkConsolidate({ kind: "consolidated", content: "x" }, { calls }),
    })
    // 2 sessions < threshold 3
    const o1 = await t.onSessionEnd()
    const o2 = await t.onSessionEnd()
    expect(o1.kind).toBe("below_threshold")
    expect(o2.kind).toBe("below_threshold")
    expect(calls.n).toBe(0)
    expect(state.read().sessionsSinceLastDream).toBe(2)
  })

  test("2. fires after N sessions (sessions threshold crossed)", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    const state = new InMemoryDreamState()
    const wt = mkWriteTarget()
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      writeTarget: wt,
      consolidate: mkConsolidate({ kind: "consolidated", content: "team knowledge" }, { calls }),
    })
    await t.onSessionEnd()
    await t.onSessionEnd()
    const o3 = await t.onSessionEnd() // 3rd → threshold
    expect(o3.kind).toBe("completed")
    expect(calls.n).toBe(1)
    expect(wt.written).toEqual(["team knowledge"])
    // counter reset + clock stamped
    expect(state.read().sessionsSinceLastDream).toBe(0)
    expect(state.read().lastDreamAtMs).toBe(clock.now())
    expect(state.read().lastOutcome).toBe("completed")
  })

  test("3. fires after H hours even with few sessions (hours threshold crossed)", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    // seed a prior dream 25h ago (> 24h threshold)
    const seeded: DreamState = {
      sessionsSinceLastDream: 0,
      lastDreamAtMs: clock.now() - 25 * 60 * 60 * 1000,
      lastOutcome: "completed",
    }
    const state = new InMemoryDreamState(seeded)
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      consolidate: mkConsolidate({ kind: "consolidated", content: "y" }, { calls }),
    })
    const o = await t.onSessionEnd() // only 1 session, but 25h elapsed
    expect(o.kind).toBe("completed")
    expect(calls.n).toBe(1)
  })

  test("4. does NOT fire when only ~1h elapsed and sessions below threshold", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    const seeded: DreamState = {
      sessionsSinceLastDream: 0,
      lastDreamAtMs: clock.now() - 1 * 60 * 60 * 1000, // 1h
      lastOutcome: "completed",
    }
    const state = new InMemoryDreamState(seeded)
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      consolidate: mkConsolidate({ kind: "consolidated", content: "y" }, { calls }),
    })
    const o = await t.onSessionEnd()
    expect(o.kind).toBe("below_threshold")
    expect(calls.n).toBe(0)
  })

  test("5. dream-lock prevents concurrent runs — second (held) caller skips", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    const state = new InMemoryDreamState({
      sessionsSinceLastDream: 2,
      lastDreamAtMs: null,
      lastOutcome: null,
    })
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      lock: heldLock, // another process holds it
      consolidate: mkConsolidate({ kind: "consolidated", content: "y" }, { calls }),
    })
    const o = await t.onSessionEnd() // counter → 3, threshold crossed, but locked
    expect(o.kind).toBe("locked")
    expect(calls.n).toBe(0)
    // counter NOT reset (we did not dream) — retries next time the lock frees
    expect(state.read().sessionsSinceLastDream).toBe(3)
  })

  test("5b. shared lock instance: two triggers, distinct holders — second skips", async () => {
    const clock = mkClock()
    const lock = new InMemoryLock(clock) // single in-proc lock scope
    // A lock we acquire out-of-band to simulate "process A is mid-dream".
    await lock.tryAcquire("memory-auto-dream", "process-A", 60_000)
    const calls = { n: 0 }
    const t = mkTrigger({
      state: new InMemoryDreamState({
        sessionsSinceLastDream: 2,
        lastDreamAtMs: null,
        lastOutcome: null,
      }),
      now: clock.now,
      policy: POLICY,
      lock,
      holderId: "process-B",
      consolidate: mkConsolidate({ kind: "consolidated", content: "y" }, { calls }),
    })
    const o = await t.onSessionEnd()
    expect(o.kind).toBe("locked")
    expect(calls.n).toBe(0)
  })

  test("6. writes to the team target, NOT MEMORY.md", async () => {
    const teamPath = resolveDreamTeamPath("/home/u/.quanta/memory")
    expect(teamPath.endsWith("MEMORY.md")).toBe(false)
    expect(teamPath).toContain("/team/")
    expect(teamPath.endsWith("cross-session.md")).toBe(true)

    // The FileDreamWriteTarget refuses to write a live MEMORY.md and writes
    // the team file via the injected fs.
    const writes: Array<{ p: string; c: string }> = []
    const mkdirs: string[] = []
    const fsFake = {
      mkdir: async (p: string): Promise<undefined> => {
        mkdirs.push(p)
        return undefined
      },
      writeFile: async (p: string, c: string): Promise<void> => {
        writes.push({ p, c })
      },
    }
    const wt = new FileDreamWriteTarget({ memoryRoot: "/home/u/.quanta/memory", fs: fsFake })
    const n = await wt.write("hello team")
    expect(n).toBe(Buffer.byteLength("hello team", "utf8"))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.p).toBe(teamPath)
    expect(writes[0]?.p.endsWith("MEMORY.md")).toBe(false)
    expect(mkdirs[0]?.endsWith("/team")).toBe(true)
  })

  test("7. knob OFF (no policy) ⇒ counter never advances, never fires, no state I/O", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    let reads = 0
    let writes = 0
    const trackingState = {
      read: (): DreamState => {
        reads += 1
        return INITIAL_DREAM_STATE
      },
      write: (): void => {
        writes += 1
      },
    }
    const t = new CrossSessionDreamTrigger({
      state: trackingState,
      consolidate: mkConsolidate({ kind: "consolidated", content: "x" }, { calls }),
      writeTarget: mkWriteTarget(),
      lock: new InMemoryLock(clock),
      now: clock.now,
      // NO policy → feature OFF
    })
    expect(t.enabled).toBe(false)
    for (let i = 0; i < 10; i++) await t.onSessionEnd()
    expect(calls.n).toBe(0)
    expect(reads).toBe(0) // never touched the persisted state
    expect(writes).toBe(0)
  })

  test("8. a failed consolidate is handled — error recorded, no crash, counter kept", async () => {
    const clock = mkClock()
    const state = new InMemoryDreamState({
      sessionsSinceLastDream: 2,
      lastDreamAtMs: null,
      lastOutcome: null,
    })
    const throwingConsolidate: DreamConsolidatePort = {
      consolidate: async () => {
        throw new Error("LLM 500")
      },
    }
    const t = mkTrigger({ state, now: clock.now, policy: POLICY, consolidate: throwingConsolidate })
    const o = await t.onSessionEnd() // counter → 3, fires, consolidate throws
    expect(o.kind).toBe("error")
    if (o.kind === "error") {
      expect(o.error.reason).toBe("consolidate_throw")
      expect(o.error.message).toContain("LLM 500")
    }
    // counter NOT reset (so it retries next session) but lastOutcome stamped
    expect(state.read().sessionsSinceLastDream).toBe(3)
    expect(state.read().lastOutcome).toBe("error")
  })

  test("9. consolidate no_op ⇒ counter reset, no team write", async () => {
    const clock = mkClock()
    const wt = mkWriteTarget()
    const state = new InMemoryDreamState({
      sessionsSinceLastDream: 2,
      lastDreamAtMs: null,
      lastOutcome: null,
    })
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      writeTarget: wt,
      consolidate: mkConsolidate({ kind: "no_op" }),
    })
    const o = await t.onSessionEnd()
    expect(o.kind).toBe("no_op")
    expect(wt.written).toHaveLength(0)
    expect(state.read().sessionsSinceLastDream).toBe(0) // we DID dream
    expect(state.read().lastOutcome).toBe("no_op")
  })

  test("10. lock is RELEASED after a successful dream (next fire can acquire)", async () => {
    const clock = mkClock()
    const lock = new InMemoryLock(clock)
    const calls = { n: 0 }
    const state = new InMemoryDreamState({
      sessionsSinceLastDream: 2,
      lastDreamAtMs: null,
      lastOutcome: null,
    })
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      lock,
      consolidate: mkConsolidate({ kind: "consolidated", content: "y" }, { calls }),
    })
    await t.onSessionEnd() // fires, dreams, releases
    expect(calls.n).toBe(1)
    // An out-of-band acquire now succeeds → lock was released.
    const r = await lock.tryAcquire("memory-auto-dream", "someone-else", 60_000)
    expect(r).toBe("acquired")
  })

  test("11. manual dream() bypasses the threshold but honors the lock + flag", async () => {
    const clock = mkClock()
    const calls = { n: 0 }
    const state = new InMemoryDreamState() // 0 sessions
    const t = mkTrigger({
      state,
      now: clock.now,
      policy: POLICY,
      consolidate: mkConsolidate({ kind: "consolidated", content: "manual" }, { calls }),
    })
    const o = await t.dream() // below threshold but manual fires anyway
    expect(o.kind).toBe("completed")
    expect(calls.n).toBe(1)

    // manual dream with feature OFF does nothing
    const off = new CrossSessionDreamTrigger({
      state: new InMemoryDreamState(),
      consolidate: mkConsolidate({ kind: "consolidated", content: "x" }, { calls }),
      writeTarget: mkWriteTarget(),
      lock: new InMemoryLock(clock),
      now: clock.now,
    })
    const offOutcome = await off.dream()
    expect(offOutcome.kind).toBe("below_threshold")
  })

  test("12. hoursSinceLastDream uses the INJECTED clock (no Date.now)", () => {
    const clock = mkClock(1_000_000_000_000)
    const seeded: DreamState = {
      sessionsSinceLastDream: 0,
      lastDreamAtMs: clock.now() - 3 * 60 * 60 * 1000, // 3h ago
      lastOutcome: "completed",
    }
    const t = mkTrigger({ state: new InMemoryDreamState(seeded), now: clock.now, policy: POLICY })
    expect(t.hoursSinceLastDream()).toBeCloseTo(3, 6)
    // never-dreamed ⇒ null
    const fresh = mkTrigger({ state: new InMemoryDreamState(), now: clock.now, policy: POLICY })
    expect(fresh.hoursSinceLastDream()).toBeNull()
  })

  test("12b. corrupt persisted lastDreamAtMs (non-finite) ⇒ treated as never-dreamed, no NaN/Infinity cadence corruption", async () => {
    // A corrupted/legacy persisted record could carry a non-finite
    // `lastDreamAtMs` (NaN from a bad parse, or ±Infinity). The hours math must
    // NOT let that fire a dream every session: `now - (-Infinity) = +Infinity`
    // would make `hoursCrossed` ALWAYS true. Treat non-finite as never-dreamed.
    const clock = mkClock()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const calls = { n: 0 }
      const state = new InMemoryDreamState({
        // sessions well BELOW threshold so ONLY a bogus hours-cross could fire
        sessionsSinceLastDream: 0,
        lastDreamAtMs: bad as unknown as number,
        lastOutcome: "completed",
      })
      const t = mkTrigger({
        state,
        now: clock.now,
        policy: POLICY,
        consolidate: mkConsolidate({ kind: "consolidated", content: "x" }, { calls }),
      })
      // hoursSinceLastDream must be null (never-dreamed), NOT NaN/Infinity.
      expect(t.hoursSinceLastDream()).toBeNull()
      const o = await t.onSessionEnd() // counter → 1 < 3, hours unknown ⇒ skip
      expect(o.kind).toBe("below_threshold")
      if (o.kind === "below_threshold") {
        expect(o.hoursSinceLastDream).toBeNull() // no NaN leak into telemetry
      }
      expect(calls.n).toBe(0) // did NOT fire a dream off a corrupt record
    }
  })

  test("13. assembleDreamPolicy — OFF gate ⇒ null (default-OFF)", () => {
    expect(
      assembleDreamPolicy({
        autoDream: false,
        autoDreamSessions: undefined,
        autoDreamHours: undefined,
      }),
    ).toBeNull()
  })

  test("14. assembleDreamPolicy — ON ⇒ defaults when thresholds absent", () => {
    const slot = assembleDreamPolicy({
      autoDream: true,
      autoDreamSessions: undefined,
      autoDreamHours: undefined,
    })
    expect(slot).not.toBeNull()
    expect(slot?.policy).toEqual(DEFAULT_DREAM_POLICY)
  })

  test("15. assembleDreamPolicy — ON ⇒ overrides honored", () => {
    const slot = assembleDreamPolicy({ autoDream: true, autoDreamSessions: 7, autoDreamHours: 0.5 })
    expect(slot?.policy).toEqual({ sessionsThreshold: 7, hoursThreshold: 0.5 })
  })

  test("16. abort from consolidate propagates (not swallowed)", async () => {
    const clock = mkClock()
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" })
    const t = mkTrigger({
      state: new InMemoryDreamState({
        sessionsSinceLastDream: 2,
        lastDreamAtMs: null,
        lastOutcome: null,
      }),
      now: clock.now,
      policy: POLICY,
      consolidate: {
        consolidate: async () => {
          throw abortErr
        },
      },
    })
    await expect(t.onSessionEnd()).rejects.toThrow("aborted")
  })
})
