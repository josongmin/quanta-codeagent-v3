import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { VERIFY_FORCE_MESSAGE } from "@/agent/verify-guard"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

/**
 * ★ CONTRACT (H6) — the Tier-0 verify-guard FORCED turn must NOT fabricate
 *   compaction-breaker strikes. The breaker's strike is a function of
 *   *compaction productivity* alone (`recordReactive(before, after)` in
 *   recovery-executor.ts L97 — drop < minProgressRatio ⇒ strike); it is
 *   recorded on the `compact` recovery action and is BLIND to *why* the loop
 *   re-streamed the model. The verify-guard adapter
 *   (src/agent/guards/verify-guard.ts L62-66) only `emit("unverified")` +
 *   appends the dropped finish + a small `metaUser(VERIFY_FORCE_MESSAGE)` and
 *   returns a SAME-TURN `CONTINUE`; it never touches `breaker`. So a strike
 *   taken *inside* a verify-forced re-stream is a TRUE thrash signal (the
 *   model's own large output PTL'd and the squeeze freed nothing), NOT an
 *   artifact of the forcing.
 *
 *   CORRECT-CONTRACT JUDGEMENT (code-grounded, not a heuristic):
 *   The breaker SHOULD count a no-progress reactive compaction that happens
 *   during a verify-forced re-stream, because:
 *     1. `breaker.noteProgress()` (turn-outcome.ts L82) — the ONLY strike reset
 *        on the loop side — fires only when a `tools` TurnResult LANDS at the
 *        loop level (runTurn returns `{kind:"tools"}`). A verify-forced
 *        re-stream stays INSIDE runTurn's `for(;;)` (same-turn-engine.ts L24-63)
 *        and lands NO tool, so strikes legitimately persist: an un-shrinkable
 *        prompt is un-shrinkable regardless of the forcing.
 *     2. The forcing message is ~340 chars (negligible vs. the >15% drop
 *        threshold on a >4000-token transcript), so the guard's OWN append
 *        cannot be what tips the squeeze into no-progress — the no-progress
 *        signal is the model's pre-existing un-summarizable payload.
 *   Therefore "verify-forced strike" is the SAME byte-path as an un-forced
 *   strike — this suite SEALS that equivalence (regression guard), it is NOT a
 *   bug fix. The discriminator (case 4) proves a verify-forced flow with a
 *   PRODUCTIVE squeeze does NOT trip — the breaker still discriminates thrash.
 *
 * HELLGATE — verify-guard FORCED turn × compaction-breaker COMPOSITION.
 *
 * Existing coverage (DO NOT duplicate):
 *  - `verify-guard-e2e.test.ts`: the guard's forcing / maxTrips / suppress
 *    wiring, NO breaker, NO PTL/compaction.
 *  - `breaker-e2e.test.ts` (GAP 1): repeated PTL, NO guard, cap=1 trip.
 *  - `breaker-x-recovery-hell-e2e.test.ts`: breaker × SAME-TURN recovery
 *    (nudge/backoff), NO verify-guard, NO mutating-edit precondition.
 *
 * The UNCOVERED DELTA proven here: an `edit` lands (a `tools` turn ⇒
 * `noteProgress` reset, strikes 0), THEN the model tries to finish UNVERIFIED,
 * the verify-guard forces an extra same-turn re-stream, and THAT forced
 * re-stream PTLs into a no-progress reactive compaction. We seal that:
 *   (a) the strike is taken correctly (cap=1 ⇒ the next PTL trips the breaker)
 *       and the run TERMINATES with `rapid_refill_breaker` — `withTimeout`
 *       proves no spin; the verify-forcing does NOT mask or duplicate it;
 *   (b) the breaker reason — not a verify-guard artifact — surfaces;
 *   (c) a PRODUCTIVE forced re-stream squeeze does NOT trip (discrimination);
 *   (d) guard OFF on the identical PTL script reaches the breaker by the SAME
 *       byte-path (no verify dependence in the strike accounting).
 *
 * compaction.ts / compaction-breaker.ts / verify-guard.ts are referenced
 * statically only — never mutated. Trip-case transcripts stay under
 * REACTIVE_MIN_INPUT_TOKENS handling the way the sibling breaker hellgate does:
 * the no-progress signal is the breaker's before/after estimate, isolated from
 * reactiveCompact's own drop-ratio fail-fast.
 */

