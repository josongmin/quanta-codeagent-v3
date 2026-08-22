import { describe, expect, it } from "bun:test"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  patch: `+++ b/x.py\n+changed`,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
  ...over,
})

/** Generate a fresh candidate per index (distinct sizes so the dedup set keeps
 *  both — this exercises the relative minimality recompute path). */
const genN = (n: number): SelectionPorts["generate"] => {
  const list = Array.from({ length: n }, (_, i) =>
    cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${"x".repeat(i)}`, files: ["x.py"] }),
  )
  return async (i) => list[i] as Candidate
}

/** Counting wrapper for the EXPENSIVE candidate-only probe ports. Each port
 *  records how many times it was invoked per candidate id, so a memo regression
 *  (re-running scoreOne for the same candidate in finalize after the early-gate
 *  probe already ran it) shows up as a count of 2 instead of 1. */
const countingPorts = (
  resolvedKofN: (c: Candidate) => { votes: number; k: number },
): {
  ports: Pick<SelectionPorts, "applyClean" | "regression" | "resolvedKofN">
  counts: Map<string, { applyClean: number; regression: number; resolvedKofN: number }>
} => {
  const counts = new Map<string, { applyClean: number; regression: number; resolvedKofN: number }>()
  const bump = (id: string, key: "applyClean" | "regression" | "resolvedKofN"): void => {
    const c = counts.get(id) ?? { applyClean: 0, regression: 0, resolvedKofN: 0 }
    c[key] += 1
    counts.set(id, c)
  }
  return {
    counts,
    ports: {
      applyClean: async (c) => {
        bump(c.id, "applyClean")
        return true
      },
      regression: async (c) => {
        bump(c.id, "regression")
        return true
      },
      resolvedKofN: async (c) => {
        bump(c.id, "resolvedKofN")
        return resolvedKofN(c)
      },
    },
  }
}

describe("bugbash #7: earlyAccept memoizes scoreOne (no double pytest/repro)", () => {
  it("TEETH: each expensive probe port runs ONCE per candidate when the early gate is NOT cleared", async () => {
    // earlyAccept is ON but the closure owner is `other.py`, so the generated
    // candidates (touching x.py) never satisfy fullyInsideOwners ⇒ no early stop
    // ⇒ finalize re-scores every deduped candidate. Pre-fix that re-score reran
    // every port a 2nd time (the discarded early-gate verdict was not cached);
    // post-fix the memo makes each port fire exactly once per candidate.
    const { ports, counts } = countingPorts(() => ({ votes: 1, k: 1 }))
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on x.py"],
      owners: new Set(["other.py"]), // candidates touch x.py ⇒ never owner-scoped
      earlyAccept: true,
      ports: { generate: genN(2), ...ports },
    })
    expect(r.earlyAccepted).toBe(false) // gate never cleared, full N generated
    for (const id of ["cand-0", "cand-1"]) {
      const c = counts.get(id)
      expect(c).toEqual({ applyClean: 1, regression: 1, resolvedKofN: 1 })
    }
  })

  it("TEETH: even the EARLY-ACCEPTED winner is probed once, not re-probed in finalize", async () => {
    // cand-0 clears the gate ⇒ earlyAccept fires ⇒ finalize(raw, true) re-scores
    // the single raw candidate. Pre-fix that finalize pass reran cand-0's ports a
    // second time; post-fix the early-gate probe is reused.
    const { ports, counts } = countingPorts(() => ({ votes: 1, k: 1 }))
    const r = await runSelection({
      n: 3,
      seeds: [undefined, "Focus on y.py", "Focus on z.py"],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: { generate: genN(3), ...ports },
    })
    expect(r.earlyAccepted).toBe(true)
    expect(r.winner?.id).toBe("cand-0")
    expect(counts.get("cand-0")).toEqual({ applyClean: 1, regression: 1, resolvedKofN: 1 })
    expect(counts.size).toBe(1) // later candidates never generated/probed
  })

  it("PAIRED control: memoized selection result is byte-identical to the non-earlyAccept run", async () => {
    // Same ports, same candidates: turning earlyAccept on (memoized path) must not
    // change the winner / admissible verdicts vs the plain N-best finalize path.
    const mk = (): SelectionPorts => ({
      generate: genN(3),
      applyClean: async () => true,
      regression: async () => true,
      // cand-1 has the strongest resolved signal but cand-0 still owner-covers;
      // both admissible — the relative minimality recompute decides ranking.
      resolvedKofN: async () => ({ votes: 1, k: 1 }),
    })
    const owners = new Set(["x.py"])
    // earlyAccept OFF ⇒ scoreOne computed fresh, no memo — the reference outcome.
    const reference = await runSelection({
      n: 1, // n=1 so no early stop confounds the comparison; pure scoring path
      seeds: [undefined],
      owners,
      ports: mk(),
    })
    const memoized = await runSelection({
      n: 1,
      seeds: [undefined],
      owners,
      earlyAccept: true,
      ports: mk(),
    })
    expect(memoized.winner?.id).toBe(reference.winner?.id)
    expect(
      memoized.scored.map((s) => [s.candidate.id, s.verdict.admissible, s.verdict.score]),
    ).toEqual(reference.scored.map((s) => [s.candidate.id, s.verdict.admissible, s.verdict.score]))
  })
})
