/**
 * DEEPER hellgate for the goal-continuation TICKER concurrency/lifecycle
 * (`src/apps/cli/goal-continuation-hook.ts`) AND the `/goal` status-chip
 * formatter boundaries (`src/apps/cli/status-pills.ts`).
 *
 * These are the mutation-grade cases the two basic suites
 * (`goal-continuation-ticker-hellgate.test.ts`,
 * `status-pills-goal-chip-hellgate.test.ts`) do NOT cover:
 *
 *   TICKER — re-entrancy under a SLOW resume (the internal single-permit
 *     `ContinuationSemaphore` must serialize overlapping ticks), permit
 *     no-leak after a rejecting resume, stop() teardown / idempotence /
 *     post-stop inertness, gate + ephemeral no-arm, intervalMs passthrough
 *     (explicit + default), and `.unref()` on the returned handle.
 *
 *   CHIP — `formatElapsed` boundaries (minute-flip, hour-flip, negative
 *     clamp), the exactly-40 / 41-char truncation boundary, empty-text
 *     suppression, the QUANTA_PILL_GOAL flag matrix + non-TTY kill, and the
 *     change semantics through `update()`.
 *
 * Every ticker test observes the REAL `runIdleContinuation` driving a REAL
 * `createObjectiveStore` through a hand-driven fake timer — the effect is the
 * observed `resume` invocation count, never a bare truthy. Red-on-injection
 * notes are inline at each guard.
 */

import { describe, expect, test } from "bun:test"
import { createObjectiveStore, type ObjectivePort } from "@/agent/objective"
import {
  type GoalContinuationProbes,
  startGoalContinuationTicker,
} from "@/apps/cli/goal-continuation-hook"
import { createStatusPills, stripAnsi } from "@/apps/cli/status-pills"

const TID = "thread-1"

/** All probes pass (idle, nothing pending, non-ephemeral) so the ONLY thing
 *  gating a launch is the goal status, the `enabled` flag, and the semaphore. */
const passingProbes = (
  objective: Pick<ObjectivePort, "get">,
  resume: (t: string) => Promise<void>,
): GoalContinuationProbes => ({
  objective,
  resume,
  threadIdle: () => true,
  planModeActive: () => false,
  turnActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
})

/** A store with a single ACTIVE goal on `TID` — the launch-eligible baseline. */
const activeStore = (): ReturnType<typeof createObjectiveStore> => {
  const store = createObjectiveStore()
  store.set(TID, { goal: "ship the feature" })
  store.updateStatus(TID, "active")
  return store
}

/**
 * A hand-driven fake timer. Captures the tick fn (so the test fires it),
 * records the ms it was armed with, exposes an `unref` spy on the returned
 * handle, and counts `clearIntervalFn` calls (so the teardown assertion is
 * exact, not just boolean).
 */
