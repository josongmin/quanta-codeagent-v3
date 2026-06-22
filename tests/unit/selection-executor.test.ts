import { describe, expect, it } from "bun:test"
import {
  buildCandidateReviewLlmEvidencePacket,
  type LlmEvidencePacket,
} from "@/runner/batch/eval/llm-evidence-packet"
import {
  buildMultiSiteFamilyContract,
  buildOwnerMustTouchContracts,
} from "@/runner/batch/eval/public-contract-bundle"
import {
  buildSelectionInputs,
  type Candidate,
  filesFromPatch,
  normalizeSelectionPath,
  normalizeSelectionPaths,
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

const patchForFiles = (files: readonly string[]): string =>
  files
    .map((file) =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    )
    .join("\n")

describe("ownerCoverageOf", () => {
  it("fraction of files that are owners; null when no files / no owners", () => {
    expect(ownerCoverageOf(["a.py", "b.py"], new Set(["a.py"]))).toBe(0.5)
    expect(ownerCoverageOf([], new Set(["a.py"]))).toBeNull()
    expect(ownerCoverageOf(["a.py"], new Set())).toBeNull()
  })
})

describe("selection input canonicalization", () => {
  it("normalizes repo paths before they become ownerCoverage authority", () => {
    const sandbox = "/tmp/work/repo"
    expect(normalizeSelectionPath("/tmp/work/repo/./sympy/core/function.py", sandbox)).toBe(
      "sympy/core/function.py",
    )
    expect(normalizeSelectionPath("./sympy/core/function.py", sandbox)).toBe(
      "sympy/core/function.py",
    )
    expect(normalizeSelectionPath("/other/repo/sympy/core/function.py", sandbox)).toBeNull()
    expect(normalizeSelectionPath("../escape.py", sandbox)).toBeNull()
  })

  it("ADVERSARIAL: real repo paths beginning with a/ or b/ stay distinct owner authority", () => {
    const sandbox = "/tmp/work/repo"
    expect(normalizeSelectionPath("a/pkg/file.py", sandbox)).toBe("a/pkg/file.py")
    expect(normalizeSelectionPath("b/pkg/file.py", sandbox)).toBe("b/pkg/file.py")
    expect(
      filesFromPatch(
        "--- a/a/pkg/file.py\n+++ b/a/pkg/file.py\n+changed\n--- a/b/pkg/file.py\n+++ b/b/pkg/file.py\n+changed",
      ),
    ).toEqual(["a/pkg/file.py", "b/pkg/file.py"])
  })

  it("dedupes normalized owner candidates and seeds from canonical file names", () => {
    const inputs = buildSelectionInputs({
      n: 4,
      sandbox: "/tmp/work/repo",
      ownerCandidates: [
        "/tmp/work/repo/sympy/core/function.py",
        "./sympy/core/function.py",
        "./sympy/core/evalf.py",
      ],
    })
    expect(inputs.ownerFiles).toEqual(["sympy/core/function.py", "sympy/core/evalf.py"])
    expect([...inputs.owners]).toEqual(["sympy/core/function.py", "sympy/core/evalf.py"])
    expect(inputs.seeds[0]).toBeUndefined()
    expect(inputs.seeds[1]).toContain("`sympy/core/function.py`")
    expect(inputs.seeds[2]).toContain("`sympy/core/evalf.py`")
    expect(inputs.seeds[3]).toBeUndefined()
  })

  it("family coverage seeds start after cand0 baseline and carry typed provenance", () => {
    const inputs = buildSelectionInputs({
      n: 3,
      sandbox: "/tmp/work/repo",
      ownerCandidates: ["./pkg/base.py"],
      candidateFamilies: {
        families: [
          {
            familyId: "symptom-owner",
            ownerFiles: ["./pkg/symptom.py"],
            reason: "symptom family",
            seed: undefined,
            sourceEvidence: ["static-symbol-witness"],
          },
          {
            familyId: "multi-site",
            ownerFiles: ["./pkg/base.py", "./pkg/backend.py"],
            reason: "shared symbol family",
            seed: "cover shared symbol",
            sourceEvidence: ["static-symbol-witness"],
          },
        ],
      },
    })

    expect(inputs.seeds[0]).toBeUndefined()
    expect(inputs.candidateFamilies[1]?.familyId).toBe("multi-site")
    expect(inputs.candidateFamilies[2]?.familyId).toBe("symptom-owner")
    expect(inputs.seeds[1]).toContain("`multi-site`")
    expect(inputs.seeds[1]).toContain("`pkg/base.py`")
    expect(inputs.ownerFiles).toEqual(["pkg/base.py", "pkg/backend.py", "pkg/symptom.py"])
  })

  it("single family seed is emitted once, then legacy owner diversity resumes", () => {
    const inputs = buildSelectionInputs({
      n: 4,
      sandbox: "/tmp/work/repo",
      ownerCandidates: ["./pkg/root.py", "./pkg/other.py"],
      candidateFamilies: {
        families: [
          {
            familyId: "multi-site",
            ownerFiles: ["./pkg/base.py", "./pkg/backend.py"],
            reason: "shared symbol family",
            seed: "cover shared symbol",
            sourceEvidence: ["static-symbol-witness"],
          },
        ],
      },
    })

    expect(inputs.candidateFamilies.map((family) => family?.familyId ?? null)).toEqual([
      null,
      "multi-site",
      null,
      null,
    ])
    expect(inputs.seeds[1]).toContain("`multi-site`")
    expect(inputs.seeds[2]).toContain("`pkg/other.py`")
    expect(inputs.seeds[3]).toContain("`pkg/base.py`")
  })

  it("extracts candidate files from diff headers through the same canonicalizer", () => {
    expect(
      filesFromPatch("--- a/./sympy/core/function.py\n+++ b/sympy/core/function.py\n+changed"),
    ).toEqual(["sympy/core/function.py"])
    expect(normalizeSelectionPaths(["./a.py", "/dev/null"], undefined)).toEqual(["a.py"])
  })

  it("parses git-quoted diff headers without losing the task file authority", () => {
    expect(
      filesFromPatch(
        [
          'diff --git "a/src/space name.ts" "b/src/space name.ts"',
          '--- "a/src/space name.ts"',
          '+++ "b/src/space name.ts"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    ).toEqual(["src/space name.ts"])
  })

  it("falls back to diff --git post-image for pure rename patches", () => {
    expect(
      filesFromPatch(
        [
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
        ].join("\n"),
      ),
    ).toEqual(["src/new.ts"])
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

  it("MESSAGE-FORMAT: declared-expected signal beats smaller scalar-only near-miss", async () => {
    const scalarOnly = cand({
      id: "cand-0",
      files: ["astropy/timeseries/core.py"],
      patch:
        "+++ b/astropy/timeseries/core.py\n" +
        "-.format(self.__class__.__name__, required_columns[0], plural, self.colnames[0])\n" +
        "+.format(self.__class__.__name__, required_columns[0], plural, self.colnames[:len(required_columns)])\n",
    })
    const fullPrefix = cand({
      id: "cand-1",
      files: ["astropy/timeseries/core.py"],
      patch:
        "+++ b/astropy/timeseries/core.py\n" +
        "+def as_scalar_or_list_str(obj):\n" +
        "+    if len(obj) == 1:\n" +
        "+        return f\"'{obj[0]}'\"\n" +
        "+    return str(obj)\n" +
        "+.format(self.__class__.__name__, as_scalar_or_list_str(required_columns), plural,\n" +
        "+        as_scalar_or_list_str(self.colnames[:len(required_columns)]))\n",
    })
    const { gen } = genFrom([scalarOnly, fullPrefix])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["astropy/timeseries/core.py"]),
      ports: {
        generate: gen,
        declaredExpected: async (c) => c.id === "cand-1",
      },
    })
    expect(r.winner?.id).toBe("cand-1")
    const nearMiss = r.scored.find((s) => s.candidate.id === "cand-0")?.verdict
    expect(nearMiss?.admissible).toBe(false)
    expect(nearMiss?.reasons).toContain("soft:declaredExpectedMatch=0")
    expect(nearMiss?.reasons).toContain(
      "hard:declaredExpectedMatch=false (candidate contradicts issue-declared expected behavior)",
    )
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.reasons).toContain(
      "soft:declaredExpectedMatch=1",
    )
  })

  it("declared-expected=false is not resurrected by best-effort fallback", async () => {
    const wrong = cand({
      id: "cand-0",
      files: ["astropy/timeseries/core.py"],
      patch:
        "+++ b/astropy/timeseries/core.py\n" +
        "-expected '{}' and found '{}'\n" +
        "+expected '{}' and found '{}'.format(required_columns, self.colnames[:len(required_columns)])\n",
    })
    const { gen } = genFrom([wrong])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(["astropy/timeseries/core.py"]),
      ports: {
        generate: gen,
        declaredExpected: async () => false,
      },
    })
    expect(r.winner).toBeNull()
    expect(r.admissibleCount).toBe(0)
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:declaredExpectedMatch=false (candidate contradicts issue-declared expected behavior)",
    )
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

  it("repairs family candidates once when generated patch misses structural owner coverage", async () => {
    const seeds: (string | undefined)[] = []
    let familyCalls = 0
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      if (i === 1) {
        familyCalls += 1
        return familyCalls === 1
          ? cand({ id: "cand-1", files: ["pkg/base.py"], patch: "+++ b/pkg/base.py\n+partial" })
          : cand({
              id: "cand-1",
              files: ["pkg/base.py", "pkg/backend.py"],
              patch: "+++ b/pkg/base.py\n+base\n+++ b/pkg/backend.py\n+backend",
            })
      }
      return cand({ id: "cand-0", files: ["pkg/other.py"] })
    }

    const r = await runSelection({
      n: 2,
      seeds: [undefined, "family seed"],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      candidateFamilies: [
        undefined,
        {
          familyId: "multi-site",
          ownerFiles: ["pkg/base.py", "pkg/backend.py"],
          reason: "shared symbol",
          seed: undefined,
          sourceEvidence: ["static-symbol-witness"],
        },
      ],
      ports: { generate: gen },
    })

    const repaired = r.scored.find((entry) => entry.candidate.id === "cand-1")?.candidate
    expect(familyCalls).toBe(2)
    expect(seeds[2]).toContain("Previous attempt missed required family owner files")
    expect(seeds[2]).toContain("`pkg/backend.py`")
    expect(repaired?.files).toEqual(["pkg/base.py", "pkg/backend.py"])
  })

  it("clean mode can derive a structural family from cand0 and upgrade it with candidate-local contracts", async () => {
    const seeds: (string | undefined)[] = []
    let calls = 0
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      calls += 1
      return calls === 1
        ? cand({
            id: "cand-0",
            patch: patchForFiles(["pkg/postgresql/client.py"]),
            files: ["pkg/postgresql/client.py"],
          })
        : cand({
            id: "cand-0",
            patch: patchForFiles(["pkg/base/client.py", "pkg/postgresql/client.py"]),
            files: ["pkg/base/client.py", "pkg/postgresql/client.py"],
          })
    }

    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/base/client.py", "pkg/postgresql/client.py"]),
      ports: {
        generate: gen,
        deriveCandidateStructuralRepair: async () => ({
          family: {
            familyId: "override-family",
            ownerFiles: ["pkg/base/client.py", "pkg/postgresql/client.py"],
            reason: "shared override family",
            seed: undefined,
            sourceEvidence: ["static-witness:ast"],
          },
          publicContracts: {
            contracts: buildMultiSiteFamilyContract([
              "pkg/base/client.py",
              "pkg/postgresql/client.py",
            ]),
          },
        }),
      },
    })

    expect(seeds).toHaveLength(2)
    expect(seeds[1]).toContain("Previous attempt missed required family owner files")
    expect(r.winner?.files).toEqual(["pkg/base/client.py", "pkg/postgresql/client.py"])
    expect(r.scored[0]?.requiredContractsSatisfied).toBeGreaterThan(0)
    expect(r.scored[0]?.verdict.reasons).not.toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
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

  it("smoke=false makes a candidate INADMISSIBLE (public hot-path breakage)", async () => {
    const a = cand({ id: "cand-0", files: ["x.py"], patch: "+++ b/x.py\n+aaa" })
    const b = cand({ id: "cand-1", files: ["x.py"], patch: "+++ b/x.py\n+bbb" })
    const { gen } = genFrom([a, b])
    const ports: SelectionPorts = {
      generate: gen,
      smoke: async (c) => c.id !== "cand-0",
    }
    const r = await runSelection({ n: 2, seeds: [undefined, undefined], owners: new Set(), ports })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(false)
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).toContain(
      "hard:smokeGreen=false (candidate broke a public smoke)",
    )
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

  it("resolvedKofN hard reject is not resubmitted as best-effort", async () => {
    const { gen } = genFrom([cand({ id: "cand-0", patch: "+++ b/a.py\n+x", files: ["a.py"] })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen, resolvedKofN: async () => ({ votes: 0, k: 1 }) },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-0")
  })

  it("ADVERSARIAL: malformed hard resolved payload cannot pass as admissible", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/a.py\n+x", files: ["a.py"] }),
      cand({ id: "cand-1", patch: "+++ b/b.py\n+y", files: ["b.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: {
        generate: gen,
        resolvedKofN: async (c) => (c.id === "cand-0" ? { votes: 0, k: 0 } : { votes: 1, k: 1 }),
      },
    })
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(false)
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.admissible).toBe(true)
    expect(r.winner?.id).toBe("cand-1")
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
    // bugbash #31: voterQuorum is the consensus ratio votes/k squashed by
    // r/(r+1) so super-quorum stays distinguishable from exact quorum. votes=1,
    // k=1 ⇒ ratio 1 ⇒ 1/(1+1) = 0.5 (was clamped to 1 before the fix).
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.reasons).toContain(
      "soft:voterQuorum=0.5",
    )
  })

  it("clean lex uses soft resolvedKofN as positive proofStrength, not only hard gates", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/a.py\n+small", files: ["a.py"] }),
      cand({
        id: "cand-1",
        patch: "+++ b/b.py\n+larger\n+but\n+validated",
        files: ["b.py"],
      }),
    ])
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(),
      resolvedKofNMode: "soft",
      ports: {
        generate: gen,
        resolvedKofN: async (c) => (c.id === "cand-1" ? { votes: 1, k: 1 } : { votes: 0, k: 1 }),
      },
    })

    expect(r.winner?.id).toBe("cand-1")
  })

  it("proof-required mode blocks safety-only regression candidates and reports proof_required_missing", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+safe_only", files: ["x.py"] }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      proofRequired: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: gen,
        regression: async () => true,
      },
    })

    expect(r.winner).toBeNull()
    expect(r.proofRequired).toBe(true)
    expect(r.noWinnerReason).toBe("proof_required_missing")
    expect(r.scored[0]?.verdict.admissible).toBe(false)
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:proofRequiredMissing=true (proof-required mode requires positive executed proof; safety or structural evidence alone cannot submit)",
    )
    expect(summarizeSelection(r).candidates[0]?.proofState).toBe("safety_only")
  })

  it("proof-required mode treats MWE execution_failed as infra_blocked instead of candidate-positive", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+maybe_fix", files: ["x.py"] }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      proofRequired: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: gen,
        mweProof: async () => ({ state: "execution_failed" }),
      },
    })

    expect(r.winner).toBeNull()
    expect(r.noWinnerReason).toBe("proof_infra_blocked")
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:proofInfraBlocked=true (public proof execution failed; do not treat this as candidate correctness)",
    )
    expect(summarizeSelection(r).candidates[0]?.proofState).toBe("infra_blocked")
  })

  it("repair seed preserves proofInfraBlocked as execution_failed instead of collapsing it to not_run", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return i === 2
        ? cand({
            id: "cand-2",
            patch: patchForFiles(["pkg/a.py"]),
            files: ["pkg/a.py"],
          })
        : cand({
            id: `cand-${i}`,
            patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
            files: ["pkg/a.py", "pkg/b.py"],
          })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      proofRequired: true,
      problemStatement: "Public issue text for proof infra failure.",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: {
        generate: gen,
        mweProof: async () => ({ state: "execution_failed" }),
      },
    })

    expect(r.winner).toBeNull()
    expect(r.noWinnerReason).toBe("proof_infra_blocked")
    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain('"stage": "repair_seed"')
    expect(seeds[2]).toContain('"source": "public_mwe"')
    expect(seeds[2]).toContain("proofInfraBlocked")
    expect(seeds[2]).toContain('"state": "execution_failed"')
  })

  it("proof-required mode appends one bounded repair candidate for contract-only evidence", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return cand({
        id: `cand-${i}`,
        patch: patchForFiles(["pkg/owner.py"]),
        files: ["pkg/owner.py"],
      })
    }
    const r = await runSelection({
      n: 1,
      mode: "clean",
      proofRequired: true,
      problemStatement: "Public issue text for a proof-required contract-only miss.",
      verificationTarget: {
        primaryRail: { kind: "repro", cmd: "python repro.py" },
        required: [{ kind: "repro", cmd: "python repro.py" }],
        optional: [],
        baseValidatedRed: true,
      },
      publicContracts: {
        contracts: buildOwnerMustTouchContracts(["pkg/owner.py"]),
      },
      seeds: [undefined],
      owners: new Set(["pkg/owner.py"]),
      ports: { generate: gen },
    })

    expect(r.winner).toBeNull()
    expect(r.noWinnerReason).toBe("proof_required_missing")
    expect(seeds).toHaveLength(2)
    expect(seeds[1]).toContain('"stage": "repair_seed"')
    expect(seeds[1]).toContain('"verificationTarget"')
    expect(seeds[1]).toContain("proofRequiredMissing")
    expect(seeds[1]).toContain("no_positive_executed_public_proof_attached")
    expect(seeds[1]).toContain("owner-must-touch:pkg/owner.py")
    expect(seeds[1]).not.toContain("requiredContractsSatisfied=1")
  })

  it("proof-required mode bypasses blind staticAccept and keeps searching through finalize", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+unguarded", files: ["x.py"] }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      proofRequired: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: { generate: gen },
    })

    expect(r.winner).toBeNull()
    expect(r.proofRequired).toBe(true)
    expect(r.noWinnerReason).toBe("proof_required_missing")
  })

  it("clean mode appends one MWE repair candidate when all generated candidates are candidate_red", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return cand({
        id: `cand-${i}`,
        patch: `+++ b/x.py\n+fix${i}`,
        files: ["x.py"],
      })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: gen,
        mweProof: async (c) => ({
          state: c.id === "cand-2" ? "patched_green" : "candidate_red",
        }),
      },
    })

    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain("public issue MWE")
    expect(r.winner?.id).toBe("cand-2")
    expect(r.scored.find((s) => s.candidate.id === "cand-2")?.candidate.mweReceipt?.state).toBe(
      "patched_green",
    )
  })

  it("clean mode enriches MWE repair with missed family coverage guidance", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      if (i === 0) {
        return cand({
          id: "cand-0",
          patch: patchForFiles(["pkg/unrelated.py"]),
          files: ["pkg/unrelated.py"],
        })
      }
      if (i === 1) {
        return cand({
          id: "cand-1",
          patch:
            "diff --git a/pkg/unrelated.py b/pkg/unrelated.py\n--- a/pkg/unrelated.py\n+++ b/pkg/unrelated.py\n@@ -1,1 +1,2 @@\n-old\n+new\n+family_attempt",
          files: ["pkg/unrelated.py"],
          familyId: "unique-owner",
          familyReason: "single authoritative owner",
          familyOwnerFiles: ["pkg/owner.py"],
        })
      }
      return cand({
        id: "cand-2",
        patch: patchForFiles(["pkg/owner.py"]),
        files: ["pkg/owner.py"],
      })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/owner.py"]),
      ports: {
        generate: gen,
        mweProof: async (c) => ({
          state: c.id === "cand-2" ? "patched_green" : "candidate_red",
        }),
      },
    })

    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain("Previous attempt missed required family owner files")
    expect(seeds[2]).toContain("`pkg/owner.py`")
    expect(r.winner?.id).toBe("cand-2")
  })

  it("clean mode does not submit a public-MWE candidate_red after repair also stays red", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return cand({
        id: `cand-${i}`,
        patch: `+++ b/x.py\n+fix${i}`,
        files: ["x.py"],
      })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: gen,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })

    expect(seeds).toHaveLength(3)
    expect(r.winner).toBeNull()
    expect(r.scored.every((s) => s.verdict.admissible === false)).toBe(true)
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:mweProof=candidate_red (public issue MWE still fails after patch)",
    )
  })

  it("clean mode appends one validated-repro repair candidate when every candidate stays unresolved", async () => {
    const seeds: (string | undefined)[] = []
    const unresolvedWithTrace = {
      votes: 0,
      k: 1,
      reproTrace: {
        vote: { verdict: "reproduced", resolved: 0, reproduced: 1, inconclusive: 0 },
        samples: [
          {
            outcome: "reproduced",
            stdoutTail: "Issue reproduced",
            stderrTail: "AssertionError: env {} should stay None",
            source: "print('Issue reproduced')",
          },
        ],
      },
    } as const
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return cand({
        id: `cand-${i}`,
        patch: `+++ b/x.py\n+fix${i}`,
        files: ["x.py"],
      })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      resolvedKofNMode: "soft",
      oracleFailureRepairSeed: "validated repro source",
      ports: {
        generate: gen,
        resolvedKofN: async (c) => (c.id === "cand-2" ? { votes: 1, k: 1 } : unresolvedWithTrace),
      },
    })

    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain("base-red validated reproduction set")
    expect(seeds[2]).toContain("Selector failure trace from cand-0")
    expect(seeds[2]).toContain("AssertionError: env {} should stay None")
    expect(seeds[2]).toContain("validated repro source")
    expect(r.winner?.id).toBe("cand-2")
  })

  it("clean mode appends one static-sanity repair candidate when a stronger structural patch is blocked only by deterministic sanity", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      if (i === 0) {
        return cand({
          id: "cand-0",
          patch:
            "diff --git a/pkg/base.py b/pkg/base.py\n--- a/pkg/base.py\n+++ b/pkg/base.py\n@@ -1,1 +1,1 @@\n-old\n+unsafe_base\n" +
            "diff --git a/pkg/backend.py b/pkg/backend.py\n--- a/pkg/backend.py\n+++ b/pkg/backend.py\n@@ -1,1 +1,1 @@\n-old\n+unsafe_backend",
          files: ["pkg/base.py", "pkg/backend.py"],
        })
      }
      if (i === 1) {
        return cand({
          id: "cand-1",
          patch: patchForFiles(["pkg/base.py"]),
          files: ["pkg/base.py"],
        })
      }
      return cand({
        id: "cand-2",
        patch:
          "diff --git a/pkg/base.py b/pkg/base.py\n--- a/pkg/base.py\n+++ b/pkg/base.py\n@@ -1,1 +1,1 @@\n-old\n+safe_base\n" +
          "diff --git a/pkg/backend.py b/pkg/backend.py\n--- a/pkg/backend.py\n+++ b/pkg/backend.py\n@@ -1,1 +1,1 @@\n-old\n+safe_backend",
        files: ["pkg/base.py", "pkg/backend.py"],
      })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      publicContracts: {
        contracts: buildMultiSiteFamilyContract(["pkg/base.py", "pkg/backend.py"]),
      },
      ports: {
        generate: gen,
        staticSanity: async (c) =>
          c.id === "cand-0" ? ["hard:staticSanity=pythonNoneSubscriptMutation(env)"] : [],
      },
    })

    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain("deterministic static sanity checks")
    expect(seeds[2]).toContain("`env` can be None before a subscript write")
    expect(r.winner?.id).toBe("cand-2")
  })

  it("clean mode appends one structural repair candidate when all generated candidates are unproven multi-source drift", async () => {
    const seeds: (string | undefined)[] = []
    const gen: SelectionPorts["generate"] = async (i, seed) => {
      seeds.push(seed)
      return i === 2
        ? cand({
            id: "cand-2",
            patch: patchForFiles(["pkg/a.py"]),
            files: ["pkg/a.py"],
          })
        : cand({
            id: `cand-${i}`,
            patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
            files: ["pkg/a.py", "pkg/b.py"],
          })
    }
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: { generate: gen },
    })

    expect(seeds).toHaveLength(3)
    expect(seeds[2]).toContain("unproven multi-source")
    expect(r.winner?.id).toBe("cand-2")
  })

  it("clean mode hard-rejects unproven multi-source drift without executable proof or public contract", async () => {
    const risky = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
      files: ["pkg/a.py", "pkg/b.py"],
    })
    const narrow = cand({
      id: "cand-1",
      patch: patchForFiles(["pkg/a.py"]),
      files: ["pkg/a.py"],
    })
    const { gen } = genFrom([risky, narrow])
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: { generate: gen },
    })

    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
  })

  it("clean mode does not submit a proofless patch when owner authority is empty", async () => {
    const { gen } = genFrom([
      cand({
        id: "cand-0",
        patch: patchForFiles(["pkg/a.py"]),
        files: ["pkg/a.py"],
      }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen },
    })

    expect(r.winner).toBeNull()
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:cleanProofAuthorityMissing=true (clean mode has no owner, executable proof, public contract, or static witness authority)",
    )
  })

  it("clean mode does not treat discovered regression keep-green as executable proof when owner authority is empty", async () => {
    const { gen } = genFrom([
      cand({
        id: "cand-0",
        patch: patchForFiles(["pkg/a.py"]),
        files: ["pkg/a.py"],
      }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(),
      ports: {
        generate: gen,
        regression: async () => true,
      },
    })

    expect(r.winner).toBeNull()
    expect(summarizeSelection(r).proofSummary?.proofState).toBe("safety_only")
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:cleanProofAuthorityMissing=true (clean mode has no owner, executable proof, public contract, or static witness authority)",
    )
  })

  it("clean mode allows multi-source candidates when executable repro proof is positive", async () => {
    const riskyButProven = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
      files: ["pkg/a.py", "pkg/b.py"],
    })
    const narrow = cand({
      id: "cand-1",
      patch: patchForFiles(["pkg/a.py"]),
      files: ["pkg/a.py"],
    })
    const { gen } = genFrom([riskyButProven, narrow])
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: {
        generate: gen,
        resolvedKofN: async (c) => (c.id === "cand-0" ? { votes: 1, k: 1 } : null),
      },
    })

    expect(r.winner?.id).toBe("cand-0")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).not.toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
  })

  it("clean mode keeps discovered regression keep-green as safety-only for multi-source drift", async () => {
    const riskyButOnlySafe = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
      files: ["pkg/a.py", "pkg/b.py"],
    })
    const narrow = cand({
      id: "cand-1",
      patch: patchForFiles(["pkg/a.py"]),
      files: ["pkg/a.py"],
    })
    const { gen } = genFrom([riskyButOnlySafe, narrow])
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: {
        generate: gen,
        regression: async (c) => (c.id === "cand-0" ? true : null),
      },
    })

    expect(r.winner?.id).toBe("cand-1")
    expect(summarizeSelection(r).candidates[0]?.proofState).toBe("safety_only")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
  })

  it("capped discovered-regression keep-green stays proof-missing, not safety-only", async () => {
    const { gen } = genFrom([
      cand({
        id: "cand-0",
        patch: patchForFiles(["pkg/a.py"]),
        files: ["pkg/a.py"],
      }),
    ])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/a.py"]),
      ports: {
        generate: gen,
        regression: async () => null,
        publicRegressionProof: async () => ({
          state: "coverage_capped",
          regressionGreen: true,
          candidateTests: ["tests/test_a.py", "tests/test_b.py"],
          sourceEvidence: new Map(),
          baseGreenTests: ["tests/test_a.py"],
          executedTests: ["tests/test_a.py"],
          failures: [],
          cappedWitnesses: { discovered: 2, executed: 1 },
        }),
      },
    })

    const summary = summarizeSelection(r)
    expect(summary.proofSummary?.publicRegressionState).toBe("coverage_capped")
    expect(summary.proofSummary?.proofState).toBe("proof_missing")
    expect(summary.candidates[0]?.publicRegression).toBe("coverage_capped")
    expect(summary.candidates[0]?.proofState).toBe("proof_missing")
  })

  it("clean mode allows multi-source candidates when a public multi-site contract is satisfied", async () => {
    const contractComplete = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/base.py", "pkg/backend.py"]),
      files: ["pkg/base.py", "pkg/backend.py"],
    })
    const incomplete = cand({
      id: "cand-1",
      patch: patchForFiles(["pkg/base.py"]),
      files: ["pkg/base.py"],
    })
    const { gen } = genFrom([contractComplete, incomplete])
    const r = await runSelection({
      n: 2,
      mode: "clean",
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      publicContracts: {
        contracts: buildMultiSiteFamilyContract(["pkg/base.py", "pkg/backend.py"]),
      },
      ports: { generate: gen },
    })

    expect(r.winner?.id).toBe("cand-0")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).not.toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
  })

  it("ADVERSARIAL: malformed soft resolved payload earns no voterQuorum credit", async () => {
    const { gen } = genFrom([cand({ id: "cand-0", patch: "+++ b/a.py\n+x", files: ["a.py"] })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      resolvedKofNMode: "soft",
      ports: {
        generate: gen,
        resolvedKofN: async () => ({ votes: 0.5, k: 1 }),
      },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(true)
    expect(r.scored[0]?.verdict.score).toBeCloseTo(0.15)
    expect(r.scored[0]?.verdict.reasons).not.toContain("soft:voterQuorum=0.5")
  })

  it("earlyAccept stops sequential selection after the first owner-scoped hard-positive candidate", async () => {
    let generated = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${i}`, files: ["x.py"] })
    }
    const r = await runSelection({
      n: 3,
      seeds: [undefined, "Focus on y.py", "Focus on z.py"],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: {
        generate: gen,
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(1)
    expect(r.earlyAccepted).toBe(true)
    expect(r.attempted).toBe(3)
    expect(r.successfulGenerations).toBe(1)
    expect(r.winner?.id).toBe("cand-0")
  })

  it("riskGate accepts low-risk candidate 0 without spending candidate 1 or selection probes", async () => {
    let generated = 0
    let applyCalls = 0
    let regressionCalls = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${i}`, files: ["x.py"] })
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on x.py"],
      owners: new Set(["x.py"]),
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: {
        generate: gen,
        applyClean: async () => {
          applyCalls += 1
          return true
        },
        regression: async () => {
          regressionCalls += 1
          return true
        },
      },
    })
    expect(generated).toBe(1)
    expect(applyCalls).toBe(0)
    expect(regressionCalls).toBe(0)
    expect(r.riskGate).toEqual({ candidateId: "cand-0", expanded: false, reasons: [] })
    expect(r.successfulGenerations).toBe(1)
    expect(r.winner?.id).toBe("cand-0")
  })

  it("riskGate records candidate_review runtime packets when the gate emits them", async () => {
    const recorded: LlmEvidencePacket[] = []
    const reviewPacket = buildCandidateReviewLlmEvidencePacket({
      problemStatement: "Axis inversion still fails when limits are preserved.",
      candidatePatchHash: "deadbeef",
      candidateFiles: ["x.py"],
      ownerEvidence: [
        {
          file: "x.py",
          symbols: ["invert_axis"],
          provenance: "selection-owner",
          sourceSlice: "def invert_axis(ax):\n    ax.set_xlim(...)",
        },
      ],
    })
    await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      riskGate: async () => ({
        expand: false,
        reasons: [],
        llmEvidencePacket: reviewPacket,
      }),
      recordLlmEvidencePacket: (packet) => {
        recorded.push(packet)
      },
      ports: {
        generate: async () => cand({ id: "cand-0", patch: "+++ b/x.py\n+fix", files: ["x.py"] }),
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.stage).toBe("candidate_review")
    expect(recorded[0]?.ownerEvidence[0]?.sourceSlice).toContain("invert_axis")
  })

  it("riskGate expansion forces candidate 1 even when candidate 0 would early-accept", async () => {
    let generated = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${i}`, files: ["x.py"] })
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on x.py"],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      riskGate: async () => ({ expand: true, reasons: ["axis-inversion-overwritten"] }),
      ports: {
        generate: gen,
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(2)
    expect(r.riskGate).toEqual({
      candidateId: "cand-0",
      expanded: true,
      reasons: ["axis-inversion-overwritten"],
    })
    expect(r.successfulGenerations).toBe(2)
    expect(r.earlyAccepted).toBe(true)
  })

  it("riskGate telemetry preserves shadow advisories without changing structural accept", async () => {
    let generated = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${i}`, files: ["x.py"] })
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on x.py"],
      owners: new Set(["x.py"]),
      riskGate: async () => ({
        expand: false,
        reasons: [],
        shadow: { expand: true, reasons: ["llm:uncertain"] },
      }),
      ports: {
        generate: gen,
      },
    })
    expect(generated).toBe(1)
    expect(r.riskGate).toEqual({
      candidateId: "cand-0",
      expanded: false,
      reasons: [],
      shadow: {
        expanded: true,
        reasons: ["llm:uncertain"],
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })

  it("ADVERSARIAL: soft-only repro quorum cannot become early-stop authority", async () => {
    let generated = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return cand({ id: `cand-${i}`, patch: `+++ b/x.py\n+fix${i}`, files: ["x.py"] })
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, "Focus on x.py"],
      owners: new Set(["x.py"]),
      resolvedKofNMode: "soft",
      earlyAccept: true,
      ports: {
        generate: gen,
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(false)
    expect(r.successfulGenerations).toBe(2)
    // bugbash #31: votes=1,k=1 ⇒ ratio 1 ⇒ r/(r+1) = 0.5 (was clamped to 1).
    expect(r.scored.every((s) => s.verdict.reasons.includes("soft:voterQuorum=0.5"))).toBe(true)
  })

  it("ADVERSARIAL: earlyAccept cannot stop without known owner authority", async () => {
    let generated = 0
    const { gen } = genFrom([
      cand({
        id: "cand-0",
        patch: "+++ b/symptom.py\n+first\n+extra churn",
        files: ["symptom.py"],
      }),
      cand({ id: "cand-1", patch: "+++ b/root.py\n+fix", files: ["root.py"] }),
    ])
    const countingGen: SelectionPorts["generate"] = async (i, seed) => {
      generated += 1
      return await gen(i, seed)
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      earlyAccept: true,
      ports: {
        generate: countingGen,
        applyClean: async () => true,
        regression: async () => true,
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(false)
    expect(r.successfulGenerations).toBe(2)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("ADVERSARIAL: earlyAccept cannot bypass owner diversity with a positive stray-file candidate", async () => {
    let generated = 0
    const gen: SelectionPorts["generate"] = async (i) => {
      generated += 1
      return i === 0
        ? cand({
            id: "cand-0",
            patch: "+++ b/owner.py\n+fix\n+++ b/stray.py\n+churn",
            files: ["owner.py", "stray.py"],
          })
        : cand({ id: "cand-1", patch: "+++ b/owner.py\n+fix", files: ["owner.py"] })
    }
    const r = await runSelection({
      n: 3,
      seeds: [undefined, "Focus on owner.py", "Focus on other.py"],
      owners: new Set(["owner.py"]),
      earlyAccept: true,
      ports: {
        generate: gen,
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(true)
    expect(r.successfulGenerations).toBe(2)
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(true)
  })

  it("ADVERSARIAL: earlyAccept never stops on an empty patch", async () => {
    let generated = 0
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [] }),
      cand({ id: "cand-1", patch: "+++ b/x.py\n+real", files: ["x.py"] }),
    ])
    const countingGen: SelectionPorts["generate"] = async (i, seed) => {
      generated += 1
      return await gen(i, seed)
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: {
        generate: countingGen,
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(true)
    expect(r.successfulGenerations).toBe(2)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("ADVERSARIAL: earlyAccept never stops on a known non-applying patch", async () => {
    let generated = 0
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/bad.py\n+stale", files: ["bad.py"] }),
      cand({ id: "cand-1", patch: "+++ b/x.py\n+real", files: ["x.py"] }),
    ])
    const countingGen: SelectionPorts["generate"] = async (i, seed) => {
      generated += 1
      return await gen(i, seed)
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: {
        generate: countingGen,
        applyClean: async (c) => c.id !== "cand-0",
        regression: async () => true,
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(true)
    expect(r.successfulGenerations).toBe(2)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("ADVERSARIAL: earlyAccept never stops on fail-open applyability (null)", async () => {
    let generated = 0
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+first", files: ["x.py"] }),
      cand({ id: "cand-1", patch: "+++ b/x.py\n+second", files: ["x.py"] }),
    ])
    const countingGen: SelectionPorts["generate"] = async (i, seed) => {
      generated += 1
      return await gen(i, seed)
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: {
        generate: countingGen,
        applyClean: async (c) => (c.id === "cand-0" ? null : true),
        regression: async () => true,
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(true)
    expect(r.successfulGenerations).toBe(2)
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(true)
  })

  it("ADVERSARIAL: configured hard resolved authority must be explicitly positive before early stop", async () => {
    let generated = 0
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+first", files: ["x.py"] }),
      cand({ id: "cand-1", patch: "+++ b/x.py\n+second", files: ["x.py"] }),
    ])
    const countingGen: SelectionPorts["generate"] = async (i, seed) => {
      generated += 1
      return await gen(i, seed)
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      earlyAccept: true,
      ports: {
        generate: countingGen,
        applyClean: async () => true,
        regression: async () => true,
        resolvedKofN: async (c) => (c.id === "cand-0" ? null : { votes: 1, k: 1 }),
      },
    })
    expect(generated).toBe(2)
    expect(r.earlyAccepted).toBe(true)
    expect(r.successfulGenerations).toBe(2)
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(true)
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

  it("explicit hard rejects fail closed: ALL inadmissible ⇒ winner is null", async () => {
    // every candidate regresses → none admissible → the selector must not
    // resubmit a known hard-rejected patch as a "best effort" answer.
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
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-1") // best-effort survives as attribution only
  })

  it("explicit smoke hard rejects fail closed: no best-effort resubmit", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+aaaa", files: ["x.py"] }),
      cand({ id: "cand-1", patch: "+++ b/y.py\n+a", files: ["y.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen, smoke: async () => false },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-1")
  })

  it("clean unproven multi-source drift hard reject is not resubmitted as best-effort", async () => {
    const risky = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/a.py", "pkg/b.py"]),
      files: ["pkg/a.py", "pkg/b.py"],
    })
    const { gen } = genFrom([risky])
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/a.py", "pkg/b.py"]),
      ports: { generate: gen },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).toBeNull()
    expect(r.scored[0]?.verdict.reasons).toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
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

  it("real regressed patch is not resubmitted just because the alternative is empty", async () => {
    // both inadmissible (real regresses; empty has patchProduced=false). The
    // real candidate can remain the terminal representative, but winner must be null.
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
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-1")
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
      // both inadmissible (real regresses; empty patchProduced=false). Without
      // the hard-reject fail-closed rule the regressed real patch would be
      // resubmitted; without the ownerCoverage hardening the empty no-patch
      // could become the terminal representative.
      ports: { generate: gen, regression: async (c) => (c.id === "cand-1" ? false : null) },
    })
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-1")
  })

  it("no winner when the only structurally submittable patch is explicitly regressed", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/owner.py\n+stale", files: ["owner.py"] }),
      cand({ id: "cand-1", patch: "+++ b/other.py\n+real", files: ["other.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["owner.py"]),
      // Both inadmissible: cand-0 is structurally bad (does not apply), cand-1
      // regresses. The selector must fail closed instead of resubmitting cand-1.
      ports: {
        generate: gen,
        applyClean: async (c) => c.id !== "cand-0",
        regression: async (c) => (c.id === "cand-1" ? false : null),
      },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate).not.toBeNull()
  })

  it("winner is null when every candidate is structurally unshippable", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [], stopReason: "max_turns", editCount: 0 }),
      cand({
        id: "cand-1",
        patch: "+++ b/bad.py\n+stale",
        files: ["bad.py"],
        stopReason: "completed",
        editCount: 1,
      }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: {
        generate: gen,
        applyClean: async (c) => (c.id === "cand-1" ? false : null),
      },
    })
    expect(r.admissibleCount).toBe(0)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-0")
    expect(r.terminalCandidate?.stopReason).toBe("max_turns")
    expect(r.terminalCandidate?.editCount).toBe(0)
  })

  it("ADVERSARIAL: terminalCandidate preserves aborted authority ahead of a higher-scoring generic miss", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [], stopReason: "aborted", editCount: 0 }),
      cand({
        id: "cand-1",
        patch: "+++ b/bad.py\n+stale",
        files: ["bad.py"],
        stopReason: "completed",
        editCount: 1,
      }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: {
        generate: gen,
        applyClean: async (c) => (c.id === "cand-1" ? false : null),
      },
    })
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-0")
    expect(r.terminalCandidate?.stopReason).toBe("aborted")
  })

  it("ADVERSARIAL: deduped empty patches preserve stronger later terminal authority", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [], stopReason: "completed", editCount: 0 }),
      cand({ id: "cand-1", patch: "", files: [], stopReason: "max_turns", editCount: 1 }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.generated).toBe(1)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-1")
    expect(r.terminalCandidate?.stopReason).toBe("max_turns")
  })

  it("terminalCandidate preserves first no-winner metadata on score ties", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "", files: [], stopReason: "max_turns", editCount: 0 }),
      cand({ id: "cand-1", patch: "", files: [], stopReason: "completed", editCount: 2 }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-0")
    expect(r.terminalCandidate?.stopReason).toBe("max_turns")
    expect(r.terminalCandidate?.editCount).toBe(0)
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
      cand({
        id: "cand-0",
        files: ["blockmatrix.py"],
        patch: "+++ b/blockmatrix.py\n+sym",
        familyId: "override-family",
        familyOwnerFiles: ["blockmatrix.py", "matexpr.py"],
      }),
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
    expect(t.ownerFiles).toEqual(["matexpr.py"])
    expect(t.earlyAccepted).toBe(false)
    expect(t.successfulGenerations).toBe(2)
    expect(t.generationFailures).toBe(0)
    expect(t.generated).toBe(2)
    expect(t.winnerId).toBe("cand-1") // owner-coverage winner
    expect(t.proofRequired).toBeUndefined()
    expect(t.candidates.map((c) => c.id)).toEqual(["cand-0", "cand-1"])
    expect(t.candidates[0]?.files).toEqual(["blockmatrix.py"])
    expect(t.candidates[0]?.familyCoverageMissing).toEqual(["matexpr.py"])
    expect(t.candidates[1]?.files).toEqual(["matexpr.py"])
    expect(t.candidates[0]?.proofState).toBe("proof_missing")
    // no full patch leaked into telemetry
    expect(JSON.stringify(t)).not.toContain("+++")
    // reasons carry the WHY (soft signals fired for the admissible winner)
    expect(t.candidates[1]?.reasons.some((x) => x.startsWith("soft:ownerCoverage"))).toBe(true)
  })

  it("empty (no-patch) candidate is inadmissible (patchProduced=false)", async () => {
    const { gen } = genFrom([cand({ id: "cand-0", patch: "", files: [] })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(false)
  })

  it("non-empty candidate with applyClean=false is inadmissible", async () => {
    const { gen } = genFrom([
      cand({ id: "cand-0", patch: "+++ b/x.py\n+stale", files: ["x.py"] }),
      cand({ id: "cand-1", patch: "+++ b/y.py\n+clean", files: ["y.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(),
      ports: {
        generate: gen,
        applyClean: async (c) => c.id !== "cand-0",
      },
    })
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(false)
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.admissible).toBe(true)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("applyClean=null on a non-empty candidate fails open", async () => {
    const { gen } = genFrom([cand({ id: "cand-0" })])
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(),
      ports: { generate: gen, applyClean: async () => null },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(true)
  })
})
