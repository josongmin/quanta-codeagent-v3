import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { Message } from "@/llm"
import { LLMError } from "@/shared"
import { cfg, ev, RecordingStream, ScriptedLLM, text, thr, withTimeout } from "./_harness"

/**
 * ★ CONTRACT — compaction thrash breaker (src/agent/compaction-breaker.ts,
 *   DEFAULT_COMPACTION_BREAKER_CAPS 3/0.15) is NOT masked by SAME-TURN recovery
 *   (max_tokens nudges, transient backoffs). Trip reason `rapid_refill_breaker`;
 *   `withTimeout` proves no infinite spin; maxTurns is NOT the savior.
 *   Discriminator: healthy compaction (≥15% progress) does NOT trip.
 *
 *   DISCOVERED BEHAVIOR (label inline):
 *   - Loop-reachable trip is at cap=1 because reactiveCompact's own fail-fast
 *     (boundary / drop-ratio) intercepts the 2nd squeeze before strike 3.
 *     Default cap=3 boundary is pinned at the unit layer
 *     (tests/unit/compaction-breaker-hellgate.test.ts) via the pure state
 *     machine. "Breaker NOT masked by recovery" is CONTRACT; cap=1-loop-
 *     reachable is CHARACTERIZATION of the reactiveCompact interaction.
 *
 * HELLGATE — compaction-thrash breaker × SAME-TURN recovery COMPOSITION.
 *
 * Existing coverage (DO NOT duplicate):
 *  - `breaker-e2e.test.ts` (GAP 1): repeated PTL, NO recovery interleave, cap=1
 *    ⇒ `rapid_refill_breaker`. Single-cause, shortest path.
 *  - `reactive-failfast-e2e.test.ts` (GAP 2): the `reactiveCompact` drop-ratio
 *    fail-fast branch with the breaker DISABLED.
 *  - `agent-recovery-e2e.test.ts`: backoff + max_tokens + malformed + empty
 *    stacked in single turns — but NEVER with PTL / reactive compaction, and
 *    never against the breaker.
 *
 * The UNCOVERED DELTA proven here: the SAME-TURN recovery budgets — max_tokens
 * "continue" nudges (`MAX_OUTPUT_CONTINUES`) and transient backoffs
 * (`MAX_TURN_STREAM_RETRIES`) — interleave WITHIN ONE TURN with the
 * `prompt_too_long → reactive compaction` thrash path WITHOUT resetting or
 * masking the reactive-thrash strike counter. A nudge appends a meta-user
 * message; a backoff sleeps; neither touches the breaker. Only a PRODUCTIVE
 * compaction (`recordReactive` saw ≥ minProgressRatio drop) or a landed TOOL
 * turn (`breaker.noteProgress()`, loop.ts ~L1601) clears strikes. So the
 * breaker still trips and the run TERMINATES — `withTimeout` proves no spin.
 *
 * ── STRUCTURAL FINDING (why every reachable trip here is at cap=1) ──────────
 * Through the REAL loop you cannot drive 3 consecutive `ok:true` no-progress
 * reactive strikes by replay: `reactiveCompact` collapses everything before
 * `findBoundary(keepTurns=2)` into ONE synthetic user message, leaving exactly
 * 2 assistant turns in the suffix. The NEXT reactive pass therefore finds
 * `boundary <= 0` ("no summarizable prefix") and returns `ok:false`, which ends
 * the run BEFORE the breaker can reach strike 3 (verified: a 3-PTL replay on a
 * big transcript errors on the 2nd PTL with that exact reason, not the
 * breaker). The default cap=3 boundary is pinned at the unit layer
 * (`tests/unit/compaction-breaker-hellgate.test.ts`, which feeds the pure state
 * machine directly). The LOOP-reachable contract — and the only place recovery
 * can interleave with a real strike before the trip — is cap=1, exercised here
 * from both sides (recovery BEFORE and AFTER the strike) plus a same-cap
 * productive control proving discrimination.
 *
 * compaction.ts is user-modified — referenced statically only, never mutated.
 * Transcripts in the trip cases stay under REACTIVE_MIN_INPUT_TOKENS (≈4000)
 * so `reactiveCompact`'s OWN drop-ratio fail-fast (GAP 2) never fires on the
 * first squeeze — the no-progress signal comes purely from the breaker's
 * before/after estimate, isolating the breaker contract from GAP 2.
 */

/** A PTL stream error (routes to the `compact` recovery action). */
const ptl = (): ReturnType<typeof thr> => thr(new LLMError("400 prompt is too long for this model"))

/** A transient stream error (routes to `backoff`, consumes a stream-retry). */
const transient = (tag: string): ReturnType<typeof thr> =>
  thr(new LLMError(`503 service unavailable ${tag}`))

