/**
 * MR-00 RED RAIL — the CLI's cost surfaces must all report ONE number.
 *
 * MEASURED PREMISE (2026-08-30, HEAD 35adaf25). The cost panel — which backs
 * BOTH the status line and `/cost` — is not fed from usage events at all. It is
 * fed a DELTA of the OTel counters (`turn-sinks.ts:49-51` reads
 * `gen_ai.usage.*` out of `metrics.snapshot().counters`). Those counters are
 * written by `AgentRecorder.tokensUsed`, which runs off `config.metrics` — the
 * slot a subagent config does not inherit. So subagent spend is invisible to
 * the panel, to the status line, and to `/cost`, while the same spend IS
 * visible on the event stream. Every surface is individually self-consistent
 * and they disagree with each other, which is why the discrepancy reads as a
 * pricing bug rather than a coverage bug.
 *
 * A second, independent hole in the same feed: `tokensUsed(input, output,
 * cacheRead)` has no cache-WRITE parameter, and nothing ever increments
 * `gen_ai.usage.cache_creation_input_tokens` even though the vocabulary
 * defines it. Cache-write is therefore structurally unpriceable on the panel.
 *
 * REVERT/MUTATION POINTS (must re-RED after MR-03/MR-04):
 *   - stop inheriting the accounting slot into child configs ⇒ "every cost
 *     surface reports the same total" REDs.
 *   - re-point the panel at the OTel counter delta ⇒ same test REDs.
 */
import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { AgentRecorder } from "@/agent/metrics"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import { TurnWorkMetricsCollector } from "@/agent/work-metrics-collector"
import { createCostPanel } from "@/apps/cli/cost-panel"
import type { StreamEvent } from "@/llm"
import { Metrics } from "@/observability/metrics"
import { createUsageAccounting } from "@/observability/usage-accounting"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const MODEL = "gpt-5.4" // $2.50 / M input
const PARENT_INPUT = 100_000 // $0.25
const CHILD_INPUT = 500_000 // $1.25
const TRUE_TOTAL_USD = 1.5 // what the session actually costs

const round = (n: number) => Math.round(n * 1e6) / 1e6

const usage = (inputTokens: number): UsageEv =>
  ({ type: "usage", model: MODEL, inputTokens, outputTokens: 0 }) as UsageEv

/** One session: a root turn plus a subagent turn, driven through the shipped
 *  `emitUsage` fan-out, then read back from every surface that shows cost.
 *
 *  MR-04 — the panel now PROJECTS the session's accountant instead of folding
 *  the OTel counter delta, so the replicated fold below is gone from this path.
 *  It survives only in the root-only control, which still exercises the legacy
 *  feed until MR-07 deletes it. */
const runSession = () => {
  const metrics = new Metrics()
  const budgetLedger = defaultBudgetLedger()
  const collector = new TurnWorkMetricsCollector()
  const usageAccounting = createUsageAccounting()
  const panel = createCostPanel({
    model: MODEL,
    now: () => 1_700_000_000_000,
    accounting: usageAccounting,
  })
  const recorder = new AgentRecorder(metrics)

  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "sess-1",
    metrics,
    budgetLedger,
    usageAccounting,
  } as unknown as AgentConfig

  const child = buildChildConfig(config, { prompt: "x" } as never, process.cwd(), {
    agentId: "child-1",
    parentId: "root",
  } as never)

  // Root turn, then the subagent's turn. Each is emitted with the recorder /
  // collector that its OWN config would carry in the loop.
  emitUsage(config, usage(PARENT_INPUT), recorder, collector, undefined)
  emitUsage(
    child,
    usage(CHILD_INPUT),
    child.metrics ? new AgentRecorder(child.metrics) : undefined,
    undefined,
    undefined,
  )

  return { panel, budgetLedger, collector, metrics, usageAccounting }
}

