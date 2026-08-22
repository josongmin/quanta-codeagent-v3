/**
 * Runtime proof for the embed façade — the public door drives a real
 * `runAgent` loop end-to-end with a scripted fake LLM (Phases 2/3/6/7).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  type AgentEvent,
  createAnalysisAgent,
  defineTool,
  fakeLlm,
  isDone,
  NoCredentialError,
  ToolRegistrationError,
} from "@/sdk"

/** Script a fake assistant turn that CALLS `toolName` with `{}`. */
const callToolTurn = (id: string, toolName: string) => ({
  events: [
    { type: "tool_use_start" as const, id, name: toolName },
    { type: "tool_use_end" as const, id, input: {} },
    { type: "message_stop" as const, stop_reason: "tool_use" },
  ],
})

const readTool = (name: string, onRun?: () => void) =>
  defineTool({
    name,
    description: name,
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute() {
      onRun?.()
      yield* []
    },
  })

let cwd: string
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "sdk-embed-"))
})
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe("createAnalysisAgent", () => {
  test("runs a scripted session and resolves an outcome (await shape)", async () => {
    const agent = createAnalysisAgent({
      cwd,
      model: "sdk-fake",
      llm: fakeLlm([{ text: "analysis complete" }]),
      maxTurns: 3,
    })
    const outcome = await agent.run("analyze this repo")
    expect(outcome.turns).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(outcome.messages)).toBe(true)
    expect(["completed", "max_turns"]).toContain(outcome.reason)
  })

  test("streams events via async-iteration (for-await shape)", async () => {
    const agent = createAnalysisAgent({
      cwd,
      model: "sdk-fake",
      llm: fakeLlm([{ text: "hello from analysis" }]),
      maxTurns: 3,
    })
    const events: AgentEvent[] = []
    for await (const e of agent.run("go")) events.push(e)
    expect(events.length).toBeGreaterThan(0)
    expect(events.some(isDone)).toBe(true)
  })

  test("read-only profile runs (mutating tools stripped from registry)", async () => {
    // A consumer-defined MUTATING tool (isReadOnly=false) must be filtered out
    // under read-only, while the run still completes.
    let mutatingCalled = false
    const mutatingTool = defineTool({
      name: "danger_write",
      description: "would mutate",
      inputSchema: z.object({}),
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      async *execute() {
        mutatingCalled = true
        yield* []
      },
    })
    const agent = createAnalysisAgent({
      cwd,
      model: "sdk-fake",
      llm: fakeLlm([{ text: "done" }]),
      tools: [mutatingTool],
      includeDefaultTools: false,
      profile: "read-only",
      maxTurns: 2,
    })
    const outcome = await agent.run("look only")
    expect(outcome.turns).toBeGreaterThanOrEqual(1)
    expect(mutatingCalled).toBe(false)
  })

  test("analysis profile ALLOWS a mutating tool to execute (regression: F1 permission↔mode)", async () => {
    let mutated = false
    const mutateTool = defineTool({
      name: "apply_change",
      description: "mutating tool",
      inputSchema: z.object({}),
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      async *execute() {
        mutated = true
        yield* []
      },
    })
    const agent = createAnalysisAgent({
      cwd,
      model: "sdk-fake",
      llm: fakeLlm([callToolTurn("t1", "apply_change"), { text: "done" }]),
      tools: [mutateTool],
      includeDefaultTools: false,
      profile: "analysis", // default; maps to batch/acceptEdits + auto onConfirm
      maxTurns: 4,
    })
    await agent.run("apply the change")
    // Before the fix, permission:{mode:"default"} + no onConfirm hard-denied the
    // mutating tool → this stayed false.
    expect(mutated).toBe(true)
  })

  test("duplicate tool names in options throw ToolRegistrationError (regression: F3)", () => {
    expect(() =>
      createAnalysisAgent({
        cwd,
        model: "sdk-fake",
        llm: fakeLlm([{ text: "x" }]),
        includeDefaultTools: false,
        tools: [readTool("dup"), readTool("dup")],
      }),
    ).toThrow(ToolRegistrationError)
  })

  test("second iteration of the same run throws (regression: single-consumer)", async () => {
    const agent = createAnalysisAgent({
      cwd,
      model: "sdk-fake",
      llm: fakeLlm([{ text: "ok" }]),
      maxTurns: 2,
    })
    const run = agent.run("go")
    for await (const _e of run) {
      // drain once
    }
    let threw = false
    try {
      for await (const _e of run) {
        // second consumer — must be rejected
      }
    } catch (err) {
      threw = err instanceof Error && /single-consumer/.test(err.message)
    }
    expect(threw).toBe(true)
  })

  test("throws NoCredentialError when the selected provider has no key", () => {
    // Force a key-requiring provider (anthropic) with no key so resolution is
    // deterministic regardless of any on-disk chatgpt-oauth token.
    expect(() =>
      createAnalysisAgent({ cwd, model: "sdk-fake", env: { QUANTA_PROVIDER: "anthropic" } }),
    ).toThrow(NoCredentialError)
  })
})
