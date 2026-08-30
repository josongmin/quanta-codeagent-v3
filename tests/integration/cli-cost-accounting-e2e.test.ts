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
 * WIRING GAP THIS TEST CANNOT CLOSE, stated plainly: `foldCostPanelDelta` is
 * private to turn-sinks.ts and the only exported seam, `composeTurnSinks`,
 * needs a whole `SessionSetupResult`. The fold below is therefore REPLICATED
 * from turn-sinks.ts:49-66 rather than driven. MR-04 removes the replication
 * by routing the panel off the accounting snapshot instead of off counters —
 * at which point this helper is deleted, not re-pointed.
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
import { type CostPanel, createCostPanel } from "@/apps/cli/cost-panel"
import type { StreamEvent } from "@/llm"
import { Metrics } from "@/observability/metrics"
import { createUsageAccounting } from "@/observability/usage-accounting"
import { GEN_AI_ATTRS } from "@/observability/vocabulary"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const MODEL = "gpt-5.4" // $2.50 / M input
const PARENT_INPUT = 100_000 // $0.25
const CHILD_INPUT = 500_000 // $1.25
const TRUE_TOTAL_USD = 1.5 // what the session actually costs

const round = (n: number) => Math.round(n * 1e6) / 1e6

const usage = (inputTokens: number): UsageEv =>
  ({ type: "usage", model: MODEL, inputTokens, outputTokens: 0 }) as UsageEv

