/**
 * HELLGATE: durable integrity guard for the Jun-20 bug-bash audit artifact.
 *
 * The bug-bash doc (`docs/bugbash/jun-20-bugbash.md`) is a *generated* artifact.
 * Its data lives in `docs/bugbash/jun-20-bugbash.findings.json`. This test is the
 * forcing-function that keeps the two honest and makes the artifact reproducible:
 *
 *   1. COUNT TRUTH      — surfaced = actionable + none-retained, and the numbers
 *                         in the JSON match the array tallies AND the rendered doc.
 *                         (Closes the "33 confirmed" overclaim: NONE entries are
 *                         counted as retained-notes, not actionable findings.)
 *   2. SCOPE PINNING    — the JSON pins a real 40-hex commit + branch + worktree
 *                         flag, and the doc header renders the short commit so a
 *                         later reader knows exactly which snapshot each verdict
 *                         targets.
 *   3. CITATION TRUTH   — every finding's `anchor` resolves to EXACTLY ONE line in
 *                         `git show <pinned-commit>:<file>`, the recorded
 *                         `anchor_line` equals that derived line, and the doc cites
 *                         `file:<anchor_line>`. Line numbers are DERIVED from the
 *                         pinned commit, never hand-typed — so they cannot silently
 *                         go stale, and a vanished anchor turns this RED.
 *
 * Anchors are resolved against the pinned commit (not the live tree) so the test
 * stays green as unrelated code moves, yet stays exact for this audit snapshot.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")
const JSON_PATH = join(REPO, "docs/bugbash/jun-20-bugbash.findings.json")
const DOC_PATH = join(REPO, "docs/bugbash/jun-20-bugbash.md")

type Finding = {
  id: number
  severity: "high" | "med" | "low" | "none"
  file: string
  anchor: string | null
  anchor_line: number | null
  title: string
}
type Data = {
  audited_commit: string | null
  audited_commit_short: string | null
  branch: string | null
  worktree_dirty: boolean | null
  counts: { total_surfaced: number; actionable: number; none_retained: number }
  findings: Finding[]
}

const data = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Data
const doc = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : ""

const requirePresent = (value: string | null, label: string): string => {
  expect(value, `${label} must be present`).not.toBeNull()
  return value ?? ""
}

/** Read a file blob at the pinned commit. Returns null if the path is absent there. */
function blobAtPin(commit: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** 1-based line numbers where `anchor` occurs as a substring in `blob`. */
function anchorLines(blob: string, anchor: string): number[] {
  const lines = blob.split("\n")
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i]?.includes(anchor)) hits.push(i + 1)
  return hits
}

describe("bug-bash doc integrity (hellgate)", () => {
  test("scope is pinned to a real commit + branch + worktree flag", () => {
    expect(data.audited_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(data.audited_commit_short).toBe((data.audited_commit ?? "").slice(0, 8))
    expect(typeof data.branch).toBe("string")
    expect((data.branch ?? "").length).toBeGreaterThan(0)
    expect(typeof data.worktree_dirty).toBe("boolean")
    const auditedCommit = requirePresent(data.audited_commit, "audited_commit")
    // The pinned commit must actually exist in this repo.
    expect(blobAtPin(auditedCommit, "package.json")).not.toBeNull()
  })

  test("counts are internally consistent and not overclaimed", () => {
    const arr = data.findings
    const actionable = arr.filter((f) => f.severity !== "none").length
    const none = arr.filter((f) => f.severity === "none").length
    expect(data.counts.total_surfaced).toBe(arr.length)
    expect(data.counts.actionable).toBe(actionable)
    expect(data.counts.none_retained).toBe(none)
    // surfaced = actionable + none-retained (the honest split)
    expect(data.counts.actionable + data.counts.none_retained).toBe(data.counts.total_surfaced)
  })

  test("doc header renders the pinned snapshot + the honest count split", () => {
    expect(doc.length).toBeGreaterThan(0)
    expect(doc).toContain(requirePresent(data.audited_commit_short, "audited_commit_short"))
    expect(doc).toContain(requirePresent(data.branch, "branch"))
    // Must render actionable vs none-retained, NOT a single "33 confirmed".
    expect(doc).toContain(`${data.counts.actionable}`)
    expect(doc).toContain(`${data.counts.none_retained}`)
    expect(doc).not.toMatch(/\b33 confirmed\b/)
  })

  test("ids are dense 1..N and unique", () => {
    const ids = data.findings.map((f) => f.id).sort((a, b) => a - b)
    expect(ids).toEqual(Array.from({ length: data.findings.length }, (_, i) => i + 1))
  })

  test("not vacuous: doc renders one index row per finding", () => {
    // Kills the empty-array vacuity hole: the per-finding citation suite below
    // generates zero tests if findings is empty, so pin a real lower bound AND
    // prove the doc actually rendered every finding as an index row.
    expect(data.findings.length).toBeGreaterThanOrEqual(1)
    const indexRows = (doc.match(/^\| \[\d+\]\(#\d+\) \|/gm) ?? []).length
    expect(indexRows).toBe(data.findings.length)
    // every id has a detail anchor target too
    for (const f of data.findings) expect(doc).toContain(`<a id="${f.id}"></a>`)
  })

  describe("every citation resolves at the pinned commit (derived, not hand-typed)", () => {
    for (const f of data.findings) {
      test(`#${f.id} ${f.file} anchor resolves uniquely + doc cites the derived line`, () => {
        const anchor = requirePresent(f.anchor, `finding #${f.id} anchor`)
        const auditedCommit = requirePresent(data.audited_commit, "audited_commit")
        const blob = requirePresent(
          blobAtPin(auditedCommit, f.file),
          `#${f.id}: ${f.file} blob at pinned commit`,
        )
        const hits = anchorLines(blob, anchor)
        // anchor must be UNIQUE in the file → unambiguous line.
        expect(
          hits.length,
          `#${f.id}: anchor "${f.anchor}" hit ${hits.length} lines in ${f.file}`,
        ).toBe(1)
        const derived = hits[0] as number
        expect(f.anchor_line, `#${f.id}: recorded anchor_line drifted from derived`).toBe(derived)
        // the rendered doc must cite file:<derived line> for this finding, as a
        // BACKTICK-DELIMITED token so `verdict.ts:55` can't vacuously match a
        // stray `verdict.ts:551` substring elsewhere in the doc.
        expect(doc).toContain(`\`${f.file}:${derived}\``)
      })
    }
  })
})
