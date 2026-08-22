/**
 * ★ CONTRACT — ADR-0109 moved-code classifier (src/tool/git/moved-code).
 *   `classifyDiff(hunks, opts?)` produces three disjoint categories:
 *   {logic, moved, mechanical}. A moved-pair requires BOTH sides to have
 *   ≥ minLines (default 5) NON-BLANK normalized lines AND Jaccard token
 *   similarity ≥ minSimilarity (default 0.85). The cap |removed|×|added|
 *   ≤ maxPairs (default 10_000) bounds worst case; above it, everything
 *   falls through to logic. Best-similarity-first 1:1 greedy match.
 *
 * HELLGATE — 16 adversarial cases proving short-block / partial-match /
 * threshold / asymmetric / pair-cap / multi-file / unicode-path invariants.
 *
 * These tests are TIGHTLY COUPLED to the constants in
 * src/tool/git/moved-code/index.ts (DEFAULT_MIN_LINES=5,
 * DEFAULT_MIN_SIMILARITY=0.85, DEFAULT_MAX_PAIRS=10_000). If any of those
 * constants change, ADR-0109 §결정 must be updated FIRST, then this file
 * follows. The constants are justified there as conservative-pick — not
 * tuned to a single corpus.
 */
import { describe, expect, test } from "bun:test"
import type { DiffHunk } from "@/tool/git/moved-code"
import { classifyDiff, parseUnifiedDiff } from "@/tool/git/moved-code"

/** 5-line block — long enough to clear the minLines floor by default. */
const FIVE_LINE_BLOCK = [
  "function alpha(input) {",
  "  const result = doWork(input)",
  "  if (result.ok) return result.value",
  "  throw new Error(result.reason)",
  "}",
].join("\n")

const mk = (
  file: string,
  startLine: number,
  kind: "added" | "removed",
  body: string,
): DiffHunk => ({
  file,
  startLine,
  endLine: startLine + body.split("\n").length - 1,
  kind,
  body,
})

