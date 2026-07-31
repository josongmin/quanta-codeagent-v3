/**
 * Hellgate (real analysis pipeline + teeth) for bench-leaderboard-analyze:
 * the post-run rollup that turns a raw bench/harness report into the leaderboard
 * markdown SSOT. Drives the WHOLE chain end-to-end —
 *   report JSON → loadVerdicts → rowsFromRun → renderLeaderboardMarkdown —
 * not an isolated helper, so a regression anywhere in the pipeline reds this.
 *
 * Teeth:
 *  - verdict bucketing: resolved/unresolved/empty-patch land in the right counts.
 *  - repo derivation: `django__django-1` → repo `django`.
 *  - dedup keeps the STRONGEST status (official_harness beats unresolved for the
 *    same instance id) — the rollup must never double-count or under-rank.
 *  - unrecognised report shape THROWS (no silent empty leaderboard).
 */
import { describe, expect, test } from "bun:test"
import {
  type LeaderRow,
  renderLeaderboardMarkdown,
  rowsFromRun,
} from "@/apps/bench/analyze/leaderboard"
import { loadVerdicts } from "@/apps/bench/analyze/verdicts"

const META = { preset: "agentless-v1", model: "gpt-5" }

describe("bench-leaderboard-analyze pipeline", () => {
  test("genuine misses (wrong-fix + empty-patch) ARE counted; re-runnable holes are NOT", () => {
    // Wrong-fix (unresolved) and empty-patch are REAL capability misses and
    // stay in the denominator. (Harness `error_ids` = re-runnable infra, tested
    // separately below.)
    const report = {
      resolved_ids: ["django__django-1"],
      unresolved_ids: ["flask__flask-2"],
      empty_patch_ids: ["sympy__sympy-3"],
    }
    const verdicts = loadVerdicts(report)
    expect(verdicts.resolved.has("django__django-1")).toBe(true)
    expect(verdicts.unresolved.has("flask__flask-2")).toBe(true)
    expect(verdicts.emptyPatch.has("sympy__sympy-3")).toBe(true)

    const rows = rowsFromRun(verdicts, META)
    const md = renderLeaderboardMarkdown(rows)
    // No re-runnable holes here ⇒ all 3 are real attempts in the denominator.
    expect(md).toContain("Official harness resolved: 1 / 3")
    // resolved instance lands under Official Harness with its derived repo.
    expect(md).toContain("| django__django-1 | django | agentless-v1 | gpt-5 |")
    // empty-patch + wrong-fix both bucket as Unresolved (real misses).
    expect(md).toContain("Unresolved: 2")
    expect(md).toContain("Unmeasured (re-runnable: 0 throttled/infra)")
    expect(md).toContain("flask__flask-2")
    expect(md).toContain("sympy__sympy-3")
  })

  test("harness error_ids are re-runnable ⇒ excluded from the denominator, surfaced separately", () => {
    const report = {
      resolved_ids: ["django__django-1"],
      unresolved_ids: ["flask__flask-2"],
      error_ids: ["sympy__sympy-9"], // throttle/harness/grader infra
    }
    const verdicts = loadVerdicts(report)
    expect(verdicts.errored.has("sympy__sympy-9")).toBe(true)
    expect(verdicts.reRunnable.has("sympy__sympy-9")).toBe(true)

    const md = renderLeaderboardMarkdown(rowsFromRun(verdicts, META))
    // Denominator = resolved + real-miss = 1 resolved + 1 wrong-fix = 2 (NOT 3).
    expect(md).toContain("Official harness resolved: 1 / 2")
    expect(md).toContain("Unresolved: 1")
    expect(md).toContain("Unmeasured (re-runnable: 1 throttled/infra)")
    // The infra instance is NOT in the miss bucket.
    expect(md).toContain("## Unmeasured — re-runnable (1)")
  })

  test("TEETH: K throttled instances do NOT deflate the rate; K empty-patches DO count as misses", () => {
    // Our-report shape carries per-instance terminations, so throttle is
    // distinguishable from a genuine empty-patch.
    const throttledRow = (id: string) => ({
      id,
      passed: false,
      patchBytes: 0,
      failure: { termination: "throttled", signals: [] },
    })
    const emptyRow = (id: string) => ({ id, passed: false, patchBytes: 0 })
    const resolvedRow = (id: string) => ({
      id,
      passed: true,
      gradeBreakdown: { resolved: true },
    })

    // Run WITH throttled instances.
    const withThrottle = loadVerdicts({
      perInstance: [
        resolvedRow("a__1"),
        resolvedRow("a__2"),
        throttledRow("a__3"),
        throttledRow("a__4"),
      ],
    })
    // Same run with the throttled instances physically removed.
    const withoutThrottle = loadVerdicts({
      perInstance: [resolvedRow("a__1"), resolvedRow("a__2")],
    })

    const mdWith = renderLeaderboardMarkdown(rowsFromRun(withThrottle, META))
    const mdWithout = renderLeaderboardMarkdown(rowsFromRun(withoutThrottle, META))
    // IDENTICAL headline rate: throttle no longer deflates (2/2 either way).
    expect(mdWith).toContain("Official harness resolved: 2 / 2")
    expect(mdWithout).toContain("Official harness resolved: 2 / 2")
    expect(mdWith).toContain("Unmeasured (re-runnable: 2 throttled/infra)")

    // CONTROL: K genuine empty-patches DO count as misses (rate drops).
    const withEmpty = loadVerdicts({
      perInstance: [resolvedRow("a__1"), resolvedRow("a__2"), emptyRow("a__3"), emptyRow("a__4")],
    })
    const mdEmpty = renderLeaderboardMarkdown(rowsFromRun(withEmpty, META))
    expect(mdEmpty).toContain("Official harness resolved: 2 / 4")
    expect(mdEmpty).toContain("Unmeasured (re-runnable: 0 throttled/infra)")
  })

  test("TEETH: genuine errored terminations (timeout/generation_error) STAY real misses", () => {
    const v = loadVerdicts({
      perInstance: [
        { id: "a__1", passed: true, gradeBreakdown: { resolved: true } },
        { id: "a__2", passed: false, failure: { termination: "timeout", signals: [] } },
        {
          id: "a__3",
          passed: false,
          failure: { termination: "generation_error", signals: [] },
        },
        { id: "a__4", passed: false, failure: { termination: "throttled", signals: [] } },
      ],
    })
    // timeout + generation_error are real misses ⇒ denominator counts them;
    // only the throttled one is excluded.
    const md = renderLeaderboardMarkdown(rowsFromRun(v, META))
    expect(md).toContain("Official harness resolved: 1 / 3")
    expect(md).toContain("Unresolved: 2")
    expect(md).toContain("Unmeasured (re-runnable: 1 throttled/infra)")
  })

  test("dedup keeps the STRONGEST status for a repeated instance id", () => {
    const rows: LeaderRow[] = [
      { instanceId: "x__1", repo: "x", preset: "p", model: "m", status: "unresolved" },
      { instanceId: "x__1", repo: "x", preset: "p", model: "m", status: "official_harness" },
    ]
    const md = renderLeaderboardMarkdown(rows)
    // One instance total, counted once, ranked as official (not unresolved).
    expect(md).toContain("Official harness resolved: 1 / 1")
    expect(md).toContain("Unresolved: 0")
  })

  test("unrecognised report shape throws (no silent empty leaderboard)", () => {
    expect(() => loadVerdicts({ nope: true })).toThrow()
    expect(() => loadVerdicts(42)).toThrow()
  })
})
