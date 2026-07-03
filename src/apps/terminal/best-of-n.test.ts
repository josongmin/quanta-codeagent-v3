/**
 * Lever #3 — best-of-N FAIR selector unit hellgate (RFC jul-2-terminal-bench-levers/04).
 *
 * PURE selector ({@link selectBestCandidate}): asserts the FAIR, no-leak ranking
 *   verified-pass > unverifiable > verified-fail,
 * the tie-breaks (clean-vs-nudged stamp; observed-exercise count; attempt-1 floor), the R5 floor
 * (a later candidate never displaces attempt-1 unless STRICTLY better), and the CARDINAL no-leak
 * invariant: a candidate whose "exercise" was a bare HIDDEN-TEST invocation is NOT credited with a
 * stronger tie-break score (reuses the verify-gate's test-path rejection via `deriveCandidateStamp` /
 * the shared classifier — the selector has no path to the hidden verifier).
 *
 * Surface-isolation: stays inside `src/apps/terminal/**` — imports only the two lever modules +
 * `@/stream` types.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import { type BestOfNCandidate, deriveCandidateStamp, selectBestCandidate } from "./best-of-n"
import type { VerificationStamp } from "./verify-gate"

const stamp = (state: VerificationStamp["state"], followUpFired?: boolean): VerificationStamp => ({
  state,
  evidence: `evidence for ${state}`,
  ...(followUpFired !== undefined ? { followUpFired } : {}),
})

/** A candidate whose events contain one observed `container_exec` running a produced deliverable. */
const exerciseEvents = (command: string, id = "c1"): readonly AgentEvent[] => [
  { type: "tool_call", id, name: "container_exec", input: { command } } as AgentEvent,
  {
    type: "tool_result",
    id,
    name: "container_exec",
    ok: true,
    preview: "output",
    exitCode: 0,
  } as AgentEvent,
]

describe("best-of-N fair selector — ranking", () => {
  test("prefers verified-pass over unverifiable over verified-fail (strict order)", () => {
    const candidates: BestOfNCandidate[] = [
      { stamp: stamp("verified-fail") }, // attempt 1
      { stamp: stamp("unverifiable") }, // attempt 2
      { stamp: stamp("verified-pass") }, // attempt 3 — the fair winner
    ]
    const sel = selectBestCandidate(candidates)
    expect(sel.winnerIndex).toBe(2)
    expect(sel.winnerState).toBe("verified-pass")
    // A scripted fake-green (a candidate that only CLAIMED success but is verified-fail) is NOT picked.
    expect(sel.winnerIndex).not.toBe(0)
  })

  test("verified-pass beats verified-fail even when the fail is attempt-1 (the f2p lever fires)", () => {
    // attempt-1 failed its own reference-comparison; attempt-2 passed → best-of-N flips it to the win.
    const sel = selectBestCandidate([
      { stamp: stamp("verified-fail") },
      { stamp: stamp("verified-pass") },
    ])
    expect(sel.winnerIndex).toBe(1)
    expect(sel.winnerState).toBe("verified-pass")
  })

  test("a candidate with NO stamp is treated as unverifiable (no invented pass, but beats verified-fail)", () => {
    const sel = selectBestCandidate([{ stamp: stamp("verified-fail") }, {}])
    expect(sel.winnerIndex).toBe(1) // no-stamp (=unverifiable) outranks verified-fail
    expect(sel.winnerState).toBe("unverifiable")
    // …but a no-stamp candidate does NOT beat a real verified-pass.
    const sel2 = selectBestCandidate([{ stamp: stamp("verified-pass") }, {}])
    expect(sel2.winnerIndex).toBe(0)
  })
})

describe("best-of-N fair selector — R5 attempt-1 floor (never lower single-attempt)", () => {
  test("an EQUAL-signal later candidate does NOT displace attempt-1", () => {
    const sel = selectBestCandidate([
      { stamp: stamp("verified-pass") },
      { stamp: stamp("verified-pass") },
    ])
    expect(sel.winnerIndex).toBe(0) // exact tie ⇒ attempt-1 keeps the win
  })

  test("N=1 identity: a single candidate is always the winner", () => {
    const sel = selectBestCandidate([{ stamp: stamp("verified-fail") }])
    expect(sel.winnerIndex).toBe(0)
    expect(sel.winnerState).toBe("verified-fail")
  })

  test("empty candidate set throws (a best-of-N run always yields ≥1)", () => {
    expect(() => selectBestCandidate([])).toThrow()
  })
})

