/**
 * A3-S3 hellgate — activation.
 *
 * TWO modes now: the authority is the session's books, so the knob is a kill
 * switch, not a rollout dial. `shadow` survives only as a deprecated alias
 * (its legacy comparison target is gone), and the resolution is PURE — it
 * RETURNS any warning for the composition root to print once per session,
 * because a module-global latch would let the first resolver eat every later
 * session's notice.
 *
 * `off` must be genuinely inert — an absent slot makes `emitUsage`'s
 * accounting sink a no-op and the surfaces say "accounting off".
 */
import { describe, expect, test } from "bun:test"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import { type AssemblerEnv, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { StreamEvent } from "@/llm"
import { createUsageAccounting, resolveUsageAccounting } from "@/observability/usage-accounting"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

describe("A3-S3 — the knob resolves ONCE, to two modes plus a spoken correction", () => {
  test("on/off resolve silently; unset is the silent default (on)", () => {
    expect(resolveUsageAccounting({})).toEqual({ mode: "on" })
    expect(resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "on" })).toEqual({ mode: "on" })
    expect(resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "off" })).toEqual({ mode: "off" })
    expect(resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: " ON " })).toEqual({ mode: "on" })
  })

  test("shadow is a deprecated alias: on, WITH a warning for the root to print", () => {
    // Not a module-global latch: the resolution RETURNS the warning and each
    // composition root prints it once per session — module state would make
    // the first test to touch it eat every later session's notice.
    const res = resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })
    expect(res.mode).toBe("on")
    expect(res.warning).toContain("shadow")
    expect(res.warning).toContain("deprecated")
  })

  test("an unrecognized non-empty value fails safe to on, and says so", () => {
    // "off when you wanted on" loses the session's books; "on when you wanted
    // off" merely keeps them — so a typo lands on the default AND is named.
    const res = resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "shdaow" })
    expect(res.mode).toBe("on")
    expect(res.warning).toContain("shdaow")
  })

  test("resolution is pure: two calls, two equal values, no shared latch", () => {
    const a = resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })
    const b = resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })
    expect(a).toEqual(b)
    expect(b.warning).toBeDefined()
  })
})

describe("explicit off is inert through the shipped fan-out", () => {
  test("emitUsage with the kill switch thrown records nowhere and still emits", () => {
    const events: unknown[] = []
    const killed =
      resolveUsageAccounting({ QUANTA_USAGE_ACCOUNTING_V2: "off" }).mode === "on"
        ? createUsageAccounting()
        : undefined
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

/*
 * A3-S3 — the reconciliation receipt is DELETED, deliberately. Its whole job
 * was comparing the authority against the legacy feed, and the legacy feed no
 * longer exists to compare against; keeping the machinery would be evidence
 * theater. The invariant rail (cost-recorders-invariant-rail) now owns
 * cross-recorder agreement, against the recorders that actually remain.
 */

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

  test("the deprecated shadow alias still mints a REAL, recording authority", () => {
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

  test("explicit on mints one too", () => {
    expect(assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "on" }).usageAccounting).toBeDefined()
  })

  test("a typo lands on the default (a live authority), never half-way", () => {
    expect(assembleWith({ QUANTA_USAGE_ACCOUNTING_V2: "yes" }).usageAccounting).toBeDefined()
  })
})
