/**
 * ADR-0269 Phase 3 — *caller-site* wire hellgate (DEFERRED slice).
 *
 * Background
 * ──────────
 * Phase 2 (ADR-0267) wired `decisionEmitter` into the admissibility gate's
 * rule/hook/permission sites. Phase 3 (ADR-0269) added 3 *additional*
 * decision-emit sites — cap / jail / budget — by way of helpers that live in
 * `@/agent/decision-emit-phase3.ts` (cap + budget) and a module-level sink
 * inside `@/storage/service.ts` (fs-jail, slice-fence forbids `@/stream`).
 *
 * The HELPERS shipped, and the CALLER sites also shipped:
 *
 *   - `src/agent/dispatch.ts#handleCapReminder`  → `emitCapReminderDecision`
 *   - `src/agent/loop.ts` (turn epilogue)        → `emitBudgetExhaustedDecision`
 *   - `src/storage/service.ts#emitJailDeny`      → `fsJailDecisionSink`
 *
 * What did NOT ship — the composition-root wire that *populates* the slot.
 * Investigation (2026-05-25, session in this hellgate's header comment):
 *
 *   (a) `src/runner/assemble/config.ts#SessionDeps`         has NO `decisionEmitter` field.
 *   (b) `src/runner/assemble/config.ts#assembleConfig`      never sets `AgentConfig.decisionEmitter`.
 *   (c) `src/storage/service.ts#setFsJailDecisionSink`      has ZERO production callers.
 *   (d) Both REPL composition root files (`src/apps/cli/repl.ts`,
 *       `src/apps/cli/repl/session-deps-compose.ts`) build a `DebugTracerHandle`
 *       and a tee but never construct a `DecisionEmitter` from it.
 *
 * Net effect: every Phase 3 caller is a no-op in production today —
 * `config.decisionEmitter` is always `undefined` and the fs-jail sink is
 * always `null`. The helpers + caller sites are *wire-ready* but the
 * composition root has not flipped the switch.
 *
 * Why this hellgate exists
 * ────────────────────────
 * The remaining wiring (one new optional field on `SessionDeps`, one spread
 * line in `assembleConfig`, one `setFsJailDecisionSink(...)` + matching
 * `clearFsJailDecisionSink()` pair in the REPL session lifecycle) lives
 * inside the user's in-flight area
 * (`src/runner/assemble/config.ts` + `src/apps/cli/repl/session-setup.ts` +
 * `src/agent/loop.ts` + `src/agent/dispatch.ts`). Per the slice-fence rule
 * for this slice we do NOT touch user-in-flight files; instead, we pin the
 * post-wire contract as a hellgate so the moment the wire lands, the test
 * suite reports the change rather than the silent-no-op shipping unnoticed.
 *
 * Cases (6 total)
 * ───────────────
 *   1. (FACT-PIN, passing) helper symbols are exported from their slice
 *      barrels in the shape callers expect — wire-ready surface invariant.
 *   2. (FACT-PIN, passing) the 3 caller sites already import + invoke the
 *      helpers (verified via static module-text inspection so a future
 *      refactor that drops the call surfaces here, not at runtime).
 *   3. (FACT-PIN, passing) the helpers' default-OFF contract holds — emitter
 *      undefined ⇒ no-op + no throw — regression-guarding the wire-OFF path.
 *   4. (DEFERRED, .todo) composition root populates `AgentConfig.decisionEmitter`
 *      via SessionDeps. Will turn green when the user wires
 *      `SessionDeps.decisionEmitter?` + the `assembleConfig` spread.
 *   5. (DEFERRED, .todo) REPL session lifecycle calls
 *      `setFsJailDecisionSink(...)` at startup and `clearFsJailDecisionSink()`
 *      at shutdown. Will turn green when the user wires it into
 *      `session-setup.ts`'s lifecycle.
 *   6. (FACT-PIN, passing) end-to-end propositional check on the WIRED path:
 *      WHEN a caller passes a non-undefined `decisionEmitter` (the post-wire
 *      shape), THEN each of the 3 caller-invocable helpers + sink emits
 *      exactly ONE event per deny. This case stitches the 3 helpers without
 *      touching prod composition — it pins the contract the post-wire
 *      runtime must satisfy.
 *
 * Slice fence: imports only from `@/agent/decision-emit-phase3` (helper
 * surface), `@/agent` (BudgetMeter), `@/storage` (jail sink), `@/stream`
 * (DecisionEmitter shape). NO `@/apps/*`, NO `@/runner/*` (those live behind
 * the user's in-flight files).
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BudgetMeter } from "@/agent"
import {
  buildJailDecisionEvent,
  emitBudgetExhaustedDecision,
  emitCapReminderDecision,
} from "@/agent/decision-emit-phase3"
import { clearFsJailDecisionSink, enforceJail, FsJailError, setFsJailDecisionSink } from "@/storage"
import type { DecisionEmitter, DecisionEvent } from "@/stream"

// ── fixtures ──────────────────────────────────────────────────────────────

const collector = (): {
  emitter: DecisionEmitter
  events: () => readonly DecisionEvent[]
} => {
  const events: DecisionEvent[] = []
  return {
    emitter: {
      emit(e: DecisionEvent): void {
        events.push(e)
      },
    },
    events: () => events,
  }
}

/** Repo root resolved off THIS file so the static-text inspection in
 *  CASE-2 keeps working under `bun test` no matter the CWD. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const readSrc = (rel: string): Promise<string> => readFile(resolve(REPO_ROOT, rel), "utf8")

// ── CASE 1 — wire-ready helper surface ────────────────────────────────────

describe("ADR-0269 Phase 3 wire — helper surface", () => {
  test("CASE-1: all 3 Phase-3 helpers are exported from their barrels", () => {
    // The helpers are the "wire-ready" surface — a composition root that
    // wishes to fill `AgentConfig.decisionEmitter` only needs these 3
    // symbols plus the fs-jail sink setter. Each must remain callable.
    expect(typeof emitCapReminderDecision).toBe("function")
    expect(typeof emitBudgetExhaustedDecision).toBe("function")
    expect(typeof buildJailDecisionEvent).toBe("function")
    expect(typeof setFsJailDecisionSink).toBe("function")
    expect(typeof clearFsJailDecisionSink).toBe("function")
  })
})

// ── CASE 2 — caller sites are wired against the helpers ──────────────────

describe("ADR-0269 Phase 3 wire — caller-site static invariants", () => {
  test("CASE-2a: dispatch.ts imports + invokes emitCapReminderDecision", async () => {
    const src = await readSrc("src/agent/dispatch.ts")
    expect(src).toContain('import { emitCapReminderDecision } from "./decision-emit-phase3"')
    // The handleCapReminder helper IS the cap caller-site chokepoint.
    expect(src).toContain("emitCapReminderDecision(config.decisionEmitter,")
    // The fs-jail / budget helpers do NOT belong here — keep dispatch's emit
    // surface scoped to cap (catches a future drift where someone moves the
    // budget call into dispatch).
    expect(src).not.toContain("emitBudgetExhaustedDecision")
  })

  test("CASE-2b: loop.ts imports + invokes emitBudgetExhaustedDecision at turn epilogue", async () => {
    const src = await readSrc("src/agent/loop.ts")
    expect(src).toContain('import { emitBudgetExhaustedDecision } from "./decision-emit-phase3"')
    // The exhaustion check + emit must live on the same path so the emit is
    // co-located with the `budget_exhausted` finish — never split.
    expect(src).toContain("checkExhausted()")
    expect(src).toContain("emitBudgetExhaustedDecision(cfg.decisionEmitter,")
    expect(src).toContain('finish("budget_exhausted"')
  })

  test("CASE-2c: storage/service.ts exposes the sink setter + emits before throwing", async () => {
    const src = await readSrc("src/storage/service.ts")
    expect(src).toContain("export const setFsJailDecisionSink")
    expect(src).toContain("export const clearFsJailDecisionSink")
    // The `emitJailDeny(...)` call MUST land before the `throw new FsJailError`
    // — verified by ordering of the two anchor substrings (the tracer needs
    // the row even when the throw is later swallowed by a tool catch).
    const emitIdx = src.indexOf("emitJailDeny(target, root)")
    const throwIdx = src.indexOf("throw new FsJailError(")
    expect(emitIdx).toBeGreaterThan(0)
    expect(throwIdx).toBeGreaterThan(0)
    expect(emitIdx).toBeLessThan(throwIdx)
  })
})

// ── CASE 3 — default-OFF (wire-absent) byte-identical contract ────────────

describe("ADR-0269 Phase 3 wire — default-OFF (no emitter, no sink) is silent", () => {
  test("CASE-3a: undefined emitter ⇒ cap helper no-ops + does not throw", () => {
    expect(() =>
      emitCapReminderDecision(undefined, {
        tool: "list_dir",
        toolCallId: "tc",
        reminder: "ignored",
        turn: 0,
      }),
    ).not.toThrow()
  })

  test("CASE-3b: undefined emitter ⇒ budget helper no-ops + does not throw", () => {
    const meter = new BudgetMeter({ dials: { maxToolCalls: 1 } })
    meter.tick("tool_call", 5)
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(true)
    expect(() => emitBudgetExhaustedDecision(undefined, ex, { turn: 0 })).not.toThrow()
  })

  test("CASE-3c: unwired sink ⇒ enforceJail STILL throws (telemetry is best-effort)", () => {
    clearFsJailDecisionSink()
    // The gate's deny decision is authoritative regardless of the sink — the
    // wire is *observational*. A future regression that makes the throw
    // contingent on a wired sink would surface here.
    expect(() => enforceJail("../escape", "/repo", "/escape")).toThrow(FsJailError)
  })
})

// ── CASE 4 — composition root populates AgentConfig.decisionEmitter

describe("ADR-0269 Phase 3 wire — composition root", () => {
  test("CASE-4: SessionDeps.decisionEmitter + assembleConfig conditional spread", async () => {
    // ADR-0269 Phase 3 closure: SessionDeps grew a `decisionEmitter` slot
    // and `assembleConfig` spreads it conditionally. The wire is live in
    // `src/apps/cli/repl/session-deps-compose.ts` (decisionEmitterFromStream).
    const { assembleConfig } = await import("@/runner/assemble/config")
    type SessionDepsShape = Parameters<typeof assembleConfig>[1]
    const emitter = { emit: () => {} }
    const baseDeps: Partial<SessionDepsShape> = {
      decisionEmitter: emitter,
    }
    const fullDeps = baseDeps as SessionDepsShape
    const withEmitter = assembleConfig([], fullDeps)
    expect(withEmitter.decisionEmitter).toBe(emitter)

    const bareDeps: Partial<SessionDepsShape> = {}
    const cfgBare = assembleConfig([], bareDeps as SessionDepsShape)
    expect(cfgBare.decisionEmitter).toBeUndefined()
  })
})

// ── CASE 5 — REPL session lifecycle install/clear of fs-jail sink

describe("ADR-0269 Phase 3 wire — REPL fs-jail sink lifecycle", () => {
  test("CASE-5: session-setup.ts calls setFsJailDecisionSink + clearFsJailDecisionSink", async () => {
    // ADR-0269 Phase 3 closure: session-setup.ts installs the sink right
    // after `composeCliSessionDeps` returns, and wraps `boot.shutdownMcp`
    // with `clearFsJailDecisionSink()` so session-end always clears the
    // process-global slot. This invariant is grep-asserted (not runtime-
    // executed) because `setupSession` requires a fully-wired bootstrap +
    // an LLM port to construct; a runtime test would need to stub every
    // collaborator and would be brittle against unrelated boot churn.
    const src = await Bun.file(
      "src/apps/cli/repl/session-setup.ts",
    ).text()
    expect(src).toContain("setFsJailDecisionSink(sessionDeps.decisionEmitter)")
    expect(src).toContain("clearFsJailDecisionSink()")
    // The clear MUST live inside the shutdownMcp wrapper (not as a free
    // call) so it fires at session-end, not at setupSession return.
    const clearIdx = src.indexOf("clearFsJailDecisionSink()")
    const shutdownIdx = src.indexOf("shutdownMcp: async")
    expect(shutdownIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeGreaterThan(shutdownIdx)
  })
})

// ── CASE 6 — POST-WIRE end-to-end propositional check (3 helpers stitched) ─

describe("ADR-0269 Phase 3 wire — post-wire e2e propositional shape", () => {
  test("CASE-6a: cap-deny ⇒ emitter receives exactly ONE kind:'cap' decision", () => {
    const cap = collector()
    // This is precisely what `dispatch.ts#handleCapReminder` will do once
    // `config.decisionEmitter` is populated by the wire. The helper IS the
    // chokepoint, so wiring the slot is sufficient — no second emit lives
    // outside this call.
    emitCapReminderDecision(cap.emitter, {
      tool: "list_dir",
      toolCallId: "tc_cap_wire",
      reminder: "Last call returned nextAction.kind=raise_max_files",
      turn: 7,
    })
    const ev = cap.events()
    expect(ev.length).toBe(1)
    expect(ev[0]?.kind).toBe("cap")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev[0]?.toolCallId).toBe("tc_cap_wire")
    expect(ev[0]?.turn).toBe(7)
    expect(ev[0]?.metadata?.tool).toBe("list_dir")
    // metadata must NOT leak tool input.
    expect(JSON.stringify(ev[0]?.metadata ?? {})).not.toContain("nextAction")
  })

  test("CASE-6b: jail-deny ⇒ sink receives exactly ONE kind:'jail' decision + enforceJail throws", () => {
    const cap = collector()
    setFsJailDecisionSink(cap.emitter)
    try {
      expect(() => enforceJail("../etc/passwd", "/repo", "/etc/passwd")).toThrow(FsJailError)
    } finally {
      clearFsJailDecisionSink()
    }
    const ev = cap.events()
    expect(ev.length).toBe(1)
    expect(ev[0]?.kind).toBe("jail")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev[0]?.reason).toContain("outside")
    expect(typeof ev[0]?.metadata?.path).toBe("string")
    // jail-deny chokepoint has no toolCallId in scope (free function).
    expect(ev[0]?.toolCallId).toBeUndefined()
  })

  test("CASE-6c: budget-exhausted ⇒ emitter receives exactly ONE kind:'budget' decision", () => {
    const cap = collector()
    const meter = new BudgetMeter({ dials: { maxToolCalls: 2 } })
    meter.tick("tool_call", 3)
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(true)
    emitBudgetExhaustedDecision(cap.emitter, ex, { turn: 11 })
    const ev = cap.events()
    expect(ev.length).toBe(1)
    expect(ev[0]?.kind).toBe("budget")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev[0]?.turn).toBe(11)
    expect(ev[0]?.metadata?.kind).toBe("tool_call")
    expect(ev[0]?.metadata?.used).toBe(3)
    expect(ev[0]?.metadata?.limit).toBe(2)
    // metadata keys MUST be exactly {kind, used, limit} — no observation
    // bleed into the row (PII/secret safety contract).
    expect(Object.keys(ev[0]?.metadata ?? {}).sort()).toEqual(["kind", "limit", "used"])
  })

  test("CASE-6d: same logical decision emits at most ONCE per call (no fan-out duplicates)", () => {
    const cap = collector()
    setFsJailDecisionSink(cap.emitter)
    try {
      // Two distinct escapes ⇒ two distinct events. The sink is single-fan
      // (last-writer-wins, documented).
      expect(() => enforceJail("../a", "/repo", "/a")).toThrow(FsJailError)
      expect(() => enforceJail("../b", "/repo", "/b")).toThrow(FsJailError)
    } finally {
      clearFsJailDecisionSink()
    }
    const ev = cap.events()
    expect(ev.length).toBe(2)
    expect(ev[0]?.metadata?.path).not.toBe(ev[1]?.metadata?.path)
  })
})
