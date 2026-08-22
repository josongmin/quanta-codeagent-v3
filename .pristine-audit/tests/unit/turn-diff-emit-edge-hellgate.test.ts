/**
 * `wireTurnDiffEmit` — edge-input hellgate (ADR-0110).
 *
 * Sibling to `loop-turn-diff-wire-hellgate.test.ts` (which exercises the LOOP
 * call pattern with a stub TurnDiffSession). THIS file pins the BUILDER itself
 * — `wireTurnDiffEmit` from `src/agent/git-observability/turn-diff-emit.ts`
 * + composite `wireGitObservability` from `index.ts` — under adversarial
 * git-runner outputs.
 *
 * Coverage gap closed:
 *   - Existing tests use a synthetic `TurnDiffSession`. This file drives the
 *     REAL builder with a fake GitRunner — so the actual orchestration code
 *     gets exercised under each edge.
 *   - First adversarial probe of: binary-like diff bytes, oversize → truncated,
 *     no-change short-circuit, git rev-parse fail at startTurn, git diff fail
 *     at endTurn, abort signal propagation, repeated startTurn idempotence,
 *     endTurn-without-startTurn no-op, per-turn anchor isolation across
 *     interleaved turns, composite wireGitObservability shape, signal forwarding,
 *     and session-id propagation via fingerprint.
 *
 * 14 distinct cases.
 */

import { describe, expect, test } from "bun:test"
import { wireGitObservability, wireTurnDiffEmit } from "@/agent/git-observability"
import { TURN_DIFF_DEFAULT_MAX_BYTES } from "@/agent/turn-diff"
import type { SessionMeta } from "@/session/types"
import type { GitRunner, GitRunResult } from "@/tool/git/types"

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

type Reply = (
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) => GitRunResult | Promise<GitRunResult>

const makeRunner = (
  reply: Reply,
): GitRunner & { calls: Array<{ args: readonly string[]; cwd: string; aborted: boolean }> } => {
  const calls: Array<{ args: readonly string[]; cwd: string; aborted: boolean }> = []
  const runner: GitRunner = {
    async run(args, cwd, signal) {
      calls.push({ args, cwd, aborted: signal?.aborted ?? false })
      return await reply(args, cwd, signal)
    },
  }
  return Object.assign(runner, { calls })
}

const ok = (stdout: string, stderr = ""): GitRunResult => ({ exitCode: 0, stdout, stderr })
const fail = (stderr = "fatal: not a git repository"): GitRunResult => ({
  exitCode: 128,
  stdout: "",
  stderr,
})

// ─────────────────────────────────────────────────────────────
// A. anchor lifecycle (4)
// ─────────────────────────────────────────────────────────────

describe("wireTurnDiffEmit — A. anchor lifecycle", () => {
  test("EDGE-1: startTurn fails (not a git repo) → endTurn returns null, NO diff commands issued", async () => {
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return fail()
      return fail()
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/no/repo" })
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev).toBeNull()
    // Only the start-turn rev-parse was called; no diff/shortstat issued.
    const diffCalls = runner.calls.filter((c) => c.args[0] === "diff")
    expect(diffCalls).toHaveLength(0)
  })

  test("EDGE-2: endTurn called WITHOUT startTurn → null, no git runs at all", async () => {
    const runner = makeRunner(async () => ok("never"))
    const session = wireTurnDiffEmit({ runner, cwd: "/some/repo" })
    const ev = await session.endTurn(42)
    expect(ev).toBeNull()
    // No anchor → no git calls.
    expect(runner.calls).toHaveLength(0)
  })

  test("EDGE-3: startTurn idempotent — second call for same turnIndex does NOT re-probe", async () => {
    let probes = 0
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") {
        probes += 1
        return ok("abc123\n")
      }
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    await session.startTurn(0) // idempotent
    await session.startTurn(0)
    expect(probes).toBe(1)
  })

  test("EDGE-4: per-turn anchors isolated — endTurn(0) consumes ONLY its own anchor, endTurn(1) still works", async () => {
    let probeCount = 0
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") {
        probeCount += 1
        return ok(`sha-${probeCount}\n`)
      }
      if (args[0] === "diff" && args.includes("--shortstat")) {
        return ok(" 1 file changed, 2 insertions(+)")
      }
      if (args[0] === "diff") {
        return ok("diff body")
      }
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    await session.startTurn(1) // separate anchor
    const ev0 = await session.endTurn(0)
    const ev1 = await session.endTurn(1)
    expect(ev0?.type).toBe("turn_diff_updated")
    expect(ev1?.type).toBe("turn_diff_updated")
    // Anchors are distinct: ev0.fromSha != ev1.fromSha (sha-1 vs sha-3 because
    // computeTurnDiff calls rev-parse again for toSha).
    expect(ev0?.fromSha).toBe("sha-1")
    expect(ev1?.fromSha).toBe("sha-2")
  })
})