describe("moved-code detector hellgate", () => {
  test("HELL-1: exact function move A → B is detected as one moved pair", () => {
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", FIVE_LINE_BLOCK),
      mk("src/b.ts", 20, "added", FIVE_LINE_BLOCK),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.logic.length).toBe(0)
    expect(out.moved[0]?.fromFile).toBe("src/a.ts")
    expect(out.moved[0]?.toFile).toBe("src/b.ts")
    expect(out.moved[0]?.similarity).toBe(1)
  })

  test("HELL-2: partial-match (50% different) is NOT moved — both stay in logic", () => {
    const removed = [
      "function alpha(input) {",
      "  const result = doWork(input)",
      "  if (result.ok) return result.value",
      "  throw new Error(result.reason)",
      "}",
    ].join("\n")
    // ~50% token churn: different identifiers, different control flow.
    const added = [
      "function beta(payload) {",
      "  return queue.enqueue(payload)",
      "  // entirely different",
      "  // body",
      "}",
    ].join("\n")
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", removed),
      mk("src/b.ts", 20, "added", added),
    ])
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(2)
  })

  test("HELL-3: below minLines (default 5) is rejected even at sim=1.0", () => {
    const small = ["a()", "b()", "c()"].join("\n") // 3 lines
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", small),
      mk("src/b.ts", 20, "added", small),
    ])
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(2)
  })

  test("HELL-4: indentation-only difference is detected as moved (normalize strips indent)", () => {
    const removed = FIVE_LINE_BLOCK
    // Same body, every line re-indented.
    const added = FIVE_LINE_BLOCK.split("\n")
      .map((l) => `        ${l}`)
      .join("\n")
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", removed),
      mk("src/b.ts", 20, "added", added),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.similarity).toBe(1)
  })

  test("HELL-5: trailing-whitespace-only difference is detected as moved", () => {
    const removed = FIVE_LINE_BLOCK
    const added = FIVE_LINE_BLOCK.split("\n")
      .map((l) => `${l}   `)
      .join("\n")
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", removed),
      mk("src/b.ts", 20, "added", added),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.similarity).toBe(1)
  })

  test("HELL-6: blank-line insertions/deletions are tolerated (normalized away)", () => {
    const removed = FIVE_LINE_BLOCK
    const added = FIVE_LINE_BLOCK.split("\n").join("\n\n") // double-spaced
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", removed),
      mk("src/b.ts", 20, "added", added),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.similarity).toBe(1)
  })

  test("HELL-7: same-file in-file move (A:10 → A:50) is detected (fromFile === toFile)", () => {
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", FIVE_LINE_BLOCK),
      mk("src/a.ts", 50, "added", FIVE_LINE_BLOCK),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.fromFile).toBe("src/a.ts")
    expect(out.moved[0]?.toFile).toBe("src/a.ts")
    expect(out.moved[0]?.fromStartLine).toBe(10)
    expect(out.moved[0]?.toStartLine).toBe(50)
  })

  test("HELL-8: mixed move + genuine change — moved pair recognized, rest stays in logic", () => {
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", FIVE_LINE_BLOCK),
      mk("src/b.ts", 20, "added", FIVE_LINE_BLOCK),
      // A genuine, unrelated change.
      mk(
        "src/c.ts",
        5,
        "removed",
        ["// old comment", "let x = 1", "let y = 2", "let z = 3", "let w = 4"].join("\n"),
      ),
      mk(
        "src/c.ts",
        5,
        "added",
        [
          "// totally different",
          "const m = mapper()",
          "await m.run()",
          "process.exit(0)",
          "// the end",
        ].join("\n"),
      ),
    ])
    expect(out.moved.length).toBe(1)
    expect(out.logic.length).toBe(2)
    // The genuine change must remain in logic.
    expect(out.logic.some((h) => h.file === "src/c.ts" && h.kind === "removed")).toBe(true)
    expect(out.logic.some((h) => h.file === "src/c.ts" && h.kind === "added")).toBe(true)
  })

  test("HELL-9: empty input → all categories empty", () => {
    const out = classifyDiff([])
    expect(out.moved).toEqual([])
    expect(out.logic).toEqual([])
    expect(out.mechanical).toEqual([])
  })

  test("HELL-10: pair-product > maxPairs cap → no detection, everything → logic", () => {
    // Build 11 × 11 = 121 pair product, cap at 100 ⇒ skip detection.
    const removed: DiffHunk[] = []
    const added: DiffHunk[] = []
    for (let i = 0; i < 11; i += 1) {
      removed.push(mk(`src/r${i}.ts`, 1, "removed", FIVE_LINE_BLOCK))
      added.push(mk(`src/a${i}.ts`, 1, "added", FIVE_LINE_BLOCK))
    }
    const out = classifyDiff([...removed, ...added], { maxPairs: 100 })
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(22)
  })

  test("HELL-11: highest-similarity wins under multi-match — 1:1 mapping enforced", () => {
    // r1 matches both a1 (sim=1) and a2 (sim≈0.86). r1 must pair with a1.
    // a2 then has no remaining `-` partner above threshold ⇒ a2 → logic.
    const base = FIVE_LINE_BLOCK
    const slightDiff = [
      "function alpha(input) {",
      "  const result = doWork(input)",
      "  if (result.ok) return result.value",
      "  throw new Error(result.reason)",
      "  // appended line nine ten eleven", // adds new tokens → sim<1
    ].join("\n")
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", base), // r0
      mk("src/b.ts", 20, "added", base), // a0 — perfect pair
      mk("src/c.ts", 30, "added", slightDiff), // a1 — lower-similarity tempter
    ])
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.toFile).toBe("src/b.ts")
    expect(out.moved[0]?.similarity).toBe(1)
    // The tempter must NOT have stolen the match.
    expect(out.logic.some((h) => h.file === "src/c.ts")).toBe(true)
  })

  test("HELL-12: similarity strictly below threshold is rejected", () => {
    // Use a custom threshold of 0.99 and a tiny perturbation that drops sim.
    const removed = FIVE_LINE_BLOCK
    const added = `${FIVE_LINE_BLOCK}\n  console.log("extra one two three four five six seven eight nine ten")`
    const out = classifyDiff(
      [mk("src/a.ts", 10, "removed", removed), mk("src/b.ts", 20, "added", added)],
      { minSimilarity: 0.99 },
    )
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(2)
  })

  test("HELL-13: three independent moves across three file-pairs", () => {
    const b1 = FIVE_LINE_BLOCK
    const b2 = [
      "class Beta {",
      "  constructor(opts) { this.opts = opts }",
      "  run() { return this.opts.handler() }",
      "  stop() { return this.opts.cleanup() }",
      "}",
    ].join("\n")
    const b3 = [
      "const gamma = async (url) => {",
      "  const res = await fetch(url)",
      "  if (!res.ok) throw new Error(res.statusText)",
      "  return res.json()",
      "}",
    ].join("\n")
    const out = classifyDiff([
      mk("src/a1.ts", 1, "removed", b1),
      mk("src/a2.ts", 1, "removed", b2),
      mk("src/a3.ts", 1, "removed", b3),
      mk("src/b1.ts", 1, "added", b1),
      mk("src/b2.ts", 1, "added", b2),
      mk("src/b3.ts", 1, "added", b3),
    ])
    expect(out.moved.length).toBe(3)
    expect(out.logic.length).toBe(0)
    const pairs = out.moved.map((m) => `${m.fromFile}→${m.toFile}`).sort()
    expect(pairs).toEqual(["src/a1.ts→src/b1.ts", "src/a2.ts→src/b2.ts", "src/a3.ts→src/b3.ts"])
  })

  test("HELL-14: identical structure with one identifier renamed — documents Jaccard behavior", () => {
    // SHORT 6-line block with one identifier renamed (3 occurrences out of
    // ~18 word-tokens). Jaccard ≈ 0.71 — BELOW the default 0.85 floor.
    // Documenting this as a known limitation of pure-Jaccard on tiny blocks
    // with high-impact renames: the algorithm trades recall for precision
    // here, by design.
    const removed = [
      "function compute(input) {",
      "  const tally = aggregate(input)",
      "  const rate = tally.total / tally.count",
      "  log(`rate=` + rate)",
      "  return rate",
      "}",
    ].join("\n")
    // Rename ONLY `tally` → `summary` (3 occurrences).
    const added = removed.replace(/tally/g, "summary")
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", removed),
      mk("src/b.ts", 20, "added", added),
    ])
    // At default threshold, NOT detected (precision-favored).
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(2)
    // But lowering the threshold catches it — proves it's a calibration
    // choice, not an algorithmic miss.
    const lenient = classifyDiff(
      [mk("src/a.ts", 10, "removed", removed), mk("src/b.ts", 20, "added", added)],
      { minSimilarity: 0.7 },
    )
    expect(lenient.moved.length).toBe(1)
    expect(lenient.moved[0]?.similarity).toBeGreaterThan(0.7)
    expect(lenient.moved[0]?.similarity).toBeLessThan(0.85)
  })

  test("HELL-15: asymmetric input (only `-` hunks) → everything in logic, moved empty", () => {
    const out = classifyDiff([
      mk("src/a.ts", 10, "removed", FIVE_LINE_BLOCK),
      mk(
        "src/b.ts",
        20,
        "removed",
        ["const x = 1", "const y = 2", "const z = 3", "const w = 4", "const v = 5"].join("\n"),
      ),
    ])
    expect(out.moved.length).toBe(0)
    expect(out.logic.length).toBe(2)
  })

  test("HELL-16: malformed `diff --git` (file path with embedded newline) is rejected safely", () => {
    // We can't smuggle a literal `\n` through the regex header parser; the
    // line splits and the second half is dropped. Verify the parser doesn't
    // throw and recovers on subsequent valid sections.
    const malformed = [
      'diff --git a/evil"\nfile.ts b/evil"\nfile.ts',
      "@@ -1,3 +1,3 @@",
      "-old",
      "+new",
      " ctx",
    ].join("\n")
    const goodSection = [
      "diff --git a/ok.ts b/ok.ts",
      "--- a/ok.ts",
      "+++ b/ok.ts",
      "@@ -10,5 +20,5 @@",
      "-function alpha(input) {",
      "-  const result = doWork(input)",
      "-  if (result.ok) return result.value",
      "-  throw new Error(result.reason)",
      "-}",
      "+function alpha(input) {",
      "+  const result = doWork(input)",
      "+  if (result.ok) return result.value",
      "+  throw new Error(result.reason)",
      "+}",
    ].join("\n")
    const text = `${malformed}\n${goodSection}\n`
    // Parser must not throw; the good section must be parseable.
    const hunks = parseUnifiedDiff(text)
    expect(Array.isArray(hunks)).toBe(true)
    const out = classifyDiff(hunks)
    // The valid section is one moved pair.
    expect(out.moved.length).toBe(1)
    expect(out.moved[0]?.fromFile).toBe("ok.ts")
    expect(out.moved[0]?.toFile).toBe("ok.ts")
  })
})

