/**
 * WS-G item 12 (UUX-1-17) — the scriptable statusline's `modelId` was FROZEN
 * at boot: `session-setup.ts` closed over `boot.model`, so a mid-session
 * `/model` change kept painting the old id on every tick.
 *
 * Fix: the view thunk is extracted (`buildSessionStatusView`) and reads the
 * model through a LIVE source the composition root can re-point at the
 * `/model` adapter (`liveModelSource.source = () => adapter.current()`).
 * These tests pin (1) the thunk re-reads per call, and (2) the end-to-end
 * chain semantics: pointing the source at a `/model` adapter makes a SET show
 * up on the next view.
 */

import { describe, expect, test } from "bun:test"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import { buildModelAdapter } from "../../../src/apps/cli/repl/ctx-adapters/model-adapter"
import {
  buildSessionStatusView,
  createLiveModelSource,
} from "../../../src/apps/cli/status-line-driver"

describe("statusline live modelId (UUX-1-17)", () => {
  test("the view thunk re-reads the model source on EVERY call", () => {
    const live = createLiveModelSource("boot-model")
    const view = buildSessionStatusView({
      cwd: "/w",
      model: live,
      effort: () => undefined,
      cost: () => undefined,
    })
    expect(view().modelId).toBe("boot-model")
    live.source = () => "switched-model"
    expect(view().modelId).toBe("switched-model")
    expect(view().modelDisplayName).toBe("switched-model")
  })

  test("chain: /model set → adapter.current() → next statusline view", async () => {
    // The REAL in-memory store, not a hand fake. aug-28: this was
    // `{ set: async () => ({ok:true}), get: async () => undefined }` — a double
    // that ACCEPTED a write and then reported no preference, which only passed
    // because the adapter kept its own shadow copy of the pick. The adapter now
    // delegates the sync read to the store (`peek`), so a store that forgets its
    // own writes is exactly the thing this chain must not tolerate.
    const store = inMemoryStickyModelStore()
    const adapter = buildModelAdapter({
      store,
      bootModel: "boot-model",
      currentMode: () => "default" as never,
      candidateIds: () => ["boot-model", "other-model"],
    })
    const live = createLiveModelSource("boot-model")
    // The surface-compose wiring: point the live source at the adapter.
    live.source = () => adapter.current()
    const view = buildSessionStatusView({
      cwd: "/w",
      model: live,
      effort: () => undefined,
      cost: () => undefined,
    })
    expect(view().modelId).toBe("boot-model")
    const outcome = await adapter.set("other-model")
    expect(outcome).toBe("ok")
    expect(view().modelId).toBe("other-model")
  })

  test("optional fields: sessionId present, cost folded when available", () => {
    const live = createLiveModelSource("m")
    const view = buildSessionStatusView({
      sessionId: "sid",
      cwd: "/w",
      model: live,
      effort: () => "high" as never,
      cost: () => ({ totalCostUsd: 1.25 }),
    })
    const v = view()
    expect(v.sessionId).toBe("sid")
    expect(v.effortLevel).toBe("high" as never)
    expect(v.totalCostUsd).toBe(1.25)
  })
})