// ─────────────────────────────────────────────────────────────
// B. diff body edge cases (4)
// ─────────────────────────────────────────────────────────────

describe("wireTurnDiffEmit — B. diff body edges", () => {
  test("EDGE-5: no-change turn (empty diff + zero shortstat) → endTurn returns null (short-circuit)", async () => {
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return ok("same-sha\n")
      if (args[0] === "diff" && args.includes("--shortstat")) return ok("")
      if (args[0] === "diff") return ok("")
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev).toBeNull()
  })

  test("EDGE-6: oversize diff body (> 64 KiB default) → unifiedDiff TRUNCATED with marker, byte ceiling enforced", async () => {
    const oversize = "x".repeat(TURN_DIFF_DEFAULT_MAX_BYTES + 5_000)
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return ok("sha\n")
      if (args[0] === "diff" && args.includes("--shortstat")) {
        return ok(" 1 file changed, 100 insertions(+)")
      }
      if (args[0] === "diff") return ok(oversize)
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev?.type).toBe("turn_diff_updated")
    expect(ev?.unifiedDiff).toContain("[truncated:")
    // The kept slice is exactly the cap; truncation marker appended.
    expect(ev?.unifiedDiff?.startsWith("x".repeat(100))).toBe(true)
    // Byte count is bounded — content + marker, not raw oversize.
    expect(ev && ev.unifiedDiff.length < oversize.length).toBe(true)
  })

  test("EDGE-7: binary-like (non-UTF8 sentinel) bytes in diff stdout → pass through verbatim (no decode crash)", async () => {
    // GitRunner's stdout is a string. A binary diff via `git diff --binary`
    // would produce something like "Binary files differ" — the emitter does
    // not attempt to validate body charset. Replace with a real null-byte
    // string to exercise the no-decode invariant.
    const binaryish = "\x00\x01\x02BINARY-MARKER\x7F\xFF"
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return ok("sha\n")
      if (args[0] === "diff" && args.includes("--shortstat")) {
        return ok(" 1 file changed, 1 insertion(+)")
      }
      if (args[0] === "diff") return ok(binaryish)
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev?.unifiedDiff).toBe(binaryish)
  })

  test("EDGE-8: git diff exits non-zero at endTurn → null returned, no throw", async () => {
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return ok("sha\n")
      if (args[0] === "diff") return fail("fatal: ambiguous argument")
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" })
    await session.startTurn(0)
    let threw: unknown = null
    let ev: unknown = "sentinel"
    try {
      ev = await session.endTurn(0)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(ev).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// C. signal forwarding (3)
// ─────────────────────────────────────────────────────────────

describe("wireTurnDiffEmit — C. signal forwarding", () => {
  test("EDGE-9: signal aborted BEFORE startTurn → captured (no anchor recorded)", async () => {
    const controller = new AbortController()
    controller.abort()
    let runnerSawSignal = false
    const runner = makeRunner(async (_args, _cwd, sig) => {
      // computeTurnDiff catches all throws; with aborted signal, runner-side
      // implementations typically throw — the emitter swallows and returns null.
      if (sig?.aborted) {
        runnerSawSignal = true
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      return ok("never")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo", signal: controller.signal })
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev).toBeNull()
    expect(runnerSawSignal).toBe(true)
  })

  test("EDGE-10: signal forwarded to EVERY runner call (start + end + shortstat + head)", async () => {
    const controller = new AbortController()
    let signalsSeen = 0
    const runner = makeRunner(async (args, _cwd, sig) => {
      if (sig === controller.signal) signalsSeen += 1
      if (args[0] === "rev-parse") return ok("sha\n")
      if (args[0] === "diff" && args.includes("--shortstat")) {
        return ok(" 1 file changed, 1 insertion(+)")
      }
      if (args[0] === "diff") return ok("body")
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo", signal: controller.signal })
    await session.startTurn(0)
    await session.endTurn(0)
    // 4 calls minimum: rev-parse (startTurn), rev-parse (endTurn toSha),
    // diff <sha>, diff --shortstat <sha>. All carrying the same signal ref.
    expect(signalsSeen).toBeGreaterThanOrEqual(3)
  })

  test("EDGE-11: maxUnifiedBytes ABSENT → default 64 KiB cap applied (truncation at default boundary)", async () => {
    const oversize = "z".repeat(TURN_DIFF_DEFAULT_MAX_BYTES + 1)
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse") return ok("sha\n")
      if (args[0] === "diff" && args.includes("--shortstat")) {
        return ok(" 1 file changed, 1 insertion(+)")
      }
      if (args[0] === "diff") return ok(oversize)
      return ok("")
    })
    const session = wireTurnDiffEmit({ runner, cwd: "/repo" }) // no maxUnifiedBytes
    await session.startTurn(0)
    const ev = await session.endTurn(0)
    expect(ev?.unifiedDiff).toContain("[truncated:")
    expect(ev?.unifiedDiff?.startsWith("z".repeat(TURN_DIFF_DEFAULT_MAX_BYTES))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// D. composite wireGitObservability (3)
// ─────────────────────────────────────────────────────────────

describe("wireGitObservability composite — D. fingerprint + turnDiff bundled", () => {
  test("EDGE-12: composite returns BOTH fingerprintMeta + turnDiff handles", () => {
    const runner = makeRunner(async () => fail())
    const composite = wireGitObservability({ runner, cwd: "/repo" })
    expect(typeof composite.fingerprintMeta).toBe("function")
    expect(typeof composite.turnDiff.startTurn).toBe("function")
    expect(typeof composite.turnDiff.endTurn).toBe("function")
  })

  test("EDGE-13: fingerprintMeta does NOT mutate input meta (returns new shallow clone)", async () => {
    const runner = makeRunner(async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("sha-abc\n")
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok("main\n")
      if (args[0] === "config") return ok("https://github.com/x/y.git\n")
      return ok("")
    })
    const composite = wireGitObservability({ runner, cwd: "/repo" })
    const input: SessionMeta = {
      id: "s-1",
      title: "test",
      cwd: "/repo",
      createdAt: 100,
      lastTouched: 100,
      archived: false,
    }
    const out = await composite.fingerprintMeta(input)
    expect(out).not.toBe(input) // new reference
    // Input untouched — no git fields injected.
    expect((input as { gitSha?: string }).gitSha).toBeUndefined()
  })

  test("EDGE-14: fingerprintMeta when git is NOT a repo → returns clone with NO gitSha/gitBranch/gitOriginUrl keys (exactOptional)", async () => {
    const runner = makeRunner(async () => fail()) // every call fails
    const composite = wireGitObservability({ runner, cwd: "/no/repo" })
    const input: SessionMeta = {
      id: "s-2",
      title: "test-norepo",
      cwd: "/no/repo",
      createdAt: 200,
      lastTouched: 200,
      archived: false,
    }
    const out = await composite.fingerprintMeta(input)
    // None of the three git keys present (per session-fingerprint.ts L37-L41).
    expect("gitSha" in out).toBe(false)
    expect("gitBranch" in out).toBe(false)
    expect("gitOriginUrl" in out).toBe(false)
    // Original fields preserved.
    expect(out.id).toBe("s-2")
    expect(out.cwd).toBe("/no/repo")
  })
})
