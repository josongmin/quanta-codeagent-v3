/**
 * DIFF-PANEL RECONCILE-COUNT PROOF — ADR-0440 perf (P2).
 *
 * BEFORE the fix, `DiffPanel` / `DiffView` / `DiffStats` were NOT memoized. On
 * every `tool.diff` frame, `useToolDiffs` returns a NEW Map ⇒ `DiffsSection`
 * re-renders ⇒ it maps `[...diffs.values()]` to `<DiffPanel>` ⇒ React re-renders
 * EVERY panel — including the N-1 UNCHANGED ones, each a full `<tr>`-per-line
 * table. A frame for ONE `toolCallId` paid O(N · lines) render work.
 *
 * The FIX memoizes `DiffPanel` on the STABLE per-id `ToolDiffMessage` reference
 * (`areDiffPanelPropsEqual`). The latest-wins Map only allocates a fresh object
 * for the ONE mutated entry, so the other N-1 panels receive the IDENTICAL
 * `diff` reference and bail — the changed one re-renders, the rest do not.
 *
 * The env is `node` (no jsdom / testing-library). We prove the win at the memo
 * comparator boundary — exactly what React evaluates before descending into a
 * memoized child. We simulate React's reconcile of the diff list: for each
 * frame, compare each panel's prev vs next per-id `diff` via the exported
 * comparator; a `true` means React SKIPS that panel's subtree (the bail we
 * want). A control run with the reference-identity check REMOVED (the
 * un-memoized path) shows every panel would have re-rendered.
 */
import { describe, expect, it } from "vitest"
import type { DiffLineData, ToolDiffMessage } from "../types/protocol"
import { toolDiffsReducer } from "../ws/canvas-hooks"
import { areDiffPanelPropsEqual } from "./DiffPanel"

const N = 40 // distinct tool calls already in the pane
const K = 20 // subsequent frames, one per distinct NEW tool call

const lines = (n: number): DiffLineData[] =>
  Array.from({ length: n }, (_, i) => ({
    type: "added" as const,
    content: `line ${i}`,
    lineNumber: i,
  }))

const diff = (toolCallId: string, additions = 3): ToolDiffMessage => ({
  kind: "tool.diff",
  toolCallId,
  path: `src/${toolCallId}.ts`,
  lines: lines(additions),
  additions,
  deletions: 0,
  emittedAt: 0,
})

/** Seed the reducer with N distinct tool diffs. */
const seededDiffs = (n: number): ReadonlyMap<string, ToolDiffMessage> => {
  let state: ReadonlyMap<string, ToolDiffMessage> = new Map()
  for (let i = 0; i < n; i += 1) {
    state = toolDiffsReducer(state, { type: "message", msg: diff(`seed-${i}`) })
  }
  return state
}

/**
 * Simulate React reconciling the `DiffsSection` panel list across a frame.
 * Returns how many panels React would RE-RENDER (comparator returned `false`),
 * given a per-panel equality predicate. `[...values()]` is the exact list
 * `DiffsSection` maps to `<DiffPanel key={diff.toolCallId} diff={diff} />`.
 */
const countRerenders = (
  before: ReadonlyMap<string, ToolDiffMessage>,
  after: ReadonlyMap<string, ToolDiffMessage>,
  equal: (a: ToolDiffMessage, b: ToolDiffMessage) => boolean,
): number => {
  const nextPanels = [...after.values()]
  let rerenders = 0
  for (const nextDiff of nextPanels) {
    const prevDiff = before.get(nextDiff.toolCallId)
    // A brand-new key has no prev ⇒ it mounts (counts as a render). An existing
    // key: React runs the memo comparator; `false` ⇒ re-render.
    if (prevDiff === undefined) {
      rerenders += 1
      continue
    }
    if (!equal(prevDiff, nextDiff)) rerenders += 1
  }
  return rerenders
}