// ── Scripted fake LLM: one Step per stream() call, last repeats ─────────────
type Step = { kind: "events"; events: StreamEvent[] } | { kind: "throw"; error: unknown }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted-test-model"
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const e of step.events) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

/** A PTL stream error → routes to the `compact` recovery action. */
const ptl = (): Step => thr(new LLMError("400 prompt is too long for this model"))

/** A short non-empty continuation summary: keeps `reactiveCompact` ok:true on a
 *  tiny transcript without meaningfully shrinking it ⇒ a NO-PROGRESS strike. */
const summary = (): Step => ev(text("<summary>resume</summary>"))

// ── Deterministic stub tools (no fs / no exec) ──────────────────────────────
const dispatched: string[] = []
const stubTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `stub ${name}`,
  inputSchema: z.any(),
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

/** A tiny multi-turn history (mirrors the sibling breaker hellgate's
 *  `tinyHistory`): >2 assistant turns so the FIRST findBoundary(keep=2) leaves a
 *  summarizable prefix (boundary>0), but small enough that estimateTokens<4000
 *  so reactiveCompact's GAP-2 drop-ratio fail-fast stays clear and the
 *  no-progress signal comes purely from the breaker estimate. The `edit` lands
 *  ON TOP of this seed, so by the time the model tries to finish there is a
 *  mutating tool in history for the verify-guard to fire on. */
const seedHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "u1 fix the bug" }] },
  { role: "assistant", content: [{ type: "text", text: "a1 looking" }] },
  { role: "user", content: [{ type: "text", text: "u2 context" }] },
  { role: "assistant", content: [{ type: "text", text: "a2 reading" }] },
  { role: "user", content: [{ type: "text", text: "u3 more context" }] },
  { role: "assistant", content: [{ type: "text", text: "a3 thinking" }] },
  { role: "user", content: [{ type: "text", text: "u4 current request" }] },
]

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: stubRegistry(),
  stream: new RecordingStream(),
  permission: { mode: "bypass" } as PermissionContext,
  messages: seedHistory(),
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 50, // ONLY the breaker can stop the trip cases (intra-turn).
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const errorEvent = (s: RecordingStream): { type: "error"; message: string } | undefined => {
  const e = s.events.find((ev) => ev.type === "error")
  return e?.type === "error" ? e : undefined
}

const countRecovery = (s: RecordingStream, reason: string): number =>
  s.events.filter((e) => e.type === "recovery" && e.reason === reason).length

const hasForcing = (messages: Message[]): boolean =>
  messages.some(
    (m) =>
      m.role === "user" &&
      m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE),
  )

