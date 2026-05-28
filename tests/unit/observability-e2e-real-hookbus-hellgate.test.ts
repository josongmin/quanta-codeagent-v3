/**
 * Audit R1-C / R2 (F7) — end-to-end observability with the REAL HookBus.
 *
 * Existing live-wire tests use a `RecordingHookBus` fake to verify the wire's
 * subscribe + dispatch contract. This test closes the remaining e2e gap: the
 * production `HookBus` class (`src/agent/hooks.ts`) participates in the same
 * chain — wire subscribes on it, an emit on it drives `RunLedger.start`, and
 * the `post_compact` event (ADR-0409 wire, R2-F1) reaches a subscriber.
 *
 * Scope: NOT the full loop (mocks/full session are out of scope here). The
 * test exercises the precise composition the production composition root
 * builds — a `HookBus` instance threaded both INTO the wire and OUT to the
 * AgentConfig — so a regression in the wire-or-bus identity surfaces here.
 */

import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import { resolveObservabilityWire } from "@/apps/agent"
import type { RecoveryProvenance } from "@/agent/recovery-reason"

const ENV_KEY = "QUANTA_OBSERVABILITY"
const onEnv = { [ENV_KEY]: "on" } as NodeJS.ProcessEnv

const bashBackgroundEvent = (shellId: string) => ({
  name: "bash",
  input: {},
  output: `[bash background] shellId=${shellId} status=running\nstdout so far:\n`,
  ok: true,
})

describe("ADR-0415 + ADR-0401 + ADR-0409 — e2e with the real HookBus (F7)", () => {
  test("real HookBus + wireObservability ⇒ post_tool_use drives runLedger.start", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    expect(handle.runLedger).toBeDefined()
    expect(handle.runLedger?.get("sh-e2e-1")).toBeNull()
    // Emit via the SAME production HookBus the wire subscribed to. The
    // attribution subscriber must transmute the banner into a ledger.start.
    await bus.emit({ type: "post_tool_use", ...bashBackgroundEvent("sh-e2e-1") })
    expect(handle.runLedger?.get("sh-e2e-1")?.status).toBe("running")
    expect(handle.runLedger?.get("sh-e2e-1")?.kind).toBe("shell")
    handle.detach()
  })

  test("real HookBus ⇒ post_compact event (ADR-0409 wire, R2-F1) reaches a subscriber", async () => {
    const bus = new HookBus()
    type Observed = { threadId: string; provenance: RecoveryProvenance }
    const recorded: Observed[] = []
    // Register a subscriber on `post_compact`. The wire doesn't own this
    // event — a host that opts into compaction visibility installs its own
    // handler. We just prove the event REACHES handlers when emitted, which
    // is the contract the ADR-0409 loop.ts wire depends on (R2-F1 fix).
    bus.on("post_compact", (e) => {
      if (e.type === "post_compact") {
        recorded.push({ threadId: e.threadId, provenance: e.provenance })
      }
      return {}
    })
    const provenance: RecoveryProvenance = {
      reason: "token_budget_exceeded",
      tokensBefore: 100_000,
      tokensAfter: 25_000,
      turnsDropped: 12,
      turnsKept: 6,
      compactedAt: 1_700_000_000_000,
    }
    await bus.emit({ type: "post_compact", threadId: "t-e2e", provenance })
    expect(recorded.length).toBe(1)
    const first = recorded[0]
    expect(first?.threadId).toBe("t-e2e")
    expect(first?.provenance.reason).toBe("token_budget_exceeded")
    expect(first?.provenance.tokensBefore).toBe(100_000)
  })

  test("gate OFF (env unset) ⇒ real HookBus still works for the subscriber, but ports inert", () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire({} as NodeJS.ProcessEnv, { hookBus: bus })
    expect(handle.runLedger).toBeUndefined()
    expect(handle.objective).toBeUndefined()
    // No subscribers ⇒ emit must not throw (HookBus fast-paths zero handlers).
    expect(() => bus.emit({ type: "post_tool_use", ...bashBackgroundEvent("sh-x") })).not.toThrow()
    handle.detach()
  })
})
