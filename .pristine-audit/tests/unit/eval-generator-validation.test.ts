/**
 * Synthetic generator — strict validation: a model that produces bad/missing
 * fields or oversized setup files is REJECTED with a reason. No half-broken
 * scenario is ever written to disk.
 *
 * We feed a ScriptedLLM responses that exercise the rejection paths plus the
 * acceptance path. Writes go to a temp dir so the repo is not mutated.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateScenarios } from "@/../src/apps/eval/synthetic/generator"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const makeLLM = (text: string): LLMPort => ({
  model: "test",
  // biome-ignore lint/correctness/useYield: scripted; iterates a fixed sequence
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const USECASE = "software-quality.debugging.error-message-paste"

describe("synthetic generator validation", () => {
  test("rejects non-array response", async () => {
    const llm = makeLLM(`{"not": "an array"}`)
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 1, outRoot: out })
    expect(r.accepted.length).toBe(0)
    expect(r.rejected.length).toBe(1)
  })

  test("rejects rubric < 3 items", async () => {
    const llm = makeLLM(
      JSON.stringify([
        {
          schema: 1,
          id: "tiny",
          usecase: USECASE,
          title: "tiny rubric",
          prompt: "do the thing",
          rubric: [
            { id: "a", description: "x" },
            { id: "b", description: "y" },
          ],
        },
      ]),
    )
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 1, outRoot: out })
    expect(r.accepted.length).toBe(0)
    expect(r.rejected[0]?.reason).toContain("rubric")
  })

  test("rejects oversized setup files", async () => {
    const huge = "x".repeat(5_000)
    const llm = makeLLM(
      JSON.stringify([
        {
          schema: 1,
          id: "huge",
          usecase: USECASE,
          title: "huge file",
          prompt: "fix it",
          files: [{ path: "src/big.ts", content: huge }],
          rubric: [
            { id: "a", description: "x" },
            { id: "b", description: "y" },
            { id: "c", description: "z" },
          ],
        },
      ]),
    )
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 1, outRoot: out })
    expect(r.accepted.length).toBe(0)
    expect(r.rejected[0]?.reason).toContain("4096")
  })

  test("REFUSES wrong-usecase response (no silent coercion)", async () => {
    const llm = makeLLM(
      JSON.stringify([
        {
          schema: 1,
          id: "happy-path",
          usecase: "wrong.id.on.purpose",
          title: "happy",
          prompt: "fix the typo",
          rubric: [
            { id: "a", description: "x" },
            { id: "b", description: "y" },
            { id: "c", description: "z" },
          ],
        },
      ]),
    )
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 1, outRoot: out })
    expect(r.accepted.length).toBe(0)
    expect(r.rejected.length).toBe(1)
    expect(r.rejected[0]?.reason).toContain("usecase mismatch")
    expect(readdirSync(out).length).toBe(0)
  })

  test("accepts a well-formed scenario with correct usecase + writes it", async () => {
    const llm = makeLLM(
      JSON.stringify([
        {
          schema: 1,
          id: "happy-path",
          usecase: USECASE,
          title: "happy",
          prompt: "fix the typo",
          files: [{ path: "src/x.ts", content: "export const x = 1\n" }],
          rubric: [
            { id: "reads", description: "agent reads the file" },
            { id: "edits", description: "agent makes a minimal edit" },
            { id: "verifies", description: "agent runs the file" },
          ],
        },
      ]),
    )
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 1, outRoot: out })
    expect(r.accepted.length).toBe(1)
    expect(r.accepted[0]?.scenario.usecase).toBe(USECASE)
    expect(existsSync(join(out, "happy-path.json"))).toBe(true)
    expect(readdirSync(out).length).toBe(1)
  })

  test("dedups by id within a single batch", async () => {
    const dupe = {
      schema: 1,
      id: "dup",
      usecase: USECASE,
      title: "dup",
      prompt: "p",
      rubric: [
        { id: "a", description: "a" },
        { id: "b", description: "b" },
        { id: "c", description: "c" },
      ],
    }
    const llm = makeLLM(JSON.stringify([dupe, dupe]))
    const out = mkdtempSync(join(tmpdir(), "gen-"))
    const r = await generateScenarios({ llm, usecase: USECASE, count: 2, outRoot: out })
    expect(r.accepted.length).toBe(1)
    expect(r.rejected.length).toBe(1)
    expect(r.rejected[0]?.reason).toContain("duplicate")
  })
})
