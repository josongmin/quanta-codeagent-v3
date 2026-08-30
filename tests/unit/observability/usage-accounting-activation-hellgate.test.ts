/**
 * MR-08 hellgate — activation, and the shadow receipt that justifies it.
 *
 * The authority changes where several surfaces get their numbers, so it ships
 * behind a three-position knob. The middle position is the one that earns its
 * keep: the failures in this area are not crashes, they are plausible wrong
 * totals, and the only way to see those before someone's status line depends
 * on them is to run both accountings side by side and report the delta.
 *
 * `off` must be genuinely inert — the whole default-OFF contract rests on an
 * absent slot making `emitUsage`'s accounting sink a no-op.
 */
import { describe, expect, test } from "bun:test"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { StreamEvent } from "@/llm"
import {
  createSessionUsageAccounting,
  createUsageAccounting,
  formatReconciliationReceipt,
  reconcileUsageAccounting,
  usageAccountingIsAuthoritative,
  usageAccountingMode,
} from "@/observability/usage-accounting"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

describe("the knob has three positions and fails safe", () => {
  test("recognized values map to their modes", () => {
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "on" })).toBe("on")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })).toBe("shadow")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "off" })).toBe("off")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: " ON " })).toBe("on") // trimmed, cased
  })

  test("unset or unrecognized lands on the DEFAULT (on), never half-way", () => {
    // The default is `on`, and a typo degrades to the default rather than
    // silently disabling the accounting: "off when you wanted on" loses the
    // session's books, "on when you wanted off" merely keeps them. Only the
    // exact words `off` / `shadow` divert.
    expect(usageAccountingMode({})).toBe("on")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "shdaow" })).toBe("on")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "1" })).toBe("on")
    expect(usageAccountingMode({ QUANTA_USAGE_ACCOUNTING_V2: "" })).toBe("on")
  })

  test("shadow records but is not authoritative; on is both", () => {
    expect(createSessionUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })).toBeDefined()
    expect(usageAccountingIsAuthoritative({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })).toBe(false)
    expect(createSessionUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "on" })).toBeDefined()
    expect(usageAccountingIsAuthoritative({ QUANTA_USAGE_ACCOUNTING_V2: "on" })).toBe(true)
  })

  test("the default constructs a live authority; only explicit off constructs nothing", () => {
    expect(createSessionUsageAccounting({})).toBeDefined()
    expect(usageAccountingIsAuthoritative({})).toBe(true)
    expect(createSessionUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "off" })).toBeUndefined()
    expect(usageAccountingIsAuthoritative({ QUANTA_USAGE_ACCOUNTING_V2: "off" })).toBe(false)
  })
})

describe("explicit off is inert through the shipped fan-out", () => {
  test("emitUsage with the kill switch thrown records nowhere and still emits", () => {
    const events: unknown[] = []
    const killed = createSessionUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "off" })
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: (e: unknown) => void events.push(e) },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "s",
      ...(killed !== undefined ? { usageAccounting: killed } : {}),
    } as unknown as AgentConfig
    expect(config.usageAccounting).toBeUndefined()
    emitUsage(
      config,
      { type: "usage", model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 0 } as Extract<
        StreamEvent,
        { type: "usage" }
      >,
      undefined,
      undefined,
      undefined,
    )
    expect(events).toHaveLength(1) // the surface event still goes out
  })
})

