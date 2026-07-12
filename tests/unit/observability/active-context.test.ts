/**
 * Active-span async context (ADR-0186 — C1 delta).
 *
 * Seals the AsyncLocalStorage active-span behaviour that C2 depends on:
 *
 *   AC-01: two concurrently INTERLEAVED withSpan scopes never observe each
 *          other's getActiveTraceRef() — proves AsyncLocalStorage isolation,
 *          NOT a shared global "current span" stack (which would cross-link).
 *   AC-02: a nested span's parent IS the enclosing active span (traceId shared,
 *          parentSpanId == outer spanId).
 *   AC-03: outside any withSpan scope, getActiveTraceRef() is undefined.
 *   AC-04: the ref restores to the prior value after a nested scope exits.
 */

import { describe, expect, test } from "bun:test"
import { contextTracer, getActiveTraceRef } from "@/observability/tracing"

/** Deterministic microtask yield so two async bodies genuinely interleave
 *  (each `await` hands control back to the scheduler). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe("active-context / getActiveTraceRef", () => {
  test("AC-03: undefined outside any withSpan scope", () => {
    expect(getActiveTraceRef()).toBeUndefined()
  })

  test("AC-01: two interleaved withSpan scopes never cross-link", async () => {
    // Each scope samples the active ref BEFORE and AFTER an interleaving yield.
    // If a global stack backed this, scope B's withSpan would overwrite the
    // "current" span and scope A would read B's spanId after the yield.
    const seenA: string[] = []
    const seenB: string[] = []

    const scopeA = contextTracer.withSpan("A", async () => {
      const ownA = getActiveTraceRef()?.spanId ?? ""
      seenA.push(ownA)
      await tick()
      seenA.push(getActiveTraceRef()?.spanId ?? "")
      await tick()
      seenA.push(getActiveTraceRef()?.spanId ?? "")
      return ownA
    })

    const scopeB = contextTracer.withSpan("B", async () => {
      const ownB = getActiveTraceRef()?.spanId ?? ""
      seenB.push(ownB)
      await tick()
      seenB.push(getActiveTraceRef()?.spanId ?? "")
      await tick()
      seenB.push(getActiveTraceRef()?.spanId ?? "")
      return ownB
    })

    const [idA, idB] = await Promise.all([scopeA, scopeB])

    // Distinct roots.
    expect(idA).not.toBe("")
    expect(idB).not.toBe("")
    expect(idA).not.toBe(idB)
    // Every sample inside scope A saw ONLY A's id (never B's) despite the
    // interleaving, and vice-versa. This is the isolation invariant.
    expect(seenA.every((s) => s === idA)).toBe(true)
    expect(seenB.every((s) => s === idB)).toBe(true)
    expect(seenA).not.toContain(idB)
    expect(seenB).not.toContain(idA)
  })

  test("AC-02: nested span's parent is the enclosing active span", async () => {
    await contextTracer.withSpan("outer", async (outerSpan) => {
      const outerRef = getActiveTraceRef()
      expect(outerRef?.spanId).toBe(outerSpan.context.spanId)

      await contextTracer.withSpan("inner", async (innerSpan) => {
        const innerRef = getActiveTraceRef()
        // Inner is the active span now.
        expect(innerRef?.spanId).toBe(innerSpan.context.spanId)
        // Same trace as the parent.
        expect(innerRef?.traceId).toBe(outerSpan.context.traceId)
        // Parent edge points at the enclosing (outer) span — this is the tree
        // linkage C2/C3 read to reconstruct invoke_agent → chat.
        expect(innerRef?.parentSpanId).toBe(outerSpan.context.spanId)
        // Inner is a fresh span, not the outer.
        expect(innerSpan.context.spanId).not.toBe(outerSpan.context.spanId)
      })
    })
  })

  test("AC-04: ref restores after a nested scope exits", async () => {
    await contextTracer.withSpan("outer", async (outerSpan) => {
      await contextTracer.withSpan("inner", async () => {})
      // After the inner scope unwinds, the outer span is active again.
      expect(getActiveTraceRef()?.spanId).toBe(outerSpan.context.spanId)
    })
    // Fully unwound.
    expect(getActiveTraceRef()).toBeUndefined()
  })
})
