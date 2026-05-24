/**
 * ★ CONTRACT — `git_moved_code` (ADR-0109 wiring): expose the pure moved-code
 * classifier as a typed first-class git Tool. The classifier itself is sealed
 * by `moved-code-detector-hellgate.test.ts` (19 cases); THIS battery seals the
 * SHELL the tool wraps it in — argv discipline, exit-code semantics, output
 * formatting, leading-dash rejection on `base`, signal forwarding, the
 * exactOptionalPropertyTypes condition-spread, and zod validation of the new
 * threshold knobs.
 *
 * Hellgate cases (mirror the ones in the build prompt):
 *
 *   1. Happy: classifies a known move pair (one function migrates between two
 *      files) → moved=1, logic=0.
 *   2. Happy: pure logic change (no movable pair) → moved=0, logic≥1.
 *   3. No diff (empty stdout) → ok:true, "(no diff to classify)".
 *   4. Empty unified diff (headers, no hunks) → ok:true, "(no hunks)".
 *   5. Leading-dash `base` rejected; runner NEVER called.
 *   6. git exit code > 1 → ok:false carrying stderr reason.
 *   7. Runner spawn error → ok:false.
 *   8. paths-injection: user-supplied `--`-string lands AFTER our `--`, so it
 *      becomes a PATH, not a git option.
 *   9. Custom `minSimilarity` rejects a 0.9-similar pair → moved=0, logic≥1.
 *  10. Very large diff is truncated to 50_000 chars with marker.
 *  11. Signal forwarding: `runner.run` receives the exact ctx.signal instance.
 *  12. Input validation: `minSimilarity: 2` → ok:false with zod parse failure.
 *  13. exactOptionalPropertyTypes: when input has NONE of the threshold knobs,
 *      defaults take effect — a 4-line pair is REJECTED (default minLines=5),
 *      proving the absent inputs didn't slip through as explicit `undefined`s.
 *  14. Tool-level pair-product guard: default 2000 skips a 45×45 diff, but a
 *      bounded override (`maxPairs: 10_000`) still allows detection.
 *  15. Input validation: `maxPairs` above the 10_000 ceiling is rejected, so
 *      the tool caller cannot disable the O(N×M) guard with an arbitrary cap.
 */
import { describe, expect, test } from "bun:test"
import { gitMovedCodeTool } from "@/tool/git/moved-code-tool"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ---------------------------------------------------------------- harness */

const ctxFor = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  signal: signal ?? new AbortController().signal,
})

interface RecordedCall {
  args: string[]
  cwd: string
  signal: AbortSignal | undefined
}

class FakeRunner implements GitRunner {
  readonly calls: RecordedCall[] = []
  constructor(
    private readonly result: GitRunResult | ((args: readonly string[]) => GitRunResult),
  ) {}
  async run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd, signal })
    return typeof this.result === "function" ? this.result(args) : this.result
  }
}

class ThrowingRunner implements GitRunner {
  async run(): Promise<GitRunResult> {
    throw new Error("spawn ENOENT")
  }
}

/** A runner that fails the test if it is ever invoked (used to assert
 *  pre-shell rejection paths NEVER reach git). */
class ForbiddenRunner implements GitRunner {
  async run(): Promise<GitRunResult> {
    throw new Error("forbidden: runner.run must NOT have been called")
  }
}

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  ctx: ToolContext = ctxFor(),
): Promise<{ result: ToolResult; progress: string[] }> => {
  const progress: string[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "progress") progress.push(ev.message)
    else result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, progress }
}

const okOut = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const okDiff = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 1 })
const errOut = (stderr: string, exitCode = 128): GitRunResult => ({
  stdout: "",
  stderr,
  exitCode,
})

/* ----------------------------------------------------- diff fixture builders */

/**
 * A 7-line function moves from `old.ts` to `new.ts` verbatim. Both sides are
 * well above `minLines=5` and identical so Jaccard = 1.0 ≫ 0.85.
 */
