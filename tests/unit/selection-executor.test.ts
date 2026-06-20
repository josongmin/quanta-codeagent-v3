import { describe, expect, it } from "bun:test"
import {
  type Candidate,
  ownerCoverageOf,
  runSelection,
  type SelectionPorts,
  summarizeSelection,
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
      regression: async (c) => c.id !== "cand-0",
    }
    const r = await runSelection({ n: 2, seeds: [undefined, undefined], owners: new Set(), ports })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(false)
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.admissible).toBe(true)
  })

  it("resolvedKofN default mode is hard: insufficient resolved votes reject", async () => {
    const { gen } = genFrom([cand({ id: "cand-0" })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen, resolvedKofN: async () => ({ votes: 0, k: 1 }) },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(false)
  })

  it("resolvedKofN soft mode gives positive credit without hard-rejecting false negatives", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/a.py\n+x", files: ["a.py"] }),
      cand({ id: "cand-1", patch: "+++ b/b.py\n+x", files: ["b.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      resolvedKofNMode: "soft",
      ports: {
        generate: gen,
        resolvedKofN: async (c) => (c.id === "cand-0" ? { votes: 0, k: 1 } : { votes: 1, k: 1 }),
      },
    })
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(true)
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.reasons).toContain(
      "soft:voterQuorum=1",
    )
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

  it("no-oracle mode: repro authority absent does not reject when other gates are green", async () => {
    const { gen } = genFrom([cand({ id: "cand-0", baseValidatedRed: null })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen, regression: async () => true },
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

  it("DEFECT2: same content edit on DIFFERENT files is NOT deduped (cross-file collision)", async () => {
    const { gen } = genFrom([
      cand({
        id: "cand-0",
        patch: "--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-x=1\n+x=2",
        files: ["foo.py"],
      }),
      cand({
        id: "cand-1",
        patch: "--- a/bar.py\n+++ b/bar.py\n@@ -1 +1 @@\n-x=1\n+x=2",
        files: ["bar.py"],
      }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.generated).toBe(2) // different fix SITES must survive dedup
  })

  it("empty patch with (stray) owner files still scores no ownerCoverage", async () => {
    // defense-in-depth: an empty no-patch must never gain owner-coverage credit.
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: ["owner.py"] }), // inconsistent but hardened
      cand({ id: "cand-1", patch: "+++ b/other.py\n+real", files: ["other.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["owner.py"]),
      // both inadmissible (real regresses; empty applyClean=false) ⇒ best-effort,
      // where the empty's bogus ownerCoverage would win if not hardened.
      ports: { generate: gen, regression: async (c) => (c.id === "cand-1" ? false : null) },
    })
    expect(r.winner?.id).toBe("cand-1") // real beats empty even though empty "touches" the owner
  })

  it("concurrency caps in-flight generate() calls (never exceeds the limit)", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 8)) // force overlap
      inFlight -= 1
      return cand({ id: `cand-${i}`, patch: `+++ b/f${i}.py\n+x${i}`, files: [`f${i}.py`] })
    }
    const r = await runSelection({
      n: 6,
      seeds: Array(6).fill(undefined),
      owners: new Set(),
      ports: { generate: gen },
      concurrency: 2,
    })
    expect(maxInFlight).toBe(2) // bounded by the cap
    expect(r.generated).toBe(6) // all candidates still produced
  })

  it("concurrency default (1) ⇒ strictly sequential (max in-flight 1)", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 4))
      inFlight -= 1
      return cand({ id: `cand-${i}`, patch: `+++ b/f${i}.py\n+x${i}`, files: [`f${i}.py`] })
    }
    await runSelection({
      n: 4,
      seeds: Array(4).fill(undefined),
      owners: new Set(),
      ports: { generate: gen }, // no concurrency ⇒ default 1
    })
    expect(maxInFlight).toBe(1)
  })

  it("concurrency preserves INDEX order for dedup determinism (first-by-index wins)", async () => {
    // cand-0 and cand-2 share content; with index-ordered collection, cand-0
    // (lower index) is kept regardless of which finishes first.
    const gen: SelectionPorts["generate"] = async (i) => {
      // make the LATER index finish FIRST to prove order is by index, not timing
      await new Promise((r) => setTimeout(r, i === 0 ? 12 : 1))
      const dup = i === 0 || i === 2
      return cand({
        id: `cand-${i}`,
        patch: dup ? "+++ b/same.py\n+dup" : `+++ b/f${i}.py\n+x${i}`,
        files: dup ? ["same.py"] : [`f${i}.py`],
      })
    }
    const r = await runSelection({
      n: 3,
      seeds: Array(3).fill(undefined),
      owners: new Set(),
      ports: { generate: gen },
      concurrency: 3,
    })
    expect(r.generated).toBe(2) // cand-0/cand-2 dedup to one
    expect(r.scored.map((s) => s.candidate.id)).toEqual(["cand-0", "cand-1"]) // cand-0 kept, index order
  })

  it("candidate generation failure does not abort selection when another candidate succeeds", async () => {
    const gen: SelectionPorts["generate"] = async (i) => {
      if (i === 0) throw new Error("candidate 0 failed")
      return cand({ id: "cand-1", patch: "+++ b/ok.py\n+fix", files: ["ok.py"] })
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.attempted).toBe(2)
    expect(r.successfulGenerations).toBe(1)
    expect(r.generationFailures).toBe(1)
    expect(r.generated).toBe(1)
    expect(r.scored).toHaveLength(1)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("all candidate generation failures degrade to empty selection instead of throwing", async () => {
    const gen: SelectionPorts["generate"] = async () => {
      throw new Error("all failed")
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
      concurrency: 2,
    })
    expect(r.attempted).toBe(2)
    expect(r.successfulGenerations).toBe(0)
    expect(r.generationFailures).toBe(2)
    expect(r.generated).toBe(0)
    expect(r.scored).toHaveLength(0)
    expect(r.winner).toBeNull()
  })

  it("summarizeSelection: compact eval-only telemetry (files + verdict, NO patch) for diagnosis", async () => {
    // the cause-vs-symptom diagnostic: which sites the candidates spanned + who won.
    const { gen } = genFrom([
      cand({ id: "cand-0", files: ["blockmatrix.py"], patch: "+++ b/blockmatrix.py\n+sym" }),
      cand({ id: "cand-1", files: ["matexpr.py"], patch: "+++ b/matexpr.py\n+root" }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on matexpr.py"],
      owners: new Set(["matexpr.py"]),
      ports: { generate: gen },
    })
    const t = summarizeSelection(r)
    expect(t.attempted).toBe(2)
    expect(t.successfulGenerations).toBe(2)
    expect(t.generationFailures).toBe(0)
    expect(t.generated).toBe(2)
    expect(t.winnerId).toBe("cand-1") // owner-coverage winner
    expect(t.candidates.map((c) => c.id)).toEqual(["cand-0", "cand-1"])
    expect(t.candidates[0]?.files).toEqual(["blockmatrix.py"])
    expect(t.candidates[1]?.files).toEqual(["matexpr.py"])
    // no full patch leaked into telemetry
    expect(JSON.stringify(t)).not.toContain("+++")
    // reasons carry the WHY (soft signals fired for the admissible winner)
    expect(t.candidates[1]?.reasons.some((x) => x.startsWith("soft:ownerCoverage"))).toBe(true)
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