/** A max_tokens stop (routes to a `nudge`, consumes an output-continue). */
const maxTokens = (t: string): ReturnType<typeof ev> => ev(text(t, "max_tokens"))

/** A short non-empty continuation summary: keeps `reactiveCompact` ok:true on a
 *  tiny transcript without meaningfully shrinking it ⇒ a NO-PROGRESS strike. */
const summary = (): ReturnType<typeof ev> => ev(text("<summary>resume</summary>"))

/** A tiny multi-turn history: >2 assistant turns so the FIRST
 *  `findBoundary(keep=2)` leaves a summarizable prefix (boundary>0), but small
 *  enough that estimateTokens < 4000 (the GAP-2 fail-fast floor stays clear).
 *  After one squeeze the prefix is gone — which is exactly why only the FIRST
 *  reactive compaction is `ok:true` (see the STRUCTURAL FINDING above). */
const tinyHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "u1" }] },
  { role: "assistant", content: [{ type: "text", text: "a1" }] },
  { role: "user", content: [{ type: "text", text: "u2" }] },
  { role: "assistant", content: [{ type: "text", text: "a2" }] },
  { role: "user", content: [{ type: "text", text: "u3" }] },
  { role: "assistant", content: [{ type: "text", text: "a3" }] },
  { role: "user", content: [{ type: "text", text: "u4 current" }] },
]

/** A big-prefix history: a large summarizable prefix (lives BEFORE the kept-2
 *  boundary) so ONE squeeze into a tiny `<summary>` is a large (>15%) drop =
 *  PROGRESS = strike reset. The retained suffix is small, so the GAP-2
 *  drop-ratio fail-fast does NOT mis-fire (the drop is genuinely large). */
const bigPrefixHistory = (): Message[] => {
  const bigA = "A ".repeat(40_000) // ~80k chars, summarizable prefix
  const bigB = "B ".repeat(40_000)
  return [
    { role: "user", content: [{ type: "text", text: `prefix1 ${bigA}` }] },
    { role: "assistant", content: [{ type: "text", text: `prefix2 ${bigB}` }] },
    { role: "user", content: [{ type: "text", text: "u2 small" }] },
    { role: "assistant", content: [{ type: "text", text: "a2 small" }] },
    { role: "user", content: [{ type: "text", text: "u3 small" }] },
    { role: "assistant", content: [{ type: "text", text: "a3 small" }] },
    { role: "user", content: [{ type: "text", text: "current small request" }] },
  ]
}

const errorEvent = (stream: RecordingStream): { type: "error"; message: string } | undefined => {
  const e = stream.events.find((ev) => ev.type === "error")
  return e?.type === "error" ? e : undefined
}

const countRecovery = (stream: RecordingStream, reason: string): number =>
  stream.events.filter((e) => e.type === "recovery" && e.reason === reason).length

