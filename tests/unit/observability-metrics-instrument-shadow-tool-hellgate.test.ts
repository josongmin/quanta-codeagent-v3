import { describe, expect, mock, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import { instrumentShadowOdb } from "@/observability/metrics/instrument-shadow"
import { instrumentTool, instrumentTools } from "@/observability/metrics/instrument-tool"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const safeCtx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

const fakeShadow = (overrides: Partial<ShadowOdb> = {}): ShadowOdb =>
  ({
    init: async () => ({ shadowDir: "/x", workspaceHash: "abc" }),
    registerHead: async () => "sha-1",
    diffSinceLast: async () => "",
    diffWorkspaceSinceLast: async () => "",
    rewindToLast: async () => {},
    rewindToVerified: async () => {},
    restorePartial: async () => {},
    markVerified: async () => {},
    listSnapshots: async () => [],
    cleanup: async () => 0,
    ...overrides,
  }) as ShadowOdb

const fakeTool = (overrides: Partial<Tool> = {}): Tool =>
  ({
    name: "fake_tool",
    description: "fake",
    inputSchema: { type: "object" } as never,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ok" } } as never
    },
    ...overrides,
  }) as Tool

describe("instrumentShadowOdb", () => {
  test("registerHead → checkpoint.total + duration_ms", async () => {
    const m = defaultMetricsRegistry()
    const o = instrumentShadowOdb(fakeShadow(), m)
    await o.registerHead("/ws")
    const names = m.snapshot().map((s) => s.name)
    expect(names).toContain("shadow.checkpoint.total")
    expect(names).toContain("shadow.checkpoint.duration_ms")
  })

  test("registerHead kind defaults to 'manual'; opts can override to 'auto'", async () => {
    const m1 = defaultMetricsRegistry()
    await instrumentShadowOdb(fakeShadow(), m1).registerHead("/ws")
    expect(m1.snapshot().find((s) => s.name === "shadow.checkpoint.total")?.labels.kind).toBe(
      "manual",
    )

    const m2 = defaultMetricsRegistry()
    await instrumentShadowOdb(fakeShadow(), m2, { defaultCheckpointKind: "auto" }).registerHead(
      "/ws",
    )
    expect(m2.snapshot().find((s) => s.name === "shadow.checkpoint.total")?.labels.kind).toBe(
      "auto",
    )
  })

  test("rewindToLast → rewind.total label target=last + duration_ms", async () => {
    const m = defaultMetricsRegistry()
    await instrumentShadowOdb(fakeShadow(), m).rewindToLast("/ws")
    const rt = m.snapshot().find((s) => s.name === "shadow.rewind.total")
    expect(rt?.labels.target).toBe("last")
    expect(m.snapshot().some((s) => s.name === "shadow.rewind.duration_ms")).toBe(true)
  })

  test("rewindToVerified → rewind.total label target=verified", async () => {
    const m = defaultMetricsRegistry()
    await instrumentShadowOdb(fakeShadow(), m).rewindToVerified("/ws")
    const rt = m.snapshot().find((s) => s.name === "shadow.rewind.total")
    expect(rt?.labels.target).toBe("verified")
  })

  test("diffSinceLast vs diffWorkspaceSinceLast → distinct diff.total kind labels", async () => {
    const m = defaultMetricsRegistry()
    const o = instrumentShadowOdb(fakeShadow(), m)
    await o.diffSinceLast("/ws")
    await o.diffWorkspaceSinceLast("/anchor", "/cmp")
    const kinds = m
      .snapshot()
      .filter((s) => s.name === "shadow.diff.total")
      .map((s) => s.labels.kind)
      .sort()
    expect(kinds).toEqual(["since-last", "workspace-since-last"])
  })

  test("restorePartial + markVerified counters", async () => {
    const m = defaultMetricsRegistry()
    const o = instrumentShadowOdb(fakeShadow(), m)
    await o.restorePartial("/ws", ["x.ts"])
    await o.markVerified("/ws")
    const names = m.snapshot().map((s) => s.name)
    expect(names).toContain("shadow.restore_partial.total")
    expect(names).toContain("shadow.markVerified.total")
  })

  test("init / listSnapshots / cleanup → no metrics (read-mostly, low value to track)", async () => {
    const m = defaultMetricsRegistry()
    const cleanupSpy = mock(async (_n: number) => 0)
    const o = instrumentShadowOdb(fakeShadow({ cleanup: cleanupSpy }), m)
    await o.init("/ws")
    await o.listSnapshots("/ws")
    await o.cleanup(1000)
    expect(cleanupSpy).toHaveBeenCalledTimes(1) // cleanup hook fired
    expect(m.snapshot().length).toBe(0) // and yet no metric was emitted
  })

  test("registerHead throws → counter still incremented (it counts ATTEMPTS) + duration still observed (finally)", async () => {
    const m = defaultMetricsRegistry()
    const o = instrumentShadowOdb(
      fakeShadow({
        registerHead: async () => {
          throw new Error("boom")
        },
      }),
      m,
    )
    let caught = false
    try {
      await o.registerHead("/ws")
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
    expect(m.snapshot().some((s) => s.name === "shadow.checkpoint.total")).toBe(true)
    expect(m.snapshot().some((s) => s.name === "shadow.checkpoint.duration_ms")).toBe(true)
  })

  test("metrics throw is swallowed", async () => {
    const throwingMetrics = {
      ...defaultMetricsRegistry(),
      increment: () => {
        throw new Error("broken")
      },
      observe: () => {
        throw new Error("broken")
      },
    } as never
    const o = instrumentShadowOdb(fakeShadow(), throwingMetrics)
    await expect(o.registerHead("/ws")).resolves.toBe("sha-1")
  })
})

describe("instrumentTool", () => {
  test("tool.call.total + duration_ms emitted on happy", async () => {
    const m = defaultMetricsRegistry()
    const t = instrumentTool(fakeTool(), m)
    for await (const _ of t.execute({}, safeCtx())) {
      /* drain */
    }
    const total = m.snapshot().find((s) => s.name === "tool.call.total")
    expect(total?.labels.tool).toBe("fake_tool")
    expect(total?.labels.ok).toBe("true")
    expect(m.snapshot().some((s) => s.name === "tool.call.duration_ms")).toBe(true)
  })

  test('ok:false result → ok="false" label', async () => {
    const m = defaultMetricsRegistry()
    const t = instrumentTool(
      fakeTool({
        async *execute() {
          yield { type: "result", result: { ok: false, output: "fail" } } as never
        },
      }) as Tool,
      m,
    )
    for await (const _ of t.execute({}, safeCtx())) {
      /* drain */
    }
    expect(m.snapshot().find((s) => s.name === "tool.call.total")?.labels.ok).toBe("false")
  })

  test('tool execute throws → ok="false" + still emit + rethrow', async () => {
    const m = defaultMetricsRegistry()
    const t = instrumentTool(
      fakeTool({
        // eslint-disable-next-line require-yield
        async *execute() {
          throw new Error("boom")
        },
      }) as Tool,
      m,
    )
    let caught = false
    try {
      for await (const _ of t.execute({}, safeCtx())) {
        /* drain */
      }
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
    expect(m.snapshot().find((s) => s.name === "tool.call.total")?.labels.ok).toBe("false")
  })

  test("toolLabel opt overrides tool.name", async () => {
    const m = defaultMetricsRegistry()
    const t = instrumentTool(fakeTool(), m, { toolLabel: "renamed" })
    for await (const _ of t.execute({}, safeCtx())) {
      /* drain */
    }
    expect(m.snapshot().find((s) => s.name === "tool.call.total")?.labels.tool).toBe("renamed")
  })

  test("instrumentTools wraps an array uniformly", async () => {
    const m = defaultMetricsRegistry()
    const [a, b] = instrumentTools(
      [fakeTool({ name: "alpha" }) as Tool, fakeTool({ name: "beta" }) as Tool],
      m,
    )
    for await (const _ of (a as Tool).execute({}, safeCtx())) {
      /* drain */
    }
    for await (const _ of (b as Tool).execute({}, safeCtx())) {
      /* drain */
    }
    const tools = m
      .snapshot()
      .filter((s) => s.name === "tool.call.total")
      .map((s) => s.labels.tool)
      .sort()
    expect(tools).toEqual(["alpha", "beta"])
  })

  test("name/desc/schema/predicates preserved verbatim", () => {
    const t = instrumentTool(fakeTool(), defaultMetricsRegistry())
    expect(t.name).toBe("fake_tool")
    expect(t.isReadOnly?.()).toBe(true)
    expect(t.isConcurrencySafe?.({} as never)).toBe(true)
  })
})
