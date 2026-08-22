/**
 * ★ CONTRACT — ADR-0117: branch-search minimal-change bias + CLI progress.
 *
 * 25-case hellgate organized in five blocks:
 *  A. patchSizeVerifier  — magnitude / detail / no-delta invariants (1..5)
 *  B. scorer integration — patch_size flows correctly through defaultScorer (6..9)
 *  C. minimalChangeSelector — tiebreak semantics + epsilon boundary (10..14)
 *  D. progress formatter — per-variant glyph/severity + ANSI + determinism (15..22)
 *  E. runner wiring      — onProgress opt-in / composition (23..25)
 *
 * All blocks are hermetic: pure functions or hand-rolled fakes. No real git,
 * no real shell, no real workspaces.
 */

import { describe, expect, test } from "bun:test"
import type {
  BranchCandidate,
  BranchTraceEvent,
  DeltaMeasurement,
  ProgressLine,
  VerifierSignal,
} from "@/agent/branch-search"
import {
  argmaxSelector,
  defaultScorer,
  formatBranchTrace,
  makeScorer,
  minimalChangeSelector,
  patchSizeVerifier,
} from "@/agent/branch-search"

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sig = (
  over: Partial<VerifierSignal> & Pick<VerifierSignal, "kind" | "pass">,
): VerifierSignal => ({ detail: "", durationMs: 1, ...over })

const baseCand = (id: string, delta?: DeltaMeasurement): BranchCandidate => {
  const out: BranchCandidate = {
    id,
    seed: {},
    workspace: `/ws/${id}`,
    outcome: { kind: "completed", turns: 1 },
    ...(delta !== undefined ? { delta } : {}),
  }
  return out
}

const scored = (
  id: string,
  total: number,
  delta?: DeltaMeasurement,
): {
  cand: BranchCandidate
  score: { total: number; breakdown: ReadonlyArray<VerifierSignal> }
} => ({
  cand: baseCand(id, delta),
  score: { total, breakdown: [] },
})

/* ================================================================== */
/* A. patchSizeVerifier                                                */
/* ================================================================== */
describe("HELL-A: patchSizeVerifier", () => {
  test("A1: cand.delta OMITTED ⇒ magnitude 0 + detail 'no-delta'", async () => {
    const cand = baseCand("c") // no delta
    const out = await patchSizeVerifier()(cand)
    expect(out).toHaveLength(1)
    const s = out[0]!
    expect(s.kind).toBe("patch_size")
    expect(s.pass).toBe(true)
    expect(s.magnitude).toBe(0)
    expect(s.detail).toBe("no-delta")
  })

  test("A2: small delta (5/5, 1 file) ⇒ magnitude in [0.3,0.4]", async () => {
    const cand = baseCand("c", { addedLines: 5, removedLines: 5, changedFiles: 1 })
    const out = await patchSizeVerifier()(cand)
    const s = out[0]!
    expect(s.magnitude).toBeGreaterThanOrEqual(0.3)
    expect(s.magnitude).toBeLessThanOrEqual(0.4)
    expect(s.detail).toBe("+5/-5, 1 file")
  })

  test("A3: large delta (500/500, 10 files) ⇒ saturates at 1.0", async () => {
    const cand = baseCand("c", { addedLines: 500, removedLines: 500, changedFiles: 10 })
    const out = await patchSizeVerifier()(cand)
    const s = out[0]!
    expect(s.magnitude).toBe(1)
    expect(s.detail).toBe("+500/-500, 10 files")
  })

  test("A4: zero delta (0/0, 0 files) ⇒ magnitude 0", async () => {
    const cand = baseCand("c", { addedLines: 0, removedLines: 0, changedFiles: 0 })
    const out = await patchSizeVerifier()(cand)
    const s = out[0]!
    expect(s.magnitude).toBe(0)
    expect(s.detail).toBe("+0/-0, 0 files")
  })

  test("A5: file count pluralization (1 file, 2 files)", async () => {
    const one = await patchSizeVerifier()(
      baseCand("c", { addedLines: 1, removedLines: 0, changedFiles: 1 }),
    )
    expect(one[0]!.detail).toBe("+1/-0, 1 file")
    const two = await patchSizeVerifier()(
      baseCand("c", { addedLines: 2, removedLines: 0, changedFiles: 2 }),
    )
    expect(two[0]!.detail).toBe("+2/-0, 2 files")
  })
})

