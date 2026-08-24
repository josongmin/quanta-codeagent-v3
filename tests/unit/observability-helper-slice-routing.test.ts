/**
 * Characterization tests for `withFullObservability`'s SLICE ROUTING — added
 * with the god-function split (43 → under cap) that replaced seven inline
 * wrap-or-passthrough ternaries with one `wrapSlice` helper.
 *
 * Injection-verified gaps in the existing observability suites: changing the
 * prefix gate from truthiness to `!== undefined`, and dropping the
 * `skippedExpected` forwarding into the health snapshot, both left them GREEN.
 *
 * Rules pinned here:
 *   R1  Each bag key routes to ITS OWN prefix — a crossover renames metrics.
 *   R2  A FALSY prefix (absent OR empty string) means "keep the instrument's
 *       own default prefix" — the gate is truthiness, not definedness.
 *   R3  An absent slice is `undefined` out, with no instrument call.
 *   R4  `skippedExpected` silences ONLY the warning; the gauge still reports
 *       the truth, and the health snapshot still receives the expectation set.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  lastHealthSnapshotInFlight,
  type ObservabilityBag,
  withFullObservability,
} from "@/observability/metrics/observability-helper"
import type { MetricsRegistry } from "@/observability/metrics/port"

const ALL_KEYS = [
  "llmProvider",
  "scheduler",
  "shadowOdb",
  "planQueue",
  "budgetLedger",
  "lspClient",
  "tools",
] as const

/** Any unknown property read yields a no-op fn, so the instrument wrappers'
 *  `.bind(target)` passthroughs work against a partial fake. */
const duck = (overrides: Record<string, unknown>): never =>
  new Proxy(overrides, {
    get: (t, p) =>
      p in t
        ? (t as Record<string | symbol, unknown>)[p]
        : typeof p === "symbol"
          ? undefined
          : () => undefined,
    has: () => true,
  }) as never

const fullBag = (): ObservabilityBag => ({
  llmProvider: duck({
    providerId: "p",
    model: "m",
    async *stream() {
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  }),
  scheduler: duck({ fork: () => "h", await: async () => ({ status: "completed" }) }),
  shadowOdb: duck({ registerHead: async () => ({ id: "s" }) }),
  planQueue: duck({ drain: () => [] }),
  budgetLedger: duck({ record: () => ({ cost: 1, breaches: [] }) }),
  lspClient: duck({ requestFormatting: async () => [] }),
  tools: [
    {
      name: "t",
      async *execute() {
        yield { type: "result", result: { ok: true, output: "" } }
      },
    },
  ] as never,
})

/** Poke every wrapped slice so its instrumentation emits, then return the set
 *  of metric names that reached the registry. */
const exerciseAndCollectNames = async (
  out: Record<string, unknown>,
  m: ReturnType<typeof defaultMetricsRegistry>,
): Promise<string[]> => {
  const t = async (fn: () => unknown) => {
    try {
      await fn()
    } catch {
      /* partial fakes on purpose */
    }
  }
  const llm = out.llmProvider as { stream: (a: unknown) => AsyncIterable<unknown> } | undefined
  if (llm)
    await t(async () => {
      for await (const _ of llm.stream({})) void _
    })
  const s = out.scheduler as { fork: (a: unknown) => string } | undefined
  if (s) await t(() => s.fork({}))
  const odb = out.shadowOdb as { registerHead: () => unknown } | undefined
  if (odb) await t(() => odb.registerHead())
  const pq = out.planQueue as { drain: (a: unknown, b: unknown) => unknown } | undefined
  if (pq) await t(() => pq.drain("t", 1))
  const bl = out.budgetLedger as { record: (e: unknown) => unknown } | undefined
  if (bl) await t(() => bl.record({ model: "m" }))
  const lsp = out.lspClient as { requestFormatting: (f: string) => unknown } | undefined
  if (lsp) await t(() => lsp.requestFormatting("f.ts"))
  const tools = out.tools as
    | ReadonlyArray<{ execute: (...a: never[]) => AsyncIterable<unknown> }>
    | undefined
  for (const tool of tools ?? [])
    await t(async () => {
      for await (const _ of tool.execute({} as never, {} as never)) void _
    })
  return [...new Set(m.snapshot().map((x) => x.name))].sort()
}

describe("withFullObservability — per-slice prefix routing", () => {
  test("R1: every slice's metrics carry ITS OWN prefix (no crossover)", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(fullBag(), {
      metrics: m,
      prefixes: {
        llm: "Pllm",
        subagent: "Psub",
        shadow: "Pshadow",
        planQueue: "Ppq",
        budget: "Pbudget",
        lsp: "Plsp",
        tool: "Ptool",
      },
    })
    const names = await exerciseAndCollectNames(out as never, m)
    // Rule: each prefix must appear on ITS OWN slice's metric family. Checking
    // only "all seven prefixes appear" would pass a straight SWAP of two
    // prefixes, so bind each prefix to a slice-specific metric suffix.
    const boundTo: ReadonlyArray<readonly [string, string]> = [
      ["Pllm", "stream.total"],
      ["Psub", "fork.total"],
      ["Pshadow", "checkpoint.total"],
      ["Ppq", "drain.total"],
      ["Pbudget", "record.total"],
      ["Plsp", "request.total"],
      ["Ptool", "call.total"],
    ]
    for (const [prefix, suffix] of boundTo) expect(names).toContain(`${prefix}.${suffix}`)
    // And no metric kept an instrument DEFAULT prefix.
    for (const d of [
      "llm.provider.",
      "subagent.",
      "shadow.",
      "plan_queue.",
      "budget.",
      "lsp.",
      "tool.",
    ])
      expect(names.some((n) => n.startsWith(d))).toBe(false)
  })

  test("R2: an EMPTY-STRING prefix falls back to the instrument default (truthiness gate)", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(fullBag(), {
      metrics: m,
      // Empty strings must behave exactly like an ABSENT prefix. An
      // `!== undefined` gate would emit metrics named ".stream.total".
      prefixes: { llm: "", lsp: "", tool: "" },
    })
    const names = await exerciseAndCollectNames(out as never, m)
    expect(names.some((n) => n.startsWith("."))).toBe(false)
    expect(names.some((n) => n.startsWith("llm.provider."))).toBe(true)
    expect(names.some((n) => n.startsWith("lsp."))).toBe(true)
    expect(names.some((n) => n.startsWith("tool."))).toBe(true)
  })

  test("R2 paired control: a NON-empty prefix does override the default", async () => {
    const m = defaultMetricsRegistry()
    const out = withFullObservability(fullBag(), { metrics: m, prefixes: { llm: "X" } })
    const names = await exerciseAndCollectNames(out as never, m)
    expect(names.some((n) => n.startsWith("X."))).toBe(true)
    expect(names.some((n) => n.startsWith("llm.provider."))).toBe(false)
  })

  test("R3: an absent slice comes out undefined; a present one comes out WRAPPED", () => {
    const m = defaultMetricsRegistry()
    const bag = fullBag()
    for (const k of ALL_KEYS) {
      const onlyThis = { [k]: bag[k] } as unknown as ObservabilityBag
      const out = withFullObservability(onlyThis, { metrics: m }) as unknown as Record<
        string,
        unknown
      >
      for (const other of ALL_KEYS) {
        if (other === k) {
          expect(out[other]).toBeDefined()
          // Wrapped, not passed through untouched.
          expect(out[other]).not.toBe((bag as Record<string, unknown>)[other])
        } else {
          expect(out[other]).toBeUndefined()
        }
      }
    }
  })
})

