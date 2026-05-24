/**
 * Unit coverage for the CLI branch-search live-progress visualizer
 * (대6 catalog L4). Hermetic — no `BranchTraceEvent` is fabricated outside
 * the trace shape exported by `@/agent/branch-search`, so a schema change
 * to that union fails this suite at compile-time (intended).
 */
import { describe, expect, test } from "bun:test"
import type { BranchTraceEvent, VerifierSignal } from "@/agent/branch-search"
import {
  createBranchProgressTracker,
  formatBranchesPanel,
  formatStatusLine,
  isBranchProgressEnabled,
} from "../../src/apps/cli/branch-search-progress"

const sig = (kind: VerifierSignal["kind"], pass: boolean): VerifierSignal => ({
  kind,
  pass,
  detail: "",
  durationMs: 1,
})

const started = (id: string): BranchTraceEvent => ({
  kind: "candidate-started",
  id,
  seed: {},
})

const finished = (id: string, turns = 1, durationMs = 100): BranchTraceEvent => ({
  kind: "candidate-finished",
  id,
  turns,
  durationMs,
})

const scored = (id: string, total: number): BranchTraceEvent => ({
  kind: "candidate-scored",
  id,
  total,
  signals: [sig("tsc", total > 0.5)],
})

const failed = (id: string, reason: string): BranchTraceEvent => ({
  kind: "candidate-failed",
  id,
  reason,
})

const winner = (id: string, total: number): BranchTraceEvent => ({
  kind: "winner-selected",
  winnerId: id,
  total,
})

// ---------------------------------------------------------------------------
// Tracker — state-machine basics
// ---------------------------------------------------------------------------
describe("createBranchProgressTracker", () => {
  test("empty initial snapshot ⇒ formatStatusLine === '' and panel says 'no recorded'", () => {
    const tr = createBranchProgressTracker()
    const s = tr.snapshot()
    expect(s.candidates.size).toBe(0)
    expect(formatStatusLine(s)).toBe("")
    expect(formatBranchesPanel(s)).toBe("(no branch search recorded yet)")
  })

  test("one candidate, started-only ⇒ '1/1' is wrong, '0/1 scored' is right", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    const line = formatStatusLine(tr.snapshot())
    // No "scored" yet ⇒ no best, no winner ⇒ short form.
    expect(line).toBe("[branch-search: 0/1 scored]")
  })

  test("5 candidates, all scored, no winner yet ⇒ live X/Y + best", () => {
    const tr = createBranchProgressTracker()
    for (let i = 1; i <= 5; i++) tr.ingest(started(`cand-${i}`))
    tr.ingest(scored("cand-1", 0.74))
    tr.ingest(scored("cand-2", 0.87))
    tr.ingest(scored("cand-3", 0.71))
    tr.ingest(scored("cand-4", 0.82))
    tr.ingest(scored("cand-5", 0.68))
    const line = formatStatusLine(tr.snapshot())
    expect(line).toBe("[branch-search: 5/5 scored · best: cand-2@0.87]")
  })

  test("score sort: panel shows highest score first; #1 is winner when latched", () => {
    const tr = createBranchProgressTracker()
    for (let i = 1; i <= 5; i++) tr.ingest(started(`cand-${i}`))
    tr.ingest(scored("cand-1", 0.74))
    tr.ingest(scored("cand-2", 0.87))
    tr.ingest(scored("cand-3", 0.71))
    tr.ingest(scored("cand-4", 0.82))
    tr.ingest(scored("cand-5", 0.68))
    tr.ingest(winner("cand-2", 0.87))
    const panel = formatBranchesPanel(tr.snapshot())
    // First row after the rule should be #1 with cand-2 (winner).
    const lines = panel.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(7) // top rule + 5 rows + bottom rule
    const firstRow = lines[1] ?? ""
    expect(firstRow).toContain("#1")
    expect(firstRow).toContain("cand-2")
    expect(firstRow).toContain("0.87")
    expect(firstRow).toContain("(winner)")
    // #5 should be cand-5 (lowest score 0.68).
    const fifthRow = lines[5] ?? ""
    expect(fifthRow).toContain("cand-5")
    expect(fifthRow).toContain("0.68")
  })

  test("tie-break on equal score uses lexicographic id (stable bestSoFar)", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(started("cand-2"))
    tr.ingest(scored("cand-2", 0.5))
    expect(tr.snapshot().bestSoFarId).toBe("cand-2")
    tr.ingest(scored("cand-1", 0.5))
    // Equal score ⇒ lexicographic winner is cand-1 (id < cand-2).
    expect(tr.snapshot().bestSoFarId).toBe("cand-1")
  })

  test("winner-selected latches and overrides best-so-far in status line", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(started("cand-2"))
    tr.ingest(scored("cand-1", 0.9))
    tr.ingest(scored("cand-2", 0.5))
    expect(formatStatusLine(tr.snapshot())).toContain("best: cand-1@0.90")
    tr.ingest(winner("cand-2", 0.5))
    // Even though cand-1 had higher score, the winner-selected event is
    // the orchestrator's authoritative pick (e.g. minimal-change selector).
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: winner cand-2@0.50]")
  })

  test("failed candidate counts toward 'scored' total (score 0, terminal)", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(started("cand-2"))
    tr.ingest(failed("cand-1", "timeout"))
    tr.ingest(scored("cand-2", 0.6))
    const s = tr.snapshot()
    expect(s.candidates.get("cand-1")?.phase).toBe("failed")
    expect(s.candidates.get("cand-1")?.score).toBe(0)
    // 2 candidates settled (1 failed + 1 scored).
    expect(formatStatusLine(s)).toBe("[branch-search: 2/2 scored · best: cand-2@0.60]")
    // Panel surfaces the failure reason inline.
    expect(formatBranchesPanel(s)).toContain("— timeout")
  })

  test("anchor failure (synthetic 'anchor' id) appears in panel without consuming a candidate slot", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(failed("anchor", "no shadow odb"))
    tr.ingest(started("cand-1"))
    tr.ingest(scored("cand-1", 0.7))
    const s = tr.snapshot()
    expect(s.candidates.size).toBe(1)
    expect(s.anchorFailure).toBe("no shadow odb")
    const panel = formatBranchesPanel(s)
    expect(panel).toContain("anchor: no shadow odb")
    // Status line ignores the synthetic anchor.
    expect(formatStatusLine(s)).toContain("best: cand-1@0.70")
  })

  test("reset clears all state", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(scored("cand-1", 0.9))
    tr.ingest(winner("cand-1", 0.9))
    expect(tr.snapshot().candidates.size).toBe(1)
    tr.reset()
    expect(tr.snapshot().candidates.size).toBe(0)
    expect(tr.snapshot().winnerId).toBeUndefined()
  })

  test("delta event populates panel `[+added/-removed]` annotation", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(finished("cand-1", 3, 200))
    tr.ingest({
      kind: "candidate-delta",
      id: "cand-1",
      delta: { addedLines: 12, removedLines: 4, changedFiles: 2 },
    })
    tr.ingest(scored("cand-1", 0.8))
    const panel = formatBranchesPanel(tr.snapshot())
    expect(panel).toContain("[+12/-4]")
  })

  test("live update sequence: snapshot reflects events in order; status line evolves", () => {
    const tr = createBranchProgressTracker()
    // T=0: starts
    tr.ingest(started("cand-1"))
    tr.ingest(started("cand-2"))
    tr.ingest(started("cand-3"))
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: 0/3 scored]")
    // T=1: first score arrives
    tr.ingest(scored("cand-1", 0.6))
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: 1/3 scored · best: cand-1@0.60]")
    // T=2: better score overtakes
    tr.ingest(scored("cand-2", 0.9))
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: 2/3 scored · best: cand-2@0.90]")
    // T=3: lower score does NOT overtake
    tr.ingest(scored("cand-3", 0.3))
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: 3/3 scored · best: cand-2@0.90]")
    // T=4: winner latches
    tr.ingest(winner("cand-2", 0.9))
    expect(formatStatusLine(tr.snapshot())).toBe("[branch-search: winner cand-2@0.90]")
  })
})