/* ================================================================== */
/* B. scorer integration                                                */
/* ================================================================== */
describe("HELL-B: scorer integration with patch_size", () => {
  test("B6: patch_size magnitude 0 ⇒ total unchanged vs no-patch_size baseline", () => {
    const base = defaultScorer([sig({ kind: "tsc", pass: true })])
    const withZero = defaultScorer([
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "patch_size", pass: true, magnitude: 0 }),
    ])
    expect(withZero.total).toBeCloseTo(base.total, 5)
  })

  test("B7: identical other signals + A.patch_size=0.5, B.patch_size=0 ⇒ A.total < B.total", () => {
    const a = defaultScorer([
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "patch_size", pass: true, magnitude: 0.5 }),
    ])
    const b = defaultScorer([
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "patch_size", pass: true, magnitude: 0 }),
    ])
    expect(a.total).toBeLessThan(b.total)
  })

  test("B8: weight override { patch_size: 0 } ⇒ signal value ignored", () => {
    const scorer = makeScorer({ patch_size: 0 })
    const withPenalty = scorer([
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "patch_size", pass: true, magnitude: 1 }),
    ])
    const baseline = scorer([sig({ kind: "tsc", pass: true })])
    expect(withPenalty.total).toBeCloseTo(baseline.total, 5)
  })

  test("B9: only a patch_size signal ⇒ total clamped to 0 (no negative)", () => {
    const s = defaultScorer([sig({ kind: "patch_size", pass: true, magnitude: 1 })])
    expect(s.total).toBe(0)
  })
})

/* ================================================================== */
/* C. minimalChangeSelector                                             */
/* ================================================================== */
describe("HELL-C: minimalChangeSelector", () => {
  test("C10: single candidate ⇒ that candidate (no tie possible)", () => {
    const w = minimalChangeSelector()([scored("only", 0.5)])
    expect(w.id).toBe("only")
  })

  test("C11: exact tie ⇒ smaller delta wins", () => {
    const w = minimalChangeSelector()([
      scored("a", 0.7, { addedLines: 10, removedLines: 10, changedFiles: 1 }), // 20
      scored("b", 0.7, { addedLines: 5, removedLines: 5, changedFiles: 1 }), // 10
    ])
    expect(w.id).toBe("b")
  })

  test("C12: tie where one has delta, one omitted ⇒ the one WITH delta wins", () => {
    const w = minimalChangeSelector()([
      scored("a", 0.7), // no delta ⇒ +Inf
      scored("b", 0.7, { addedLines: 100, removedLines: 100, changedFiles: 5 }),
    ])
    expect(w.id).toBe("b")
  })

  test("C13: scores differ by exactly epsilon ⇒ not tied; base winner unchanged", () => {
    const epsilon = 1e-6
    // Base argmax picks "a" (0.7 > 0.7 - eps). minimalChange should NOT
    // reclassify these as tied (boundary is strict `<`), so "a" stays.
    const w = minimalChangeSelector(
      argmaxSelector,
      epsilon,
    )([
      scored("a", 0.7, { addedLines: 1000, removedLines: 0, changedFiles: 1 }),
      scored("b", 0.7 - epsilon, { addedLines: 1, removedLines: 0, changedFiles: 1 }),
    ])
    expect(w.id).toBe("a")
  })

  test("C14: all tied but no deltas anywhere ⇒ base winner unchanged (no false promotion)", () => {
    // argmax ties on score=0.5 → lexicographic id ⇒ "a" wins.
    // minimalChange sees all +Inf deltas; preserves base winner.
    const w = minimalChangeSelector()([scored("b", 0.5), scored("a", 0.5), scored("c", 0.5)])
    expect(w.id).toBe("a")
  })
})

/* ================================================================== */
/* D. progress formatter                                                */
/* ================================================================== */
describe("HELL-D: formatBranchTrace", () => {
  test("D15: candidate-started ⇒ '▶' prefix, severity info; ASCII '>' when useUnicode:false", () => {
    const ev: BranchTraceEvent = { kind: "candidate-started", id: "cand-0", seed: {} }
    const uni = formatBranchTrace(ev)
    expect(uni.text.startsWith("▶")).toBe(true)
    expect(uni.severity).toBe("info")
    const ascii = formatBranchTrace(ev, { useUnicode: false })
    expect(ascii.text.startsWith(">")).toBe(true)
  })

  test("D16: candidate-finished plural — turns=1 'turn'; turns=3 'turns'", () => {
    const one = formatBranchTrace({
      kind: "candidate-finished",
      id: "c",
      turns: 1,
      durationMs: 42,
    })
    expect(one.text).toContain("1 turn")
    expect(one.text).not.toContain("1 turns")
    const three = formatBranchTrace({
      kind: "candidate-finished",
      id: "c",
      turns: 3,
      durationMs: 42,
    })
    expect(three.text).toContain("3 turns")
  })

  test("D17: candidate-failed regular id ⇒ '✗' prefix, severity warning", () => {
    const out = formatBranchTrace({ kind: "candidate-failed", id: "cand-2", reason: "boom" })
    expect(out.text.startsWith("✗")).toBe(true)
    expect(out.severity).toBe("warning")
    expect(out.text).toContain("cand-2")
    expect(out.text).toContain("boom")
  })

  test("D18: candidate-failed id='anchor' ⇒ '⚠' prefix, distinct text", () => {
    const out = formatBranchTrace({
      kind: "candidate-failed",
      id: "anchor",
      reason: "ENOSPC",
    })
    expect(out.text.startsWith("⚠")).toBe(true)
    expect(out.text).toContain("anchor registration failed")
    expect(out.text).toContain("ENOSPC")
    expect(out.severity).toBe("warning")
  })

  test("D19: candidate-delta ⇒ 'Δ' prefix + '+A/-R, F file(s)'", () => {
    const oneFile = formatBranchTrace({
      kind: "candidate-delta",
      id: "c",
      delta: { addedLines: 5, removedLines: 3, changedFiles: 1 },
    })
    expect(oneFile.text.startsWith("Δ")).toBe(true)
    expect(oneFile.text).toContain("+5/-3, 1 file")
    const manyFiles = formatBranchTrace({
      kind: "candidate-delta",
      id: "c",
      delta: { addedLines: 5, removedLines: 3, changedFiles: 4 },
    })
    expect(manyFiles.text).toContain("4 files")
  })

  test("D20: winner-selected ⇒ '★' prefix, severity success, score 3-decimals", () => {
    const out = formatBranchTrace({
      kind: "winner-selected",
      winnerId: "cand-1",
      total: 0.872345,
    })
    expect(out.text.startsWith("★")).toBe(true)
    expect(out.severity).toBe("success")
    expect(out.text).toContain("0.872")
    expect(out.text).not.toContain("0.8723") // truncated to 3
  })

  test("D21: colors:true + severity success ⇒ ANSI green wrapping", () => {
    const out = formatBranchTrace(
      { kind: "winner-selected", winnerId: "c", total: 0.5 },
      { colors: true },
    )
    expect(out.text.startsWith("\x1b[32m")).toBe(true)
    expect(out.text.endsWith("\x1b[0m")).toBe(true)
  })

  test("D22: determinism — same event + opts produce byte-identical text", () => {
    const ev: BranchTraceEvent = {
      kind: "candidate-scored",
      id: "c",
      total: 0.5,
      signals: [],
    }
    const a = formatBranchTrace(ev)
    const b = formatBranchTrace(ev)
    expect(a.text).toBe(b.text)
    expect(a.severity).toBe(b.severity)
  })
})

