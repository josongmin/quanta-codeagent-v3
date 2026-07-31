/**
 * ★ CONTRACT — Composition of FallbackLLM (src/llm/fallback.ts) × verify-guard
 *   (src/agent/verify-guard.ts, ADR-0067) × closeout in ONE `runAgent` run.
 *   - Per-switch stream_reset tombstone: dead partials from N intermediate
 *     providers must each be tombstoned; single-tombstone would LEAK b1, c1...
 *     (proven adversarially in the unit fallback-hellgate).
 *   - Fallback recovery does NOT bypass verify-guard: a fallback-swapped edit
 *     still requires a real test command afterward to satisfy the gate.
 *
 *   DISCOVERED BEHAVIOR (label inline):
 *   - FallbackLLM is STATELESS per turn — the loop calls .stream() per turn and
 *     FallbackLLM restarts at providers[0]. Turn independence is CONTRACT;
 *     exact .calls counts per turn are CHARACTERIZATION.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { VERIFY_FORCE_MESSAGE } from "@/agent/verify-guard"
import { FallbackLLM, type LLMPort, type Message, type StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"
import { withTimeout } from "./_harness"

/**
 * CROSS-SUBSYSTEM HELLGATE (e2e) — provider fallback (`FallbackLLM`
 * `stream_reset` tombstone) × verify-guard forcing × closeout, all in ONE real
 * `runAgent` run.
 *
 * The headline question this suite answers — which NEITHER
 * `fallback-tombstone-e2e.test.ts` (proves the tombstone discard alone, single
 * 1-turn run, no quality gate) NOR `verify-guard-hellgate-e2e.test.ts` (proves
 * the gate alone, with a plain `ScriptedLLM`, no provider swap) covers — is:
 *
 *   "Does a mid-stream provider swap (overload 529 → fallback) COMPOSE with the
 *    verify gate, or does fallback recovery silently bypass the gate?"
 *
 * Concretely: provider A streams a partial assistant text + an `edit` tool_use
 * then 529s; provider B re-streams the SAME turn (the loop sees one `stream()`
 * per turn — FallbackLLM swaps internally and prefixes B's output with a single
 * `{ type: "stream_reset" }` tombstone). The loop's `streamingTurn` must:
 *   (1) discard A's dead partial so the assembled assistant message contains
 *       ONLY B's content, AND
 *   (2) STILL run the verify-guard against B's surviving `edit` — so a later
 *       finish-after-only-`git status` is forced into an extra turn until a
 *       real `pytest`/`test_runner` runs.
 *
 * If (2) fails — the gate does NOT fire after a fallback swap — that is a REAL
 * composition bug (fallback recovery laundering an unverified edit past the
 * quality gate). The CONTROL case (3, no swap) makes the tombstone count in
 * case 1 non-vacuous; case 4 proves a PRE-yield swap is fully transparent.
 *
 * `stream_reset` is NOT a distinct `AgentEvent` (it lives only in the per-turn
 * `rawEvents` consumed by `assembleFromEvents`); the observable proof of "how
 * many tombstones surfaced" is therefore (a) per-provider `.calls` counters
 * (how many providers were driven) PLUS (b) assembled-content discrimination
 * (each dead partial's marker text is ABSENT). Both together pin the count.
 */

// ── scripted providers (LLMPort doubles fed to FallbackLLM) ──────────────────

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** A 529 overload that `isFallbackTrigger` matches unconditionally. */
const overload529 = (): LLMError => {
  const e = new LLMError("529 Overloaded", { kind: "overloaded", statusCode: 529 })
  ;(e as unknown as { status: number }).status = 529
  return e
}

/** Yields the given events, then throws (a mid-stream provider death). */
class PartialThenThrow implements LLMPort {
  readonly model = "primary-model"
  calls = 0
  constructor(
    private readonly partial: StreamEvent[],
    private readonly error: unknown,
  ) {}
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    for (const e of this.partial) yield e
    throw this.error
  }
}

/** Throws BEFORE yielding anything (pre-yield death → transparent swap). */
class ThrowBeforeYield implements LLMPort {
  readonly model = "primary-model"
  calls = 0
  constructor(private readonly error: unknown) {}
  // biome-ignore lint/correctness/useYield: intentionally throws before any yield
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    throw this.error
  }
}

/**
 * Scripted multi-turn provider: one `events[]` per `stream()` call, last
 * repeats. Used for the SURVIVING provider that has to play several turns
 * (edit → finish → forced verify → finish) across the chain case.
 */
class ScriptedProvider implements LLMPort {
  readonly model = "fallback-model"
  calls = 0
  constructor(private readonly steps: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const step = this.steps[this.calls] ?? this.steps[this.steps.length - 1]
    this.calls += 1
    if (!step) throw new LLMError("script exhausted")
    for (const e of step) yield e
  }
}

