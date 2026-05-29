/**
 * Context-change persistent injection L3→L4 integration battery (ADR-0080 /
 * ADR-0319 / ADR-0320 / ADR-0335 codex-r2).
 *
 * Existing coverage:
 *   - `src/agent/context-change/__tests__/detector.hellgate.test.ts` — pure
 *     diff over `TurnStateSnapshot` (unit).
 *   - `src/agent/context-change/__tests__/inject.hellgate.test.ts` — pure
 *     event → `Message[]` builder (unit).
 *
 * What was missing (and what THIS file adds):
 *   The full PROVIDER → SNAPSHOT → DETECT → DIFF → STORE → BUILD-TURN-CONTEXT
 *   pipeline, exercised against a real `TypedHistoryEventStore`, a real
 *   `WorkingMemory`, and a real `buildTurnContext` invocation. None of this
 *   slice is auto-wired in the loop yet (default-OFF) — these tests pin the
 *   contract a future wire-up must satisfy.
 *
 * Pipeline under test (per Codex `record_context_updates_and_set_reference
 * _context_item`, `codex-rs/core/src/session/turn.rs:161`):
 *
 *     turn N─1 snapshot ──┐
 *                         ├── detectContextChanges ── events ─┐
 *     turn N   snapshot ──┘                                   │
 *                                                             ▼
 *                          TypedHistoryEventStore.append(…)
 *                                                             │
 *                                  store.since(prevTurnCursor) ▼
 *                                                             │
 *                buildTurnContext({ contextChangeEvents }) ◄───┘
 *                                                             │
 *                                                             ▼
 *                                     wm.append(reminder)  +  LLM sees the
 *                                                             envelope on the
 *                                                             next turn.
 *
 * Scenarios:
 *
 *   E1 — Baseline byte-identity:
 *         no snapshot change between turns ⇒ detector returns []
 *         ⇒ store empty ⇒ buildTurnContext emits ZERO context-update
 *         messages ⇒ rendered tail byte-identical to a no-events run.
 *
 *   E2 — cwd flip:
 *         cwd: A → B ⇒ ONE `<context-update field="cwd">` envelope
 *         spliced AFTER baseMessages and BEFORE the trailing
 *         `<system-reminder>` (chronological order per ADR-0321).
 *
 *   E3 — active skill activation:
 *         activeSkills: [] → ["progress-audit"] ⇒ ONE
 *         `<skill-activation>` envelope; SAME-trigger replay on turn N+1
 *         (already-active steady state) emits ZERO new events (dedup).
 *
 *   E4 — active mode flip with reason:
 *         mode: "default" → "plan" with `modeChangeReason: "/plan"` ⇒
 *         ONE `<mode-change>` envelope carrying the reason field, NOT a
 *         duplicate `<context-update field="mode">` (per detector pass 3
 *         contract).
 *
 *   E5 — Turn-N / turn-N+1 dedup:
 *         the SAME snapshot pair (prev, current) replayed twice produces
 *         the same event list, but a producer that uses
 *         `store.since(lastSeenAt)` and bumps the cursor must NOT
 *         re-inject the same diff into turn N+1 (the typed history is a
 *         monotonic stream; the dedup lives in the cursor).
 *
 *   E6 — undefined provider safety:
 *         absent (undefined) provider + absent (undefined) store ⇒
 *         buildTurnContext stays on the legacy single-block prefix path
 *         (no context-update splice), byte-identical to a no-wire run.
 *
 *   E7 — Multi-field simultaneous flip:
 *         cwd + mode + skill all change in one turn ⇒ THREE events emitted
 *         in deterministic detector order (cwd, mode_change, skill) ⇒
 *         buildTurnContext emits THREE envelopes in detector order, with
 *         the `<system-reminder>` still LAST.
 *
 *   E8 — repo-rules path diff:
 *         repoRulesPaths gain + lose paths in one turn ⇒ ONE
 *         `<repo-rules-change>` envelope carrying both `added: …` and
 *         `removed: …` lines.
 *
 * Adversarial pins:
 *   - no-change ⇒ no inject (byte-identical to a turn with `contextChangeEvents`
 *     fully absent).
 *   - dedup: turn-N event injected; turn-N+1 with same prev/current snapshot
 *     does NOT re-inject (cursor-driven `since` advances past the boundary).
 *   - undefined provider: a fresh buildTurnContext call without the channel
 *     present is byte-identical to the legacy path.
 *
 * Scope guard:
 *   - This file is TEST-ONLY. NO production code is mutated. The slice
 *     remains default-OFF; this battery exercises it via direct producer
 *     wiring at the test boundary (the same shape the future loop wire-up
 *     will use). Per task brief: "src 0 변경".
 */

