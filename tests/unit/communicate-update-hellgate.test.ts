import { describe, expect, test } from "bun:test"
import {
  buildDefaultTools,
  type CommunicateUpdateInput,
  createCommunicateUpdateTool,
  type ProgressUpdateMirror,
  type ToolContext,
  ToolRegistry,
} from "@/tool"

/** Minimal ToolContext factory (mirrors update-working-state.test.ts). */
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...over,
})

/** Recording ProgressSink — captures every emitted mirror. */
const recordingSink = (): {
  emits: ProgressUpdateMirror[]
  emit: (u: ProgressUpdateMirror) => void
} => {
  const emits: ProgressUpdateMirror[] = []
  return { emits, emit: (u) => emits.push(u) }
}

const drain = async (
  tool: ReturnType<typeof createCommunicateUpdateTool>,
  input: CommunicateUpdateInput,
  c: ToolContext = ctx(),
): Promise<{ ok: boolean; output: string }> => {
  let result = { ok: false, output: "" }
  for await (const ev of tool.execute(input, c)) {
    if (ev.type === "result") result = ev.result
  }
  return result
}

describe("communicate_update — tool contract", () => {
  test("read-only, concurrency-safe, pre-approval HITL tier (never confirms)", () => {
    const tool = createCommunicateUpdateTool()
    const input: CommunicateUpdateInput = { current_step: "x" }
    expect(tool.name).toBe("communicate_update")
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe(input)).toBe(true)
    expect(tool.hitlTier?.(input)).toBe("pre-approval-ok")
  })

  test("emits exactly one mirror with ONLY current_step when terminal fields omitted", async () => {
    const sink = recordingSink()
    const tool = createCommunicateUpdateTool()
    const out = await drain(
      tool,
      { current_step: "reading the manifest" },
      ctx({ progressSink: sink }),
    )
    expect(out.ok).toBe(true)
    expect(out.output).toBe("progress reported")
    expect(sink.emits).toHaveLength(1)
    const m = sink.emits[0]
    if (m === undefined) throw new Error("expected one emit")
    expect(m).toEqual({ current_step: "reading the manifest" })
    // exactOptionalPropertyTypes: omitted optionals must be ABSENT, not undefined.
    expect("final_summary" in m).toBe(false)
    expect("completed_subtitle" in m).toBe(false)
  })

  test("emits the full triple when all fields provided", async () => {
    const sink = recordingSink()
    const tool = createCommunicateUpdateTool()
    await drain(
      tool,
      {
        current_step: "wiring the adapter",
        final_summary: "Added the structured progress channel end to end.",
        completed_subtitle: "Wired structured progress channel",
      },
      ctx({ progressSink: sink }),
    )
    expect(sink.emits).toHaveLength(1)
    expect(sink.emits[0]).toEqual({
      current_step: "wiring the adapter",
      final_summary: "Added the structured progress channel end to end.",
      completed_subtitle: "Wired structured progress channel",
    })
  })
})

describe("communicate_update — malformed args (no-throw via registry)", () => {
  const reg = () => new ToolRegistry([createCommunicateUpdateTool()])

  test("empty current_step rejected", async () => {
    await expect(reg().run("communicate_update", { current_step: "" }, ctx())).rejects.toThrow()
  })

  test("over-cap current_step rejected (DoS cap)", async () => {
    await expect(
      reg().run("communicate_update", { current_step: "x".repeat(10_000) }, ctx()),
    ).rejects.toThrow(/current_step/i)
  })

  test("over-cap final_summary rejected", async () => {
    await expect(
      reg().run(
        "communicate_update",
        { current_step: "ok", final_summary: "y".repeat(10_000) },
        ctx(),
      ),
    ).rejects.toThrow(/final_summary/i)
  })

  test("over-cap completed_subtitle rejected", async () => {
    await expect(
      reg().run(
        "communicate_update",
        { current_step: "ok", completed_subtitle: "z".repeat(500) },
        ctx(),
      ),
    ).rejects.toThrow(/completed_subtitle/i)
  })

  test("missing current_step rejected (required field)", async () => {
    await expect(
      reg().run("communicate_update", { final_summary: "only summary" }, ctx()),
    ).rejects.toThrow()
  })

  test("a valid minimal call passes the registry parse + still emits", async () => {
    const sink = recordingSink()
    const registry = new ToolRegistry([createCommunicateUpdateTool()])
    const r = await registry.run(
      "communicate_update",
      { current_step: "ok" },
      ctx({ progressSink: sink }),
    )
    expect(r.ok).toBe(true)
    expect(sink.emits).toHaveLength(1)
  })
})

describe("communicate_update — render-only / no control authority", () => {
  test("execute yields ONLY a result (no control/loop events)", async () => {
    const sink = recordingSink()
    const tool = createCommunicateUpdateTool()
    const events: string[] = []
    for await (const ev of tool.execute({ current_step: "go" }, ctx({ progressSink: sink }))) {
      events.push(ev.type)
    }
    expect(events).toEqual(["result"])
  })

  test("does NOT touch FS / shell / git (no cwd-dependent behavior)", async () => {
    // The tool ignores cwd entirely — succeeds identically with a bogus path.
    const sink = recordingSink()
    const tool = createCommunicateUpdateTool()
    const out = await drain(
      tool,
      { current_step: "go" },
      ctx({ cwd: "/nonexistent/\0", progressSink: sink }),
    )
    expect(out.ok).toBe(true)
    expect(sink.emits).toHaveLength(1)
  })

  test("resolves immediately without awaiting any host promise (non-blocking)", async () => {
    // No requestUserInput / no decision channel is consulted; a context that
    // would DEADLOCK a blocking tool (no input port) resolves fine here.
    const sink = recordingSink()
    const tool = createCommunicateUpdateTool()
    const out = await drain(tool, { current_step: "still going" }, ctx({ progressSink: sink }))
    expect(out.ok).toBe(true)
  })
})

describe("communicate_update — default-OFF byte-identical", () => {
  test("absent sink ⇒ ok:true, emits nothing (best-effort observability)", async () => {
    const tool = createCommunicateUpdateTool()
    const out = await drain(tool, { current_step: "no sink here" }, ctx())
    expect(out.ok).toBe(true)
    expect(out.output).toBe("progress reported")
  })

  test("not registered when progressUpdate port absent (byte-identical menu)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("communicate_update")
  })

  test("registered when progressUpdate port present", () => {
    const names = buildDefaultTools({ progressUpdate: true }).map((t) => t.name)
    expect(names).toContain("communicate_update")
  })
})