// ── stub tools the verify-guard can inspect ──────────────────────────────────

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const dispatched: string[] = []
// Concrete passthrough object (NOT z.any()): preserves the `command` field the
// fake LLM sends, which the verify-guard gate inspects, while still producing a
// real object JSON-schema at registry-build time.
const stubTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `stub ${name}`,
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  async *execute() {
    dispatched.push(name)
    yield { type: "result", result: { ok: true, output: `${name} ok` } }
  },
})

const stubRegistry = (): ToolRegistry =>
  new ToolRegistry([
    stubTool("read", true),
    stubTool("edit", false),
    stubTool("write", false),
    stubTool("test_runner", false),
    stubTool("bash", false),
  ])

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: stubRegistry(),
  stream: new RecordingStream(),
  permission: { mode: "bypass" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 8,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

// ── observers ────────────────────────────────────────────────────────────────

const assistantText = (messages: Message[]): string =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")

const toolUseSequence = (messages: Message[]): string[] =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.name))

const forcingCount = (messages: Message[]): number =>
  messages.filter(
    (m) =>
      m.role === "user" &&
      m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE),
  ).length

const hasForcing = (messages: Message[]): boolean => forcingCount(messages) > 0

const recoveryUnverified = (stream: RecordingStream): number =>
  stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified").length

