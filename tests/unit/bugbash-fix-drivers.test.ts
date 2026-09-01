/**
 * Bugbash (jun-20) — drivers group teeth.
 *
 * Covers the production apps-driver telemetry fix (#6): the SDK bench path
 * (`@/apps/bench/eval` → apps driver) must emit the `knobs_applied` stream
 * event at its agent entry points, matching the runner-core driver. Before the
 * fix the apps driver re-implemented `runAgentOnce` / `runAgentPhase` with their
 * own `BenchStreamTap` but never called `emitKnobsApplied`, so EVERY real SDK
 * trajectory was silently missing the greppable per-run knobs marker.
 *
 * Teeth (red-on-injection): we run a real `runInstance` from the PRODUCTION
 * module with a fake LLM and a strict observe dir, then read the per-attempt
 * JSONL trajectory and assert the recorded `knobs_applied` line is present.
 * Reverting either `emitKnobsApplied` call in the apps driver drops the line
 * and fails this test.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

// This rail proves the production telemetry wire, not a 20-second latency
// target. Keep the inner agent deadline below Bun's 60s test watchdog while
// leaving enough room for a loaded host to prepare the sandbox and execute the
// real production path before the fake edit is sampled.
const TELEMETRY_RUN_TIMEOUT_MS = 50_000

class EditOnceLLM implements LLMPort {
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (.+?)\.(?:\n| When done)/)?.[1] ?? ""
    yield { type: "tool_use_start", id: "e1", name: "edit" }
    yield {
      type: "tool_use_end",
      id: "e1",
      input: {
        path: join(sandbox, "math.js"),
        old_string: "return a - b",
        new_string: "return a + b",
      },
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Read the single per-attempt trajectory JSONL the BenchObserver wrote and
 *  return the parsed `recovery`-kind lines (the trajectory family the
 *  `knobs_applied` event maps onto). */
const readTrajectory = (
  observeDir: string,
  runId: string,
): Array<{ kind: string; data: Record<string, unknown> }> => {
  const runDir = join(observeDir, runId)
  const jsonl = readdirSync(runDir).find((f) => f.endsWith(".jsonl"))
  expect(jsonl).toBeDefined()
  return readFileSync(join(runDir, jsonl as string), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> })
}

describe("apps (production SDK) bench driver knobs_applied telemetry", () => {
  test("single-pass runInstance emits a knobs_applied trajectory line (#6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bugbash-drivers-knobs-"))
    const repo = join(dir, "repo")
    const observeDir = join(dir, "observe")
    const runId = "bugbash-knobs-run"
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(
        join(repo, "math.js"),
        "function add(a,b){ return a - b }\nmodule.exports={add}\n",
      )
      const instance: Instance = {
        id: "knobs-applied-prod-path",
        repoPath: repo,
        problemStatement: "Fix add() in math.js.",
        testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
      }

      const result = await runInstance(instance, {
        llm: new EditOnceLLM(),
        maxTurns: 3,
        timeoutMs: TELEMETRY_RUN_TIMEOUT_MS,
        observe: { dir: observeDir, runId, attempt: 0 },
      })

      // The agent ran the single-pass path and produced the edit — this proves
      // we exercised runAgentPhase (the entry point that must emit the event),
      // not an early bail.
      expect(result.patch).toContain("return a + b")

      const recovery = readTrajectory(observeDir, runId).filter((l) => l.kind === "recovery")
      const knobsLine = recovery.find((l) => l.data.reason === "knobs_applied")
      // RED if either emitKnobsApplied call is reverted in the apps driver:
      // no recovery/knobs_applied line is ever written to the trajectory.
      expect(knobsLine).toBeDefined()
      expect(knobsLine?.data.surface).toBe("bench")
      // The payload carries the per-run knobs/preset/cost marker (greppable SSOT).
      expect(knobsLine?.data).toHaveProperty("knobs")
      expect(knobsLine?.data).toHaveProperty("preset")
      expect(knobsLine?.data).toHaveProperty("costMultiplier")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
