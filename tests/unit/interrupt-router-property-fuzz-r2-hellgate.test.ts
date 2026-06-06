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

describe("interrupt-router property fuzz R2 — never-swallow / never-false-deliver", () => {
  test("R1+R2+R3: ≥500 random begin/end/abort/advance/dispose interleavings", () => {
    const SEQUENCES = 800
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const rng = lcg(seed * 2654435761)
      const time = makeFakeTime()
      const source = new AbortController()
      const derived = new AbortController()
      let abortCount = 0
      // Count how many times derived is aborted (must be ≤ 1).
      derived.signal.addEventListener("abort", () => {
        abortCount++
      })

      const router = makeInterruptRouter({
        source: source.signal,
        derived,
        now: time.now,
        maxMs: MAX_MS,
        scheduler: time.scheduler,
      })

      // Oracle state.
      let openDepth = 0
      let sourceAborted = false
      let abortCapturedAt: number | undefined // when an abort was captured while open
      let disposed = false
      let abortFiredWhileClosed = false

      // A stack of live section handles (begin returns {end}).
      const sections: Array<{ end(): void }> = []

      const steps = 4 + Math.floor(rng() * 28)
      for (let st = 0; st < steps; st++) {
        const op = Math.floor(rng() * 6)
        if (op === 0 && !disposed) {
          // begin()
          sections.push(router.seam.begin())
          openDepth++
        } else if (op === 1 && sections.length > 0 && !disposed) {
          // end() — close the most-recent open section
          const handle = sections.pop()
          handle?.end()
          openDepth = Math.max(0, openDepth - 1)
        } else if (op === 2 && !sourceAborted && !disposed) {
          // abort the source
          sourceAborted = true
          if (openDepth > 0) {
            abortCapturedAt = time.now() // withheld; watchdog starts NOW
          } else {
            abortFiredWhileClosed = true // immediate
          }
          source.abort(new Error("esc"))
        } else if (op === 3) {
          // advance the clock a random amount
          time.advance(1 + Math.floor(rng() * (MAX_MS + 20)))
        } else if (op === 4 && !disposed) {
          // dispose
          router.dispose()
          disposed = true
        }
        // op===5 ⇒ no-op (pure ordering jitter)

        // --- INVARIANT CHECKS at every step ---

        // R2: if source NEVER aborted, derived is NEVER aborted.
        if (!sourceAborted) {
          if (derived.signal.aborted) {
            throw new Error(
              `R2 FALSE-DELIVER seed=${seed} step=${st}: derived aborted with no source abort`,
            )
          }
          expect(derived.signal.aborted).toBe(false)
        }

        // R1: a closed-time abort propagates immediately (unless disposed first).
        if (abortFiredWhileClosed && !disposed) {
          if (!derived.signal.aborted) {
            throw new Error(
              `R1 SWALLOW (closed) seed=${seed} step=${st}: closed-time abort not delivered`,
            )
          }
          expect(derived.signal.aborted).toBe(true)
        }

        // R3: derived aborted at most once.
        if (abortCount > 1) {
          throw new Error(`R3 DOUBLE-ABORT seed=${seed} step=${st}: abortCount=${abortCount}`)
        }
      }

      // --- TERMINAL never-swallow check ---
      // Drive the system to quiescence: if a section was holding a captured abort
      // and the router was NOT disposed before delivery, advancing well past the
      // cap MUST force-deliver it (the watchdog can never hold forever). We close
      // any still-open sections first OR rely purely on the watchdog cap.
      if (sourceAborted && !disposed) {
        // Advance comfortably past any capture-anchored watchdog deadline.
        time.advance(MAX_MS + 1)
        if (!derived.signal.aborted) {
          throw new Error(
            `R1 SWALLOW (watchdog) seed=${seed}: source aborted, advanced past cap, still not delivered ` +
              `(capturedAt=${abortCapturedAt} closed=${abortFiredWhileClosed})`,
          )
        }
        expect(derived.signal.aborted).toBe(true)
      }

      // R3: dispose is idempotent + never double-aborts.
      router.dispose()
      router.dispose()
      expect(abortCount).toBeLessThanOrEqual(1)
    }
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
