/**
 * ADR-0110 hellgate — git observability wiring helpers
 *
 * 16 adversarial cases covering:
 *   - wireSessionGitFingerprint (Part A) — SessionMeta fingerprint attach,
 *     immutability, best-effort failure modes.
 *   - wireTurnDiffEmit (Part B) — turn-scoped state machine: start/end
 *     idempotence, multi-turn isolation, spawn-error collapse, event
 *     discriminator.
 *   - wireGitObservability (Part C) — composite helper sanity.
 *
 * All cases use a fake GitRunner (closed-port DI) — no real git process. The
 * underlying primitives (captureGitFingerprint, captureTurnStart,
 * computeTurnDiff, buildTurnDiffEvent) already have their own hellgates; this
 * file exercises the WIRING contract only.
 */

import { describe, expect, test } from "bun:test"
import {
  wireGitObservability,
  wireSessionGitFingerprint,
  wireTurnDiffEmit,
} from "@/agent/git-observability"
import type { SessionMeta } from "@/session/types"
import type { GitRunner, GitRunResult } from "@/tool/git/types"

const makeRunner = (
  responses: Record<string, GitRunResult | Error>,
): GitRunner & { calls: readonly string[][]; signals: readonly (AbortSignal | undefined)[] } => {
  const calls: string[][] = []
  const signals: (AbortSignal | undefined)[] = []
  return {
    calls,
    signals,
    async run(args: readonly string[], _cwd: string, signal?: AbortSignal) {
      calls.push([...args])
      signals.push(signal)
      const key = args.join(" ")
      const r = responses[key]
      if (r instanceof Error) throw r
      if (r) return r
      return { stdout: "", stderr: `no canned: ${key}`, exitCode: 128 }
    },
  }
}

const ok = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const fail = (stderr: string): GitRunResult => ({ stdout: "", stderr, exitCode: 128 })

const baseMeta = (): SessionMeta => ({
  id: "sess-1",
  title: "untitled",
  cwd: "/tmp/repo",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

// -----------------------------------------------------------------------------
// wireSessionGitFingerprint
// -----------------------------------------------------------------------------

describe("ADR-0110 wireSessionGitFingerprint (hellgate)", () => {
  test("HELL-1: git repo cwd ⇒ meta.gitSha/gitBranch/gitOriginUrl filled", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc123\n"),
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "config --get remote.origin.url": ok("git@github.com:org/repo.git\n"),
    })
    const out = await wireSessionGitFingerprint(baseMeta(), runner)
    expect(out.gitSha).toBe("abc123")
    expect(out.gitBranch).toBe("main")
    expect(out.gitOriginUrl).toBe("git@github.com:org/repo.git")
  })

  test("HELL-2: non-git cwd ⇒ all three fields absent (meta unchanged)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": fail("fatal: not a git repository"),
      "rev-parse --abbrev-ref HEAD": fail("fatal: not a git repository"),
      "config --get remote.origin.url": fail("fatal: not a git repository"),
    })
    const meta = baseMeta()
    const out = await wireSessionGitFingerprint(meta, runner)
    expect(out.gitSha).toBeUndefined()
    expect(out.gitBranch).toBeUndefined()
    expect(out.gitOriginUrl).toBeUndefined()
    // Identity-equality NOT required — but base fields must be carried.
    expect(out.id).toBe(meta.id)
    expect(out.cwd).toBe(meta.cwd)
    expect(out.createdAt).toBe(meta.createdAt)
  })

  test("HELL-3: original meta untouched (returns new object)", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc\n"),
      "rev-parse --abbrev-ref HEAD": ok("dev\n"),
      "config --get remote.origin.url": fail("no remote"),
    })
    const meta = baseMeta()
    const snapshot = { ...meta }
    const out = await wireSessionGitFingerprint(meta, runner)
    // The original object reference must not have new fields attached.
    expect(meta).toEqual(snapshot)
    expect(meta.gitSha).toBeUndefined()
    // The returned object has them.
    expect(out).not.toBe(meta)
    expect(out.gitSha).toBe("abc")
    expect(out.gitBranch).toBe("dev")
  })

  test("HELL-4: spawn-error on every query ⇒ returns meta with fingerprint absent, no throw", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": new Error("ENOENT: git not found"),
      "rev-parse --abbrev-ref HEAD": new Error("ENOENT: git not found"),
      "config --get remote.origin.url": new Error("ENOENT: git not found"),
    })
    const meta = baseMeta()
    const out = await wireSessionGitFingerprint(meta, runner)
    expect(out.gitSha).toBeUndefined()
    expect(out.gitBranch).toBeUndefined()
    expect(out.gitOriginUrl).toBeUndefined()
    expect(out.id).toBe(meta.id)
  })

  test("HELL-5: signal forwarded to runner (abort-aware best-effort)", async () => {
    const ctrl = new AbortController()
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc\n"),
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "config --get remote.origin.url": ok("https://example/x.git\n"),
    })
    await wireSessionGitFingerprint(baseMeta(), runner, ctrl.signal)
    // Every captured call must have seen the signal.
    expect(runner.signals.length).toBeGreaterThan(0)
    for (const s of runner.signals) expect(s).toBe(ctrl.signal)
  })

  test("HELL-6: detached HEAD ⇒ gitSha present, gitBranch absent", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("deadbeef\n"),
      "rev-parse --abbrev-ref HEAD": ok("HEAD\n"), // detached literal
      "config --get remote.origin.url": ok("https://example/x.git\n"),
    })
    const out = await wireSessionGitFingerprint(baseMeta(), runner)
    expect(out.gitSha).toBe("deadbeef")
    expect(out.gitBranch).toBeUndefined()
    expect(out.gitOriginUrl).toBe("https://example/x.git")
  })
})

