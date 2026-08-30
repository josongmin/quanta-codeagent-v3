/**
 * MR-08 wiring proof — the CLI composition root, not just the assembler.
 *
 * The activation knob has TWO roots: `assembleAgentConfig` serves the headless
 * / batch / SDK surfaces, and the CLI session bootstraps its own. Proving one
 * says nothing about the other, and the CLI is the surface a person actually
 * watches — the status line and `/cost` are the whole reason this work exists.
 *
 * So this drives the shipped `bootstrapSession` and asserts the authority
 * reaches the result, from which the runtime overlay sets it on `AgentConfig`
 * (so `emitUsage` records into it) and the panel factory projects it. A single
 * instance is the load-bearing part: two would put the recording and the
 * rendering on different objects, which is the original bug wearing new
 * clothes.
 */
import { describe, expect, test } from "bun:test"
import { bootstrapSession, isSessionBootstrapError } from "@/host/bootstrap"
import {
  makeFakeBootstrapDeps as makeFakeDeps,
  makeFakeBootstrapRuntime as makeRuntime,
} from "../../_support/bootstrap-fake-deps"

const bootWith = async (env: Record<string, string | undefined>) => {
  const result = await bootstrapSession(makeFakeDeps(), makeRuntime({ env }), {})
  if (isSessionBootstrapError(result)) throw new Error("bootstrap failed in fixture")
  return result
}

describe("the CLI composition root honors the activation knob", () => {
  test("knob unset ⇒ the CLI session gets a live authority (default-ON)", async () => {
    expect((await bootWith({})).usageAccounting).toBeDefined()
  })

  test("explicit off ⇒ no authority (the kill switch)", async () => {
    expect((await bootWith({ QUANTA_USAGE_ACCOUNTING_V2: "off" })).usageAccounting).toBeUndefined()
  })

  test("shadow ⇒ a real, recording authority", async () => {
    const boot = await bootWith({ QUANTA_USAGE_ACCOUNTING_V2: "shadow" })
    expect(boot.usageAccounting).toBeDefined()
    // Present is not enough — it has to actually record.
    boot.usageAccounting?.record({
      callId: "c1",
      at: 1_700_000_000_000,
      usage: {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        freshInputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      cost: {
        totalUsd: 3,
        freshInputUsd: 3,
        cacheReadUsd: 0,
        cacheWriteUsd: 0,
        outputUsd: 0,
        pricingKnown: true,
        pricingModel: "claude-sonnet-4-6",
        pricingVersion: "test",
      },
      provenance: { sessionId: "s", agentId: "root", agentKind: "root", depth: 0 },
    })
    expect(boot.usageAccounting?.snapshot().totalUsd).toBeCloseTo(3, 9)
  })

  test("on ⇒ an authority too (shadow and on differ in who reads it)", async () => {
    expect((await bootWith({ QUANTA_USAGE_ACCOUNTING_V2: "on" })).usageAccounting).toBeDefined()
  })

  test("a typo lands on the default, not on a silent disable", async () => {
    expect((await bootWith({ QUANTA_USAGE_ACCOUNTING_V2: "shdaow" })).usageAccounting).toBeDefined()
  })
})
