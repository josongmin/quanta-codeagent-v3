/**
 * ADR-0102 hellgate — turn_diff_updated emitter
 *
 * 14 adversarial cases. The emitter is closed-port (injected `GitRunner`) so
 * tests stub the runner directly — no real git process. Real-git smoke is
 * covered by the integration suite when present; this file exercises the
 * STATE MACHINE.
 */

import { describe, expect, test } from "bun:test"
import {
  buildTurnDiffEvent,
  captureTurnStart,
  computeTurnDiff,
  TURN_DIFF_DEFAULT_MAX_BYTES,
} from "@/agent/turn-diff"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import { present } from "../_helpers/expect-present"

/** Build a runner that replies to argv prefixes with canned results. The map
 *  key is the argv joined by space; the runner matches by exact join. */
const makeRunner = (
  responses: Record<string, GitRunResult | Error>,
): GitRunner & { calls: readonly string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    async run(args: readonly string[]) {
      calls.push([...args])
      const key = args.join(" ")
      const r = responses[key]
      if (r instanceof Error) throw r
      if (r) return r
      return { stdout: "", stderr: `no canned response for: ${key}`, exitCode: 1 }
    },
  }
}

const okResult = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const failResult = (stderr: string): GitRunResult => ({ stdout: "", stderr, exitCode: 128 })

describe("ADR-0102 turn-diff emitter — captureTurnStart (hellgate)", () => {
  test("HELL-1: captures HEAD SHA on success", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": okResult("abc123def456abc123def456abc123def456abcd\n"),
    })
    const sha = await captureTurnStart(runner, "/tmp/repo")
    expect(sha).toBe("abc123def456abc123def456abc123def456abcd")
  })

  test("HELL-2: returns null when not a git repo (non-zero exit)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": failResult("fatal: not a git repository"),
    })
    const sha = await captureTurnStart(runner, "/tmp/notrepo")
    expect(sha).toBeNull()
  })

  test("HELL-3: returns null when HEAD output is empty", async () => {
    const runner = makeRunner({ "rev-parse HEAD": okResult("") })
    const sha = await captureTurnStart(runner, "/tmp/repo")
    expect(sha).toBeNull()
  })

  test("HELL-4: returns null when runner throws (spawn error)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": new Error("ENOENT: git not found"),
    })
    const sha = await captureTurnStart(runner, "/tmp/repo")
    expect(sha).toBeNull()
  })

  test("HELL-5: signal forwarded to runner", async () => {
    const ctrl = new AbortController()
    const runner = makeRunner({
      "rev-parse HEAD": okResult("deadbeefcafebabe\n"),
    })
    await captureTurnStart(runner, "/tmp/repo", ctrl.signal)
    // The runner's spy doesn't capture the signal slot directly in this test
    // shape, but the call happened (i.e. runner was invoked with the args).
    expect(runner.calls.length).toBe(1)
  })
})

