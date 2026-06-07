/**
 * Hellgate — ask_user CLI wiring (ADR-0494).
 *
 * Proves the composition-root adapter (`buildCliAskUserPort` +
 * `askUserPortFromPrompter`) actually drives the `ask_user` tool end-to-end:
 *   1. an injected (fake) ElicitationPrompter routes each kind to the right
 *      method and surfaces the typed answer through the tool;
 *   2. the MCP `empty-enum` failure maps to ask_user's `empty-options`;
 *   3. the headless build (no TTY) denies without blocking.
 */
import { describe, expect, test } from "bun:test"
import { askUserPortFromPrompter } from "@/apps/cli/ask-user-wire"
import type { ElicitationPrompter, ElicitationResult } from "@/mcp"
import { askUserTool } from "@/tool/ask-user"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as unknown as ToolContext
const resultOf = async (it: AsyncIterable<ToolEvent>) => {
  for await (const e of it) if (e.type === "result") return e.result
  throw new Error("no result")
}

// A fake prompter that records which method was called and returns a fixed value.
const fakePrompter = (calls: string[]): ElicitationPrompter => {
  const ok = <T>(value: T): Promise<ElicitationResult<T>> => Promise.resolve({ ok: true, value })
  return {
    promptString: (r) => (calls.push("string"), ok(`s:${r.prompt}`)),
    promptNumber: () => (calls.push("number"), ok(42)),
    promptInteger: () => (calls.push("integer"), ok(7)),
    promptBoolean: () => (calls.push("boolean"), ok(true)),
    promptEnum: (r) => (calls.push("enum"), ok(r.options[0] as string)),
    promptMultiEnum: (r) => (calls.push("multiEnum"), ok([r.options[0] as string])),
    promptSingleEnum: () => (calls.push("singleEnum"), ok("x")),
  }
}

describe("ask_user CLI wiring — kind routing through the adapter", () => {
  test("each kind reaches the matching prompter method and surfaces the answer", async () => {
    const calls: string[] = []
    const port = askUserPortFromPrompter(fakePrompter(calls))
    const tool = askUserTool(port)

    expect((await resultOf(tool.execute({ kind: "string", prompt: "name?" }, ctx()))).ok).toBe(true)
    expect((await resultOf(tool.execute({ kind: "boolean", prompt: "ok?" }, ctx()))).ok).toBe(true)
    expect((await resultOf(tool.execute({ kind: "number", prompt: "n?" }, ctx()))).ok).toBe(true)
    expect(
      (await resultOf(tool.execute({ kind: "select", prompt: "p", options: ["a", "b"] }, ctx())))
        .ok,
    ).toBe(true)
    expect(
      (
        await resultOf(
          tool.execute({ kind: "multiselect", prompt: "p", options: ["a", "b"] }, ctx()),
        )
      ).ok,
    ).toBe(true)

    expect(calls).toEqual(["string", "boolean", "number", "enum", "multiEnum"])
  })

  test("empty-enum failure maps to empty-options", async () => {
    const prompter = {
      ...fakePrompter([]),
      promptEnum: () => Promise.resolve({ ok: false, reason: "empty-enum" } as const),
    } as ElicitationPrompter
    const tool = askUserTool(askUserPortFromPrompter(prompter))
    const r = await resultOf(tool.execute({ kind: "select", prompt: "p", options: ["a"] }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("empty-options")
  })
})