// -----------------------------------------------------------------------------
// wireTurnDiffEmit
// -----------------------------------------------------------------------------

describe("ADR-0110 wireTurnDiffEmit (hellgate)", () => {
  test("HELL-7: endTurn without prior startTurn ⇒ null (no anchor)", async () => {
    const runner = makeRunner({})
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    const ev = await sess.endTurn(0)
    expect(ev).toBeNull()
  })

  test("HELL-8: startTurn ⇒ endTurn with no changes ⇒ null", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc123\n"),
      "diff abc123": ok(""),
      "diff --shortstat abc123": ok(""),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    const ev = await sess.endTurn(0)
    expect(ev).toBeNull()
  })

  test("HELL-9: startTurn → changes → endTurn ⇒ turn_diff_updated event", async () => {
    const diffBody = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc123\n"),
      "diff abc123": ok(diffBody),
      "diff --shortstat abc123": ok(" 1 file changed, 1 insertion(+), 1 deletion(-)\n"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(7)
    const ev = await sess.endTurn(7)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe("turn_diff_updated")
    expect(ev?.turn).toBe(7)
    expect(ev?.fromSha).toBe("abc123")
    expect(ev?.toSha).toBe("abc123")
    expect(ev?.filesChanged).toBe(1)
    expect(ev?.insertions).toBe(1)
    expect(ev?.deletions).toBe(1)
    expect(ev?.unifiedDiff).toBe(diffBody)
  })

  test("HELL-10: startTurn twice for same turnIndex ⇒ idempotent (first SHA kept)", async () => {
    let revParseCalls = 0
    const headReplies = ["first00\n", "second0\n"]
    const cannedRest: Record<string, GitRunResult> = {
      "diff first00": ok("body\n"),
      "diff --shortstat first00": ok(" 1 file changed, 1 insertion(+)\n"),
    }
    const runner: GitRunner = {
      async run(args) {
        const key = args.join(" ")
        if (key === "rev-parse HEAD") return ok(headReplies[revParseCalls++] ?? "")
        return cannedRest[key] ?? fail(`no canned: ${key}`)
      },
    }
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(3)
    await sess.startTurn(3) // second call must be a no-op
    expect(revParseCalls).toBe(1) // only the first start probed rev-parse
    const ev = await sess.endTurn(3)
    expect(ev?.fromSha).toBe("first00")
  })

  test("HELL-11: different turnIndices ⇒ independent state per turn", async () => {
    // Two startTurn calls anchor distinct SHAs; subsequent rev-parse calls
    // (one per startTurn) get sequential canned replies.
    const headReplies = ["sha0aaa\n", "sha1bbb\n"]
    let headIdx = 0
    const cannedRest: Record<string, GitRunResult> = {
      "diff sha0aaa": ok("body-0\n"),
      "diff --shortstat sha0aaa": ok(" 1 file changed, 1 insertion(+)\n"),
      "diff sha1bbb": ok("body-1\n"),
      "diff --shortstat sha1bbb": ok(" 2 files changed, 5 insertions(+)\n"),
    }
    const runner: GitRunner = {
      async run(args) {
        const key = args.join(" ")
        if (key === "rev-parse HEAD") return ok(headReplies[headIdx++] ?? "")
        return cannedRest[key] ?? fail(`no canned: ${key}`)
      },
    }
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    await sess.startTurn(1)
    const ev0 = await sess.endTurn(0)
    const ev1 = await sess.endTurn(1)
    expect(ev0?.fromSha).toBe("sha0aaa")
    expect(ev0?.unifiedDiff).toBe("body-0\n")
    expect(ev0?.filesChanged).toBe(1)
    expect(ev1?.fromSha).toBe("sha1bbb")
    expect(ev1?.unifiedDiff).toBe("body-1\n")
    expect(ev1?.filesChanged).toBe(2)
  })

  test("HELL-11A: endTurn consumes anchor after successful emit", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc123\n"),
      "diff abc123": ok("body\n"),
      "diff --shortstat abc123": ok(" 1 file changed, 1 insertion(+)\n"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    const first = await sess.endTurn(0)
    const callsAfterFirst = runner.calls.length
    const second = await sess.endTurn(0)
    expect(first?.type).toBe("turn_diff_updated")
    expect(second).toBeNull()
    expect(runner.calls.length).toBe(callsAfterFirst)
  })

  test("HELL-11B: endTurn consumes anchor even when diff payload is null", async () => {
    let headIdx = 0
    const runner = makeRunner({
      "diff sha1": ok(""),
      "diff --shortstat sha1": ok(""),
      "diff sha2": ok(""),
      "diff --shortstat sha2": ok(""),
    })
    const baseRun = runner.run.bind(runner)
    runner.run = async (args, cwd, signal) => {
      if (args.join(" ") === "rev-parse HEAD") {
        headIdx += 1
        return ok(`sha${headIdx}\n`)
      }
      return baseRun(args, cwd, signal)
    }
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    expect(await sess.endTurn(0)).toBeNull()
    expect(headIdx).toBe(2)
    await sess.startTurn(0)
    expect(headIdx).toBe(3)
    expect(await sess.endTurn(0)).toBeNull()
  })

  test("HELL-12: spawn-error on rev-parse ⇒ no anchor; endTurn returns null", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": new Error("ENOENT: git not found"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    const ev = await sess.endTurn(0)
    expect(ev).toBeNull()
  })

  test("HELL-13: maxUnifiedBytes forwarded to computeTurnDiff (truncates body)", async () => {
    const huge = "x".repeat(2000)
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc\n"),
      "diff abc": ok(huge),
      "diff --shortstat abc": ok(" 1 file changed, 1 insertion(+)\n"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo", maxUnifiedBytes: 64 })
    await sess.startTurn(0)
    const ev = await sess.endTurn(0)
    expect(ev).not.toBeNull()
    // Truncation marker must be present and body must be longer than cap
    // (cap + marker) but shorter than original.
    expect(ev?.unifiedDiff.length).toBeLessThan(huge.length)
    expect(ev?.unifiedDiff).toContain("[truncated:")
  })

  test("HELL-14: returned event discriminator is turn_diff_updated", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc\n"),
      "diff abc": ok("body\n"),
      "diff --shortstat abc": ok(" 1 file changed, 1 insertion(+)\n"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo" })
    await sess.startTurn(0)
    const ev = await sess.endTurn(0)
    // Type-narrow assertion: discriminator value pinned.
    if (ev === null) throw new Error("expected event, got null")
    const t: "turn_diff_updated" = ev.type
    expect(t).toBe("turn_diff_updated")
  })

  test("HELL-15: signal forwarded to runner during turn diff queries", async () => {
    const ctrl = new AbortController()
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc\n"),
      "diff abc": ok("body\n"),
      "diff --shortstat abc": ok(" 1 file changed, 1 insertion(+)\n"),
    })
    const sess = wireTurnDiffEmit({ runner, cwd: "/tmp/repo", signal: ctrl.signal })
    await sess.startTurn(0)
    await sess.endTurn(0)
    expect(runner.signals.length).toBeGreaterThan(0)
    for (const s of runner.signals) expect(s).toBe(ctrl.signal)
  })
})

// -----------------------------------------------------------------------------
// wireGitObservability composite
// -----------------------------------------------------------------------------

describe("ADR-0110 wireGitObservability composite (hellgate)", () => {
  test("HELL-16: composite exposes both fingerprintMeta and turnDiff seam", async () => {
    const runner = makeRunner({
      "rev-parse HEAD": ok("abc123\n"),
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "config --get remote.origin.url": ok("git@github.com:org/repo.git\n"),
      "diff abc123": ok("body\n"),
      "diff --shortstat abc123": ok(" 1 file changed, 1 insertion(+)\n"),
    })
    const obs = wireGitObservability({ runner, cwd: "/tmp/repo" })
    const meta = await obs.fingerprintMeta(baseMeta())
    expect(meta.gitSha).toBe("abc123")
    expect(meta.gitBranch).toBe("main")
    expect(meta.gitOriginUrl).toBe("git@github.com:org/repo.git")
    await obs.turnDiff.startTurn(0)
    const ev = await obs.turnDiff.endTurn(0)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe("turn_diff_updated")
    expect(ev?.turn).toBe(0)
  })
})
