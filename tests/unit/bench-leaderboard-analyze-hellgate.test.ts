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
  test("harness report ⇒ verdicts ⇒ rows ⇒ markdown with correct bucketing + repo", () => {
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
    expect(md).toContain("Official harness resolved: 1 / 3")
    // resolved instance lands under Official Harness with its derived repo.
    expect(md).toContain("| django__django-1 | django | agentless-v1 | gpt-5 |")
    // empty-patch + unresolved both bucket as Unresolved.
    expect(md).toContain("Unresolved: 2")
    expect(md).toContain("flask__flask-2")
    expect(md).toContain("sympy__sympy-3")
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
