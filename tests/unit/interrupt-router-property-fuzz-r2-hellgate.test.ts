/**
 * Hellgate ROUND 2 (PROPERTY / DIFFERENTIAL FUZZ) — interrupt router
 * (`makeInterruptRouter`, `src/tool/critical-section.ts`; jun-6
 * tool-interrupt-behavior). THE HIGHEST-VALUE invariant of this slice.
 *
 * Round 1 (`tool-interrupt-behavior-core-hellgate`) crafted RFC §6 cases 1–7.
 * This round 2 FUZZES the timing/ordering SPACE deterministically (fake clock +
 * fake scheduler, no real timers) — random interleavings of
 * begin / end / abort / clock-advance / dispose — and checks the load-bearing
 * properties against a REFERENCE ORACLE with ZERO tolerance:
 *
 *   R1  NEVER-SWALLOW: once `source` aborts, the abort is delivered to `derived`
 *       no later than `maxMs` after the moment it was CAPTURED (the watchdog
 *       starts at capture, not window-open). Concretely: after the source has
 *       aborted, if we have advanced the clock ≥ maxMs past the capture AND the
 *       router is not disposed-before-delivery, `derived.signal.aborted` is true.
 *   R2  NEVER-FALSE-DELIVER: if `source` NEVER aborts, `derived` is NEVER
 *       aborted, no matter the begin/end/advance interleaving.
 *   R3  DISPOSED-EXACTLY-ONCE / NO-DOUBLE-ABORT: `derived.abort` fires at most
 *       once (a captured + force-delivered + end()-redelivered sequence does
 *       not abort twice); `dispose()` is idempotent.
 *
 * ≥500 random sequences. Deterministic LCG, fake clock.
 */

import { describe, expect, test } from "bun:test"
import { type CriticalSectionScheduler, makeInterruptRouter } from "@/tool"

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const makeFakeTime = () => {
  let nowMs = 0
  let seq = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  const scheduler: CriticalSectionScheduler = {
    schedule(ms, cb) {
      const id = seq++
      timers.set(id, { at: nowMs + ms, cb })
      return () => {
        timers.delete(id)
      }
    },
  }
  const advance = (ms: number): void => {
    nowMs += ms
    const due = [...timers.entries()].filter(([, t]) => t.at <= nowMs)
    for (const [id, t] of due) {
      timers.delete(id)
      t.cb()
    }
  }
  return { now: () => nowMs, scheduler, advance }
}

const MAX_MS = 50

type FuzzHarness = {
  readonly rng: () => number
  readonly time: ReturnType<typeof makeFakeTime>
  readonly source: AbortController
  readonly derived: AbortController
  readonly router: ReturnType<typeof makeInterruptRouter>
  readonly abortCount: () => number
}

type FuzzOracle = {
  openDepth: number
  sourceAborted: boolean
  abortCapturedAt: number | undefined
  disposed: boolean
  abortFiredWhileClosed: boolean
  readonly sections: Array<{ end(): void }>
}

const makeFuzzHarness = (seed: number): FuzzHarness => {
  const rng = lcg(seed * 2654435761)
  const time = makeFakeTime()
  const source = new AbortController()
  const derived = new AbortController()
  let count = 0
  derived.signal.addEventListener("abort", () => {
    count++
  })
  const router = makeInterruptRouter({
    source: source.signal,
    derived,
    now: time.now,
    maxMs: MAX_MS,
    scheduler: time.scheduler,
  })
  return { rng, time, source, derived, router, abortCount: () => count }
}

const makeFuzzOracle = (): FuzzOracle => ({
  openDepth: 0,
  sourceAborted: false,
  abortCapturedAt: undefined,
  disposed: false,
  abortFiredWhileClosed: false,
  sections: [],
})

const beginFuzzSection = (harness: FuzzHarness, oracle: FuzzOracle): void => {
  oracle.sections.push(harness.router.seam.begin())
  oracle.openDepth++
}

const endFuzzSection = (oracle: FuzzOracle): void => {
  const handle = oracle.sections.pop()
  handle?.end()
  oracle.openDepth = Math.max(0, oracle.openDepth - 1)
}

const abortFuzzSource = (harness: FuzzHarness, oracle: FuzzOracle): void => {
  oracle.sourceAborted = true
  if (oracle.openDepth > 0) {
    oracle.abortCapturedAt = harness.time.now()
  } else {
    oracle.abortFiredWhileClosed = true
  }
  harness.source.abort(new Error("esc"))
}

/** Execute exactly one randomized operation; no branch changes the generated
 * operation space, and op 5 stays an intentional ordering-jitter no-op. */
