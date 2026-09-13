import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runAgent } from "@/agent"
import { __resetRuntimeConfig } from "@/shared"
import { type AgentEvent, JsonlRecorder, TeeStream } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"
import type { SpillDirRefusal } from "@/tool/output-spill"
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
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QUANTA_TOOL_OUTPUT_MAX
    else process.env.QUANTA_TOOL_OUTPUT_MAX = prevEnv
    __resetRuntimeConfig()
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

    // R5-A wiring: the spill path must flow all the way through the stream
    // (registry → result.evidence.fullLogPath → dispatch.evidenceOf →
    // DispatchResult.fullLogPath → loop emit "tool_result"). Confirm the
    // trajectory event carries the same path the marker advertised.
    const toolResultEvents = stream.events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    const trEv = toolResultEvents[0]
    if (trEv?.type !== "tool_result") throw new Error("expected tool_result event")
    expect(trEv.fullLogPath).toBe(spillPath)
  })
})

/**
 * NW-2 wiring — a spill outcome reaches the stream and the JSONL trajectory as a
 * FIELD. `ToolRegistry.run` sets `evidence.fullLogPath` for a persisted spill and
 * `evidence.spillRefusal` for a refused one; the dispatch seam (`evidenceOf`)
 * flattens both onto `DispatchResult`, the loop's `tool_result` emit spreads
 * them, and the JSONL recorder's `toolResultData` writes them. Each arm drives
 * the real `runAgent` with a real `ToolRegistry`, a `RecordingStream` and a real
 * `JsonlRecorder` behind a `TeeStream`, then reads the JSONL file back.
 *
 * The three arms pin the exact key set of the `tool_result` event and of the
 * JSONL `data` (only `preview`/`stdoutTail` text and the `durationMs` number are
 * set aside): a symlinked `.quanta/tool-output` gives `spillRefusal` and no
 * `fullLogPath`; a real directory gives `fullLogPath` and no `spillRefusal`;
 * sub-budget output in the same symlinked repo gives neither.
 */

const outputTool = (name: string, output: string): Tool => ({
  name,
  description: "Test tool that emits a fixed output.",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    yield { type: "result", result: { ok: true, output } }
  },
})

describe("NW-2 — the spill outcome reaches the tool_result event and the JSONL line as a field", () => {
  let root: string
  let repo: string
  let outside: string
  let prevEnv: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-spill-evidence-"))
    repo = join(root, "repo")
    outside = join(root, "outside")
    mkdirSync(repo)
    mkdirSync(outside)
    prevEnv = process.env.QUANTA_TOOL_OUTPUT_MAX
    process.env.QUANTA_TOOL_OUTPUT_MAX = "500"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QUANTA_TOOL_OUTPUT_MAX
    else process.env.QUANTA_TOOL_OUTPUT_MAX = prevEnv
    __resetRuntimeConfig()
    rmSync(root, { recursive: true, force: true })
  })

  const linkToolOutputOutside = (): void => {
    mkdirSync(join(repo, ".quanta"))
    symlinkSync("../../outside", join(repo, ".quanta", "tool-output"))
  }

  /** One tool call through `runAgent`; returns the single `tool_result` event
   *  and the `data` of the single `tool_result` JSONL line read back from disk. */
  const drive = async (
    tool: Tool,
  ): Promise<{
    event: Extract<AgentEvent, { type: "tool_result" }>
    data: Record<string, unknown>
  }> => {
    const recording = new RecordingStream()
    const runId = "run-spill-evidence"
    const jsonlPath = join(root, "trajectory", runId, "session.jsonl")
    const recorder = new JsonlRecorder(jsonlPath, { ctx: { runId }, now: () => 1_700_000_000_000 })
    const llm = new ScriptedLLM([ev(toolUse("t1", tool.name, {})), ev(text("done"))])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new TeeStream([recording, recorder]),
          registry: new ToolRegistry([tool]),
          cwd: repo,
          maxTurns: 3,
        }),
      ),
      15_000,
      "tool-spill-evidence",
    )
    recorder.close()
    expect(out.reason).toBe("completed")
    const events = recording.events.filter((e) => e.type === "tool_result")
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.type !== "tool_result") throw new Error("expected a tool_result event")
    const lines = readFileSync(jsonlPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> })
      .filter((l) => l.kind === "tool_result")
    expect(lines).toHaveLength(1)
    return { event, data: (lines[0] as { data: Record<string, unknown> }).data }
  }

  /** The event and JSONL data minus the free-text tail and the timing number. */
  const shapeOf = (r: Awaited<ReturnType<typeof drive>>) => {
    const { preview, durationMs, ...event } = r.event
    const { stdoutTail, durationMs: lineDurationMs, ...data } = r.data
    expect(typeof preview).toBe("string")
    expect(stdoutTail).toBe(preview)
    expect(typeof durationMs).toBe("number")
    expect(lineDurationMs).toBe(durationMs)
    return { event, data }
  }

  test("symlinked `.quanta/tool-output`: spillRefusal on the event and the JSONL line, no fullLogPath", async () => {
    linkToolOutputOutside()
    const refusal: SpillDirRefusal = { kind: "symlink", path: join(repo, ".quanta", "tool-output") }
    const { event, data } = shapeOf(await drive(outputTool("big_output", GIANT)))
    expect(event).toStrictEqual({
      type: "tool_result",
      id: "t1",
      name: "big_output",
      ok: true,
      spillRefusal: refusal,
    })
    expect(data).toStrictEqual({ name: "big_output", ok: true, spillRefusal: refusal })
    // The refusal is real: nothing was written through the link.
    expect(readdirSync(outside)).toEqual([])
  })

  test("paired control, real `.quanta/tool-output`: fullLogPath on both, no spillRefusal", async () => {
    const { event, data } = shapeOf(await drive(outputTool("big_output", GIANT)))
    const spillDir = join(repo, ".quanta", "tool-output")
    const spilled = readdirSync(spillDir)
    expect(spilled).toHaveLength(1)
    const fullLogPath = join(spillDir, spilled[0] as string)
    expect(event).toStrictEqual({
      type: "tool_result",
      id: "t1",
      name: "big_output",
      ok: true,
      fullLogPath,
    })
    expect(data).toStrictEqual({ name: "big_output", ok: true, fullLogPath })
    expect(readFileSync(fullLogPath, "utf8")).toBe(GIANT)
  })

  test("paired control, sub-budget output in the symlinked repo: neither field", async () => {
    linkToolOutputOutside()
    const { event, data } = shapeOf(await drive(outputTool("small_output", "tiny")))
    expect(event).toStrictEqual({ type: "tool_result", id: "t1", name: "small_output", ok: true })
    expect(data).toStrictEqual({ name: "small_output", ok: true })
    expect(readdirSync(outside)).toEqual([])
  })
})