describe("HELLGATE — verify-guard forced turn × compaction breaker composition", () => {
  /**
   * CASE 1 — HEADLINE. The verify-FORCED re-stream PTLs into a no-progress
   * reactive compaction; the breaker still trips and the run terminates.
   *
   *   call-1 edit (tools turn lands ⇒ runTurn returns {tools};
   *               resolveTurnLoopOutcome → breaker.noteProgress(), strikes 0)
   *   call-2 text "done" → finish attempt, NO verify since the edit ⇒
   *               verify-guard BLOCKS, emits "unverified", appends forcing,
   *               same-turn CONTINUE (NO turn increment, NO noteProgress)
   *   call-3 throw PTL  → compact: check() ok (strike 0), squeeze... (summary @4)
   *   call-4 summary    → recordReactive ⇒ NO-PROGRESS ⇒ strike 1 (== cap 1)
   *   call-5 throw PTL  → compact: check() ABORTS (1>=1). terminate.
   * = 5 LLM calls. The forcing is REAL (one "unverified" recovery) and the trip
   * is the BREAKER's, proving the verify-forcing neither masked nor fabricated
   * the strike. `withTimeout` proves no spin.
   */
  test("1. HEADLINE: edit → verify forces → forced re-stream PTL thrash ⇒ breaker trips, no spin", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })), // 1
      ev(text("All done, the fix is complete.")), //                  2 → forced
      ptl(), //                                                       3
      summary(), //                                                   4 → strike 1
      ptl(), //                                                       5 → aborts
      ev(text("should never be reached")),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          verifyGuard: { maxTrips: 2 },
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case1-forced-thrash-trips",
    )

    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(5)
    // The forcing genuinely fired (not skipped) — the strike happened DURING the
    // verify-forced same-turn re-stream.
    expect(hasForcing(out.messages)).toBe(true)
    expect(countRecovery(stream, "unverified")).toBe(1)
    // The COMPACTION-thrash breaker surfaced — not a verify-guard artifact.
    const err = errorEvent(stream)
    expect(err).toBeDefined()
    expect(err?.message).toContain("rapid_refill_breaker")
    expect(err?.message.toLowerCase()).toContain("reactive compaction")
    // The edit landed exactly once (the only tool dispatched); the forced
    // re-streams never landed a tool (so noteProgress never re-reset strikes).
    expect(dispatched).toEqual(["edit"])
  })

  /**
   * CASE 2 — STRIKE ACCOUNTING IS BLIND TO THE FORCING. Same PTL/summary thrash
   * script as CASE 1, but with the verify-guard CONFIG ABSENT. The model's
   * edit-then-finish would normally complete immediately (guard OFF), so we
   * instead drive the thrash from the start of a non-edit finish path: the trip
   * must be byte-identical to the guarded case's breaker behaviour. This isolates
   * "did the forcing change the strike accounting?" — it must NOT.
   *
   * Without the guard, call-2's "done" finishes the turn cleanly (a {completed}
   * turn), so to exercise the SAME thrash we PTL straight after the edit lands:
   *   call-1 edit → tools turn (noteProgress, strikes 0)
   *   call-2 throw PTL → compact ok (strike 0), summary @3
   *   call-3 summary  → NO-PROGRESS ⇒ strike 1 (cap)
   *   call-4 throw PTL → compact check() ABORTS. terminate.
   * = 4 calls. Same breaker reason, NO forcing event — proof the strike path is
   * the SAME with or without verify-forcing (the guard is orthogonal).
   */
  test("2. guard OFF, same thrash after edit ⇒ SAME breaker trip, zero forcing (strike path is guard-blind)", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })), // 1
      ptl(), //                                                       2
      summary(), //                                                   3 → strike 1
      ptl(), //                                                       4 → aborts
      ev(text("should never be reached")),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          // NO verifyGuard
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case2-guard-off-same-trip",
    )

    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(4)
    expect(hasForcing(out.messages)).toBe(false)
    expect(countRecovery(stream, "unverified")).toBe(0)
    const err = errorEvent(stream)
    expect(err).toBeDefined()
    expect(err?.message).toContain("rapid_refill_breaker")
    expect(dispatched).toEqual(["edit"])
  })

  /**
   * CASE 3 — RED-ON-INJECTION (regression sentinel). Removing the verify-guard
   * does NOT remove the breaker trip in CASE 1; conversely, removing the BREAKER
   * config from CASE 1's script must let the run SPIN past the strike point — so
   * the guard alone never trips on PTL. This asserts the breaker is the load-
   * bearing stopper: with the breaker DISABLED, the same edit→force→PTL→summary
   * thrash does NOT terminate at the strike; instead reactiveCompact's OWN
   * fail-fast on the 2nd squeeze (boundary<=0 after the first collapse) ends it
   * with a NON-breaker reason. If a future change made the verify-guard itself
   * abort on thrash, this case's reason would flip to the breaker text and go RED.
   */
  test("3. breaker DISABLED on the identical forced-thrash script ⇒ NOT a breaker abort (guard never trips on PTL)", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })), // 1
      ev(text("All done, the fix is complete.")), //                  2 → forced
      ptl(), //                                                       3
      summary(), //                                                   4
      ptl(), //                                                       5 → 2nd squeeze fail-fast
      ev(text("should never be reached")),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          verifyGuard: { maxTrips: 2 },
          // NO compactionBreaker
        }),
      ),
      15_000,
      "case3-no-breaker-no-breaker-abort",
    )

    // The forcing still fired (the guard is independent of the breaker).
    expect(hasForcing(out.messages)).toBe(true)
    expect(countRecovery(stream, "unverified")).toBe(1)
    // Whatever ends it, it is NOT the breaker — the verify-guard never aborts on
    // PTL thrash. (reactiveCompact's own fail-fast surfaces a non-breaker error.)
    const err = errorEvent(stream)
    if (err !== undefined) {
      expect(err.message).not.toContain("rapid_refill_breaker")
    }
    expect(dispatched).toEqual(["edit"])
  })

  /**
   * CASE 4 — DISCRIMINATOR. Same verify-FORCED flow, but the single reactive
   * compaction during the forced re-stream is PRODUCTIVE (a big summarizable
   * prefix collapses into a tiny `<summary>`, >15% drop) ⇒ `recordReactive`
   * RESETS the strike to 0 and the breaker NEVER trips. The next stream call is
   * a clean `end_turn` ⇒ the run COMPLETES. Same cap=1, opposite outcome: the
   * breaker discriminates THRASH from HEALTHY compaction even when the squeeze
   * happens inside a verify-forced re-stream — the forcing does not bias it.
   */
  test("4. DISCRIMINATOR: verify forces, forced re-stream squeeze is PRODUCTIVE ⇒ no trip, run completes", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const bigA = "A ".repeat(40_000)
    const bigB = "B ".repeat(40_000)
    // A big-prefix seed so ONE squeeze into a tiny <summary> is a >15% drop.
    const bigSeed: Message[] = [
      { role: "user", content: [{ type: "text", text: `prefix1 ${bigA}` }] },
      { role: "assistant", content: [{ type: "text", text: `prefix2 ${bigB}` }] },
      { role: "user", content: [{ type: "text", text: "u2 small" }] },
      { role: "assistant", content: [{ type: "text", text: "a2 small" }] },
      { role: "user", content: [{ type: "text", text: "u3 small" }] },
      { role: "assistant", content: [{ type: "text", text: "a3 small" }] },
      { role: "user", content: [{ type: "text", text: "current small request" }] },
    ]
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })), // 1
      ev(text("All done, the fix is complete.")), //                  2 → forced (unverified)
      ptl(), //                                                       3 → PTL on the forced re-stream
      summary(), //                                                   4 → summarizer call: PRODUCTIVE ⇒ strike reset
      ev(toolUse("t1", "test_runner", { suite: "nearest" })), //      5 → forced turn finally VERIFIES
      ev(text("Verified and truly done.", "end_turn")), //            6 → completes
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: bigSeed,
          verifyGuard: { maxTrips: 2 },
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case4-discriminator-productive",
    )

    expect(out.reason).toBe("completed")
    expect(errorEvent(stream)).toBeUndefined()
    // The forcing DID fire (the forced re-stream is where the squeeze happened).
    expect(hasForcing(out.messages)).toBe(true)
    expect(countRecovery(stream, "unverified")).toBeGreaterThanOrEqual(1)
    // Exactly one reactive compaction happened, productive ⇒ no breaker trip.
    expect(countRecovery(stream, "compact")).toBe(1)
    // The forced flow ultimately VERIFIED (test_runner) and completed — the
    // productive squeeze cleared the strike so the breaker never fired.
    expect(dispatched).toEqual(["edit", "test_runner"])
  })

  /**
   * CASE 5 — NORMAL (verify PASSES, no compaction): the happy path is wholly
   * unaffected by the breaker. edit → test_runner (verify after edit ⇒ guard
   * never blocks) → done. No PTL, no forcing, no breaker abort, no spin.
   */
  test("5. NORMAL: verify after edit ⇒ no forcing, no breaker involvement, completes clean", async () => {
    dispatched.length = 0
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })), // 1
      ev(toolUse("t1", "test_runner", { suite: "nearest" })), //      2 → verify
      ev(text("Tests pass. Done.", "end_turn")), //                   3
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          verifyGuard: { maxTrips: 2 },
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case5-normal-verify-passes",
    )

    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(3)
    expect(hasForcing(out.messages)).toBe(false)
    expect(countRecovery(stream, "unverified")).toBe(0)
    expect(errorEvent(stream)).toBeUndefined()
    expect(dispatched).toEqual(["edit", "test_runner"])
  })
})