describe("every CLI cost surface reports the same total", () => {
  test("every cost surface reports the same total", () => {
    const { panel, budgetLedger, collector } = runSession()

    // One diagnostic object so the failure names WHICH surfaces drifted and by
    // how much, instead of failing on the first mismatch and hiding the rest.
    const { usageAccounting } = runSession()
    // Every surface that reports a SESSION total, in one object, so a failure
    // names which one drifted and by how much instead of stopping at the first.
    const reported = {
      truth: TRUE_TOTAL_USD,
      authority: round(usageAccounting.snapshot().totalUsd),
      costPanel: round(panel.snapshot().totalCostUsd ?? 0),
      statusLine: round(panel.snapshot().totalCostUsd ?? 0), // same snapshot source
      ledger: round(budgetLedger.snapshot().totalCost),
    }
    expect(reported).toEqual({
      truth: TRUE_TOTAL_USD,
      authority: TRUE_TOTAL_USD,
      costPanel: TRUE_TOTAL_USD,
      statusLine: TRUE_TOTAL_USD,
      ledger: TRUE_TOTAL_USD,
    })

    /**
     * SCOPE CORRECTION. `TurnWorkMetricsCollector` is deliberately NOT in the
     * table above. It is a per-TURN artifact — the loop hands each turn its own
     * collector — so requiring it to equal a SESSION total was a category error
     * in the original rail, not a defect in the collector. A subagent's turn
     * has its own collector and its own metrics; folding the child's spend into
     * the parent's turn would misreport BOTH.
     *
     * What must hold is that its number is right FOR ITS SCOPE, and that no
     * surface presents a per-turn figure as a session total.
     */
    const rootTurnOnly = 0.25
    expect(round(collector.finalize(MODEL).estimatedCostUsd ?? 0)).toBe(rootTurnOnly)
    expect(rootTurnOnly).toBeLessThan(TRUE_TOTAL_USD) // the two scopes really differ here
  })

  test("the panel and the status line report the subagent's spend", () => {
    // Isolated from the surfaces still awaiting MR-05, so a regression in the
    // panel's projection shows up HERE as a fresh failure instead of hiding
    // inside a test that is red for an unrelated reason.
    const { panel, usageAccounting } = runSession()
    expect(round(usageAccounting.snapshot().totalUsd)).toBe(TRUE_TOTAL_USD)
    expect(round(panel.snapshot().totalCostUsd ?? 0)).toBe(TRUE_TOTAL_USD)
    // The panel's own per-model view comes from the same snapshot, so it sees
    // the child's tokens too — the counter feed it used to read never did.
    expect(panel.byModel().find((b) => b.model === MODEL)?.inputTokens).toBe(
      PARENT_INPUT + CHILD_INPUT,
    )
  })

  test("/cost renders the per-model rows and the agent split from the authority", () => {
    // Hell-audit findings, both wired-but-inert in my own work:
    //   1. `renderDetailed` read the LEGACY per-model map directly, which is
    //      empty in projected mode — so the "By model:" block silently never
    //      rendered, even though `byModel()` next door projected it fine. Two
    //      readers of the same numbers is the split this campaign is closing.
    //   2. The root/subagent breakdown was computed by the projection and
    //      displayed nowhere, which leaves the box unable to answer the exact
    //      question that started this: how much of the bill was the subagents?
    const { panel, usageAccounting } = runSession()
    const detailed = panel.renderDetailed()

    // The session ran one model, so no "By model:" block — that threshold is
    // unchanged. Add a second model and it must appear.
    expect(usageAccounting.snapshot().byModel.size).toBe(1)
    expect(detailed).not.toContain("By model:")

    // The subagent split IS present, because a subagent really spent money.
    expect(detailed).toContain("By agent:")
    expect(detailed).toContain("subagents:")
    expect(detailed).toContain("$1.25") // the child's share of the $1.50
    expect(detailed).toContain("$0.25") // the root's
  })

  test("a two-model session renders BOTH rows from the authority", () => {
    // The case that actually distinguishes the two feeds: in projected mode the
    // legacy per-model map is empty, so a reader that consults it renders no
    // rows at all while `byModel()` next door has them. A single-model session
    // cannot tell those apart — it renders no block either way.
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
    })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "sess-1",
      usageAccounting,
    } as unknown as AgentConfig
    emitUsage(config, usage(PARENT_INPUT), undefined, undefined, undefined)
    emitUsage(
      config,
      { ...usage(PARENT_INPUT), model: "claude-sonnet-4-6" } as UsageEv,
      undefined,
      undefined,
      undefined,
    )

    const detailed = panel.renderDetailed()
    expect(detailed).toContain("By model:")
    expect(detailed).toContain(MODEL)
    expect(detailed).toContain("claude-sonnet-4-6")
  })

  test("a root-only session's box gains no agent split", () => {
    // Rendered only when a subagent actually spent something, so an ordinary
    // session's `/cost` is unchanged.
    const metrics = new Metrics()
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
    })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "sess-1",
      metrics,
      usageAccounting,
    } as unknown as AgentConfig
    emitUsage(config, usage(PARENT_INPUT), new AgentRecorder(metrics), undefined, undefined)
    expect(panel.renderDetailed()).not.toContain("By agent:")
  })

  test("the RENDERED status line and /cost header show the projected totals", () => {
    // The hole this pins: `snapshot()` was projected but `render()` and
    // `renderDetailed()` read the raw legacy state — so with the authority ON,
    // the status line said "n/a · 0 in / 0 out" and the /cost header rows were
    // zeros while snapshot() reported the real total. Asserting snapshot()
    // alone let that ship; these assertions are on the STRINGS a user sees.
    const { panel } = runSession()
    panel.noteTurn()

    const line = panel.render()
    expect(line).toContain("$1.50")
    expect(line).not.toContain("n/a")
    expect(line).not.toContain("0 in")

    const detailed = panel.renderDetailed()
    expect(detailed).toContain("600,000 tok") // parent 100k + child 500k
    expect(detailed).toContain("$1.50")
  })

  test("A2: an unknown model is admitted as UNPRICED and the panel says incomplete", () => {
    // Runtime priceUsage gives unknown models NO fallback: totalUsd 0,
    // pricingKnown false. estimatedUsd stays 0, so a surface watching only
    // estimatedUsd misses every production unknown call — an unknown-only
    // session rendered as an exact "$0.00", which is a wrong number wearing
    // confidence. The books must carry an unpricedCalls count and the panel
    // must say "incomplete", never exact-zero.
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
    })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "sess-1",
      usageAccounting,
    } as unknown as AgentConfig
    // REAL producer, not a hand-built fixture: the whole point is that the
    // production unknown-model path is the one being made honest.
    emitUsage(
      config,
      { ...usage(1_000_000), model: "mystery-model-99" } as UsageEv,
      undefined,
      undefined,
      undefined,
    )

    const snap = usageAccounting.snapshot() as ReturnType<typeof usageAccounting.snapshot> & {
      unpricedCalls?: number
    }
    expect(snap.unpricedCalls).toBe(1)
    expect(snap.totalUsd).toBe(0)

    // Unknown-only session: the status line must not read as an exact $0.00 …
    expect(panel.render()).toContain("cost incomplete")
    expect(panel.render()).not.toContain("$0.0000")
    // … and /cost must name the count.
    expect(panel.renderDetailed()).toContain("1 unpriced")
  })

  test("A2 control: a fully-priced session shows NO incomplete marker", () => {
    const { panel } = runSession()
    expect(panel.render()).not.toContain("incomplete")
    expect(panel.renderDetailed()).not.toContain("unpriced")
  })

  test("A2 mixed: known spend + an unknown call shows the total AND the gap", () => {
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
    })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "sess-1",
      usageAccounting,
    } as unknown as AgentConfig
    emitUsage(config, usage(PARENT_INPUT), undefined, undefined, undefined) // $0.25 known
    emitUsage(
      config,
      { ...usage(1_000_000), model: "mystery-model-99" } as UsageEv,
      undefined,
      undefined,
      undefined,
    )
    const line = panel.render()
    expect(line).toContain("$0.25") // the known part is still shown …
    expect(line).toContain("unpriced") // … and the gap is named, not absorbed
  })

  test("a hostile model id cannot inject terminal escapes into /cost", () => {
    // The model on a usage event is PROVIDER-supplied text. `state.model` was
    // sanitized at construction, but the per-model bucket keys never were — and
    // those keys are what the "By model:" rows print. Measured before the fix:
    // an id carrying an ANSI escape reached the rendered box verbatim, inside
    // the panel's own border. Projected mode made that block render where it
    // previously never did, which is what turned a latent hole into a live one.
    const ESC = String.fromCharCode(27)
    const hostile = `evil${ESC}[31mMODEL`
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
    })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "sess-1",
      usageAccounting,
    } as unknown as AgentConfig
    emitUsage(config, usage(PARENT_INPUT), undefined, undefined, undefined)
    emitUsage(
      config,
      { ...usage(PARENT_INPUT), model: hostile } as UsageEv,
      undefined,
      undefined,
      undefined,
    )

    // The accounting keeps the id verbatim — the books must stay exact …
    expect(usageAccounting.snapshot().byModel.has(hostile)).toBe(true)
    // … and every RENDER path strips it.
    expect(panel.renderDetailed()).not.toContain(ESC)
    expect(panel.byModel().some((b) => b.model.includes(ESC))).toBe(false)
    // The row is still there, just declawed — not silently dropped.
    expect(panel.renderDetailed()).toContain("evil")

    // (A3 removed the legacy per-model map; the projection above is now the
    // only feed, so this single arm IS the whole render boundary.)
  })
})