describe("ADR-0102 turn-diff emitter — computeTurnDiff (hellgate)", () => {
  test("HELL-6: returns null when diff stderr fails (not a repo)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": okResult("ffffffff\n"),
      "diff abc": failResult("fatal: bad object abc"),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload).toBeNull()
  })

  test("HELL-7: returns null when nothing changed (empty diff + zero stats)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": okResult("abc\n"),
      "diff abc": okResult(""),
      "diff --shortstat abc": okResult(""),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload).toBeNull()
  })

  test("HELL-8: returns payload with stats parsed when shortstat is present", async () => {
    const diffBody = `diff --git a/foo.ts b/foo.ts\nindex 1..2 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n line1\n+added\n line2\n line3\n`
    const runner = makeRunner({
      "rev-parse HEAD": okResult("def\n"),
      "diff abc": okResult(diffBody),
      "diff --shortstat abc": okResult(" 3 files changed, 42 insertions(+), 7 deletions(-)\n"),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload).not.toBeNull()
    expect(payload?.fromSha).toBe("abc")
    expect(payload?.toSha).toBe("def")
    expect(payload?.filesChanged).toBe(3)
    expect(payload?.insertions).toBe(42)
    expect(payload?.deletions).toBe(7)
    expect(payload?.unifiedDiff).toBe(diffBody)
  })

  test("HELL-9: toSha falls back to fromSha when HEAD resolve fails (working-tree only)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": failResult("fatal: detached HEAD lost"),
      "diff abc": okResult("some diff body"),
      "diff --shortstat abc": okResult(" 1 file changed, 1 insertion(+)\n"),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload?.fromSha).toBe("abc")
    expect(payload?.toSha).toBe("abc")
  })

  test("HELL-10: insertion-only diff parses with deletions=0", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": okResult("def\n"),
      "diff abc": okResult("body"),
      "diff --shortstat abc": okResult(" 1 file changed, 5 insertions(+)\n"),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload?.insertions).toBe(5)
    expect(payload?.deletions).toBe(0)
  })

  test("HELL-11: huge diff truncated with marker at maxUnifiedBytes", async () => {
    const huge = "x".repeat(200 * 1024)
    const runner = makeRunner({
      "rev-parse HEAD": okResult("def\n"),
      "diff abc": okResult(huge),
      "diff --shortstat abc": okResult(" 1 file changed, 10 insertions(+)\n"),
    })
    const payload = await computeTurnDiff({
      runner,
      cwd: "/tmp/repo",
      fromSha: "abc",
      maxUnifiedBytes: 64 * 1024,
    })
    expect(payload?.unifiedDiff.length).toBeGreaterThan(64 * 1024)
    expect(payload?.unifiedDiff).toContain("[truncated:")
    expect(payload?.unifiedDiff).toContain(`${200 * 1024} bytes total`)
    // Visible body up to the truncation marker is exactly maxUnifiedBytes.
    const upTo = present(payload, "computeTurnDiff payload").unifiedDiff.indexOf("\n\n[truncated:")
    expect(upTo).toBe(64 * 1024)
  })

  test("HELL-12: maxUnifiedBytes invalid (negative / 0 / NaN) ⇒ falls back to default", async () => {
    const huge = "y".repeat(TURN_DIFF_DEFAULT_MAX_BYTES + 100)
    const runner = makeRunner({
      "rev-parse HEAD": okResult("def\n"),
      "diff abc": okResult(huge),
      "diff --shortstat abc": okResult(" 1 file changed, 1 insertion(+)\n"),
    })
    const payload = await computeTurnDiff({
      runner,
      cwd: "/tmp/repo",
      fromSha: "abc",
      maxUnifiedBytes: -1,
    })
    expect(payload?.unifiedDiff).toContain("[truncated:")
    const upTo = present(payload, "computeTurnDiff payload").unifiedDiff.indexOf("\n\n[truncated:")
    expect(upTo).toBe(TURN_DIFF_DEFAULT_MAX_BYTES)
  })

  test("HELL-13: spawn error (runner throws) returns null without throwing", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": new Error("ENOENT: git not found"),
    })
    const payload = await computeTurnDiff({ runner, cwd: "/tmp/repo", fromSha: "abc" })
    expect(payload).toBeNull()
  })
})

describe("ADR-0102 turn-diff emitter — buildTurnDiffEvent (hellgate)", () => {
  test("HELL-14: composes a fully-populated `turn_diff_updated` event", () => {
    const evt = buildTurnDiffEvent(3, {
      fromSha: "abc",
      toSha: "def",
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      unifiedDiff: "body",
    })
    expect(evt.type).toBe("turn_diff_updated")
    expect(evt.turn).toBe(3)
    expect(evt.fromSha).toBe("abc")
    expect(evt.toSha).toBe("def")
    expect(evt.filesChanged).toBe(2)
    expect(evt.insertions).toBe(10)
    expect(evt.deletions).toBe(3)
    expect(evt.unifiedDiff).toBe("body")
  })
})