describe("HELLGATE e2e — FallbackLLM tombstone × verify-guard × closeout compose", () => {
  test("CASE 1: A streams partial+edit then 529 ⇒ B's edit kept, A's dead partial discarded, edit still dispatches", async () => {
    dispatched.length = 0
    const primary = new PartialThenThrow(
      [
        { type: "text_delta", delta: "DEAD-PARTIAL-A: about to edit, trust me" },
        { type: "tool_use_start", id: "deadE", name: "edit" },
      ],
      overload529(),
    )
    // B re-streams the turn: a clean text + the surviving edit. Then finishes
    // with a real test_runner so the verify-guard is satisfied (no forcing here
    // — case 1 isolates the tombstone-discard composition, case 2 the gate).
    const fallback = new ScriptedProvider([
      [
        { type: "text_delta", delta: "LIVE-B answer kept" },
        { type: "tool_use_start", id: "liveE", name: "edit" },
        { type: "tool_use_end", id: "liveE", input: { path: "/x.ts", patch: "real fix" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      toolUse("t1", "test_runner", { suite: "all" }),
      text("Done."),
    ])

    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "case1-tombstone-discard",
    )

    expect(out.reason).toBe("completed")
    // FallbackLLM is STATELESS across turns: it always starts at provider[0],
    // so the primary is driven (and 529s → swaps) on EVERY turn, not just turn 1.
    // 3 turns here (edit → test_runner → finish) ⇒ primary called 3×, each turn
    // re-tombstoning its fresh dead partial and B re-streaming. That the gate and
    // assembly stay correct under a per-turn swap is exactly the composition proof.
    expect(primary.calls).toBe(3)
    expect(fallback.calls).toBe(3)
    // Only B's content survived assembly — A's dead partial is gone.
    const all = assistantText(out.messages)
    expect(all).toContain("LIVE-B answer kept")
    expect(all).not.toContain("DEAD-PARTIAL-A")
    // The dead `edit` tool_use from A must NOT have dispatched; only B's edit.
    // Sequence: [edit (from B), test_runner]. Exactly ONE edit, not two.
    expect(toolUseSequence(out.messages)).toEqual(["edit", "test_runner"])
    expect(dispatched).toEqual(["edit", "test_runner"])
    // EXACTLY ONE tombstone surfaced: one provider (A) yielded a partial then
    // failed, so the surviving stream is prefixed with one stream_reset. The
    // proof is structural — A's marker absent + B's present + single edit.
    expect(all.match(/DEAD-PARTIAL/g)).toBeNull()
  })

  test("CASE 2: CHAIN — fallback-swapped edit then ONLY `git status` ⇒ verify-guard STILL forces; real test releases", async () => {
    dispatched.length = 0
    const primary = new PartialThenThrow(
      [
        { type: "text_delta", delta: "DEAD-PARTIAL-A before swap" },
        { type: "tool_use_start", id: "deadE", name: "edit" },
      ],
      overload529(),
    )
    // Turn 1 (on B, after swap): the edit lands.
    // Turn 2: lying finish after ONLY git status → MUST be forced.
    // Turn 3 (the git status turn) — wait: model issues git status as a turn,
    //   then a lying finish, then forced extra turn runs a real pytest, then done.
    const fallback = new ScriptedProvider([
      // turn 1 — the swapped-in edit (this turn is the one A died on)
      [
        { type: "text_delta", delta: "LIVE-B: applying the fix" },
        { type: "tool_use_start", id: "liveE", name: "edit" },
        { type: "tool_use_end", id: "liveE", input: { path: "/x.ts", patch: "fix" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      // turn 2 — a lying "verification" that is NOT a test
      toolUse("b1", "bash", { command: "git status" }),
      // turn 3 — naive finish attempt → verify-guard forces an extra turn
      text("All done, fix is complete."),
      // turn 4 (FORCED) — a real pytest satisfies the gate
      toolUse("b2", "bash", { command: "python -m pytest -q" }),
      // turn 5 — finish, now released
      text("Verified for real, done."),
    ])

    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "case2-fallback-then-verify-force",
    )

    expect(out.reason).toBe("completed")
    // Stateless FallbackLLM ⇒ the primary 529s and swaps on EVERY turn. 5 turns
    // (edit → git status → forced finish → pytest → finish) ⇒ primary called 5×.
    // The gate composing correctly DESPITE a swap on every single turn is the point.
    expect(primary.calls).toBe(5)
    // THE HEADLINE: fallback recovery did NOT bypass the gate. The model
    // attempted to finish after edit + git-status; the guard forced exactly one
    // extra turn (recovery:unverified emitted once, VERIFY_FORCE_MESSAGE injected).
    expect(hasForcing(out.messages)).toBe(true)
    expect(forcingCount(out.messages)).toBe(1)
    expect(recoveryUnverified(stream)).toBe(1)
    // The dead partial is still gone after the swap.
    expect(assistantText(out.messages)).not.toContain("DEAD-PARTIAL-A")
    // The real pytest is what released the gate; both bash calls dispatched.
    expect(toolUseSequence(out.messages)).toEqual(["edit", "bash", "bash"])
    expect(dispatched).toEqual(["edit", "bash", "bash"])
    // fallback driven 5 turns; the forced extra turn pushed it past the naive
    // first-finish count (turn 3) — proof the gate added a turn.
    expect(fallback.calls).toBe(5)
    expect(fallback.calls).toBeGreaterThan(3)
  })

  test("CASE 3: CONTROL — A succeeds first try (no swap) + real test ⇒ ZERO tombstone, normal completion", async () => {
    dispatched.length = 0
    // Primary that simply succeeds — never throws, never swaps.
    const primary = new ScriptedProvider([
      [
        { type: "text_delta", delta: "PRIMARY answer, no swap" },
        { type: "tool_use_start", id: "e1", name: "edit" },
        { type: "tool_use_end", id: "e1", input: { path: "/x.ts", patch: "fix" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      toolUse("t1", "test_runner", { suite: "all" }),
      text("Done."),
    ])
    // A fallback that MUST NEVER be reached.
    const fallback = new ScriptedProvider([text("FALLBACK-SHOULD-NOT-RUN")])

    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "case3-control-no-swap",
    )

    expect(out.reason).toBe("completed")
    expect(fallback.calls).toBe(0) // fallback never engaged → ZERO swaps
    const all = assistantText(out.messages)
    expect(all).toContain("PRIMARY answer, no swap")
    expect(all).not.toContain("FALLBACK-SHOULD-NOT-RUN")
    // No tombstone could have surfaced (no swap). edit + real test → no forcing.
    expect(hasForcing(out.messages)).toBe(false)
    expect(forcingCount(out.messages)).toBe(0)
    expect(recoveryUnverified(stream)).toBe(0)
    expect(toolUseSequence(out.messages)).toEqual(["edit", "test_runner"])
    expect(dispatched).toEqual(["edit", "test_runner"])
  })

  test("CASE 4: PRE-YIELD swap transparency — A 529s BEFORE yielding ⇒ transparent swap, no tombstone, normal run", async () => {
    dispatched.length = 0
    const primary = new ThrowBeforeYield(overload529())
    const fallback = new ScriptedProvider([
      [
        { type: "text_delta", delta: "B answer (transparent swap)" },
        { type: "tool_use_start", id: "e1", name: "edit" },
        { type: "tool_use_end", id: "e1", input: { path: "/x.ts", patch: "fix" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      toolUse("t1", "test_runner", { suite: "all" }),
      text("Done."),
    ])

    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })),
      15_000,
      "case4-preyield-transparent",
    )

    expect(out.reason).toBe("completed")
    // Pre-yield death on EVERY turn (stateless swap): 3 turns ⇒ primary 3×, and
    // each swap is transparent (no partial was yielded before the throw).
    expect(primary.calls).toBe(3)
    expect(fallback.calls).toBe(3)
    // Pre-yield death → no prior partial → NO stream_reset. Assembly is clean by
    // construction; B's content is the whole message. There is nothing to discard
    // and (critically) no spurious tombstone that would have reset B's own stream.
    const all = assistantText(out.messages)
    expect(all).toContain("B answer (transparent swap)")
    // The verify gate still operates normally on the transparently-swapped turn:
    // edit + real test_runner → satisfied, no forcing.
    expect(hasForcing(out.messages)).toBe(false)
    expect(recoveryUnverified(stream)).toBe(0)
    expect(toolUseSequence(out.messages)).toEqual(["edit", "test_runner"])
    expect(dispatched).toEqual(["edit", "test_runner"])
  })
})
