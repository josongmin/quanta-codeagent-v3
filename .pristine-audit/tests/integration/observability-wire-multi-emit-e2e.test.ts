/**
 * TKT-0415 — observability-wire multi-emit e2e (L3 → L4).
 *
 * The unit batteries (`observability-live-wire-hellgate`,
 * `observability-e2e-real-hookbus-hellgate`, `observability-multi-emit-smoke-
 * hellgate`) cover the wire-side contract in isolation: a real `HookBus`
 * + `wireObservability` chain drives `RunLedger.start`/`settle`, the wire's
 * port slots populate, etc.
 *
 * What's still missing at L3 is a single integration test that exercises the
 * PRODUCTION composition the web-daemon's `runtime-factory.ts` builds end-to-
 * end on ONE shared bus:
 *
 *   • `attachObservabilityPorts(facade, handle)` — the four read-only getters
 *     on `ObservableRuntimeFacade` reflect the wire's LIVE state (= every
 *     `addBlocker` / `start` / `settle` invocation is observable through the
 *     facade, not just the returned handle).
 *
 *   • A REALISTIC multi-emit sequence: `session_start` → 2× `post_tool_use`
 *     (bash background + agent background) → `post_compact` → `post_tool_use`
 *     (bash_await exit 0) on ONE bus, exercising every event variant the wire
 *     cares about + an `addBlocker` call that lands on the SAME objective
 *     port the facade exposes.
 *
 *   • Gate OFF (env unset) ⇒ `bus` is `undefined`, the wire returns the noop
 *     handle, every facade getter reads `undefined`, `attachObservabilityPorts`
 *     does NOT replace the facade's prototype-bound methods. Byte-identical
 *     legacy path.
 *
 * Slice fence: this file is L4 — it imports the PUBLIC seams only
 * (`attachObservabilityPorts` / `wireObservability` / `HookBus` /
 * `resolveObservabilityWire`). No reach into wire internals, no mutation of
 * any sealed slice. `wireSessionObservability` is private to runtime-factory;
 * we reconstruct the SAME shape from its public deps so the integration is
 * faithful to the production composition root.
 */

import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import type { RecoveryProvenance } from "@/agent/recovery-reason"
import { attachObservabilityPorts } from "@/apps/web-daemon/runtime-factory"
import type { RuntimeFacade } from "@/sdk/runtime"

/* ─────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                  */
/* ─────────────────────────────────────────────────────────────────────── */

/** Adapt a live `HookBus` to the duck-typed surface the wire consumes.
 *  Mirror of the private `toObservabilityHookBus` inside runtime-factory —
 *  duplicated verbatim so the integration touches NOTHING inside the slice
 *  while exercising the exact production adapter shape. */
const toObservabilityHookBus = (bus: HookBus): ObservabilityHookBus => ({
  subscribe: (event, handler) => {
    bus.on(event, handler as never)
    return () => undefined
  },
})

/** Reconstruct the (private) `wireSessionObservability` projection that
 *  `runtime-factory.ts` builds for each web-daemon session. ALL inputs are
 *  the same as the private helper; the gate truth-table is byte-identical:
 *  `QUANTA_OBSERVABILITY === "on"` ⇒ mint a real bus + thread it through;
 *  else ⇒ noop handle + undefined bus. */
const wireSessionObservability = (
  env: Record<string, string | undefined>,
  cwd: string,
): { readonly handle: ObservabilityWireHandle; readonly bus: HookBus | undefined } => {
  if (env.QUANTA_OBSERVABILITY !== "on") {
    return { handle: wireObservability(), bus: undefined }
  }
  const bus = new HookBus()
  const handle = wireObservability({
    enabled: true,
    repoRoot: cwd,
    hookBus: toObservabilityHookBus(bus),
  })
  return { handle, bus }
}

/** Build a minimum-viable `RuntimeFacade` stub whose `createSession` /
 *  `close` are NOT load-bearing for the observability axis. We pin only
 *  that `attachObservabilityPorts` widens this shape into an
 *  `ObservableRuntimeFacade` WITHOUT clobbering either method. */
const mkFacadeStub = (): RuntimeFacade => ({
  createSession: async () => {
    throw new Error("not used in this integration")
  },
  close: async () => undefined,
})

const bashBackgroundEvent = (shellId: string) => ({
  type: "post_tool_use" as const,
  name: "bash",
  input: {},
  output: `[bash background] shellId=${shellId} status=running\nstdout so far:\n`,
  ok: true,
})

const bashAwaitExit0Event = (shellId: string) => ({
  type: "post_tool_use" as const,
  name: "bash_await",
  input: {},
  output: `[bash_await exit 0]\nshellId=${shellId}\nlast stdout:\nok\n`,
  ok: true,
})

