import { describe, expect, test } from "bun:test"
import type { BranchCandidate } from "@/agent/branch-search"
import { DEFAULT_TSC_VERIFY_CMD, type ShellRunner, tscVerifier } from "@/agent/branch-search/verify"

const candidate = (): BranchCandidate => ({
  id: "cand-1",
  seed: {},
  workspace: "/tmp/branch-search-candidate",
  outcome: { kind: "completed", turns: 1 },
})

describe("tscVerifier", () => {
  // INJECTED fake shell (no `mock.module("@/runtime", …)`): bun's `mock.restore()`
  // does NOT undo a `mock.module` replacement, so the old approach leaked a fake
  // `runShell` to every sibling test file in the single-process run (the
  // bash/localize/grep full-suite contamination). The verifier takes `runShell`
  // as an inject seam (like `clock`), so the fake stays scoped to this test.
  test("defaults to the repo-native fast typecheck rail", async () => {
    const calls: Array<{ cmd: string; cwd: string; timeoutMs?: number }> = []
    const fakeShell: ShellRunner = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
    }

    const signals = await tscVerifier({ timeoutMs: 321, runShell: fakeShell })(candidate())

    expect(DEFAULT_TSC_VERIFY_CMD).toBe("bun run typecheck")
    expect(calls).toEqual([
      { cmd: "bun run typecheck", cwd: "/tmp/branch-search-candidate", timeoutMs: 321 },
    ])
    expect(signals).toEqual([
      { kind: "tsc", pass: true, detail: "typecheck clean", durationMs: expect.any(Number) },
    ])
  })
})