// ---------------------------------------------------------------------------
// Render — color / no-color symmetry
// ---------------------------------------------------------------------------
describe("formatBranchesPanel — color OFF/ON", () => {
  // String-built regexes — the literal ESC control char (\x1b) must NOT
  // appear in source per biome `noControlCharactersInRegex` (same trick as
  // tests/unit/cli/markdown-painter.test.ts).
  const ESC = String.fromCharCode(27)
  const ANSI_ANY_RE = new RegExp(`${ESC}\\[`)
  const ANSI_BOLD_GREEN_RE = new RegExp(`${ESC}\\[1m${ESC}\\[32m`)
  const ANSI_RED_RE = new RegExp(`${ESC}\\[31m`)
  const ANSI_RESET_RE = new RegExp(`${ESC}\\[0m`)

  test("color OFF (default) emits no ANSI codes", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(scored("cand-1", 0.9))
    tr.ingest(winner("cand-1", 0.9))
    const panel = formatBranchesPanel(tr.snapshot())
    expect(panel).not.toMatch(ANSI_ANY_RE)
  })

  test("color ON (opt-in) emits ANSI codes around winner + failed rows", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest(started("cand-2"))
    tr.ingest(scored("cand-1", 0.9))
    tr.ingest(failed("cand-2", "boom"))
    tr.ingest(winner("cand-1", 0.9))
    const panel = formatBranchesPanel(tr.snapshot(), { colors: true })
    // Green/bold around the winner row + red around the failed row.
    expect(panel).toMatch(ANSI_BOLD_GREEN_RE)
    expect(panel).toMatch(ANSI_RED_RE)
    // ANSI reset must appear (otherwise the user's terminal stays painted).
    expect(panel).toMatch(ANSI_RESET_RE)
  })

  test("non-finite score renders as '--' (defensive)", () => {
    const tr = createBranchProgressTracker()
    tr.ingest(started("cand-1"))
    tr.ingest({
      kind: "candidate-scored",
      id: "cand-1",
      total: Number.NaN,
      signals: [],
    })
    const panel = formatBranchesPanel(tr.snapshot())
    expect(panel).toContain("--")
    expect(panel).not.toContain("NaN")
  })
})

// ---------------------------------------------------------------------------
// Env knob
// ---------------------------------------------------------------------------
describe("isBranchProgressEnabled", () => {
  test("TTY + no knob ⇒ enabled (default-ON)", () => {
    expect(isBranchProgressEnabled({}, true)).toBe(true)
  })
  test("non-TTY ⇒ disabled regardless of knob", () => {
    expect(isBranchProgressEnabled({ QUANTA_BRANCH_SEARCH_PROGRESS: "1" }, false)).toBe(false)
    expect(isBranchProgressEnabled({}, undefined)).toBe(false)
  })
  test("explicit 0/false/off/no disables on TTY", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
      expect(isBranchProgressEnabled({ QUANTA_BRANCH_SEARCH_PROGRESS: v }, true)).toBe(false)
    }
  })
  test("any other value keeps it enabled", () => {
    expect(isBranchProgressEnabled({ QUANTA_BRANCH_SEARCH_PROGRESS: "1" }, true)).toBe(true)
    expect(isBranchProgressEnabled({ QUANTA_BRANCH_SEARCH_PROGRESS: "yes" }, true)).toBe(true)
  })
})