/* ================================================================== */
/* E. runner wiring (composition)                                        */
/* ================================================================== */
describe("HELL-E: branch-search-runner wiring", () => {
  /** Mirror of the runner's `buildBranchProgressTrace` — kept inline so the
   *  test exercises the documented composition shape directly (E23/E24/E25).
   *  Returns `undefined` when `onProgress` is unset (byte-identical
   *  no-progress path). */
  const buildProgressTrace = (
    onProgress: ((line: ProgressLine) => void) | undefined,
    base?: (e: BranchTraceEvent) => void,
  ): ((e: BranchTraceEvent) => void) | undefined => {
    if (onProgress === undefined) {
      // No progress callback: pass through the base sink unchanged (or
      // undefined if none). This models the runner's behaviour where the
      // tool's onTrace slot is OMITTED entirely when onProgress is absent.
      return base
    }
    return (event: BranchTraceEvent) => {
      if (base !== undefined) {
        try {
          base(event)
        } catch {
          /* base sink must not break the search */
        }
      }
      try {
        onProgress(formatBranchTrace(event))
      } catch {
        /* host progress callback must never break the search */
      }
    }
  }

  test("E23: onProgress absent ⇒ no onProgress-derived wrapper (base sink survives)", () => {
    const baseEvents: BranchTraceEvent[] = []
    const base = (e: BranchTraceEvent): void => {
      baseEvents.push(e)
    }
    // onProgress absent — composed onTrace is the base sink itself (no wrap)
    const composed = buildProgressTrace(undefined, base)
    expect(composed).toBe(base)
    // and with no base either, composed is undefined (byte-identical legacy)
    expect(buildProgressTrace(undefined, undefined)).toBeUndefined()
  })

  test("E24: onProgress present ⇒ called with each formatted ProgressLine in order", () => {
    const lines: ProgressLine[] = []
    const composed = buildProgressTrace((l) => lines.push(l))
    expect(composed).toBeDefined()
    const events: BranchTraceEvent[] = [
      { kind: "candidate-started", id: "cand-0", seed: {} },
      { kind: "candidate-scored", id: "cand-0", total: 0.5, signals: [] },
      { kind: "winner-selected", winnerId: "cand-0", total: 0.5 },
    ]
    for (const e of events) composed!(e)
    expect(lines).toHaveLength(3)
    expect(lines[0]!.text).toContain("started")
    expect(lines[1]!.text).toContain("scored")
    expect(lines[2]!.severity).toBe("success")
  })

  test("E25: onProgress AND base onTrace both wired ⇒ BOTH called per event", () => {
    const baseEvents: BranchTraceEvent[] = []
    const progressLines: ProgressLine[] = []
    const composed = buildProgressTrace(
      (l) => progressLines.push(l),
      (e) => baseEvents.push(e),
    )
    expect(composed).toBeDefined()
    const events: BranchTraceEvent[] = [
      { kind: "candidate-started", id: "c", seed: {} },
      { kind: "candidate-failed", id: "c", reason: "x" },
    ]
    for (const e of events) composed!(e)
    expect(baseEvents).toHaveLength(2)
    expect(progressLines).toHaveLength(2)
    expect(baseEvents[0]!.kind).toBe("candidate-started")
    expect(progressLines[0]!.text).toContain("started")
    expect(progressLines[1]!.severity).toBe("warning")
  })
})