describe("the shadow receipt reports what it can and admits what it cannot", () => {
  const authorityWith = (calls: readonly { input: number; output: number }[]) => {
    const acct = createUsageAccounting()
    calls.forEach((c, i) => {
      acct.record({
        callId: `c${i}`,
        at: 1_700_000_000_000,
        usage: {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          freshInputTokens: c.input,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: c.output,
        },
        cost: {
          totalUsd: (c.input * 3) / 1_000_000,
          freshInputUsd: (c.input * 3) / 1_000_000,
          cacheReadUsd: 0,
          cacheWriteUsd: 0,
          outputUsd: 0,
          pricingKnown: true,
          pricingModel: "claude-sonnet-4-6",
          pricingVersion: "test",
        },
        provenance: { sessionId: "s", agentId: "root", agentKind: "root", depth: 0 },
      })
    })
    return acct.snapshot()
  }

  test("agreement is reported with the call count that backs it", () => {
    const snap = authorityWith([{ input: 1_000_000, output: 0 }])
    const receipt = reconcileUsageAccounting(snap, {
      totalUsd: 3,
      promptTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(receipt.agrees).toBe(true)
    expect(receipt.calls).toBe(1)
    expect(formatReconciliationReceipt(receipt)).toContain("agrees across 1 calls")
  })

  test("prompt tokens are compared only when the caller can express them neutrally", () => {
    // FALSE-ALARM REGRESSION. The CLI's legacy input count is
    // `gen_ai.usage.input_tokens`, which is provider-shaped: OpenAI's already
    // contains the cached portion, Anthropic's does not. Comparing it to the
    // authority's provider-neutral prompt total made the receipt shout
    // DIVERGES on Anthropic sessions where the two feeds agreed perfectly —
    // measured, 1.4M vs 1.0M on a cache-heavy turn with no subagent. A receipt
    // that fires on healthy sessions teaches the operator to ignore it.
    const snap = authorityWith([{ input: 1_000_000, output: 0 }])
    const omitted = reconcileUsageAccounting(snap, { totalUsd: 3, outputTokens: 0 })
    expect(omitted.agrees).toBe(true)
    // …and a caller that CAN supply a neutral number still gets it checked.
    const supplied = reconcileUsageAccounting(snap, {
      totalUsd: 3,
      outputTokens: 0,
      promptTokens: 999_999,
    })
    expect(supplied.agrees).toBe(false)
  })

  test("a legacy feed that missed a subagent shows up as a token AND dollar delta", () => {
    // The exact production failure: the legacy counter feed saw the root turn
    // and not the child's, so it is short by the child on both axes.
    const snap = authorityWith([
      { input: 100_000, output: 0 },
      { input: 500_000, output: 0 },
    ])
    const receipt = reconcileUsageAccounting(snap, {
      totalUsd: 0.3,
      promptTokens: 100_000,
      outputTokens: 0,
    })
    expect(receipt.agrees).toBe(false)
    expect(receipt.deltas.map((d) => d.field).sort()).toEqual(["promptTokens", "totalUsd"])
    expect(receipt.deltas.find((d) => d.field === "promptTokens")?.delta).toBe(500_000)
    expect(formatReconciliationReceipt(receipt)).toContain("DIVERGES")
  })

  test("sub-cent float noise is not a disagreement", () => {
    // Comparing raw floats would bury the real deltas under rounding.
    const snap = authorityWith([{ input: 1_000_000, output: 0 }])
    const receipt = reconcileUsageAccounting(snap, {
      totalUsd: 3.000_04,
      promptTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(receipt.agrees).toBe(true)
  })

  test("a token count differing by ONE is a disagreement", () => {
    // Tokens are integers, and a token delta means the two feeds saw different
    // CALLS — the failure that matters — not a rounding difference.
    const snap = authorityWith([{ input: 1_000_000, output: 0 }])
    const receipt = reconcileUsageAccounting(snap, {
      totalUsd: 3,
      promptTokens: 999_999,
      outputTokens: 0,
    })
    expect(receipt.agrees).toBe(false)
  })

  test("a receipt over zero calls says so instead of claiming agreement", () => {
    // "agrees" across nothing is not evidence, and reading it as evidence is
    // exactly the optimistic judgement shadow mode exists to prevent.
    const receipt = reconcileUsageAccounting(createUsageAccounting().snapshot(), {
      totalUsd: 0,
      promptTokens: 0,
      outputTokens: 0,
    })
    expect(receipt.calls).toBe(0)
    expect(formatReconciliationReceipt(receipt)).toContain("nothing compared")
  })
})

describe("ANTI-THEATER: the knob reaches a live config through the real assembler", () => {
  // Driving `assembleAgentConfig` — the shipped composition root for the
  // headless / batch / SDK surfaces — rather than the helper, because a wire
  // that is correct in isolation and unregistered in the registry is exactly
  // the wired-but-inert failure this repo keeps finding.
  const assembleWith = (env: AssemblerEnv) =>
    assembleAgentConfig(
      { mode: "interactive", base: { cwd: "/tmp" } as unknown as RuntimeAgentConfigBase },
      env,
    )

  test("knob unset ⇒ a live authority on the config (default-ON)", () => {
    const cfg = assembleWith({})
    expect(cfg.usageAccounting).toBeDefined()
  })

  test("explicit off ⇒ slot UNSET (the kill switch really kills)", () => {
    expect(assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "off" }).usageAccounting).toBeUndefined()
  })

  test("shadow mints a REAL, recording authority on the config", () => {
    const cfg = assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })
    expect(cfg.usageAccounting).toBeDefined()
    // It actually records — not merely present.
    emitUsage(
      { ...cfg, stream: { emit: () => undefined } } as unknown as AgentConfig,
      {
        type: "usage",
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 0,
      } as Extract<StreamEvent, { type: "usage" }>,
      undefined,
      undefined,
      undefined,
    )
    expect(cfg.usageAccounting?.snapshot().totalUsd).toBeCloseTo(3, 9)
  })

  test("on mints one too — shadow and on differ in who READS it", () => {
    expect(assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "on" }).usageAccounting).toBeDefined()
  })

  test("a typo lands on the default (a live authority), never half-way", () => {
    expect(assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "yes" }).usageAccounting).toBeDefined()
  })
})