const subagentLaunchEvent = (taskId: string) => ({
  type: "post_tool_use" as const,
  name: "agent",
  input: { background: true },
  output: `Subagent launched in background. task_id: ${taskId}\npoll with task_output`,
  ok: true,
})

const provenance: RecoveryProvenance = {
  reason: "token_budget_exceeded",
  tokensBefore: 100_000,
  tokensAfter: 25_000,
  turnsDropped: 12,
  turnsKept: 6,
  compactedAt: 1_700_000_000_000,
}

/* ─────────────────────────────────────────────────────────────────────── */
/* §1 — Gate ON: multi-emit sequence on ONE shared bus.                     */
/* ─────────────────────────────────────────────────────────────────────── */

describe("TKT-0415 §1 — multi-emit e2e: session_start + post_tool_use ×N + post_compact", () => {
  test("CASE-1: full sequence drives runLedger.start through the SAME bus + facade exposes live state", async () => {
    const { handle, bus } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on" },
      "/tmp/quanta-test",
    )
    expect(bus).toBeDefined()
    expect(handle.runLedger).toBeDefined()
    expect(handle.objective).toBeDefined()

    const facade = attachObservabilityPorts(mkFacadeStub(), handle)
    // Facade getters proxy the handle ⇒ live state before any event.
    expect(facade.runLedger).toBe(handle.runLedger)
    expect(facade.objective).toBe(handle.objective)
    expect(facade.approvalStateMachine).toBe(handle.approvalStateMachine)
    expect(facade.shadowVerify).toBe(handle.shadowVerify)

    // 1) session_start — no subscriber wires it, but the bus MUST accept it
    //    (regression guard for the empty-handler-list fast path).
    await (bus as HookBus).emit({ type: "session_start", sessionId: "sess-multi-1" })

    // 2) post_tool_use #1 — bash background launch ⇒ runLedger.start.
    await (bus as HookBus).emit(bashBackgroundEvent("sh-multi-1"))
    expect(facade.runLedger?.get("sh-multi-1")?.status).toBe("running")
    expect(facade.runLedger?.get("sh-multi-1")?.kind).toBe("shell")

    // 3) post_tool_use #2 — subagent background launch ⇒ runLedger.start (subagent).
    await (bus as HookBus).emit(subagentLaunchEvent("task-multi-1"))
    expect(facade.runLedger?.get("task-multi-1")?.status).toBe("running")
    expect(facade.runLedger?.get("task-multi-1")?.kind).toBe("subagent")

    // 4) post_compact — no wire subscriber yet, but the bus MUST accept it
    //    (R2-F1 fix: ADR-0409 emit reaches a subscriber when one is wired).
    let postCompactSeen = 0
    ;(bus as HookBus).on("post_compact", (e) => {
      if (e.type === "post_compact") postCompactSeen += 1
      return {}
    })
    await (bus as HookBus).emit({ type: "post_compact", threadId: "t-multi", provenance })
    expect(postCompactSeen).toBe(1)

    // 5) post_tool_use #3 — bash_await exit 0 ⇒ runLedger.settle (completed).
    await (bus as HookBus).emit(bashAwaitExit0Event("sh-multi-1"))
    expect(facade.runLedger?.get("sh-multi-1")?.status).toBe("completed")
    // Subagent still running (independent id).
    expect(facade.runLedger?.get("task-multi-1")?.status).toBe("running")

    // 6) objective.addBlocker through the facade getter ⇒ same store the
    //    wire created. A second read through `handle.objective` MUST see the
    //    same blocker (the facade isn't a copy — it's a getter).
    facade.objective?.set("t-multi", { goal: "ship feature", successCriteria: ["typecheck"] })
    const after = facade.objective?.addBlocker("t-multi", {
      reason: "awaiting review",
      waitingOn: "user",
    })
    expect(after?.blockers.length).toBe(1)
    expect(handle.objective?.get("t-multi")?.blockers.length).toBe(1)
    expect(handle.objective?.get("t-multi")?.status).toBe("blocked")

    handle.detach()
  })

  test("CASE-2: 4 facade getters remain stable across multiple emits (identity not refreshed per-call)", async () => {
    const { handle, bus } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on" },
      "/tmp/quanta-test",
    )
    const facade = attachObservabilityPorts(mkFacadeStub(), handle)

    const ledger1 = facade.runLedger
    const objective1 = facade.objective
    const asm1 = facade.approvalStateMachine
    const sv1 = facade.shadowVerify

    await (bus as HookBus).emit(bashBackgroundEvent("sh-stable"))
    await (bus as HookBus).emit(bashAwaitExit0Event("sh-stable"))

    // Getters are PROXIES: they read the wire's handle slot each call, and
    // the slot reference does NOT change as the ledger mutates. (Stable
    // identity is what the ADR-0408 emitter relies on for its readers.)
    expect(facade.runLedger).toBe(ledger1)
    expect(facade.objective).toBe(objective1)
    expect(facade.approvalStateMachine).toBe(asm1)
    expect(facade.shadowVerify).toBe(sv1)

    handle.detach()
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §2 — Gate OFF: byte-identical noop legacy path.                          */
/* ─────────────────────────────────────────────────────────────────────── */

describe("TKT-0415 §2 — gate OFF (env unset) ⇒ byte-identical noop", () => {
  test("CASE-3: bus undefined + every facade getter reads undefined", () => {
    const { handle, bus } = wireSessionObservability({}, "/tmp/quanta-test")
    expect(bus).toBeUndefined()
    expect(handle.runLedger).toBeUndefined()
    expect(handle.objective).toBeUndefined()
    expect(handle.approvalStateMachine).toBeUndefined()
    expect(handle.shadowVerify).toBeUndefined()

    const facade = attachObservabilityPorts(mkFacadeStub(), handle)
    expect(facade.runLedger).toBeUndefined()
    expect(facade.objective).toBeUndefined()
    expect(facade.approvalStateMachine).toBeUndefined()
    expect(facade.shadowVerify).toBeUndefined()
    // detach is the shared noop; calling it MUST NOT throw.
    expect(() => handle.detach()).not.toThrow()
  })

  test("CASE-4: gate OFF ⇒ attachObservabilityPorts preserves createSession + close (prototype-bound methods)", async () => {
    const stub = mkFacadeStub()
    const closeSeen = { count: 0 }
    const stubWithCounted: RuntimeFacade = {
      createSession: stub.createSession,
      close: async () => {
        closeSeen.count += 1
      },
    }
    const { handle } = wireSessionObservability({}, "/tmp/quanta-test")
    const facade = attachObservabilityPorts(stubWithCounted, handle)
    // createSession is still the same function reference — the widen wires
    // ONLY the 4 observability getters via Object.defineProperties.
    expect(facade.createSession).toBe(stubWithCounted.createSession)
    await facade.close()
    expect(closeSeen.count).toBe(1)
  })

  test("CASE-5: gate OFF + bare-host emit ⇒ no throw (no subscribers, fast-path)", async () => {
    // Even without the wire subscribing, a host that ALSO mints its own bus
    // (e.g. a different surface) and emits onto it must not crash. The
    // empty-handler fast path is load-bearing for the byte-identical legacy
    // claim. (We use `bashBackgroundEvent` shape directly — type tag is
    // already `post_tool_use`.)
    const bus = new HookBus()
    await expect(bus.emit(bashBackgroundEvent("sh-noop"))).resolves.toBeDefined()
  })
})

/* ─────────────────────────────────────────────────────────────────────── */
/* §3 — Adversarial: subscriber throw does NOT propagate.                   */
/* ─────────────────────────────────────────────────────────────────────── */

describe("TKT-0415 §3 — adversarial: subscriber throw is contained", () => {
  test("CASE-6: a sibling subscriber that throws does NOT break the run-ledger-attribution chain", async () => {
    const { handle, bus } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on" },
      "/tmp/quanta-test",
    )
    // Wire a SECOND post_tool_use subscriber that THROWS. HookBus contains
    // handler exceptions (it logs them via `safeHandler`); the wire's own
    // attribution subscriber must still receive the event.
    ;(bus as HookBus).on("post_tool_use", () => {
      throw new Error("sibling subscriber crash")
    })
    // Emit a bash-background event. The throwing sibling should not prevent
    // run-ledger.start from being called.
    await (bus as HookBus).emit(bashBackgroundEvent("sh-throw-1"))
    expect(handle.runLedger?.get("sh-throw-1")?.status).toBe("running")
    handle.detach()
  })

  test("CASE-7: facade getters keep reading the live handle after detach (closed slot stays defined)", async () => {
    // After detach the wire's HOST unsubscribe runs, but the port slots
    // themselves are NOT cleared — a UI/emitter that still holds the facade
    // can keep reading the FINAL state. This is the contract the ADR-0408
    // emitter depends on (post-shutdown snapshot read).
    const { handle, bus } = wireSessionObservability(
      { QUANTA_OBSERVABILITY: "on" },
      "/tmp/quanta-test",
    )
    const facade = attachObservabilityPorts(mkFacadeStub(), handle)
    await (bus as HookBus).emit(bashBackgroundEvent("sh-detach"))
    expect(facade.runLedger?.get("sh-detach")?.status).toBe("running")
    handle.detach()
    // Post-detach: the slot reference remains; the entry is still readable.
    expect(facade.runLedger?.get("sh-detach")?.status).toBe("running")
    // A second detach MUST be a noop (idempotent NO-THROW).
    expect(() => handle.detach()).not.toThrow()
  })
})
