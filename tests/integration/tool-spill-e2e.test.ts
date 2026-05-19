import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runAgent } from "@/agent"
import { type Tool, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/**
 * GAP 3 — the result-size cap + on-disk spill, exercised through the REAL
 * registry → dispatch → loop path (not a unit call to `capToolOutput`).
 *
 * `ToolRegistry.run` applies `capToolOutput({ maxChars: envMaxChars(env),
 * spillDir: join(ctx.cwd, ".quanta", "tool-output") })` to EVERY tool's
 * output. We register a real `Tool` that emits an output far larger than a
 * tiny `QUANTA_TOOL_OUTPUT_MAX`, drive it via the scripted model through
 * `runAgent`, and assert: (a) the `tool_result` the model actually sees (the
 * one appended to the transcript) is the `<persisted-output>` marker, and (b)
 * a spill file was written under `<cwd>/.quanta/tool-output/`. The env var is
 * restored and the temp cwd removed afterwards.
 */

const GIANT = "Z".repeat(40_000)

const bigOutputTool: Tool = {
  name: "big_output",
  description: "Test tool that emits an oversized output to exercise the spill.",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    yield { type: "result", result: { ok: true, output: `BIGSTART ${GIANT} BIGEND` } }
  },
}

describe("GAP 3 — result-size cap + spill through real registry/dispatch", () => {
  let dir: string
  let prevEnv: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-spill-"))
    prevEnv = process.env.QUANTA_TOOL_OUTPUT_MAX
    process.env.QUANTA_TOOL_OUTPUT_MAX = "500"
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QUANTA_TOOL_OUTPUT_MAX
    else process.env.QUANTA_TOOL_OUTPUT_MAX = prevEnv
    rmSync(dir, { recursive: true, force: true })
  })

  test("oversized tool output ⇒ model sees <persisted-output> + spill file written", async () => {
    const registry = new ToolRegistry([bigOutputTool])
    const llm = new ScriptedLLM([
      ev(toolUse("t1", "big_output", {})),
      ev(text("done after seeing the persisted marker")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, registry, cwd: dir, maxTurns: 3 })),
      15_000,
      "tool-spill",
    )

    expect(out.reason).toBe("completed")

    // The tool_result block the model actually consumed (appended to the
    // canonical transcript) must be the capped <persisted-output> marker —
    // proving the cap ran on the real registry/dispatch path, not the raw 40k.
    const trBlocks = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(trBlocks).toHaveLength(1)
    const tr = trBlocks[0]
    if (tr?.type !== "tool_result") throw new Error("expected a tool_result block")
    expect(tr.content).toContain("<persisted-output>")
    expect(tr.content).toContain("</persisted-output>")
    expect(tr.content).toContain("exceeded the 500-char tool-result budget")
    // The raw 40k payload must NOT be passed to the model verbatim.
    expect(tr.content.length).toBeLessThan(GIANT.length)

    // A spill file was written under <cwd>/.quanta/tool-output/.
    const spillDir = join(dir, ".quanta", "tool-output")
    expect(existsSync(spillDir)).toBe(true)
    const spilled = readdirSync(spillDir).filter((f) => f.endsWith(".txt"))
    expect(spilled).toHaveLength(1)
    const spillPath = join(spillDir, spilled[0] as string)
    // The spill holds the FULL original output verbatim.
    const full = readFileSync(spillPath, "utf8")
    expect(full).toBe(`BIGSTART ${GIANT} BIGEND`)
    // The marker references that exact spill path so the model can Read it.
    expect(tr.content).toContain(spillPath)
  })
})