describe("withFullObservability — skippedExpected is warning-scoped only", () => {
  test("R4: an expected skip silences the warning but still gauges 0", () => {
    const warns: string[] = []
    const gauges: Array<[string, number, string]> = []
    const base = defaultMetricsRegistry()
    const m = {
      ...base,
      increment: base.increment.bind(base),
      observe: base.observe.bind(base),
      snapshot: base.snapshot.bind(base),
      gauge: (n: string, v: number, l?: Record<string, string>) => {
        gauges.push([n, v, String(l?.slice)])
        return base.gauge(n, v, l)
      },
    } as MetricsRegistry
    withFullObservability(
      {},
      {
        metrics: m,
        warnOnSkipped: true,
        emitWiredGauge: true,
        skippedExpected: new Set(ALL_KEYS),
        warn: (msg) => warns.push(msg),
      },
    )
    expect(warns).toHaveLength(0)
    // The gauge is machine-facing and must NOT be silenced by the allowlist.
    expect(gauges).toHaveLength(ALL_KEYS.length)
    expect(gauges.every(([n, v]) => n === "observability.wired.total" && v === 0)).toBe(true)
  })

  test("R4 paired control: an UNexpected skip does warn, naming exactly those slices", () => {
    const warns: string[] = []
    withFullObservability(
      {},
      {
        metrics: defaultMetricsRegistry(),
        warnOnSkipped: true,
        skippedExpected: new Set(["scheduler", "shadowOdb"] as const),
        warn: (msg) => warns.push(msg),
      },
    )
    expect(warns).toHaveLength(1)
    const msg = warns[0] ?? ""
    expect(msg).toContain("5 slice(s) unwired")
    expect(msg).not.toContain("scheduler")
    expect(msg).not.toContain("shadowOdb")
    for (const k of ["llmProvider", "planQueue", "budgetLedger", "lspClient", "tools"])
      expect(msg).toContain(k)
  })

  test("R4: skippedExpected reaches the health snapshot (note='skipped intentionally')", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-route-"))
    const target = join(dir, "health.json")
    const llmOnly: ObservabilityBag = { llmProvider: fullBag().llmProvider as never }
    withFullObservability(llmOnly, {
      metrics: defaultMetricsRegistry(),
      healthSnapshotPath: target,
      skippedExpected: new Set(["tools"] as const),
    })
    await lastHealthSnapshotInFlight()
    const body = (await Bun.file(target).json()) as {
      slices: Array<{ slice: string; wired: boolean; note: string }>
    }
    const tools = body.slices.find((s) => s.slice === "tools")
    const lsp = body.slices.find((s) => s.slice === "lspClient")
    // An expected skip is distinguishable from a plain missing slice.
    expect(tools?.note).toBe("skipped intentionally")
    expect(lsp?.note).toBe("missing")
    expect(tools?.wired).toBe(false)
  })
})