const memoEqual = (a: ToolDiffMessage, b: ToolDiffMessage): boolean =>
  areDiffPanelPropsEqual({ diff: a }, { diff: b })

// The un-memoized control: React with no `memo` re-renders EVERY child whenever
// the parent (`DiffsSection`) re-renders — which it does every frame (new Map).
const alwaysRerender = (): boolean => false

describe("DiffPanel reconcile-count (P2 perf proof)", () => {
  it("keeps unchanged per-id diff refs STABLE across a frame (memo bails on N-1 panels)", () => {
    const before = seededDiffs(N)
    const beforeRefs = new Map([...before.entries()])

    // One NEW tool call arrives. Latest-wins Map keeps every existing entry's
    // object reference identical — only the new key allocates.
    const after = toolDiffsReducer(before, { type: "message", msg: diff("frame-new") })

    let stableRefs = 0
    for (const [id, ref] of beforeRefs) {
      if (after.get(id) === ref) stableRefs += 1
    }
    // ALL N pre-existing entries kept their exact reference.
    expect(stableRefs).toBe(N)
    expect(after.size).toBe(N + 1)
  })

  it("re-renders ONLY the changed panel per frame (memoized), independent of N", () => {
    let state = seededDiffs(N)

    let totalRerenders = 0
    for (let k = 0; k < K; k += 1) {
      const before = state
      // Each frame is a NEW distinct tool call ⇒ exactly one mount, N bails.
      state = toolDiffsReducer(before, { type: "message", msg: diff(`frame-${k}`) })
      totalRerenders += countRerenders(before, state, memoEqual)
    }

    // Exactly one render per frame (the new panel mounts; the growing set of
    // prior panels ALL bail). NOT O(N·K).
    expect(totalRerenders).toBe(K)
  })

  it("re-renders the SAME panel when its own toolCallId gets a fresh frame", () => {
    let state = seededDiffs(N)
    const before = state
    // Latest-wins UPDATE of an existing id ⇒ that panel's `diff` object is NEW
    // ⇒ its comparator returns false ⇒ it re-renders. The others still bail.
    state = toolDiffsReducer(before, { type: "message", msg: diff("seed-0", 99) })

    const rerenders = countRerenders(before, state, memoEqual)
    expect(rerenders).toBe(1)
    expect(state.get("seed-0")?.additions).toBe(99)
  })

  it("CONTROL: the un-memoized path re-renders EVERY panel each frame (the bug)", () => {
    let state = seededDiffs(N)

    let totalRerenders = 0
    for (let k = 0; k < K; k += 1) {
      const before = state
      state = toolDiffsReducer(before, { type: "message", msg: diff(`frame-${k}`) })
      totalRerenders += countRerenders(before, state, alwaysRerender)
    }

    // Without memo, every panel in the (growing) list re-renders every frame:
    // sum over k of (N + k + 1) ≫ K. This is the O(N·K) blowup the fix kills.
    const worstCase = Array.from({ length: K }, (_, k) => N + k + 1).reduce((a, b) => a + b, 0)
    expect(totalRerenders).toBe(worstCase)
    expect(totalRerenders).toBeGreaterThan(K)
  })

  it("comparator is EXACT: same ref ⇒ bail; different ref ⇒ render (no stale, no over-render)", () => {
    const d = diff("t1")
    // Same reference ⇒ bail (unchanged panel).
    expect(areDiffPanelPropsEqual({ diff: d }, { diff: d })).toBe(true)
    // A genuinely new object (daemon always builds fresh) ⇒ render. This is why
    // there is NO stale risk: a content change ALWAYS yields a new reference.
    const d2 = diff("t1", 7)
    expect(areDiffPanelPropsEqual({ diff: d }, { diff: d2 })).toBe(false)
    // A primitive display prop change (theme) ⇒ render even if diff is same ref.
    expect(areDiffPanelPropsEqual({ diff: d, theme: "dark" }, { diff: d, theme: "light" })).toBe(
      false,
    )
  })
})
