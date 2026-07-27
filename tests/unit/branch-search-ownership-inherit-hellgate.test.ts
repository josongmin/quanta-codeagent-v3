/**
 * SECURITY HELLGATE (jul-27, round-4 spawn-path completeness audit): `branch_search`
 * candidate forks are built INLINE in `bindBranchRunCandidate` (branch-search-
 * runner.ts) via `{...parentSansBranch}` + direct `runAgent` — they do NOT enter
 * `buildChildConfig`, so they never call `narrowChildOwnership`. That is SAFE only
 * because a candidate carries the parent's `ownershipPolicy` VERBATIM via the
 * spread AND has no per-candidate owned/forbidden input (⇒ inheriting the parent
 * fence IS the correct narrowing). This test PINS that inheritance so the fence
 * can never be silently dropped from the spread (a regression would re-open the
 * spawn-boundary escape on the branch_search path).
 *
 * RED-first: delete `ownershipPolicy` from `parentSansBranch` (or stop spreading
 * it into `child`) ⇒ the candidate runs UNFENCED and this test goes RED.
 */
import { describe, expect, test } from "bun:test"
import { buildOwnershipPolicy } from "@/agent/ownership-policy"

const { __setBranchRunAgentForTest, bindBranchRunCandidate } = await import(
  "@/agent/branch-search-runner"
)

const fence = buildOwnershipPolicy({
  owned: ["src"],
  forbidden: ["src/secret"],
  cwd: "/repo",
  enforced: true,
})

// biome-ignore lint/suspicious/noExplicitAny: inert config/param stubs for the fork boundary
const rootConfig = (over: Record<string, unknown> = {}): any =>
  ({ depth: 0, cwd: "/repo", llm: {}, ownershipPolicy: fence, ...over }) as any
// biome-ignore lint/suspicious/noExplicitAny: inert candidate-invocation params
const candidateArgs = (): any =>
  ({
    seed: {},
    workspace: "/tmp/ws",
    task: "do X",
    baseLlm: {},
    signal: new AbortController().signal,
  }) as any

describe("branch_search candidate inherits the parent FS-ownership fence (funnel-bypass is safe)", () => {
  test("the forked child carries the parent's EXACT ownershipPolicy", async () => {
    let captured: { ownershipPolicy?: unknown } | null = null
    __setBranchRunAgentForTest((async (child: { ownershipPolicy?: unknown }) => {
      captured = child
      return { turns: 1, reason: "completed", messages: [] }
      // biome-ignore lint/suspicious/noExplicitAny: test override signature
    }) as any)
    try {
      await bindBranchRunCandidate(rootConfig())(candidateArgs())
    } finally {
      __setBranchRunAgentForTest(null)
    }
    expect(captured).not.toBeNull()
    // LOAD-BEARING: verbatim inheritance — same enforced fence binds the candidate.
    expect((captured as { ownershipPolicy?: unknown } | null)?.ownershipPolicy).toBe(fence)
    expect(fence?.enforced).toBe(true)
  })

  test("an UNFENCED parent yields an unfenced candidate (no fabricated fence)", async () => {
    let captured: { ownershipPolicy?: unknown } | null = null
    __setBranchRunAgentForTest((async (child: { ownershipPolicy?: unknown }) => {
      captured = child
      return { turns: 1, reason: "completed", messages: [] }
      // biome-ignore lint/suspicious/noExplicitAny: test override signature
    }) as any)
    try {
      await bindBranchRunCandidate(rootConfig({ ownershipPolicy: undefined }))(candidateArgs())
    } finally {
      __setBranchRunAgentForTest(null)
    }
    expect((captured as { ownershipPolicy?: unknown } | null)?.ownershipPolicy).toBeUndefined()
  })
})