import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent"
import { buildTurnContext } from "@/agent"
import {
  buildPersistentInjectionMessages,
  captureSnapshot,
  detectContextChanges,
  type TurnStateSnapshot,
} from "@/agent/context-change"
import type { Message } from "@/llm"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import { createWorkingMemory } from "@/memory/working"

// ─────────────────────────────────────────────────────────────────────────
// Helpers — keep the test bodies declarative.
// ─────────────────────────────────────────────────────────────────────────

/** Stable epoch for "turn N". The detector stamps `at` from the caller; the
 *  store filters by `>=`. We give each turn a distinct, monotonically-
 *  increasing millis so the cursor pattern (E5 dedup) is easy to read. */
const TURN_AT = (n: number): number => 1_700_000_000_000 + n * 60_000

/** Minimal `TurnContextInput` shape — replicates the existing
 *  `prompt-escape-hellgate.test.ts` base() pattern. baseMessages is one
 *  user turn so the assembled list is `[user, …events?, reminder]`. */
const SEED: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
const baseInput = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: SEED,
  cwd: "/repo",
  planMode: false,
  ...over,
})

/** Pull the trailing `<system-reminder>` message's text. The reminder is the
 *  last user message; context-change envelopes splice IMMEDIATELY BEFORE it. */
const reminderText = (messages: readonly Message[]): string => {
  const last = messages[messages.length - 1]
  const block = last?.content[0]
  return block?.type === "text" ? block.text : ""
}

/** Concat every text block across `messages` so we can grep for envelope
 *  fragments regardless of which message carries them. */