/** REPLICATED from turn-sinks.ts:49-66 — see the wiring-gap note above. */
const foldPanelFromCounters = (
  panel: Pick<CostPanel, "incrementTurn">,
  counters: Record<string, number>,
  prev: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
  // The model the turn actually ran on. Hardcoding it here priced an Anthropic
  // turn at gpt rates and produced a $1.60-vs-$3.12 "divergence" that was this
  // fixture's, not production's — the shipped fold reads it off the usage event.
  model: string = MODEL,
): void => {
  const curIn = counters[GEN_AI_ATTRS.usage.inputTokens] ?? 0
  const curOut = counters[GEN_AI_ATTRS.usage.outputTokens] ?? 0
  const curCache = counters[GEN_AI_ATTRS.usage.cacheReadInputTokens] ?? 0
  panel.incrementTurn({
    inputTokens: Math.max(0, curIn - prev.inputTokens),
    outputTokens: Math.max(0, curOut - prev.outputTokens),
    cacheReadTokens: Math.max(0, curCache - prev.cacheReadTokens),
    model,
  })
  prev.inputTokens = curIn
  prev.outputTokens = curOut
  prev.cacheReadTokens = curCache
}

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

  test("SHADOW: the panel renders the legacy feed and prints a reconciliation receipt", () => {
    // Hell-audit finding: `reconcileUsageAccounting` had ZERO production
    // callers, so shadow mode recorded into an authority nobody read and
    // produced no evidence — the entire reason the middle position exists was
    // unreachable. This drives the mode end to end.
    const metrics = new Metrics()
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
      accountingAuthoritative: false, // shadow
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
    const child = buildChildConfig(config, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)

    emitUsage(config, usage(PARENT_INPUT), new AgentRecorder(metrics), undefined, undefined)
    emitUsage(child, usage(CHILD_INPUT), undefined, undefined, undefined)
    const prev = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    foldPanelFromCounters(panel, metrics.snapshot().counters, prev)

    // The panel still shows the LEGACY number — shadow changes nothing a user
    // was already looking at.
    expect(round(panel.snapshot().totalCostUsd ?? 0)).toBe(0.25)
    // …and the receipt names the divergence the authority can see.
    const detailed = panel.renderDetailed()
    expect(detailed).toContain("usage-accounting shadow")
    expect(detailed).toContain("DIVERGES")
  })

  test("SHADOW does not cry wolf on an Anthropic session that used the cache", () => {
    // The false alarm this closes: the legacy input counter is provider-shaped,
    // so an Anthropic turn with cache reads made the receipt report a
    // divergence the feeds did not actually have. Both providers must read
    // "agrees" on a healthy session, or the receipt is noise.
    for (const model of ["gpt-5.4", "claude-sonnet-4-6"]) {
      const metrics = new Metrics()
      const usageAccounting = createUsageAccounting()
      const panel = createCostPanel({
        model,
        now: () => 1_700_000_000_000,
        accounting: usageAccounting,
        accountingAuthoritative: false,
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
      emitUsage(
        config,
        {
          type: "usage",
          model,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 400_000,
        } as UsageEv,
        new AgentRecorder(metrics),
        undefined,
        undefined,
      )
      const prev = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      foldPanelFromCounters(panel, metrics.snapshot().counters, prev, model)
      expect(panel.renderDetailed()).toContain("agrees across 1 calls")
    }
  })

  test("SHADOW on an agreeing session reports agreement, with a call count", () => {
    // Paired control: no subagent, so the two feeds see the same calls.
    const metrics = new Metrics()
    const usageAccounting = createUsageAccounting()
    const panel = createCostPanel({
      model: MODEL,
      now: () => 1_700_000_000_000,
      accounting: usageAccounting,
      accountingAuthoritative: false,
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
    const prev = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    foldPanelFromCounters(panel, metrics.snapshot().counters, prev)

    const detailed = panel.renderDetailed()
    expect(detailed).toContain("agrees across 1 calls")
    expect(detailed).not.toContain("DIVERGES")
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

    // The LEGACY feed renders per-model rows too, from its own map, and needs
    // the same defense — the fix is at the render boundary, so both arms must
    // be exercised or one of them can regress unnoticed.
    const legacy = createCostPanel({ model: MODEL, now: () => 1_700_000_000_000 })
    legacy.incrementTurn({ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, model: MODEL })
    legacy.incrementTurn({
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      model: hostile,
    })
    expect(legacy.renderDetailed()).not.toContain(ESC)
    expect(legacy.byModel().some((b) => b.model.includes(ESC))).toBe(false)
    expect(legacy.renderDetailed()).toContain("evil")
  })

  test("the panel and the ledger agree on a turn that used the prompt cache", () => {
    // Root-only, so subagent coverage is NOT the variable here — this isolates
    // the SECOND way the surfaces drift apart: the panel prices cache reads via
    // `costUsd` (provider-aware, carves cached tokens out of input for OpenAI)
    // while the ledger adds them on top. Same turn, same tokens, two totals —
    // this is what a user sees as "the status line and /cost disagree".
    const metrics = new Metrics()
    const budgetLedger = defaultBudgetLedger()
    const panel = createCostPanel({ model: MODEL, now: () => 1_700_000_000_000 })
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
    } as unknown as AgentConfig

    const cached = { ...usage(1_000_000), cacheReadTokens: 400_000 } as UsageEv
    emitUsage(config, cached, new AgentRecorder(metrics), undefined, undefined)
    const prev = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    foldPanelFromCounters(panel, metrics.snapshot().counters, prev)

    // REDs: panel $1.60 vs ledger $2.60 on one turn's single usage event.
    expect(round(panel.snapshot().totalCostUsd ?? 0)).toBe(round(budgetLedger.snapshot().totalCost))
  })

  // PAIRED CONTROL — a session with NO subagent already agrees end to end.
  // Green today and must stay green: it isolates the RED to child coverage
  // rather than to pricing, the fold, or this fixture.
  test("PAIRED CONTROL: a root-only session already agrees (must stay green)", () => {
    const metrics = new Metrics()
    const budgetLedger = defaultBudgetLedger()
    const collector = new TurnWorkMetricsCollector()
    const panel = createCostPanel({ model: MODEL, now: () => 1_700_000_000_000 })
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
    } as unknown as AgentConfig

    emitUsage(config, usage(PARENT_INPUT), new AgentRecorder(metrics), collector, undefined)
    const prev = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    foldPanelFromCounters(panel, metrics.snapshot().counters, prev)

    const rootOnly = 0.25
    expect(round(panel.snapshot().totalCostUsd ?? 0)).toBe(rootOnly)
    expect(round(budgetLedger.snapshot().totalCost)).toBe(rootOnly)
    expect(round(collector.finalize(MODEL).estimatedCostUsd ?? 0)).toBe(rootOnly)
  })
})
