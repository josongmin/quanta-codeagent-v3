/**
 * enter_plan_mode — CONSUMER CONTRACT (loop integration, scripted LLM, $0).
 *
 * This is the harness-honors-the-contract half of the split contract test for
 * model-driven plan entry. It does NOT use a real model (the LLM is a
 * deterministic ScriptedLLM double), so it is an INTEGRATION test of the
 * consume side — deliberately NOT labelled "e2e". The producer half (does a
 * real model actually emit this tool_use for a non-trivial task?) lives as a
 * cassette-frozen elicitation smoke under tests/smoke/fixtures.
 *
 * The contract artifact both halves share is the tool_use shape
 * `{ name: "enter_plan_mode", input: { reason } }`. Here we PIN that when the
 * loop RECEIVES that shape it:
 *   1. flips collaboration mode to `plan` at the turn boundary (mode_changed
 *      default→plan emitted, reason propagated to onPlanEnterRequest),
 *   2. so the NEXT turn's mutating `write` is blocked at the dispatch seam
 *      (tool_result.ok=false, execute() NEVER reached),
 *   3. and the loop still completes (plan mode is a posture, not an abort).
 *
 * Paired control (no enter_plan_mode call) proves the block is CAUSED by the
 * entry, not ambient: the identical `write` executes normally.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgent } from "@/agent"
import type { AgentEvent } from "@/stream"
import { enterPlanModeTool, type Tool, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/** Operator port stub — its mere PRESENCE gates enter_plan_mode's registration
 *  + the ctx.enterPlanMode seam. Never actually called in these scenarios
 *  (nothing requests plan EXIT). */
const dummyPlanExitPort = { request: async () => ({ decision: "approved" as const }) }

/** Mutating `write` stub — classified `write_filesystem` in MUTATING_TOOL_TABLE
 *  (real tool name), so a plan-mode block carries the typed collab-mode reason.
 *  Records executions: a reached execute() in plan mode means the seam LEAKED. */
const captureWriteTool = (executions: { count: number }): Tool =>
  ({
    name: "write",
    description: "Mutating write stub that records every successful invocation.",
    inputSchema: z.object({ path: z.string(), content: z.string() }) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute() {
      executions.count += 1
      yield { type: "result", result: { ok: true, output: "WROTE (would-be-leak)" } }
    },
  }) as Tool

const REASON = "multi-file refactor spanning 4 files; plan before editing"

describe("enter_plan_mode — consumer contract (scripted tool_use → real loop honors the flip)", () => {
  test("model-emitted enter_plan_mode flips to plan; NEXT-turn write is seam-blocked; loop completes", async () => {
    const executions = { count: 0 }
    const seenReasons: string[] = []
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e-1", "enter_plan_mode", { reason: REASON })),
      ev(toolUse("w-1", "write", { path: "/tmp/x", content: "data" })),
      ev(text("acknowledged — staying read-only until the plan is ready")),
    ])
    const config = cfg({
      llm,
      registry: new ToolRegistry([enterPlanModeTool() as Tool, captureWriteTool(executions)]),
      stream,
      planExitPort: dummyPlanExitPort,
      onPlanEnterRequest: (e: { reason: string }) => seenReasons.push(e.reason),
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "enter-plan:consumer")

    // Loop survived plan entry + a blocked mutation and reached a clean end.
    expect(outcome.reason).toBe("completed")

    // 1. The reason threaded model → tool → ctx → onPlanEnterRequest.
    expect(seenReasons).toEqual([REASON])

    // 2. The turn-boundary flip emitted exactly one default→plan transition.
    const modeChanges = stream.events.filter(
      (e): e is Extract<AgentEvent, { type: "mode_changed" }> => e.type === "mode_changed",
    )
    expect(modeChanges).toHaveLength(1)
    expect(modeChanges[0]).toMatchObject({ from: "default", to: "plan" })

    // 3. enter_plan_mode itself succeeded.
    const enterResult = stream.events.find(
      (e) => e.type === "tool_result" && e.name === "enter_plan_mode",
    )
    expect(enterResult && enterResult.type === "tool_result" && enterResult.ok).toBe(true)

    // 4. The NEXT-turn write was blocked at the seam — execute() never ran.
    expect(executions.count).toBe(0)
    const writeResult = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(writeResult).toBeDefined()
    if (writeResult && writeResult.type === "tool_result") {
      expect(writeResult.ok).toBe(false)
      const lower = writeResult.preview.toLowerCase()
      expect(lower === "mode-blocked" || lower.includes("plan")).toBe(true)
    }
  }, 15_000)

  test("paired control: WITHOUT enter_plan_mode, the identical write executes (block is caused by entry)", async () => {
    const executions = { count: 0 }
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("w-2", "write", { path: "/tmp/y", content: "data" })),
      ev(text("done")),
    ])
    const config = cfg({
      llm,
      registry: new ToolRegistry([enterPlanModeTool() as Tool, captureWriteTool(executions)]),
      stream,
      planExitPort: dummyPlanExitPort,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "enter-plan:control")

    expect(outcome.reason).toBe("completed")
    // No entry ⇒ no flip ⇒ write runs normally.
    expect(executions.count).toBe(1)
    expect(stream.events.filter((e) => e.type === "mode_changed")).toHaveLength(0)
    const writeResult = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(writeResult && writeResult.type === "tool_result" && writeResult.ok).toBe(true)
  }, 15_000)
})