describe("best-of-N fair selector — tie-breaks (same fair state)", () => {
  test("a stamp earned WITHOUT a follow-up nudge beats one earned only AFTER the nudge", () => {
    // Both verified-pass; attempt-2 was clean (no nudge) → strictly stronger evidence → wins.
    const sel = selectBestCandidate([
      { stamp: stamp("verified-pass", true) }, // attempt-1 needed the nudge
      { stamp: stamp("verified-pass", false) }, // attempt-2 exercised cleanly
    ])
    expect(sel.winnerIndex).toBe(1)
    // …and a clean attempt-1 is NOT displaced by a nudged attempt-2 (R5 floor holds under tie-break).
    const sel2 = selectBestCandidate([
      { stamp: stamp("verified-pass", false) },
      { stamp: stamp("verified-pass", true) },
    ])
    expect(sel2.winnerIndex).toBe(0)
  })

  test("with equal state + equal cleanliness, MORE observed exercises in the candidate's own stream wins", () => {
    const one = exerciseEvents("./solver a.txt", "x1")
    const two: readonly AgentEvent[] = [
      ...exerciseEvents("./solver a.txt", "x1"),
      // a GENUINE second run of the deliverable (NOT `pytest …` — P2-B: a test-runner is not an
      // exercise, so it can no longer inflate the tie-break; see the no-leak test below).
      ...exerciseEvents("./solver b.txt", "x2"),
    ]
    const sel = selectBestCandidate([
      { stamp: stamp("verified-pass", false), events: one },
      { stamp: stamp("verified-pass", false), events: two },
    ])
    expect(sel.winnerIndex).toBe(1)
  })
})

describe("best-of-N fair selector — CARDINAL no-leak (never credit a hidden-test peek)", () => {
  test("a candidate whose only 'exercise' is reading a bare hidden test is NOT credited an exercise count", () => {
    // `cat tests/hidden/expected.txt` / `ls tests/` are NOT exercises (verify-gate fail-closed: they
    // inspect a hidden test rather than RUN the produced deliverable) → evidence count 0 → this
    // candidate does NOT out-tiebreak a genuine deliverable run.
    const peeker: readonly AgentEvent[] = [
      {
        type: "tool_call",
        id: "p1",
        name: "container_exec",
        input: { command: "cat tests/hidden/expected.txt" },
      } as AgentEvent,
      {
        type: "tool_result",
        id: "p1",
        name: "container_exec",
        ok: true,
        preview: "42",
        exitCode: 0,
      } as AgentEvent,
    ]
    const genuine = exerciseEvents("./solver input.txt", "g1")
    // Both stamped verified-pass + clean; only the tie-break evidence count differs. The genuine
    // deliverable run (attempt-2) must win — the peeker's test-read earns ZERO exercise credit.
    const sel = selectBestCandidate([
      { stamp: stamp("verified-pass", false), events: peeker }, // attempt-1: test-peek → count 0
      { stamp: stamp("verified-pass", false), events: genuine }, // attempt-2: real run → count 1
    ])
    expect(sel.winnerIndex).toBe(1)
  })

  test("deriveCandidateStamp reuses the verify-gate: a test-peek trajectory is NOT verified-pass", () => {
    // A run that only `cat`s a hidden test file never RAN its deliverable → the fair signal is
    // unverifiable, NOT a claimed pass. This proves the selector's per-candidate stamp derivation
    // routes through the fail-closed gate (no hidden-test path to a pass).
    const peekOnly: readonly AgentEvent[] = [
      {
        type: "tool_call",
        id: "p1",
        name: "container_exec",
        input: { command: "cat tests/hidden/expected.txt" },
      } as AgentEvent,
      {
        type: "tool_result",
        id: "p1",
        name: "container_exec",
        ok: true,
        preview: "42",
        exitCode: 0,
      } as AgentEvent,
    ]
    const s = deriveCandidateStamp(peekOnly, "The expected output is 42, so I'm confident.")
    expect(s.state).toBe("unverifiable")

    // Contrast: a run that COMPARED its output to a (non-test) reference + observed a match is
    // verified-pass. (verify-gate v2 requires an observed L1 comparison — a bare `./solver` RUN with no
    // diff is only L0 ⇒ unverifiable; the legit pass must diff against a task-provided reference.)
    const s2 = deriveCandidateStamp(
      exerciseEvents("diff out.txt reference.txt"),
      "Output matches the reference.",
    )
    expect(s2.state).toBe("verified-pass")
  })
})
