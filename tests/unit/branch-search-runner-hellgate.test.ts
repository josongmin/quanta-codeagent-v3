/**
 * Branch-search runner boundary: candidates never inherit branchSearch (or a
 * candidate could recursively fan out), and depth denial is typed rather than
 * throwing into the proposal loop.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const children: Array<Record<string, unknown>> = []

mock.module("@/agent/loop", () => ({
  runAgent: async (child: Record<string, unknown>) => {
    children.push(child)
    return { reason: "completed", messages: [], turns: 2 }
  },
}))

const { bindBranchRunCandidate } = await import("@/agent/branch-search-runner")
const { __resetRuntimeConfig } = await import("@/shared/runtime-config")

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  children.length = 0
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

const config = (): Parameters<typeof bindBranchRunCandidate>[0] =>
  ({
    depth: 0,
    cwd: "/tmp/root",
    llm: { model: "test", stream: async function* () {} },
    branchSearch: {
      defaultN: 2,
      defaultVerifierKinds: ["test"],
      timeoutPerBranchMs: 1_000,
      isolation: "tmpdir",
    },
  }) as unknown as Parameters<typeof bindBranchRunCandidate>[0]

const args = () =>
  ({
    id: "candidate-0",
    seed: { promptHint: "try another route" },
    workspace: "/tmp/candidate-0",
    task: "repair",
    baseLlm: { model: "base", stream: async function* () {} },
    signal: new AbortController().signal,
  }) as unknown as Parameters<ReturnType<typeof bindBranchRunCandidate>>[0]

describe("HELLGATE branch-search runner", () => {
  test("candidate config recursively strips branchSearch before the runAgent fork", async () => {
    const outcome = await bindBranchRunCandidate(config())(args())

    expect(outcome).toEqual({ kind: "completed", turns: 2 })
    expect(children).toHaveLength(1)
    expect(children[0]?.depth).toBe(1)
    expect(children[0]?.cwd).toBe("/tmp/candidate-0")
    expect(Object.hasOwn(children[0]!, "branchSearch")).toBe(false)
  })

  test("cap-zero denial returns a failed candidate and never throws or forks", async () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "0"
    __resetRuntimeConfig()

    const outcome = await bindBranchRunCandidate(config())(args())

    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("denied") })
    expect(children).toEqual([])
  })
})