const executeFuzzOperation = (op: number, harness: FuzzHarness, oracle: FuzzOracle): void => {
  if (op === 0 && !oracle.disposed) {
    beginFuzzSection(harness, oracle)
  } else if (op === 1 && oracle.sections.length > 0 && !oracle.disposed) {
    endFuzzSection(oracle)
  } else if (op === 2 && !oracle.sourceAborted && !oracle.disposed) {
    abortFuzzSource(harness, oracle)
  } else if (op === 3) {
    harness.time.advance(1 + Math.floor(harness.rng() * (MAX_MS + 20)))
  } else if (op === 4 && !oracle.disposed) {
    harness.router.dispose()
    oracle.disposed = true
  }
}

const assertFuzzStepInvariants = (
  seed: number,
  step: number,
  harness: FuzzHarness,
  oracle: FuzzOracle,
): void => {
  if (!oracle.sourceAborted) {
    if (harness.derived.signal.aborted) {
      throw new Error(
        `R2 FALSE-DELIVER seed=${seed} step=${step}: derived aborted with no source abort`,
      )
    }
    expect(harness.derived.signal.aborted).toBe(false)
  }
  if (oracle.abortFiredWhileClosed && !oracle.disposed) {
    if (!harness.derived.signal.aborted) {
      throw new Error(
        `R1 SWALLOW (closed) seed=${seed} step=${step}: closed-time abort not delivered`,
      )
    }
    expect(harness.derived.signal.aborted).toBe(true)
  }
  if (harness.abortCount() > 1) {
    throw new Error(`R3 DOUBLE-ABORT seed=${seed} step=${step}: abortCount=${harness.abortCount()}`)
  }
}

const assertFuzzTerminalInvariant = (
  seed: number,
  harness: FuzzHarness,
  oracle: FuzzOracle,
): void => {
  if (oracle.sourceAborted && !oracle.disposed) {
    harness.time.advance(MAX_MS + 1)
    if (!harness.derived.signal.aborted) {
      throw new Error(
        `R1 SWALLOW (watchdog) seed=${seed}: source aborted, advanced past cap, still not delivered ` +
          `(capturedAt=${oracle.abortCapturedAt} closed=${oracle.abortFiredWhileClosed})`,
      )
    }
    expect(harness.derived.signal.aborted).toBe(true)
  }
  harness.router.dispose()
  harness.router.dispose()
  expect(harness.abortCount()).toBeLessThanOrEqual(1)
}

const runFuzzSequence = (seed: number): void => {
  const harness = makeFuzzHarness(seed)
  const oracle = makeFuzzOracle()
  const steps = 4 + Math.floor(harness.rng() * 28)
  for (let step = 0; step < steps; step++) {
    executeFuzzOperation(Math.floor(harness.rng() * 6), harness, oracle)
    assertFuzzStepInvariants(seed, step, harness, oracle)
  }
  assertFuzzTerminalInvariant(seed, harness, oracle)
}

describe("interrupt-router property fuzz R2 — never-swallow / never-false-deliver", () => {
  test("R1+R2+R3: ≥500 random begin/end/abort/advance/dispose interleavings", () => {
    const SEQUENCES = 800
    for (let seed = 1; seed <= SEQUENCES; seed++) runFuzzSequence(seed)
  })

  test("R1 minimal: long abort-free section, THEN abort, must deliver within maxMs of capture", () => {
    // The round-1-fixed swallow class: the window-open watchdog fires + disarms
    // with nothing to deliver during a long abort-free section; the cap must
    // RE-ARM at capture time so a late abort is still bounded.
    const time = makeFakeTime()
    const source = new AbortController()
    const derived = new AbortController()
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: time.now,
      maxMs: MAX_MS,
      scheduler: time.scheduler,
    })
    router.seam.begin() // never ends
    time.advance(MAX_MS * 10) // long abort-free section — any open-time watchdog fires harmlessly
    expect(derived.signal.aborted).toBe(false)
    source.abort(new Error("late")) // capture NOW
    expect(derived.signal.aborted).toBe(false) // withheld
    time.advance(MAX_MS - 1)
    expect(derived.signal.aborted).toBe(false) // still inside the cap-from-capture
    time.advance(1) // hit capture+maxMs
    expect(derived.signal.aborted).toBe(true) // delivered — NOT swallowed
    router.dispose()
  })

  test("R2 minimal: never aborting + arbitrary begin/end churn never delivers", () => {
    const time = makeFakeTime()
    const source = new AbortController()
    const derived = new AbortController()
    const router = makeInterruptRouter({
      source: source.signal,
      derived,
      now: time.now,
      maxMs: MAX_MS,
      scheduler: time.scheduler,
    })
    for (let i = 0; i < 20; i++) {
      const cs = router.seam.begin()
      time.advance(MAX_MS * 3)
      cs.end()
      time.advance(MAX_MS * 3)
    }
    expect(derived.signal.aborted).toBe(false)
    router.dispose()
  })
})