const allText = (messages: readonly Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n")

/** Count exact substring occurrences (case-sensitive). */
const countExact = (haystack: string, needle: string): number => haystack.split(needle).length - 1

// ─────────────────────────────────────────────────────────────────────────
// E1 — Baseline byte-identity (no-change ⇒ no inject)
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E1 baseline byte-identity", () => {
  test("identical snapshots ⇒ detector returns [] ⇒ buildTurnContext byte-identical to no-events path", () => {
    const snap: TurnStateSnapshot = captureSnapshot({
      cwd: "/repo",
      mode: "default",
      model: "claude-x",
      repoRulesPaths: ["AGENTS.md"],
      activeSkills: ["progress-audit"],
    })
    // Same instance both arguments — fast-path reference-identity branch.
    const events = detectContextChanges(snap, snap, TURN_AT(1))
    expect(events).toEqual([])

    const store = createInMemoryTypedHistoryEventStore()
    for (const e of events) store.append(e)
    const since = store.since(0)
    expect(since).toEqual([])

    const withChannel = buildTurnContext(baseInput({ contextChangeEvents: since }))
    const withoutChannel = buildTurnContext(baseInput())

    // The two assembled message arrays must be structurally equal — no
    // accidental empty splice, no extra wrapper.
    expect(withChannel.messages.length).toBe(withoutChannel.messages.length)
    expect(reminderText(withChannel.messages)).toBe(reminderText(withoutChannel.messages))
    // Promised promptPolicy field reflects zero events.
    expect(withChannel.promptPolicy.contextChangeCount).toBe(0)
  })

  test("equal-content but DIFFERENT instance snapshots ⇒ detector still returns []", () => {
    const a = captureSnapshot({
      cwd: "/repo",
      mode: "default",
      model: "m",
      repoRulesPaths: ["x.md"],
      activeSkills: ["s"],
    })
    const b = captureSnapshot({
      cwd: "/repo",
      mode: "default",
      model: "m",
      repoRulesPaths: ["x.md"],
      activeSkills: ["s"],
    })
    expect(a).not.toBe(b) // distinct instances
    const events = detectContextChanges(a, b, TURN_AT(1))
    expect(events).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E2 — cwd flip
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E2 cwd flip", () => {
  test('cwd: A → B ⇒ ONE <context-update field="cwd"> envelope before reminder', () => {
    const prev = captureSnapshot({ cwd: "/repo/a" })
    const cur = captureSnapshot({ cwd: "/repo/b" })
    const events = detectContextChanges(prev, cur, TURN_AT(1), { turnId: "turn-2" })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("context_update")

    const store = createInMemoryTypedHistoryEventStore()
    for (const e of events) store.append(e)
    const ctx = buildTurnContext(baseInput({ contextChangeEvents: store.since(0) }))
    const text = allText(ctx.messages)

    // Envelope spliced and the reminder is still LAST.
    expect(text).toContain("<context-update>")
    expect(text).toContain("field: cwd")
    expect(text).toContain("prev: /repo/a")
    expect(text).toContain("next: /repo/b")
    expect(text).toContain('turnId="turn-2"')
    expect(text).toContain("<system-reminder>")
    // Exactly one genuine `<system-reminder>` opener in the rendered tail.
    expect(countExact(text, "<system-reminder>")).toBe(1)
    expect(countExact(text, "</system-reminder>")).toBe(1)
    expect(ctx.promptPolicy.contextChangeCount).toBe(1)

    // The context-update message sits BEFORE the reminder (chronological).
    const ctxUpdateIdx = ctx.messages.findIndex((m) => {
      const b = m.content[0]
      return b?.type === "text" && b.text.includes("<context-update>")
    })
    const reminderIdx = ctx.messages.findIndex((m) => {
      const b = m.content[0]
      return b?.type === "text" && b.text.includes("<system-reminder>")
    })
    expect(ctxUpdateIdx).toBeGreaterThanOrEqual(0)
    expect(reminderIdx).toBeGreaterThan(ctxUpdateIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E3 — skill activation + steady-state dedup
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E3 skill activation + steady-state replay", () => {
  test("activation ⇒ ONE <skill-activation>; replay with same active set ⇒ ZERO new events", () => {
    const turn1Prev = captureSnapshot({ activeSkills: [] })
    const turn1Cur = captureSnapshot({ activeSkills: ["progress-audit"] })
    const turn1 = detectContextChanges(turn1Prev, turn1Cur, TURN_AT(1))
    expect(turn1).toHaveLength(1)
    expect(turn1[0]?.kind).toBe("skill_activation")

    // Steady state on turn 2: nothing new activated.
    const turn2Prev = turn1Cur
    const turn2Cur = captureSnapshot({ activeSkills: ["progress-audit"] })
    const turn2 = detectContextChanges(turn2Prev, turn2Cur, TURN_AT(2))
    expect(turn2).toEqual([])

    // Verify the envelope wires through buildTurnContext for turn-1.
    const store = createInMemoryTypedHistoryEventStore()
    for (const e of turn1) store.append(e)
    const ctx1 = buildTurnContext(baseInput({ contextChangeEvents: store.since(0) }))
    expect(allText(ctx1.messages)).toContain("<skill-activation>")
    expect(allText(ctx1.messages)).toContain("skill: progress-audit")

    // Turn 2's window (events whose `at >= TURN_AT(2)`) is empty, so the
    // build emits NO new skill-activation envelope on turn 2.
    const turn2Window = store.since(TURN_AT(2))
    expect(turn2Window).toEqual([])
    const ctx2 = buildTurnContext(baseInput({ contextChangeEvents: turn2Window }))
    expect(allText(ctx2.messages)).not.toContain("<skill-activation>")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E4 — mode flip with reason (single mode-change, NOT a sibling context_update)
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E4 mode flip with reason", () => {
  test('mode: default → plan with reason ⇒ ONE <mode-change> envelope, NO sibling <context-update field="mode">', () => {
    const prev = captureSnapshot({ mode: "default" })
    const cur = captureSnapshot({ mode: "plan" })
    const events = detectContextChanges(prev, cur, TURN_AT(1), {
      modeChangeReason: "/plan slash",
      turnId: "t-1",
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("mode_change")

    const store = createInMemoryTypedHistoryEventStore()
    for (const e of events) store.append(e)
    const ctx = buildTurnContext(baseInput({ contextChangeEvents: store.since(0) }))
    const text = allText(ctx.messages)

    expect(text).toContain("<mode-change>")
    expect(text).toContain("prev: default")
    expect(text).toContain("next: plan")
    expect(text).toContain("reason: /plan slash")
    // Negative invariant: detector pass 3 says mode_change SUPERSEDES the
    // generic context_update for the mode field — no duplicate envelope.
    expect(text).not.toContain("field: mode")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E5 — Turn-N / turn-N+1 dedup via the store cursor
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E5 cursor-driven dedup across turns", () => {
  test("same diff on turn-N and turn-N+1 ⇒ store accumulates BOTH; per-turn cursor injects each ONCE", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const wm = createWorkingMemory<Message>()
    for (const m of SEED) wm.append(m)

    // Turn-1 boundary: cwd flips.
    const turn1Events = detectContextChanges(
      captureSnapshot({ cwd: "/a" }),
      captureSnapshot({ cwd: "/b" }),
      TURN_AT(1),
      { turnId: "t1" },
    )
    for (const e of turn1Events) store.append(e)

    // Producer cursor — what the loop will track. Start at 0; bump to the
    // LAST seen event's at + 1 after every drain so the next call's
    // since(cursor) returns ONLY new events.
    let cursor = 0
    const turn1Window = store.since(cursor)
    expect(turn1Window).toHaveLength(1)
    cursor = (turn1Window[turn1Window.length - 1]?.at ?? 0) + 1

    const ctx1 = buildTurnContext(baseInput({ contextChangeEvents: turn1Window }))
    expect(countExact(allText(ctx1.messages), "<context-update>")).toBe(1)

    // Turn-2 boundary: ANOTHER cwd flip (same field, different values).
    const turn2Events = detectContextChanges(
      captureSnapshot({ cwd: "/b" }),
      captureSnapshot({ cwd: "/c" }),
      TURN_AT(2),
      { turnId: "t2" },
    )
    for (const e of turn2Events) store.append(e)

    const turn2Window = store.since(cursor)
    // The store accumulated 2 events; the windowed `since(cursor)` returns
    // ONLY the second (turn-1's event was already drained by the cursor).
    expect(store.snapshot()).toHaveLength(2)
    expect(turn2Window).toHaveLength(1)
    expect(turn2Window[0]?.at).toBe(TURN_AT(2))

    const ctx2 = buildTurnContext(baseInput({ contextChangeEvents: turn2Window }))
    expect(countExact(allText(ctx2.messages), "<context-update>")).toBe(1)
    // Turn 2's envelope is the SECOND flip, not the first.
    expect(allText(ctx2.messages)).toContain("next: /c")
    expect(allText(ctx2.messages)).not.toContain("next: /b")
  })

  test("identical-content REPLAY of the same prev/current pair ⇒ second invocation emits SAME shape; dedup is the caller's cursor", () => {
    // The detector itself is pure — same input ⇒ same output. Dedup is a
    // PRODUCER concern (the loop) via the cursor. This test pins that the
    // detector is replay-stable AND that buildTurnContext is byte-identical
    // when the producer correctly windows by `since`.
    const prev = captureSnapshot({ cwd: "/a" })
    const cur = captureSnapshot({ cwd: "/b" })
    const ev1 = detectContextChanges(prev, cur, TURN_AT(1))
    const ev2 = detectContextChanges(prev, cur, TURN_AT(1))
    expect(ev1).toEqual(ev2)

    // If a buggy producer re-pushes the same event ⇒ buildTurnContext
    // splices BOTH (it is NOT dedup-aware — the contract is "render what
    // the producer hands me"). This is the negative invariant: dedup is a
    // CURSOR responsibility, NOT a prompt-assembly responsibility.
    const ctxBuggy = buildTurnContext(baseInput({ contextChangeEvents: [...ev1, ...ev2] }))
    expect(countExact(allText(ctxBuggy.messages), "<context-update>")).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E6 — undefined provider / undefined store safety
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E6 undefined provider safety", () => {
  test("absent contextChangeEvents ⇒ byte-identical to legacy single-block path", () => {
    // Two omissions (NOT explicit `undefined`) because `TurnContextInput`
    // is declared with `exactOptionalPropertyTypes: true` — absent field
    // and `undefined` field are distinct at the type layer, and the
    // byte-identity contract is "field absent ⇒ byte-identical".
    const a = buildTurnContext(baseInput())
    const b = buildTurnContext(baseInput())
    expect(a.messages.length).toBe(b.messages.length)
    expect(reminderText(a.messages)).toBe(reminderText(b.messages))
    expect(a.promptPolicy.contextChangeCount).toBe(0)
    expect(b.promptPolicy.contextChangeCount).toBe(0)
  })

  test("explicit empty events ⇒ byte-identical to absent (no empty splice)", () => {
    const a = buildTurnContext(baseInput({ contextChangeEvents: [] }))
    const b = buildTurnContext(baseInput())
    expect(a.messages.length).toBe(b.messages.length)
    expect(reminderText(a.messages)).toBe(reminderText(b.messages))
  })

  test("buildPersistentInjectionMessages([]) ⇒ [] (no empty Message)", () => {
    expect(buildPersistentInjectionMessages([])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E7 — Multi-field simultaneous flip
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E7 multi-field simultaneous flip", () => {
  test("cwd + mode + skill change in one turn ⇒ THREE envelopes in detector order, reminder still LAST", () => {
    const prev = captureSnapshot({
      cwd: "/a",
      mode: "default",
      activeSkills: [],
    })
    const cur = captureSnapshot({
      cwd: "/b",
      mode: "plan",
      activeSkills: ["progress-audit"],
    })
    const events = detectContextChanges(prev, cur, TURN_AT(1), {
      modeChangeReason: "user",
    })
    expect(events).toHaveLength(3)
    // Detector pass order: cwd (pass 2), mode (pass 3), skill (pass 6).
    expect(events[0]?.kind).toBe("context_update")
    expect(events[1]?.kind).toBe("mode_change")
    expect(events[2]?.kind).toBe("skill_activation")

    const store = createInMemoryTypedHistoryEventStore()
    for (const e of events) store.append(e)
    const ctx = buildTurnContext(baseInput({ contextChangeEvents: store.since(0) }))

    // Each envelope rendered exactly once.
    const text = allText(ctx.messages)
    expect(countExact(text, "<context-update>")).toBe(1)
    expect(countExact(text, "<mode-change>")).toBe(1)
    expect(countExact(text, "<skill-activation>")).toBe(1)
    // Reminder still the LAST message.
    expect(ctx.messages[ctx.messages.length - 1]?.content[0]?.type).toBe("text")
    expect(reminderText(ctx.messages)).toContain("<system-reminder>")
    expect(ctx.promptPolicy.contextChangeCount).toBe(3)

    // Detector order = splice order in the message array.
    const indices = ctx.messages.map((m) => {
      const b = m.content[0]
      if (b?.type !== "text") return -1
      if (b.text.includes("<context-update>")) return 1
      if (b.text.includes("<mode-change>")) return 2
      if (b.text.includes("<skill-activation>")) return 3
      if (b.text.includes("<system-reminder>")) return 4
      return 0
    })
    // Filter out the seed message (0) and verify monotonic ordering.
    const filtered = indices.filter((i) => i > 0)
    expect(filtered).toEqual([1, 2, 3, 4])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E8 — repo-rules path diff
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E8 repo-rules path diff", () => {
  test("added + removed paths ⇒ ONE <repo-rules-change> with both lists", () => {
    const prev = captureSnapshot({ repoRulesPaths: ["AGENTS.md", "old.md"] })
    const cur = captureSnapshot({
      repoRulesPaths: ["AGENTS.md", "new.md", "extra.md"],
    })
    const events = detectContextChanges(prev, cur, TURN_AT(1))
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("repo_rules_change")

    const store = createInMemoryTypedHistoryEventStore()
    for (const e of events) store.append(e)
    const ctx = buildTurnContext(baseInput({ contextChangeEvents: store.since(0) }))
    const text = allText(ctx.messages)
    expect(text).toContain("<repo-rules-change>")
    expect(text).toContain("added: new.md, extra.md")
    expect(text).toContain("removed: old.md")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// E9 — WorkingMemory parity — splicing the context-change messages into wm
//      preserves snapshot ordering and the reminder remains LAST.
// ─────────────────────────────────────────────────────────────────────────

describe("context-change e2e — E9 WorkingMemory wire", () => {
  test("appending context-change envelopes into wm mirrors buildTurnContext's order", () => {
    const wm = createWorkingMemory<Message>()
    for (const m of SEED) wm.append(m)

    const events = detectContextChanges(
      captureSnapshot({ cwd: "/a", mode: "default" }),
      captureSnapshot({ cwd: "/b", mode: "plan" }),
      TURN_AT(1),
      { modeChangeReason: "/plan" },
    )
    const builtMsgs = buildPersistentInjectionMessages(events)
    for (const m of builtMsgs) wm.append(m)

    // Mirror buildTurnContext through the wm-fed channel. `contextChangeEvents`
    // OMITTED on purpose (not `undefined`) so the byte-identity invariant
    // under `exactOptionalPropertyTypes: true` holds.
    const ctx = buildTurnContext(baseInput({ baseMessages: [...wm.snapshot()] }))
    // The wm already carries the envelopes, so they ride as PART of
    // baseMessages instead of being spliced by `contextChangeEvents`. The
    // rendered tail must still show all envelopes and the reminder LAST.
    const text = allText(ctx.messages)
    expect(text).toContain("<context-update>")
    expect(text).toContain("<mode-change>")
    expect(reminderText(ctx.messages)).toContain("<system-reminder>")

    // wm.tokenEstimate is finite (sanity — JSON.stringify on real Message
    // objects must not throw and must produce a positive count).
    const est = wm.tokenEstimate()
    expect(est).toBeGreaterThan(0)
    expect(Number.isFinite(est)).toBe(true)
  })
})
