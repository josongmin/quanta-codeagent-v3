import { describe, expect, it } from "bun:test"
import {
  type Candidate,
  ownerCoverageOf,
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

/** Fake generator from a fixed list; records the seeds it was asked for. */
const genFrom = (
  list: readonly Candidate[],
): { gen: SelectionPorts["generate"]; seeds: (string | undefined)[] } => {
  const seeds: (string | undefined)[] = []
  const gen: SelectionPorts["generate"] = async (i, seed) => {
    seeds.push(seed)
    return list[i] as Candidate
  }
  return { gen, seeds }
}

describe("ownerCoverageOf", () => {
  it("fraction of files that are owners; null when no files / no owners", () => {
    expect(ownerCoverageOf(["a.py", "b.py"], new Set(["a.py"]))).toBe(0.5)
    expect(ownerCoverageOf([], new Set(["a.py"]))).toBeNull()
    expect(ownerCoverageOf(["a.py"], new Set())).toBeNull()
  })
})

describe("runSelection", () => {
  it("CAUSE-vs-SYMPTOM: the candidate touching the closure owner file wins", async () => {
    // cand-0 fixates on the symptom file; cand-1 (owner-seeded) hits the root.
    const symptom = cand({
      id: "cand-0",
      files: ["blockmatrix.py"],
      patch: "+++ b/blockmatrix.py\n+x",
    })
    const root = cand({ id: "cand-1", files: ["matexpr.py"], patch: "+++ b/matexpr.py\n+y" })
    const { gen } = genFrom([symptom, root])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on matexpr.py"],
      owners: new Set(["matexpr.py"]), // closure ranked the root-cause file
      ports: { generate: gen },
    })
    expect(r.winner?.id).toBe("cand-1") // owner-coverage 1.0 beats 0.0
  })

  it("wiring-proof: each candidate is generated with its diversity seed", async () => {
    const { gen, seeds } = genFrom([
      cand({ id: "cand-0" }),
      cand({ id: "cand-1", files: ["y.py"] }),
    ])
    await runSelection({
      n: 2,
      seeds: [undefined, "Focus on y.py"],
      owners: new Set(["x.py"]),
      ports: { generate: gen },
    })
    expect(seeds).toEqual([undefined, "Focus on y.py"])
  })

  it("regression=false makes a candidate INADMISSIBLE (red-on-injection)", async () => {
    const a = cand({ id: "cand-0", files: ["x.py"], patch: "+++ b/x.py\n+aaa" })
    const b = cand({ id: "cand-1", files: ["x.py"], patch: "+++ b/x.py\n+bbb" })
    const { gen } = genFrom([a, b])
    // cand-0 regresses a test, cand-1 is clean → cand-1 must win even if equal otherwise.
    const ports: SelectionPorts = {
      generate: gen,
      regression: async (c) => (c.id === "cand-0" ? false : true),
    }
    const r = await runSelection({ n: 2, seeds: [undefined, undefined], owners: new Set(), ports })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(false)
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.admissible).toBe(true)
  })

  it("PAIRED control: regression port ABSENT ⇒ fail-open, candidates stay admissible", async () => {
    const { gen } = genFrom([cand({ id: "cand-0" })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen }, // no regression port
    })
    expect(r.scored[0]?.verdict.admissible).toBe(true)
  })

  it("best-effort fallback: ALL inadmissible ⇒ still returns a winner (never null)", async () => {
    // every candidate regresses → none admissible → selectBestEffort picks by score.
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+aaaa", files: ["x.py"] }),
      cand({ id: "cand-1", patch: "+++ b/y.py\n+a", files: ["y.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen, regression: async () => false },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).not.toBeNull() // hard gates inform but never submit nothing
    expect(r.winner?.id).toBe("cand-1") // smaller diff ⇒ higher minimality
  })

  it("dedup: identical patches collapse to one scored entry", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+same" }),
      cand({ id: "cand-1", patch: "+++ b/x.py\n+same" }), // dup content
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.generated).toBe(1)
    expect(r.scored).toHaveLength(1)
  })

  it("empty no-patch NEVER beats a real patch in best-effort (minimality must not reward size 0)", async () => {
    // both inadmissible (real regresses; empty has applyClean=false). The winner
    // must be the REAL candidate — an empty diff is a non-fix, not a "minimal" fix.
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [] }), // empty no-patch
      cand({ id: "cand-1", patch: "+++ b/x.py\n+real fix", files: ["x.py"] }), // real, but regresses
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen, regression: async (c) => (c.id === "cand-1" ? false : null) },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner?.id).toBe("cand-1") // real beats empty even when both inadmissible
  })

  it("empty (no-patch) candidate is inadmissible (applyClean=false)", async () => {
    const { gen } = genFrom([cand({ id: "cand-0", patch: "", files: [] })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(false)
  })
})