const fakeTimer = (): {
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn: (h: ReturnType<typeof setInterval>) => void
  fire: () => Promise<void>
  armedMs: () => number | null
  armedCount: () => number
  clearedCount: () => number
  unrefCount: () => number
} => {
  let captured: (() => void) | null = null
  let ms: number | null = null
  let armed = 0
  let cleared = 0
  let unrefs = 0
  const handle = {
    unref: (): void => {
      unrefs += 1
    },
  } as unknown as ReturnType<typeof setInterval>
  return {
    setIntervalFn: (fn, m) => {
      captured = fn
      ms = m
      armed += 1
      return handle
    },
    clearIntervalFn: () => {
      cleared += 1
    },
    fire: async () => {
      captured?.()
      // Let the fire-and-forget `void runIdleContinuation(...)` settle: the
      // orchestrator awaits `resume`, so several microtask flushes are needed
      // for a resolving resume to complete its `finally` (permit release).
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    armedMs: () => ms,
    armedCount: () => armed,
    clearedCount: () => cleared,
    unrefCount: () => unrefs,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — re-entrancy / overlapping ticks (the single permit must serialize)
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — re-entrancy: single permit serializes overlapping ticks", () => {
  test("a SLOW resume held across a 2nd tick launches ONCE; a later tick re-launches", async () => {
    const store = activeStore()

    // Controllable slow resume: tick 1 gets a promise we hold open. The permit
    // is acquired BEFORE `await resume` and released in a `finally` AFTER, so
    // an unresolved resume keeps the single permit held across ticks.
    let resumeCalls = 0
    const pendingReleases: Array<() => void> = []
    const resume = (): Promise<void> => {
      resumeCalls += 1
      return new Promise<void>((res) => {
        pendingReleases.push(res)
      })
    }

    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, resume),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(ticker).toBeDefined()

    await timer.fire() // tick 1 — acquires the permit, awaits the slow resume
    expect(resumeCalls).toBe(1)

    // tick 2 BEFORE the slow resume resolves — the permit is still held, so
    // `tryAcquire()` returns null → `semaphore-busy` → NO 2nd launch.
    // Red-on-injection: delete the single-permit guard and this becomes 2.
    await timer.fire()
    expect(resumeCalls).toBe(1)

    // Now let tick 1's resume resolve — the `finally` releases the permit.
    const firstRelease = pendingReleases.shift()
    if (firstRelease === undefined) throw new Error("first slow resume was not armed")
    firstRelease()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // A LATER tick can now launch again (permit free). This proves the guard
    // SERIALIZED (not permanently blocked) the overlapping ticks.
    // Swap in a fast resume for the re-launch by holding a fresh promise that
    // resolves immediately.
    await timer.fire()
    // The re-launch used the SAME `resume` closure; it bumps the counter and
    // hands back a new held promise — resolve it so the test leaves nothing
    // pending.
    expect(resumeCalls).toBe(2)
    // The async ticker invokes `resume` after this scope is constructed; widen
    // the statically empty-array control-flow view to its declared callback
    // contract before checking the runtime hand-off.
    const secondRelease: (() => void) | undefined = pendingReleases.shift()
    if (secondRelease === undefined) throw new Error("second slow resume was not armed")
    secondRelease()
  })

  test("PAIRED CONTROL: with a FAST resume, two sequential ticks launch twice", async () => {
    // Mirror of the above minus the held permit: each tick's resume resolves
    // within the microtask flush, so the permit is free by the next tick and
    // both ticks launch. Proves the single-launch above is the SLOW-resume
    // permit hold, not an unconditional dedupe.
    const store = activeStore()
    let resumeCalls = 0
    const resume = async (): Promise<void> => {
      resumeCalls += 1
    }
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, resume),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.fire()
    expect(resumeCalls).toBe(1)
    await timer.fire()
    expect(resumeCalls).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — permit released after resume REJECTS (real no-leak proof)
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — permit no-leak after a rejecting resume", () => {
  test("a resume that THROWS on tick 1 does not leak the permit; tick 2 launches", async () => {
    const store = activeStore()
    let calls = 0
    // Tick 1 rejects; tick 2 succeeds. The `finally` around `permit.release()`
    // must run even when `await deps.resume` rejects — otherwise the permit
    // leaks and tick 2 would see `semaphore-busy` and never launch.
    // Red-on-injection: move `permit.release()` out of the `finally` and the
    // second `expect(calls).toBe(2)` fails (stuck at 1).
    const resume = (): Promise<void> => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error("resume boom"))
      return Promise.resolve()
    }
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, resume),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })

    await timer.fire() // tick 1 — resume rejects
    expect(calls).toBe(1)

    await timer.fire() // tick 2 — permit must be free; launches
    expect(calls).toBe(2)
  })

  test("a SYNCHRONOUSLY-throwing resume also does not leak the permit", async () => {
    const store = activeStore()
    let calls = 0
    const resume = (): Promise<void> => {
      calls += 1
      if (calls === 1) throw new Error("sync boom") // thrown before returning a promise
      return Promise.resolve()
    }
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, resume),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    await timer.fire()
    expect(calls).toBe(1)
    await timer.fire()
    expect(calls).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — stop() teardown / idempotence / post-stop inertness
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — stop() teardown", () => {
  test("after stop(), firing the captured tick does NOTHING (no resume)", async () => {
    const store = activeStore()
    let resumes = 0
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {
        resumes += 1
      }),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })

    ticker?.stop()
    // Simulate the callback being queued immediately before clearInterval(). A
    // real clear only removes future interval work; it cannot retract this
    // captured callback. The callback-local stopped gate is therefore required.
    await timer.fire()
    expect(resumes).toBe(0)
    expect(timer.clearedCount()).toBe(1)
  })

  test("stop() is idempotent — 2nd call is safe and does NOT clear twice", () => {
    const store = activeStore()
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    ticker?.stop()
    ticker?.stop() // idempotent — the `stopped` guard prevents a 2nd clear
    // Red-on-injection: drop the `if (stopped) return` guard and this is 2.
    expect(timer.clearedCount()).toBe(1)
  })

  test("clearIntervalFn is NOT called before stop()", () => {
    const store = activeStore()
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(timer.clearedCount()).toBe(0) // armed, never cleared until stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — gate + ephemeral: no timer armed (paired against the live case)
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — gate + ephemeral arm NO timer", () => {
  test("enabled:false ⇒ undefined AND setIntervalFn is NEVER called", () => {
    const store = activeStore()
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: false,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(ticker).toBeUndefined()
    // The fake setIntervalFn captures ONLY when invoked; armedCount stays 0.
    expect(timer.armedCount()).toBe(0)
  })

  test("undefined threadId ⇒ undefined AND setIntervalFn is NEVER called", () => {
    const store = activeStore()
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: undefined,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(ticker).toBeUndefined()
    expect(timer.armedCount()).toBe(0)
  })

  test('empty-string threadId ("") ⇒ undefined AND no timer armed', () => {
    const store = activeStore()
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: "",
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(ticker).toBeUndefined()
    expect(timer.armedCount()).toBe(0)
  })

  test("PAIRED CONTROL: enabled:true + valid threadId DOES arm exactly one timer", () => {
    const store = activeStore()
    const timer = fakeTimer()
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(ticker).toBeDefined()
    expect(timer.armedCount()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — intervalMs passthrough (explicit + default)
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — intervalMs passthrough", () => {
  test("the injected setIntervalFn receives the EXACT intervalMs passed", () => {
    const store = activeStore()
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      intervalMs: 4321,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    // Red-on-injection: hardcode the ms in the driver and this fails.
    expect(timer.armedMs()).toBe(4321)
  })

  test("omitting intervalMs uses the DEFAULT 15_000ms", () => {
    const store = activeStore()
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(timer.armedMs()).toBe(15_000)
  })

  test("intervalMs of 0 is honored (not coerced to the default via ??)", () => {
    // `?? DEFAULT` only fires on null/undefined, so 0 must pass through as 0
    // (a `|| DEFAULT` bug would swallow it). Exact-value guard.
    const store = activeStore()
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      intervalMs: 0,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    expect(timer.armedMs()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TICKER — unref (the timer must never hold the loop open)
// ─────────────────────────────────────────────────────────────────────────────

describe("ticker — unref on the returned handle", () => {
  test("the returned handle's unref() is called exactly once on arm", () => {
    const store = activeStore()
    const timer = fakeTimer()
    startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    // Red-on-injection: remove the `(handle).unref?.()` line and this is 0.
    expect(timer.unrefCount()).toBe(1)
  })

  test("a handle WITHOUT unref does not crash the arm (optional-chained)", () => {
    // The driver guards `.unref?.()`; a fake handle lacking unref must not throw.
    const store = activeStore()
    let armed = false
    const ticker = startGoalContinuationTicker({
      enabled: true,
      threadId: TID,
      probes: passingProbes(store, async () => {}),
      // Handle with NO unref method.
      setIntervalFn: () => {
        armed = true
        return {} as unknown as ReturnType<typeof setInterval>
      },
      clearIntervalFn: () => {},
    })
    expect(armed).toBe(true)
    expect(ticker).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHIP — formatElapsed boundaries (via render + stripAnsi)
// ─────────────────────────────────────────────────────────────────────────────

const chip = (elapsedMs: number, text = "g"): string => {
  const line = stripAnsi(
    createStatusPills({
      enabled: true,
      isTTY: true,
      env: {},
      initial: { goal: { text, elapsedMs } },
    }).render(),
  )
  return line
}

describe("chip — formatElapsed minute/hour boundaries", () => {
  test("0ms ⇒ 0m", () => {
    expect(chip(0)).toContain("· 0m")
  })

  test("59_999ms (just under a minute) ⇒ 0m (floors down)", () => {
    // Red-on-injection: round instead of floor and this becomes 1m.
    expect(chip(59_999)).toContain("· 0m")
  })

  test("60_000ms (exactly one minute) ⇒ 1m", () => {
    expect(chip(60_000)).toContain("· 1m")
    expect(chip(60_000)).not.toContain("· 0m")
  })

  test("59 minutes ⇒ 59m (no hour segment)", () => {
    const line = chip(59 * 60_000)
    expect(line).toContain("· 59m")
    expect(line).not.toContain("h ")
  })

  test("60 minutes (hour flip) ⇒ 1h 0m", () => {
    // Red-on-injection: an off-by-one in the h/m split shows `0h 60m` or `1h`.
    expect(chip(60 * 60_000)).toContain("· 1h 0m")
  })

  test("127 minutes ⇒ 2h 7m", () => {
    expect(chip(127 * 60_000)).toContain("· 2h 7m")
  })

  test("multi-hour: 500 minutes ⇒ 8h 20m", () => {
    // 500 = 8*60 + 20.
    expect(chip(500 * 60_000)).toContain("· 8h 20m")
  })

  test("negative elapsed is CLAMPED to 0m (never a negative render)", () => {
    // Math.max(0, …) — a dropped clamp would render `-1m` or `NaNm`.
    expect(chip(-5000)).toContain("· 0m")
    expect(chip(-5000)).not.toContain("-")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHIP — truncation boundary (exactly 40 vs 41 chars)
// ─────────────────────────────────────────────────────────────────────────────

describe("chip — objective truncation boundary at 40 chars", () => {
  test("objective of EXACTLY 40 chars renders in FULL (no ellipsis)", () => {
    const forty = "a".repeat(40)
    const line = chip(0, forty)
    expect(line).toContain(forty) // full text present
    expect(line).not.toContain("…") // boundary is `> 40`, so 40 is untruncated
  })

  test("objective of 41 chars is truncated to 39 chars + ellipsis", () => {
    const fortyOne = "b".repeat(41)
    const line = chip(0, fortyOne)
    expect(line).toContain("…")
    expect(line).not.toContain(fortyOne) // full text NOT present
    // Visible objective is slice(0,39) + "…" = 39 b's then the ellipsis.
    expect(line).toContain(`${"b".repeat(39)}…`)
    // Red-on-injection: an off-by-one slice would show 38 or 40 b's before "…".
    expect(line).not.toContain("b".repeat(40))
  })

  test("a much-longer objective still truncates to the same 39+ellipsis width", () => {
    const line = chip(0, "c".repeat(200))
    expect(line).toContain(`${"c".repeat(39)}…`)
    expect(line).not.toContain("c".repeat(40))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHIP — empty text suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("chip — empty objective text suppresses the chip", () => {
  test('text:"" ⇒ NO chip even with the flag ON', () => {
    // Red-on-injection: drop the `goal.text === ""` guard and the 🎯 leaks
    // with an empty objective.
    const line = stripAnsi(
      createStatusPills({
        enabled: true,
        isTTY: true,
        env: {}, // QUANTA_PILL_GOAL defaults ON
        initial: { goal: { text: "", elapsedMs: 60_000 } },
      }).render(),
    )
    expect(line).not.toContain("🎯")
  })

  test('PAIRED CONTROL: same flag/state but non-empty text ⇒ chip present', () => {
    const line = stripAnsi(
      createStatusPills({
        enabled: true,
        isTTY: true,
        env: {},
        initial: { goal: { text: "x", elapsedMs: 60_000 } },
      }).render(),
    )
    expect(line).toContain("🎯 x · 1m")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHIP — QUANTA_PILL_GOAL flag matrix + non-TTY kill (paired controls)
// ─────────────────────────────────────────────────────────────────────────────

const renderGoal = (env: NodeJS.ProcessEnv, isTTY = true): string =>
  stripAnsi(
    createStatusPills({
      enabled: true,
      isTTY,
      env,
      initial: { goal: { text: "objective", elapsedMs: 0 } },
    }).render(),
  )

describe("chip — QUANTA_PILL_GOAL flag matrix", () => {
  test("unset (default ON) ⇒ chip shown", () => {
    expect(renderGoal({})).toContain("🎯 objective")
  })

  test('="0" ⇒ chip hidden', () => {
    expect(renderGoal({ QUANTA_PILL_GOAL: "0" })).not.toContain("🎯")
  })

  test('="off" ⇒ chip hidden', () => {
    expect(renderGoal({ QUANTA_PILL_GOAL: "off" })).not.toContain("🎯")
  })

  test('="false" ⇒ chip hidden', () => {
    expect(renderGoal({ QUANTA_PILL_GOAL: "false" })).not.toContain("🎯")
  })

  test('="1" ⇒ chip shown (explicit ON, paired control)', () => {
    expect(renderGoal({ QUANTA_PILL_GOAL: "1" })).toContain("🎯 objective")
  })

  test("non-TTY hides ALL pills INCLUDING the goal chip (empty render)", () => {
    // The non-TTY branch returns every flag false and render() is "" — a hard
    // kill regardless of QUANTA_PILL_GOAL. Red-on-injection: honour the flag in
    // the non-TTY branch and 🎯 leaks to a piped sink.
    const line = renderGoal({ QUANTA_PILL_GOAL: "1" }, false)
    expect(line).toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHIP — change semantics via update()
// ─────────────────────────────────────────────────────────────────────────────

describe("chip — change semantics via update()", () => {
  test("update() lights the chip with the NEW text", () => {
    const p = createStatusPills({ enabled: true, isTTY: true, env: {}, initial: {} })
    expect(stripAnsi(p.render())).not.toContain("🎯")
    p.update({ goal: { text: "fresh goal", elapsedMs: 0 } })
    expect(stripAnsi(p.render())).toContain("🎯 fresh goal · 0m")
  })

  test("update({goal:undefined}) CLEARS the chip", () => {
    const p = createStatusPills({
      enabled: true,
      isTTY: true,
      env: {},
      initial: { goal: { text: "was here", elapsedMs: 0 } },
    })
    expect(stripAnsi(p.render())).toContain("🎯 was here")
    p.update({ goal: undefined })
    // Red-on-injection: a shallow-merge that skips explicit-undefined keys would
    // leave the stale chip. The spread `{ ...state, ...patch }` must overwrite.
    expect(stripAnsi(p.render())).not.toContain("🎯")
  })

  test("a partial update of a DIFFERENT field does NOT drop the goal chip", () => {
    const p = createStatusPills({
      enabled: true,
      isTTY: true,
      env: {},
      initial: { goal: { text: "sticky goal", elapsedMs: 0 } },
    })
    expect(stripAnsi(p.render())).toContain("🎯 sticky goal")
    // Update an unrelated field — the merge must preserve `goal`.
    p.update({ cwd: "/tmp/whatever" })
    const line = stripAnsi(p.render())
    expect(line).toContain("🎯 sticky goal")
    expect(line).toContain("whatever") // the new field is present too
  })

  test("update() can change the elapsed while keeping the same objective", () => {
    const p = createStatusPills({
      enabled: true,
      isTTY: true,
      env: {},
      initial: { goal: { text: "long runner", elapsedMs: 0 } },
    })
    expect(stripAnsi(p.render())).toContain("🎯 long runner · 0m")
    p.update({ goal: { text: "long runner", elapsedMs: 90 * 60_000 } })
    expect(stripAnsi(p.render())).toContain("🎯 long runner · 1h 30m")
  })
})