const movedDiff = (): string =>
  [
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -10,7 +10,0 @@",
    "-export const tally = (items: number[]): number => {",
    "-  let total = 0",
    "-  for (const x of items) {",
    "-    total += x",
    "-  }",
    "-  return total",
    "-}",
    "diff --git a/new.ts b/new.ts",
    "--- a/new.ts",
    "+++ b/new.ts",
    "@@ -1,0 +1,7 @@",
    "+export const tally = (items: number[]): number => {",
    "+  let total = 0",
    "+  for (const x of items) {",
    "+    total += x",
    "+  }",
    "+  return total",
    "+}",
    "",
  ].join("\n")

/**
 * Two file diffs that share NO tokens — strictly logic on each side.
 */
const pureLogicDiff = (): string =>
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,5 +10,5 @@",
    "-export const alpha = (zzz: number): number => {",
    "-  const bravo = zzz + 100",
    "-  const charlie = bravo * 17",
    "-  return charlie",
    "-}",
    "+export const omega = (qqq: string): string => {",
    "+  const sigma = qqq.toUpperCase()",
    "+  const tau = sigma.repeat(7)",
    "+  return tau",
    "+}",
    "",
  ].join("\n")

/**
 * A 4-line moved block — sized to be UNDER the default `minLines=5` so the
 * classifier rejects it as a pair. Used by the exact-optional default test.
 */
const fourLineMovedDiff = (): string =>
  [
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -1,4 +1,0 @@",
    "-export const id = (x: number): number => {",
    "-  const y = x",
    "-  return y",
    "-}",
    "diff --git a/new.ts b/new.ts",
    "--- a/new.ts",
    "+++ b/new.ts",
    "@@ -1,0 +1,4 @@",
    "+export const id = (x: number): number => {",
    "+  const y = x",
    "+  return y",
    "+}",
    "",
  ].join("\n")

/**
 * Generate many small file diffs to force a large formatted output past the
 * 50_000-char cap. We use unique tokens per pair so NO pair matches as moved
 * → every hunk lands in the logic list, exploding the formatted size.
 */
const hugeLogicDiff = (n: number): string => {
  const parts: string[] = []
  for (let i = 0; i < n; i += 1) {
    parts.push(
      `diff --git a/file_${i}_with_a_fairly_long_padding_suffix_to_eat_chars.ts b/file_${i}_with_a_fairly_long_padding_suffix_to_eat_chars.ts`,
    )
    parts.push(`--- a/file_${i}_with_a_fairly_long_padding_suffix_to_eat_chars.ts`)
    parts.push(`+++ b/file_${i}_with_a_fairly_long_padding_suffix_to_eat_chars.ts`)
    parts.push("@@ -1 +1 @@")
    parts.push(`-old_unique_token_${i}_no_match_anywhere_xxxxxxxxxxxxxxxx`)
    parts.push(`+new_unique_token_${i}_no_match_anywhere_yyyyyyyyyyyyyyyy`)
  }
  parts.push("")
  return parts.join("\n")
}

/**
 * 45 removed hunks + 45 added hunks = pair-product 2025. This is just above
 * the tool default (2000) but below the bounded override ceiling (10_000),
 * which lets the test prove both branches without huge fixture cost.
 */
const overDefaultButUnderCeilingMovedDiff = (): string => {
  const body = [
    "export const tally = (items: number[]): number => {",
    "  let total = 0",
    "  for (const x of items) {",
    "    total += x",
    "  }",
    "  return total",
    "}",
  ].join("\n")
  const parts: string[] = []
  for (let i = 0; i < 45; i += 1) {
    parts.push(`diff --git a/old_${i}.ts b/old_${i}.ts`)
    parts.push(`--- a/old_${i}.ts`)
    parts.push(`+++ b/old_${i}.ts`)
    parts.push("@@ -1,7 +1,0 @@")
    for (const line of body.split("\n")) parts.push(`-${line}`)
    parts.push(`diff --git a/new_${i}.ts b/new_${i}.ts`)
    parts.push(`--- a/new_${i}.ts`)
    parts.push(`+++ b/new_${i}.ts`)
    parts.push("@@ -1,0 +1,7 @@")
    for (const line of body.split("\n")) parts.push(`+${line}`)
  }
  parts.push("")
  return parts.join("\n")
}

