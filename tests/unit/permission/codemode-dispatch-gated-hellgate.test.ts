/**
 * SINGLE-PEP behavioral hellgate (P2-T3) — the codemode in-cell dispatch path
 * routes through the SAME admissibility gate as the main loop. A
 * `hand-off-required` tool invoked via `buildCodeCellDispatchPort` is DENIED and
 * NEVER executed — proving codemode cannot be a gate bypass (it re-enters
 * `dispatchTool`, not the raw executor). Complements the static single-PEP
 * fence: the fence guards the call sites, this guards the behavior.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { buildCodeCellDispatchPort } from "@/agent/codemode-wire"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

const stubLlm: LLMPort = { model: "stub", stream: async function* () {} } as unknown as LLMPort

const handoffTool = (counts: { n: number }): Tool => ({
  name: "destroyer",
  description: "destroyer",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "hand-off-required",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

describe("codemode in-cell dispatch is PEP-gated [P2-T3]", () => {
  test("a hand-off-required tool invoked via codeCellDispatch is DENIED, never executed", async () => {
    const counts = { n: 0 }
    const config = {
      llm: stubLlm,
      signal: new AbortController().signal,
      registry: new ToolRegistry([handoffTool(counts)]),
      permission: { mode: "bypass" } as PermissionContext,
    } as unknown as AgentConfig

    const port = buildCodeCellDispatchPort({
      config,
      permission: { mode: "bypass" } as PermissionContext,
      // autoClassifier omitted (optional) — exactOptionalPropertyTypes rejects
      // an explicit `undefined` for an optional `AutoModeClassifier` slot.
      cellId: "cell-1",
    })

    const outcome = await port("destroyer", {})

    // Routed through dispatchTool's gate (A3 hand-off floor) ⇒ denied result,
    // not an executed one. The tool body NEVER ran even under bypass.
    expect(outcome.ok).toBe(false)
    expect(counts.n).toBe(0)
  })
})