describe("HELLGATE — compaction breaker × same-turn recovery composition", () => {
  /**
   * CASE 1 — INTERLEAVE, recovery wedged AFTER the strike, BEFORE the trip
   * (the headline). In one turn:
   *   1 throw PTL        → compact, check ok (strike 0), squeeze... (summary @2)
   *   2 summary          → recordReactive ⇒ NO-PROGRESS ⇒ strike 1 (== cap 1)
   *   3 max_tokens "p1"  → nudge  (outputContinues 0→1); strike UNCHANGED
   *   4 throw 503 "t1"   → backoff (streamRetries 0→1);   strike UNCHANGED
   *   5 throw PTL        → compact, check() ABORTS (1>=1). terminate.
   * = 5 stream calls. If the nudge/backoff had reset or masked the strike, the
   * 5th PTL's pre-squeeze check would NOT abort and the run would spin until
   * `withTimeout`. It must abort with the breaker reason.
   */
  test("1. INTERLEAVE (recovery after strike): PTL → nudge → backoff → PTL ⇒ breaker still trips, no spin", async () => {
    const llm = new ScriptedLLM([
      ptl(), //           1
      summary(), //       2  → strike 1 (cap)
      maxTokens("p1"), // 3  → nudge
      transient("t1"), // 4  → backoff
      ptl(), //           5  → check() aborts
      ev(text("should never be reached")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: tinyHistory(),
          maxTurns: 50, // ONLY the breaker can stop this (see case 4).
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case1-interleave-after-strike",
    )

    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(5)
    const err = errorEvent(stream)
    expect(err).toBeDefined()
    // The COMPACTION-thrash breaker fired — not a backoff/nudge exhaustion.
    expect(err?.message).toContain("rapid_refill_breaker")
    expect(err?.message.toLowerCase()).toContain("reactive compaction")
    // The interleave genuinely happened (recovery is real, not skipped):
    expect(countRecovery(stream, "nudge")).toBe(1)
    expect(countRecovery(stream, "backoff")).toBe(1)
    // SAME-TURN budgets (3 each) were NOT exhausted (1 used each), so recovery
    // running dry did NOT end the run — the breaker did.
    expect(out.turns).toBe(0)
  })

  /**
   * CASE 2 — INTERLEAVE, recovery wedged BEFORE the strike. Proves the strike
   * counter is not perturbed by recovery actions that precede it either:
   *   1 max_tokens "p1"  → nudge   (outputContinues 0→1)
   *   2 throw 503 "t1"   → backoff (streamRetries 0→1)
   *   3 throw PTL        → compact, check ok (strike 0), squeeze... (summary @4)
   *   4 summary          → recordReactive ⇒ NO-PROGRESS ⇒ strike 1 (== cap 1)
   *   5 throw PTL        → compact, check() ABORTS (1>=1). terminate.
   * = 5 stream calls. Same trip, recovery on the other side of the strike.
   */
  test("2. INTERLEAVE (recovery before strike): nudge → backoff → PTL → PTL ⇒ breaker still trips", async () => {
    const llm = new ScriptedLLM([
      maxTokens("p1"), // 1  → nudge
      transient("t1"), // 2  → backoff
      ptl(), //           3
      summary(), //       4  → strike 1 (cap)
      ptl(), //           5  → check() aborts
      ev(text("should never be reached")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: tinyHistory(),
          maxTurns: 50,
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case2-interleave-before-strike",
    )

    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(5)
    const err = errorEvent(stream)
    expect(err).toBeDefined()
    expect(err?.message).toContain("rapid_refill_breaker")
    expect(err?.message.toLowerCase()).toContain("reactive compaction")
    expect(countRecovery(stream, "nudge")).toBe(1)
    expect(countRecovery(stream, "backoff")).toBe(1)
    expect(out.turns).toBe(0)
  })

  /**
   * CASE 3 — CONTROL / discriminator at the SAME cap=1. Identical breaker
   * config as cases 1 & 2, but the single reactive compaction ACTUALLY MAKES
   * PROGRESS (a large prefix collapses into a tiny `<summary>`, > 15% drop), so
   * `recordReactive` RESETS the strike to 0 and the breaker NEVER trips. The
   * next stream call returns a clean `end_turn` ⇒ the run COMPLETES.
   *
   * Same cap, opposite outcome — proving the breaker discriminates THRASH
   * (cases 1/2: no-progress squeeze ⇒ trip) from HEALTHY compaction (here:
   * productive squeeze ⇒ no trip). It is NOT "trip after N compactions
   * regardless".
   */
  test("3. CONTROL (same cap=1): a PRODUCTIVE compaction ⇒ breaker does NOT trip, run completes", async () => {
    const llm = new ScriptedLLM([
      ptl(), //                            1
      summary(), //                        2  → productive squeeze ⇒ strike RESET
      ev(text("done — final answer", "end_turn")), // 3 → completes
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: bigPrefixHistory(),
          maxTurns: 50,
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case3-control-progress",
    )

    expect(out.reason).toBe("completed")
    expect(errorEvent(stream)).toBeUndefined()
    // 1 reactive compaction happened (named in the recovery trace), yet because
    // it was productive the cap-1 breaker did NOT trip — discrimination.
    expect(countRecovery(stream, "compact")).toBe(1)
    // A real model turn landed.
    expect(llm.calls).toBe(3)
    expect(out.turns).toBe(1)
  })

  /**
   * CASE 4 — maxTurns is NOT what saved it (the discriminator for cases 1 & 2).
   * The trip happens WITHIN one turn's inner recovery loop — PTL/nudge/backoff
   * never increment `turn` — so even with maxTurns set to the TIGHTEST value
   * (1) the BREAKER, not the turn budget, surfaces the error. A `max_turns`
   * outcome would report `reason:"max_turns"` and `turns:1`; we assert neither.
   */
  test("4. maxTurns did NOT save it: trip is intra-turn, breaker reason surfaces, turns=0", async () => {
    const llm = new ScriptedLLM([
      ptl(), //     1
      summary(), // 2  → strike 1 (cap)
      ptl(), //     3  → check() aborts pre-squeeze
      ev(text("should never be reached")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: tinyHistory(),
          maxTurns: 1, // tightest possible turn budget
          compactionBreaker: { caps: { maxConsecutiveReactive: 1 } },
        }),
      ),
      15_000,
      "case4-not-maxturns",
    )

    expect(out.reason).toBe("error")
    expect(out.reason).not.toBe("max_turns")
    expect(llm.calls).toBe(3) // throw, summary, throw → abort pre-squeeze
    const err = errorEvent(stream)
    expect(err).toBeDefined()
    // If maxTurns had stopped it, the error reason would NOT be the breaker's.
    expect(err?.message).toContain("rapid_refill_breaker")
    // The whole spin lived inside ONE turn's recovery loop — zero productive
    // turns consumed.
    expect(out.turns).toBe(0)
  })
})