/* -------------------------------------------------------------------- tests */

describe("gitMovedCodeTool", () => {
  test("metadata: read-only, concurrency-safe, name matches", () => {
    const t = gitMovedCodeTool(new FakeRunner(okOut("")))
    expect(t.name).toBe("git_moved_code")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
    expect(t.description).toMatch(/moved/i)
  })

  // 1. classifies a known move
  test("classifies a known move pair (moved=1, logic=0)", async () => {
    const runner = new FakeRunner(okDiff(movedDiff()))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/moved:\s+1 pairs/)
    expect(result.output).toMatch(/logic:\s+0 hunks/)
    expect(result.output).toContain("old.ts")
    expect(result.output).toContain("new.ts")
  })

  // 2. pure logic — no movable pair
  test("pure logic change → moved=0, logic≥1", async () => {
    const runner = new FakeRunner(okDiff(pureLogicDiff()))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/moved:\s+0 pairs/)
    expect(result.output).toMatch(/logic:\s+[1-9]\d* hunks/)
  })

  // 3. no diff
  test("empty stdout → ok:true with no-diff sentinel", async () => {
    const runner = new FakeRunner(okOut(""))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output).toBe("(no diff to classify)")
  })

  // 4. headers but no hunks
  test("diff with headers but no hunks → ok:true with no-hunks sentinel", async () => {
    // Headers only — no `@@` lines so `parseUnifiedDiff` returns [].
    const headers =
      "diff --git a/foo.ts b/foo.ts\nsimilarity index 100%\nrename from foo.ts\nrename to bar.ts\n"
    const runner = new FakeRunner(okDiff(headers))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output).toBe("(no hunks)")
  })

  // 5. leading-dash base rejection — runner NEVER called
  test("leading-dash base → ok:false, runner NEVER invoked", async () => {
    for (const base of ["-rm-rf", "--output=/tmp/pwn", "-G."]) {
      const runner = new ForbiddenRunner()
      const { result } = await collect(gitMovedCodeTool(runner), { base })
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/must not begin with '-'/)
    }
  })

  // 6. git exit code > 1
  test("git exit code 128 → ok:false with stderr reason", async () => {
    const runner = new FakeRunner(errOut("fatal: bad object xyz", 128))
    const { result } = await collect(gitMovedCodeTool(runner), { base: "xyz" })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("bad object")
  })

  // 7. spawn error
  test("runner spawn error → ok:false (spawn-error path)", async () => {
    const { result } = await collect(gitMovedCodeTool(new ThrowingRunner()), {})
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/spawn|ENOENT/i)
  })

  // 8. paths injection — user's `--` MUST land after our `--`
  test("paths injection: our `--` separates EVERY user path (incl. dashes)", async () => {
    const runner = new FakeRunner(okOut(""))
    await collect(gitMovedCodeTool(runner), {
      paths: ["--", "../../etc/passwd"],
    })
    const argv = runner.calls[0]?.args
    expect(argv).toBeDefined()
    // The shape must be: ["diff", "--", "--", "../../etc/passwd"]. The FIRST
    // `--` is ours (path-separator); the SECOND `--` is now interpreted by git
    // as a literal path, not an option. The user's leading `--` cannot turn
    // back into a git option because it sits AFTER our separator.
    expect(argv).toEqual(["diff", "--", "--", "../../etc/passwd"])
    // Defense-in-depth: the FIRST `--` must come BEFORE any user-supplied path.
    if (argv === undefined) throw new Error("unreachable")
    const firstSep = argv.indexOf("--")
    const firstUserPath = argv.findIndex((a) => a === "../../etc/passwd")
    expect(firstSep).toBeGreaterThanOrEqual(0)
    expect(firstUserPath).toBeGreaterThan(firstSep)
  })

  // 9. custom minSimilarity
  test("custom minSimilarity=0.99 rejects a slightly-different pair → moved=0", async () => {
    // Same shape as movedDiff() but the + side renames one token. With the
    // default threshold (0.85) we'd still match; at 0.99 the 1-token shift
    // pushes Jaccard < threshold so the pair lands in logic.
    const renamedDiff = [
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ b/old.ts",
      "@@ -10,7 +10,0 @@",
      "-export const tally = (items: number[]): number => {",
      "-  let total = 0",
      "-  for (const x of items) {",
      "-    total += x",
      "-  }",
      "-  return total",
      "-}",
      "diff --git a/new.ts b/new.ts",
      "--- a/new.ts",
      "+++ b/new.ts",
      "@@ -1,0 +1,7 @@",
      "+export const tally = (items: number[]): number => {",
      "+  let totalRenamed = 0",
      "+  for (const x of items) {",
      "+    totalRenamed += x",
      "+  }",
      "+  return totalRenamed",
      "+}",
      "",
    ].join("\n")
    const runner = new FakeRunner(okDiff(renamedDiff))
    const { result } = await collect(gitMovedCodeTool(runner), { minSimilarity: 0.99 })
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/moved:\s+0 pairs/)
    expect(result.output).toMatch(/logic:\s+[1-9]\d* hunks/)
  })

  // 10. output truncation
  test("very large output is truncated to 50_000 chars with marker", async () => {
    const runner = new FakeRunner(okDiff(hugeLogicDiff(2000)))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(50_000 + 200)
    expect(result.output).toMatch(/truncated/)
  })

  // 11. signal forwarding
  test("ctx.signal is forwarded by identity to runner.run", async () => {
    const runner = new FakeRunner(okOut(""))
    const ac = new AbortController()
    await collect(gitMovedCodeTool(runner), {}, ctxFor(ac.signal))
    expect(runner.calls[0]?.signal).toBe(ac.signal)
  })

  // 12. input validation
  test("minSimilarity > 1 fails zod parse → ok:false (no runner call)", async () => {
    const runner = new ForbiddenRunner()
    const { result } = await collect(gitMovedCodeTool(runner), { minSimilarity: 2 })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid input/i)
  })

  // 13. exactOptionalPropertyTypes — defaults take effect when knobs are absent
  test("default minLines=5 rejects a 4-line move pair (no implicit undefined)", async () => {
    const runner = new FakeRunner(okDiff(fourLineMovedDiff()))
    const { result } = await collect(gitMovedCodeTool(runner), {})
    expect(result.ok).toBe(true)
    // 4-line block is below default minLines=5 → no move recognized.
    expect(result.output).toMatch(/moved:\s+0 pairs/)
  })

  // 13b. ditto — explicit override lets the same 4-line move through.
  test("explicit minLines=3 lets the same 4-line move through (override works)", async () => {
    const runner = new FakeRunner(okDiff(fourLineMovedDiff()))
    const { result } = await collect(gitMovedCodeTool(runner), { minLines: 3 })
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/moved:\s+1 pairs/)
  })

  test("default maxPairs=2000 skips a 45×45 candidate set, bounded maxPairs=10_000 restores detection", async () => {
    const diff = overDefaultButUnderCeilingMovedDiff()

    const defaultRunner = new FakeRunner(okDiff(diff))
    const defaultResult = await collect(gitMovedCodeTool(defaultRunner), {})
    expect(defaultResult.result.ok).toBe(true)
    expect(defaultResult.result.output).toMatch(/moved:\s+0 pairs/)
    expect(defaultResult.result.output).toMatch(/logic:\s+90 hunks/)

    const widenedRunner = new FakeRunner(okDiff(diff))
    const widenedResult = await collect(gitMovedCodeTool(widenedRunner), { maxPairs: 10_000 })
    expect(widenedResult.result.ok).toBe(true)
    expect(widenedResult.result.output).toMatch(/moved:\s+45 pairs/)
    expect(widenedResult.result.output).toMatch(/logic:\s+0 hunks/)
  })

  test("maxPairs above the 10_000 ceiling fails zod parse → ok:false (no runner call)", async () => {
    const runner = new ForbiddenRunner()
    const { result } = await collect(gitMovedCodeTool(runner), { maxPairs: 10_001 })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid input/i)
  })
})