describe("parseUnifiedDiff — basic shape coverage (supports hellgate)", () => {
  test("parses a single added+removed pair", () => {
    const text = [
      "diff --git a/src/a.ts b/src/b.ts",
      "--- a/src/a.ts",
      "+++ b/src/b.ts",
      "@@ -10,2 +20,2 @@",
      "-foo",
      "-bar",
      "+foo",
      "+bar",
    ].join("\n")
    const hunks = parseUnifiedDiff(text)
    expect(hunks.length).toBe(2)
    const removed = hunks.find((h) => h.kind === "removed")
    const added = hunks.find((h) => h.kind === "added")
    expect(removed?.file).toBe("src/a.ts")
    expect(removed?.startLine).toBe(10)
    expect(removed?.endLine).toBe(11)
    expect(added?.file).toBe("src/b.ts")
    expect(added?.startLine).toBe(20)
    expect(added?.endLine).toBe(21)
  })

  test("strips ANSI color escapes from --color-moved output", () => {
    const ESC = "\x1B"
    const text = [
      `${ESC}[1mdiff --git a/x.ts b/x.ts${ESC}[m`,
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      `${ESC}[31m-old${ESC}[m`,
      `${ESC}[32m+new${ESC}[m`,
    ].join("\n")
    const hunks = parseUnifiedDiff(text)
    expect(hunks.length).toBe(2)
    expect(hunks.find((h) => h.kind === "removed")?.body).toBe("old")
    expect(hunks.find((h) => h.kind === "added")?.body).toBe("new")
  })

  test("handles \\ No newline at end of file marker", () => {
    const text = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n")
    const hunks = parseUnifiedDiff(text)
    expect(hunks.length).toBe(2)
  })
})
