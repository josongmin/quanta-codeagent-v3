import { describe, expect, test } from "bun:test"
import { buildCandidatePoolRows, touchedFilesFromDiff } from "./candidate-ledger"
import type { RepairCandidateOutcome } from "./types"

// jun-29 — the breadth pool ledger must capture EVERY candidate (not just the
// adopted winner) so "was there a winning candidate the selector missed?" is
// answerable post-hoc. These are leaf units (pure diff-parse + field copy).

const DIFF_2FILE = `diff --git a/sphinx/ext/napoleon/docstring.py b/sphinx/ext/napoleon/docstring.py
index abc..def 100644
--- a/sphinx/ext/napoleon/docstring.py
+++ b/sphinx/ext/napoleon/docstring.py
@@ -1 +1 @@
-old
+new
diff --git a/sphinx/util/docfields.py b/sphinx/util/docfields.py
index 111..222 100644
--- a/sphinx/util/docfields.py
+++ b/sphinx/util/docfields.py
@@ -1 +1 @@
-x
+y`

const fakeCandidate = (
  patch: string,
  ok: boolean,
  extra: Record<string, unknown> = {},
): RepairCandidateOutcome =>
  ({
    run: { patch, turns: 1 } as RepairCandidateOutcome["run"],
    validator: { ok, ...extra } as unknown as RepairCandidateOutcome["validator"],
    adopt: async () => {},
  }) as RepairCandidateOutcome

describe("touchedFilesFromDiff", () => {
  test("parses every diff --git b/ path, deduped, in order", () => {
    expect(touchedFilesFromDiff(DIFF_2FILE)).toEqual([
      "sphinx/ext/napoleon/docstring.py",
      "sphinx/util/docfields.py",
    ])
  })

  test("empty patch ⇒ []", () => {
    expect(touchedFilesFromDiff("")).toEqual([])
    expect(touchedFilesFromDiff("not a diff\njust text")).toEqual([])
  })

  test("dedups a file that appears twice", () => {
    const d = `diff --git a/x.py b/x.py\n@@\ndiff --git a/x.py b/x.py\n@@`
    expect(touchedFilesFromDiff(d)).toEqual(["x.py"])
  })
})

describe("buildCandidatePoolRows", () => {
  test("captures ALL candidates in index order (not just the winner)", () => {
    const candidates = [
      fakeCandidate(DIFF_2FILE, false),
      fakeCandidate("diff --git a/other.py b/other.py\n@@", true),
      fakeCandidate("", false), // empty/no-edit candidate
    ]
    const rows = buildCandidatePoolRows(2, candidates)
    expect(rows.length).toBe(3) // EVERY candidate, not 1
    expect(rows.map((r) => r.candidateIndex)).toEqual([0, 1, 2])
    expect(rows.every((r) => r.round === 2)).toBe(true)
  })

  test("row carries touchedFiles + patchBytes + validatorOk", () => {
    const [row] = buildCandidatePoolRows(0, [fakeCandidate(DIFF_2FILE, false)])
    expect(row?.touchedFiles).toEqual([
      "sphinx/ext/napoleon/docstring.py",
      "sphinx/util/docfields.py",
    ])
    expect(row?.patchBytes).toBe(DIFF_2FILE.length)
    expect(row?.validatorOk).toBe(false)
  })

  test("reproOutcome read from consensus, else reproOutcome, else omitted", () => {
    const rows = buildCandidatePoolRows(0, [
      fakeCandidate("", true, { consensus: "resolved" }),
      fakeCandidate("", false, { reproOutcome: "reproduced" }),
      fakeCandidate("", false),
    ])
    expect(rows[0]?.reproOutcome).toBe("resolved")
    expect(rows[1]?.reproOutcome).toBe("reproduced")
    expect(rows[2]?.reproOutcome).toBeUndefined()
  })

  test("typed lead file/symbol from location fanout is persisted for RCA", () => {
    const [row] = buildCandidatePoolRows(0, [
      {
        ...fakeCandidate("diff --git a/pkg/core.py b/pkg/core.py\n@@", false),
        locationFocus: {
          leadFile: "pkg/core.py",
          relatedFiles: ["pkg/utils.py"],
          leadSymbol: "render",
          otherSymbols: ["parse"],
        },
      },
    ])
    expect(row?.leadFile).toBe("pkg/core.py")
    expect(row?.leadSymbol).toBe("render")
  })

  test("typed family coverage metadata is persisted for structural RCA", () => {
    const [row] = buildCandidatePoolRows(0, [
      {
        ...fakeCandidate("diff --git a/pkg/core.py b/pkg/core.py\n@@", false),
        familyId: "multi-site",
        familyCoverageMissing: ["pkg/peer.py"],
      },
    ])
    expect(row?.familyId).toBe("multi-site")
    expect(row?.familyCoverageMissing).toEqual(["pkg/peer.py"])
  })

  test("empty pool ⇒ [] (degenerate fan-out, no rows)", () => {
    expect(buildCandidatePoolRows(0, [])).toEqual([])
  })
})
