import { describe, expect, test } from "bun:test"
import { cleanupSelectionCandidateSandbox } from "@/runner/batch/eval/driver"

describe("cleanupSelectionCandidateSandbox", () => {
  test("evicts the LSP workspace before removing the fork sandbox", async () => {
    const calls: string[] = []

    await cleanupSelectionCandidateSandbox("/tmp/candidate", {
      evictLspWorkspaces: async (cwd) => {
        calls.push(`evict:${cwd}`)
      },
      cleanupSandbox: async (sandbox) => {
        calls.push(`cleanup:${sandbox}`)
      },
    })

    expect(calls).toEqual(["evict:/tmp/candidate", "cleanup:/tmp/candidate"])
  })

  test("still removes the fork sandbox when LSP eviction fails", async () => {
    const calls: string[] = []

    await cleanupSelectionCandidateSandbox("/tmp/candidate", {
      evictLspWorkspaces: async (cwd) => {
        calls.push(`evict:${cwd}`)
        throw new Error("lsp transport already dead")
      },
      cleanupSandbox: async (sandbox) => {
        calls.push(`cleanup:${sandbox}`)
      },
    })

    expect(calls).toEqual(["evict:/tmp/candidate", "cleanup:/tmp/candidate"])
  })
})
