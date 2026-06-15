/**
 * ADR-0536 P0 — bench ANALYSIS layer tests (PURE).
 *
 * Covers all four modules with inline fixtures for BOTH report shapes. Each
 * test asserts a real observable (set membership, file-set divergence, dedup
 * outcome) and includes a red-on-injection partner where the prompt asks for
 * it, so a vacuous/over-permissive implementation fails here.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { diffRuns, renderDiff } from "./diff"
import { explainFailure, filesInDiff } from "./explain"
import { type LeaderRow, renderLeaderboardMarkdown, rowsFromRun } from "./leaderboard"
import { loadVerdicts, loadVerdictsFromFile } from "./verdicts"

// ── verdicts: both shapes normalise to the same RunVerdicts ────────────────

describe("loadVerdicts — both report shapes", () => {
  const ourReport = {
    timestamp: "2026-06-15T00:00:00Z",
    model: "m",
    provider: "p",
    n: 4,
    totals: { total: 4, resolved: 1, resolvedPct: 25 },
    perInstance: [
      { id: "django__django-1", passed: true, turns: 3, patchBytes: 120 },
      { id: "django__django-2", passed: false, turns: 5, patchBytes: 40 }, // unresolved
      {
        id: "django__django-3",
        passed: false,
        turns: 0,
        patchBytes: 0,
        failure: { termination: "generation_error", signals: ["empty_patch"] },
      },
      {
        id: "django__django-4",
        passed: false,
        turns: 2,
        patchBytes: 10,
        error: "boom",
        failure: { termination: "harness_error", signals: [] },
      },
    ],
    knobs: { resolved: {}, inactive: [] },
  }

  const harnessReport = {
    total_instances: 4,
    resolved_instances: 1,
    unresolved_instances: 1,
    error_instances: 1,
    empty_patch_instances: 1,
    resolved_ids: ["django__django-1"],
    unresolved_ids: ["django__django-2"],
    error_ids: ["django__django-4"],
    empty_patch_ids: ["django__django-3"],
  }

  test("our bench report → correct four buckets", () => {
    const v = loadVerdicts(ourReport)
    expect([...v.resolved]).toEqual(["django__django-1"])
    expect([...v.unresolved]).toEqual(["django__django-2"])
    expect([...v.emptyPatch]).toEqual(["django__django-3"])
    expect([...v.errored]).toEqual(["django__django-4"])
  })

  test("harness report → correct four buckets", () => {
    const v = loadVerdicts(harnessReport)
    expect([...v.resolved]).toEqual(["django__django-1"])
    expect([...v.unresolved]).toEqual(["django__django-2"])
    expect([...v.emptyPatch]).toEqual(["django__django-3"])
    expect([...v.errored]).toEqual(["django__django-4"])
  })

  test("both shapes yield equivalent RunVerdicts for equivalent data", () => {
    const a = loadVerdicts(ourReport)
    const b = loadVerdicts(harnessReport)
    for (const k of ["resolved", "unresolved", "emptyPatch", "errored"] as const) {
      expect([...a[k]].sort()).toEqual([...b[k]].sort())
    }
  })

  test("red-on-injection: a passing instance is NEVER counted unresolved", () => {
    const v = loadVerdicts(ourReport)
    expect(v.unresolved.has("django__django-1")).toBe(false)
    expect(v.resolved.has("django__django-1")).toBe(true)
  })

  test("harness *_ids may be JSON-encoded strings (double-encoded export)", () => {
    const v = loadVerdicts({ resolved_ids: '["a__1","b__2"]', unresolved_ids: [] })
    expect([...v.resolved].sort()).toEqual(["a__1", "b__2"])
  })

  test("unrecognised shape throws", () => {
    expect(() => loadVerdicts({ nope: 1 })).toThrow()
    expect(() => loadVerdicts(null)).toThrow()
  })

  test("loadVerdictsFromFile reads + parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"))
    const p = join(dir, "report.json")
    writeFileSync(p, JSON.stringify(harnessReport))
    const v = loadVerdictsFromFile(p)
    expect([...v.resolved]).toEqual(["django__django-1"])
  })
})

// ── diff: A resolved {x,y}, B resolved {y,z} ───────────────────────────────

describe("diffRuns", () => {
  const mk = (resolved: string[], rest: string[] = []) => ({
    resolved: new Set(resolved),
    unresolved: new Set(rest),
    errored: new Set<string>(),
    emptyPatch: new Set<string>(),
  })

  test("newlyResolved [z], newlyBroken [x], stillResolved [y]", () => {
    const a = mk(["x", "y"], ["z"])
    const b = mk(["y", "z"], ["x"])
    const d = diffRuns(a, b)
    expect(d.newlyResolved).toEqual(["z"])
    expect(d.newlyBroken).toEqual(["x"])
    expect(d.stillResolved).toEqual(["y"])
    expect(d.resolvedA).toBe(2)
    expect(d.resolvedB).toBe(2)
    // union {x,y,z} = 3 instances, delta 0 → 0%
    expect(d.deltaPct).toBe(0)
  })

  test("deltaPct reflects a real improvement", () => {
    // A resolves 0/3, B resolves 2/3 → +2/3 ≈ +67%
    const a = mk([], ["x", "y", "z"])
    const b = mk(["x", "y"], ["z"])
    const d = diffRuns(a, b)
    expect(d.deltaPct).toBe(67)
  })

  test("red-on-injection: an instance resolved in BOTH is never newlyBroken/newlyResolved", () => {
    const a = mk(["y"])
    const b = mk(["y"])
    const d = diffRuns(a, b)
    expect(d.newlyResolved).toEqual([])
    expect(d.newlyBroken).toEqual([])
    expect(d.stillResolved).toEqual(["y"])
  })

  test("renderDiff surfaces every section", () => {
    const out = renderDiff(diffRuns(mk(["x", "y"]), mk(["y", "z"])))
    expect(out).toContain("newly resolved")
    expect(out).toContain("z")
    expect(out).toContain("newly broken")
    expect(out).toContain("x")
    expect(out).toContain("still resolved")
  })
})

// ── explain: agent touched the right file but wrong algorithm ───────────────

describe("filesInDiff", () => {
  test("extracts b/<path> from diff --git headers", () => {
    const patch = [
      "diff --git a/pylint/foo.py b/pylint/foo.py",
      "--- a/pylint/foo.py",
      "+++ b/pylint/foo.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/pylint/bar.py b/pylint/bar.py",
      "+z",
    ].join("\n")
    expect(filesInDiff(patch)).toEqual(["pylint/foo.py", "pylint/bar.py"])
  })

  test("empty / non-diff patch → []", () => {
    expect(filesInDiff("")).toEqual([])
    expect(filesInDiff("just some text\nno headers")).toEqual([])
  })
})

describe("explainFailure", () => {
  const writeDataset = (): { datasetPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "explain-"))
    const goldPatch = [
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py",
      "+gold change A",
      "diff --git a/pylint/checkers/utils.py b/pylint/checkers/utils.py",
      "+gold change B",
    ].join("\n")
    const testPatch = [
      "diff --git a/tests/test_format.py b/tests/test_format.py",
      "+def test_thing(): assert True",
    ].join("\n")
    const row = {
      instance_id: "pylint-dev__pylint-8898",
      patch: goldPatch,
      test_patch: testPatch,
      FAIL_TO_PASS: '["tests/test_format.py::test_thing"]',
    }
    const datasetPath = join(dir, "instances.jsonl")
    writeFileSync(datasetPath, `${JSON.stringify(row)}\n`)
    return { datasetPath }
  }

  test("agent touched only 1 of 2 gold files → sameFiles=false, FAIL_TO_PASS surfaced", () => {
    const { datasetPath } = writeDataset()
    const agentPatch = "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+agent change"
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatch,
    })
    expect(e.goldFiles).toEqual(["pylint/checkers/format.py", "pylint/checkers/utils.py"])
    expect(e.agentFiles).toEqual(["pylint/checkers/format.py"])
    expect(e.sameFiles).toBe(false)
    expect(e.failToPass).toEqual(["tests/test_format.py::test_thing"])
    expect(e.summary).toContain("tests/test_format.py::test_thing")
    expect(e.summary).toContain("PARTIAL OVERLAP")
  })

  test("same-file-set (right file, wrong algorithm) → sameFiles=true and a clear verdict", () => {
    const { datasetPath } = writeDataset()
    // Agent touched EXACTLY the two gold files but still failed.
    const agentPatch = [
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py",
      "+wrong algo",
      "diff --git a/pylint/checkers/utils.py b/pylint/checkers/utils.py",
      "+wrong algo",
    ].join("\n")
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatch,
    })
    expect(e.sameFiles).toBe(true)
    expect(e.summary).toContain("SAME FILE SET")
  })

  test("no agent patch → agentFiles [], sameFiles false", () => {
    const { datasetPath } = writeDataset()
    const e = explainFailure({ datasetPath, instanceId: "pylint-dev__pylint-8898" })
    expect(e.agentPatch).toBeUndefined()
    expect(e.agentFiles).toEqual([])
    expect(e.sameFiles).toBe(false)
  })

  test("agentPatchPath is read from disk when no inline patch given", () => {
    const { datasetPath } = writeDataset()
    const dir = mkdtempSync(join(tmpdir(), "agent-"))
    const agentPatchPath = join(dir, "agent.patch")
    writeFileSync(
      agentPatchPath,
      "diff --git a/pylint/checkers/format.py b/pylint/checkers/format.py\n+x",
    )
    const e = explainFailure({
      datasetPath,
      instanceId: "pylint-dev__pylint-8898",
      agentPatchPath,
    })
    expect(e.agentFiles).toEqual(["pylint/checkers/format.py"])
  })

  test("missing instance throws", () => {
    const { datasetPath } = writeDataset()
    expect(() => explainFailure({ datasetPath, instanceId: "nope__1" })).toThrow()
  })
})

// ── leaderboard: dedup keeps resolved when same instance appears twice ──────

describe("renderLeaderboardMarkdown", () => {
  test("rowsFromRun derives repo from instanceId and resolved flag", () => {
    const rows = rowsFromRun(
      {
        resolved: new Set(["django__django-1"]),
        unresolved: new Set(["flask__flask-9"]),
        errored: new Set<string>(),
        emptyPatch: new Set<string>(),
      },
      { preset: "agentless-v1", model: "gpt-5" },
    )
    const byId = new Map(rows.map((r) => [r.instanceId, r]))
    expect(byId.get("django__django-1")?.repo).toBe("django")
    expect(byId.get("django__django-1")?.resolved).toBe(true)
    expect(byId.get("flask__flask-9")?.repo).toBe("flask")
    expect(byId.get("flask__flask-9")?.resolved).toBe(false)
  })

  test("dedup keeps RESOLVED when an instance appears resolved + unresolved", () => {
    const rows: LeaderRow[] = [
      { instanceId: "x__1", repo: "x", preset: "a", model: "m", resolved: false },
      { instanceId: "x__1", repo: "x", preset: "b", model: "m", resolved: true },
    ]
    const md = renderLeaderboardMarkdown(rows)
    // 1 instance total, counted as resolved.
    expect(md).toContain("Resolved: 1 / 1")
    // x__1 must appear under the resolved table; the unresolved table is empty.
    const [, resolvedSection = "", unresolvedSection = ""] = md.split(/## (?:Resolved|Unresolved)/)
    expect(resolvedSection).toContain("x__1")
    expect(unresolvedSection).not.toContain("x__1")
  })

  test("red-on-injection: an only-unresolved instance is NOT promoted to resolved", () => {
    const rows: LeaderRow[] = [
      { instanceId: "y__2", repo: "y", preset: "a", model: "m", resolved: false },
    ]
    const md = renderLeaderboardMarkdown(rows)
    expect(md).toContain("Resolved: 0 / 1")
  })
})
