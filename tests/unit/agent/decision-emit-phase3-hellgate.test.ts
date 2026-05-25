/**
 * ADR-0269 (Phase 3 of ADR-0239 / follow-up to ADR-0267) — `decision` event
 * emit hellgate at the remaining 3 gate sites:
 *
 *   - cap     — `CapEnforcer.check` returns a non-undefined reminder string
 *               (the ADR-0062 ignored-hint signal). Emitted from dispatch's
 *               consumer chokepoint where `cfg.decisionEmitter` is in scope.
 *   - jail    — `enforceJail` rejects a path that escapes the workspace.
 *               Emitted from `@/storage/service.ts` via the module-level
 *               sink injected by `setFsJailDecisionSink(...)`.
 *   - budget  — `BudgetMeter.checkExhausted()` returns `exhausted=true`.
 *               Emitted from `loop.ts` consumer site (kept here as a unit
 *               check of the helper `emitBudgetExhaustedDecision`).
 *
 * Invariants asserted (same posture as ADR-0267 Phase 2):
 *   1. emit produces the EXACT DecisionEvent shape (kind/outcome/reason).
 *   2. `toolCallId` is populated where the call.id is available.
 *   3. `decisionEmitter: undefined` ⇒ ZERO emits + the gate result is
 *      byte-identical to the legacy path.
 *   4. An emitter that THROWS does not affect the gate result
 *      (try/catch isolation — observational sink contract).
 *   5. Same logical decision emits ONCE per call (no duplicates).
 *   6. `metadata` carries ONLY safe enums/categorical tags + numerical
 *      observations — never tool input bodies or env values.
 *   7. Allow paths stay SILENT — only deny (and budget hard-deny) emit.
 *
 * Slice fence: imports the dispatch chokepoint + storage jail sink + budget
 * helper. No CLI, no apps wiring.
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"
import { CapEnforcer } from "@/agent/cap-enforcer"
import { emitBudgetExhaustedDecision, emitCapReminderDecision } from "@/agent/decision-emit-phase3"
import { clearFsJailDecisionSink, enforceJail, FsJailError, setFsJailDecisionSink } from "@/storage"
import type { DecisionEmitter, DecisionEvent } from "@/stream"

// ── helpers ───────────────────────────────────────────────────────────────

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

const poisonEmitter: DecisionEmitter = {
  emit(): void {
    throw new Error("simulated tracer crash")
  },
}

// ── site 1: cap (4 cases) ─────────────────────────────────────────────────

describe("ADR-0269 emit: cap gate", () => {
  test("cap deny emit on reminder fire — shape", () => {
    const cap = collector()
    emitCapReminderDecision(cap.emitter, {
      tool: "list_dir",
      toolCallId: "tc_cap",
      reminder: "Last call returned nextAction.kind=raise_max_files",
      turn: 3,
    })
    const ev = cap.events()
    expect(ev.length).toBe(1)
    expect(ev[0]?.type).toBe("decision")
    expect(ev[0]?.kind).toBe("cap")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev[0]?.toolCallId).toBe("tc_cap")
    expect(ev[0]?.turn).toBe(3)
    // reason must carry the categorical reminder body, not raw input.
    expect(ev[0]?.reason).toContain("cap")
    expect(ev[0]?.metadata?.tool).toBe("list_dir")
  })

  test("cap allow path is SILENT — caller does NOT invoke emit when check returns undefined", () => {
    // Audit-FIX: previous version had a comment "(No call here)" claiming
    // the absence of an emit call PROVED the silent contract. That is a
    // tautology — not calling the helper trivially doesn't emit. We now
    // exercise the actual caller pattern: when CapEnforcer.check returns
    // undefined, the caller (dispatch chokepoint) wraps the emit in an
    // `if (reminder !== undefined)` guard. Simulate that guard here +
    // assert the collector remains EMPTY after running the guarded path.
    const enforcer = new CapEnforcer()
    const reminder = enforcer.check("list_dir", { path: "x" })
    expect(reminder).toBeUndefined()
    const cap = collector()
    if (reminder !== undefined) {
      // Unreachable under the contract — but spelling out the guarded path
      // makes the silent invariant a positive assertion, not a missing call.
      emitCapReminderDecision(cap.emitter, {
        tool: "list_dir",
        toolCallId: "x",
        reminder,
        turn: 0,
      })
    }
    expect(cap.events().length).toBe(0)
  })

  test("cap reason carries the reminder substring (first sentence only — `;` split)", () => {
    // Audit-add: source compresses `reminder` to its first sentence (split
    // on `;`). Pin: a reminder of "first part; second part" surfaces only
    // "first part" inside `reason`, and the trailing tail is NOT leaked.
    const cap = collector()
    emitCapReminderDecision(cap.emitter, {
      tool: "list_dir",
      toolCallId: "tc_split",
      reminder: "first reminder body; second hidden tail",
      turn: 1,
    })
    expect(cap.events().length).toBe(1)
    const reason = cap.events()[0]?.reason ?? ""
    expect(reason).toContain("first reminder body")
    expect(reason).not.toContain("second hidden tail")
  })

  test("cap emitter undefined ⇒ no-op + no throw (default-OFF)", () => {
    expect(() =>
      emitCapReminderDecision(undefined, {
        tool: "list_dir",
        toolCallId: "tc_cap_off",
        reminder: "ignored",
        turn: 0,
      }),
    ).not.toThrow()
  })

  test("cap throwing emitter is isolated — no propagation", () => {
    expect(() =>
      emitCapReminderDecision(poisonEmitter, {
        tool: "list_dir",
        toolCallId: "tc_cap_poison",
        reminder: "ignored",
        turn: 0,
      }),
    ).not.toThrow()
  })
})

// ── site 2: jail (5 cases) ────────────────────────────────────────────────

describe("ADR-0269 emit: fs-jail gate", () => {
  test("jail deny emit on enforceJail throw — path + root in metadata, secret-safe, turn=0 sentinel", () => {
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
    // path is the realpath-resolved target. On macOS `/etc` resolves to
    // `/private/etc`; on Linux it stays `/etc`. Either way the categorical
    // signal — "the offending escape was rooted at the /etc tree" — is
    // preserved; assert via substring rather than equality.
    expect(ev[0]?.metadata?.path).toContain("etc/passwd")
    // Audit-add: source ALSO emits `metadata.root` (the workspace jail
    // root). Pin both keys + their substring shape — a regression that
    // dropped `root` would be untestable without this.
    expect(typeof ev[0]?.metadata?.root).toBe("string")
    // jail-deny has no toolCallId in scope (free-function chokepoint).
    expect(ev[0]?.toolCallId).toBeUndefined()
    // Sentinel turn: the jail sink is module-level and lacks a turn signal,
    // so the emit hard-codes turn=0 (see storage/service.ts emitJailDeny).
    expect(ev[0]?.turn).toBe(0)
  })

  test("jail allow path is SILENT — paths inside the jail emit zero events", () => {
    const cap = collector()
    setFsJailDecisionSink(cap.emitter)
    try {
      expect(() => enforceJail("nested.txt", "/repo", "/repo/nested.txt")).not.toThrow()
    } finally {
      clearFsJailDecisionSink()
    }
    expect(cap.events().length).toBe(0)
  })

  test("jail sink unwired ⇒ enforceJail still throws on escape (default-OFF)", () => {
    clearFsJailDecisionSink()
    expect(() => enforceJail("../escape", "/repo", "/escape")).toThrow(FsJailError)
  })

  test("jail throwing sink does NOT poison the throw — gate result stable", () => {
    setFsJailDecisionSink(poisonEmitter)
    try {
      expect(() => enforceJail("../escape", "/repo", "/escape")).toThrow(FsJailError)
    } finally {
      clearFsJailDecisionSink()
    }
  })

  test("clearFsJailDecisionSink is idempotent", () => {
    clearFsJailDecisionSink()
    clearFsJailDecisionSink()
    expect(() => enforceJail("../escape", "/repo", "/escape")).toThrow(FsJailError)
  })
})

// ── site 3: budget (5 cases) ──────────────────────────────────────────────

describe("ADR-0269 emit: budget gate", () => {
  test("budget hard-deny emit on checkExhausted — used/limit in metadata", () => {
    const meter = new BudgetMeter({ dials: { maxToolCalls: 2 } })
    meter.tick("tool_call", 3) // observed 3 > dial 2 ⇒ exhausted
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(true)
    const cap = collector()
    emitBudgetExhaustedDecision(cap.emitter, ex, { turn: 5 })
    const ev = cap.events()
    expect(ev.length).toBe(1)
    expect(ev[0]?.kind).toBe("budget")
    expect(ev[0]?.outcome).toBe("deny")
    expect(ev[0]?.reason).toContain("budget")
    expect(ev[0]?.reason).toContain("tool_call")
    expect(ev[0]?.turn).toBe(5)
    expect(ev[0]?.metadata?.used).toBe(3)
    expect(ev[0]?.metadata?.limit).toBe(2)
    expect(ev[0]?.metadata?.kind).toBe("tool_call")
  })

  test("budget allow path is SILENT — exhausted=false produces no emit", () => {
    const meter = new BudgetMeter({ dials: { maxToolCalls: 10 } })
    meter.tick("tool_call", 1)
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(false)
    const cap = collector()
    emitBudgetExhaustedDecision(cap.emitter, ex, { turn: 0 })
    expect(cap.events().length).toBe(0)
  })

  test("budget emitter undefined ⇒ no-op + no throw (default-OFF)", () => {
    const meter = new BudgetMeter({ dials: { maxToolCalls: 1 } })
    meter.tick("tool_call", 5)
    const ex = meter.checkExhausted()
    expect(() => emitBudgetExhaustedDecision(undefined, ex, { turn: 0 })).not.toThrow()
  })

  test("budget throwing emitter is isolated — no propagation", () => {
    const meter = new BudgetMeter({ dials: { maxToolCalls: 1 } })
    meter.tick("tool_call", 5)
    const ex = meter.checkExhausted()
    expect(() => emitBudgetExhaustedDecision(poisonEmitter, ex, { turn: 0 })).not.toThrow()
  })

  test("budget metadata carries ONLY observation numbers — no secret bleed", () => {
    const meter = new BudgetMeter({ dials: { maxInputTokens: 100 } })
    meter.tick("input_tokens", 250)
    const ex = meter.checkExhausted()
    const cap = collector()
    emitBudgetExhaustedDecision(cap.emitter, ex, { turn: 1 })
    const ev = cap.events()[0]
    expect(ev).toBeDefined()
    // serialise + assert the metadata keys are exactly {kind, used, limit}.
    const meta = ev?.metadata ?? {}
    expect(Object.keys(meta).sort()).toEqual(["kind", "limit", "used"])
  })

  test("budget defence-in-depth: exhausted=true with missing kind/observed/budget falls back to 'unknown'/0/0", () => {
    // Audit-add: source has `?? "unknown"`, `?? 0`, `?? 0` fallback chain
    // (decision-emit-phase3.ts L101-103). These were UNTESTED — a regression
    // that swapped the fallbacks (e.g., `undefined → NaN`) would slip past
    // the contract. Build a synthetic BudgetExhaustion that triggers each
    // fallback simultaneously to pin the helper's behaviour.
    const cap = collector()
    emitBudgetExhaustedDecision(
      cap.emitter,
      {
        exhausted: true,
        // kind / budget / observed all intentionally omitted — exercises the
        // `?? "unknown"` + `?? 0` paths in decision-emit-phase3.ts.
      },
      { turn: 9 },
    )
    expect(cap.events().length).toBe(1)
    const ev = cap.events()[0]
    expect(ev?.kind).toBe("budget")
    expect(ev?.outcome).toBe("deny")
    expect(ev?.turn).toBe(9)
    expect(ev?.metadata?.kind).toBe("unknown")
    expect(ev?.metadata?.used).toBe(0)
    expect(ev?.metadata?.limit).toBe(0)
    // The reason composes them inline — pin the exact substring so a future
    // refactor that swaps used/limit order shows up as a regression.
    expect(ev?.reason).toContain("budget exhausted: unknown used=0 limit=0")
  })

  test("budget reason carries the (kind, used, limit) categorical observation — not raw env / config", () => {
    // Audit-add: pin that the reason carries ONLY the numerical observation
    // and the dial-kind enum — no env-var values, no dial config object.
    const meter = new BudgetMeter({ dials: { maxToolCalls: 3 } })
    meter.tick("tool_call", 7)
    const ex = meter.checkExhausted()
    const cap = collector()
    emitBudgetExhaustedDecision(cap.emitter, ex, { turn: 2 })
    const reason = cap.events()[0]?.reason ?? ""
    expect(reason).toContain("tool_call")
    expect(reason).toContain("used=7")
    expect(reason).toContain("limit=3")
    // No dial-object debug spew — the reason must not include "dials" or
    // arbitrary JSON.
    expect(reason).not.toContain("dials")
    expect(reason).not.toContain("{")
  })
})
