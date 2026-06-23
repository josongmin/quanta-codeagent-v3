import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "../../src/apps/bench/eval"
import type { Instance } from "../../src/apps/bench/types"
import { scopedEnv } from "../_support/scoped-env"

const ENV = scopedEnv([
  "PATH",
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_V5_ADAPTIVE",
])

const withPyrightOnPath = (pathValue: string | undefined): string => {
  const pyrightBinDir = join(process.env.HOME ?? "", ".local", "bin")
  if (pathValue === undefined || pathValue === "") return pyrightBinDir
  const parts = pathValue.split(":")
  return parts.includes(pyrightBinDir) ? pathValue : `${pyrightBinDir}:${pathValue}`
}

class AdaptiveRouteLLM implements LLMPort {
  solveCalls = 0
  routeCalls = 0
  private pendingExpandedEdit = false
  private expandedEditDone = false

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (input.tools.some((tool) => tool.name === "route_adaptive_phase")) {
      this.routeCalls += 1
      const firstRoute = this.routeCalls === 1
      if (firstRoute) this.pendingExpandedEdit = true
      yield { type: "tool_use_start", id: `route-${this.routeCalls}`, name: "route_adaptive_phase" }
      yield {
        type: "tool_use_end",
        id: `route-${this.routeCalls}`,
        input: firstRoute
          ? {
              action: "deeper_localize",
              evidenceGaps: ["localization_uncertain"],
              citedEvidenceIds: ["owners"],
              why: "thin pass produced no concrete owner-backed patch",
            }
          : {
              action: "accept_thin",
              evidenceGaps: [],
              citedEvidenceIds: ["candidate", "owners"],
              why: "expanded pass produced a concrete owner-backed patch",
            },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }

    const prompt = input.messages
      .flatMap((message) => message.content)
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
    const sandbox = prompt.match(/Work inside (\S+?)\./)?.[1] ?? ""

    this.solveCalls += 1
    if (sandbox === "") {
      yield { type: "text_delta", delta: "FILE: calc.py\nREASON: the issue names calc.py directly." }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    if (this.pendingExpandedEdit && !this.expandedEditDone) {
      this.pendingExpandedEdit = false
      this.expandedEditDone = true
      yield { type: "tool_use_start", id: "write-2", name: "write" }
      yield {
        type: "tool_use_end",
        id: "write-2",
        input: {
          path: join(sandbox, "calc.py"),
          content: "def add(a, b):\n    return a + b\n",
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    if (!this.expandedEditDone) {
      yield { type: "text_delta", delta: "thin miss" }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "bench-v5-adaptive-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("bench v5 adaptive routing", () => {
  test(
    "reroutes a thin miss into a deeper phase and records adaptive telemetry",
    ENV.run(async () => {
      ENV.set({
        PATH: withPyrightOnPath(process.env.PATH),
        QUANTA_BENCH_LOCALIZE_PHASE: "0",
        QUANTA_BENCH_PRESET: "agentless-v5-thin-and-expanded",
        QUANTA_BENCH_V5_ADAPTIVE: "1",
      })
      await withTmp(async (dir) => {
        const repo = join(dir, "repo")
        mkdirSync(repo, { recursive: true })
        writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n")
        const instance: Instance = {
          id: "inst-add-py",
          repoPath: repo,
          problemStatement: "Fix add() in calc.py so it returns the sum.",
          testCmd: 'python -c "from calc import add; raise SystemExit(0 if add(2, 3) == 5 else 1)"',
        }
        const llm = new AdaptiveRouteLLM()
        const result = await runInstance(instance, {
          llm,
          maxTurns: 5,
          timeoutMs: 30_000,
        })
        expect(result.passed).toBe(true)
        expect(result.patch).toContain("return a + b")
        expect(result.adaptiveRoute?.steps).toEqual(["deeper_localize"])
        expect(result.adaptiveRoute?.finalAction).toBe("accept_thin")
        expect(result.adaptiveRoute?.outcome).toBe("finalize")
        expect(llm.solveCalls).toBeGreaterThanOrEqual(2)
        expect(llm.routeCalls).toBe(2)
      })
    }),
    20_000,
  )
})
