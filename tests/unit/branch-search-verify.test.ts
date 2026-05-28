import { afterEach, describe, expect, mock, test } from "bun:test"
import type { BranchCandidate } from "@/agent/branch-search"

const candidate = (): BranchCandidate => ({
  id: "cand-1",
  seed: {},
  workspace: "/tmp/branch-search-candidate",
  outcome: { kind: "completed", turns: 1 },
})

describe("tscVerifier", () => {
  afterEach(() => {
    mock.restore()
  })

  test("defaults to the repo-native fast typecheck rail", async () => {
    const calls: Array<{ cmd: string; cwd: string; timeoutMs?: number }> = []

    await mock.module("@/runtime", () => ({
      runShell: async (
        cmd: string,
        opts: { cwd: string; timeoutMs?: number },
      ): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> => {
        calls.push({ cmd, cwd: opts.cwd, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
      },
    }))

    const { DEFAULT_TSC_VERIFY_CMD, tscVerifier } = await import("@/agent/branch-search/verify")
    const signals = await tscVerifier({ timeoutMs: 321 })(candidate())

    expect(DEFAULT_TSC_VERIFY_CMD).toBe("bun run typecheck")
    expect(calls).toEqual([
      {
        cmd: "bun run typecheck",
        cwd: "/tmp/branch-search-candidate",
        timeoutMs: 321,
      },
    ])
    expect(signals).toEqual([
      {
        kind: "tsc",
        pass: true,
        detail: "typecheck clean",
        durationMs: expect.any(Number),
      },
    ])
  })
})
