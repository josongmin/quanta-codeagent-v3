import { describe, expect, it } from "bun:test"
import type { CandidateFamily } from "@/runner/batch/eval/candidate-families"
import {
  buildCleanSelectionAuthorityContracts,
  buildMultiSiteFamilyContract,
  buildOwnerMustTouchContracts,
} from "@/runner/batch/eval/public-contract-bundle"
import type { PublicContractBundle } from "@/runner/batch/eval/public-contract-types"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

const fileDiff = (file: string, body = "+    new_guard"): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n${body}`

const cand0Of = (over: Partial<Candidate>): Candidate => ({
  id: "cand-0",
  patch: fileDiff("pkg/owner.py"),
  turns: 1,
  files: ["pkg/owner.py"],
  baseValidatedRed: true,
  ...over,
})

const diff =
  "diff --git a/pkg/owner.py b/pkg/owner.py\n--- a/pkg/owner.py\n+++ b/pkg/owner.py\n@@ -1,1 +1,1 @@\n-old\n+new_guard"

const cand: Candidate = {
  id: "cand-0",
  patch: diff,
  turns: 1,
  files: ["pkg/owner.py"],
  baseValidatedRed: true,
}

const ports = (over: Partial<SelectionPorts> = {}): SelectionPorts => ({
  generate: async () => cand,
  applyClean: async () => true,
  ...over,
})

const run = (mode: "clean" | "research", over: Partial<SelectionPorts>) =>
  runSelection({
    n: 1,
    seeds: [undefined],
    owners: new Set(["pkg/owner.py"]),
    mode,
    ports: ports(over),
  })

const bigDiff =
  "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a\n" +
  "diff --git a/pkg/b.py b/pkg/b.py\n--- a/pkg/b.py\n+++ b/pkg/b.py\n@@ -1,1 +1,1 @@\n-old\n+fix_b"
const smallDiff =
  "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a_only"

const bigCand: Candidate = {
  id: "cand-0",
  patch: bigDiff,
  turns: 1,
  files: ["pkg/a.py", "pkg/b.py"],
  baseValidatedRed: true,
}
const smallCand: Candidate = {
  id: "cand-1",
  patch: smallDiff,
  turns: 1,
  files: ["pkg/a.py"],
  baseValidatedRed: true,
}

const runPair = (mode: "clean" | "research", resolvedKofN: SelectionPorts["resolvedKofN"]) =>
  runSelection({
    n: 2,
    seeds: [undefined, undefined],
    owners: new Set(["pkg/a.py"]),
    mode,
    ports: {
      generate: async (i) => [bigCand, smallCand][i] as Candidate,
      applyClean: async () => true,
      ...(resolvedKofN !== undefined ? { resolvedKofN } : {}),
    },
  })

const issueOwnerContracts = (file: string): PublicContractBundle =>
  buildCleanSelectionAuthorityContracts({
    candidates: [{ file, sources: ["issue-file"] }],
  }) ?? { contracts: [] }

const issueApiContracts = (symbol: string): PublicContractBundle =>
  buildCleanSelectionAuthorityContracts({
    apiSymbols: [symbol],
  }) ?? { contracts: [] }

const publicMultiSiteContracts = (files: readonly string[]): PublicContractBundle => ({
  contracts: [
    {
      contractId: `multi-site-family:${files.join("|")}`,
      kind: "multi-site-family",
      strength: "required",
      provenance: "public-test",
      subjectFiles: [...files],
      subjectSymbols: [],
    },
  ],
})

describe("clean-mode lexicographic selection (T-SEL-06 live wiring)", () => {
  it("CLEAN: a BIGGER patch WITH validated proof beats a smaller one WITHOUT — proof dominates size", async () => {
    // cand-0 (2 files) has resolved quorum; cand-1 (1 file) has none.
    const r = await runPair("clean", async (c) => (c.id === "cand-0" ? { votes: 1, k: 1 } : null))
    expect(r.winner?.id).toBe("cand-0")
  })

  it("CLEAN: with proof tied (none), the SMALLER patch wins (minimality is the last tier)", async () => {
    const r = await runPair("clean", async () => null)
    expect(r.winner?.id).toBe("cand-1")
  })

  it("CLEAN: contract tier is EMPTY by default — no heuristic owner contract; smaller wins on proof tie", async () => {
    // RED-ON-INJECTION for the rule fix: with NO genuinely-sourced contracts
    // supplied, the contract-dominance tier must contribute nothing (the closure
    // owner ranking is heuristic and must not become a `required` contract), so a
    // proof-tied pair is decided by minimality — the SMALLER drift patch wins.
    const ownerBigNoContract: Candidate = {
      id: "cand-0",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a\n" +
        "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1,1 +1,1 @@\n-old\n+fix_c",
      turns: 1,
      files: ["pkg/a.py", "pkg/c.py"],
      baseValidatedRed: true,
    }
    const drift: Candidate = {
      id: "cand-1",
      patch:
        "diff --git a/pkg/z.py b/pkg/z.py\n--- a/pkg/z.py\n+++ b/pkg/z.py\n@@ -1,1 +1,1 @@\n-old\n+fix_z",
      turns: 1,
      files: ["pkg/z.py"],
      baseValidatedRed: true,
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py"]),
      mode: "clean",
      ports: {
        generate: async (i) => [ownerBigNoContract, drift][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-1") // smaller wins — owner heuristic does NOT dominate
  })

  it("CLEAN: a supplied STATIC-WITNESS owner contract is ignored — smaller drift still wins on proof tie", async () => {
    // owner = pkg/a.py. cand-0 (2 files) touches the owner; cand-1 (1 file) drifts to pkg/z.py.
    const ownerBig: Candidate = {
      id: "cand-0",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a\n" +
        "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1,1 +1,1 @@\n-old\n+fix_c",
      turns: 1,
      files: ["pkg/a.py", "pkg/c.py"],
      baseValidatedRed: true,
    }
    const driftSmall: Candidate = {
      id: "cand-1",
      patch:
        "diff --git a/pkg/z.py b/pkg/z.py\n--- a/pkg/z.py\n+++ b/pkg/z.py\n@@ -1,1 +1,1 @@\n-old\n+fix_z",
      turns: 1,
      files: ["pkg/z.py"],
      baseValidatedRed: true,
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py"]),
      mode: "clean",
      publicContracts: { contracts: buildOwnerMustTouchContracts(["pkg/a.py"]) },
      ports: {
        generate: async (i) => [ownerBig, driftSmall][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-1")
  })

  it("CLEAN: a generated candidate-local STATIC-WITNESS owner contract is ignored too", async () => {
    const ownerBig: Candidate = {
      id: "cand-0",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a\n" +
        "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1,1 +1,1 @@\n-old\n+fix_c",
      turns: 1,
      files: ["pkg/a.py", "pkg/c.py"],
      baseValidatedRed: true,
      publicContracts: { contracts: buildOwnerMustTouchContracts(["pkg/a.py"]) },
    }
    const driftSmall: Candidate = {
      id: "cand-1",
      patch:
        "diff --git a/pkg/z.py b/pkg/z.py\n--- a/pkg/z.py\n+++ b/pkg/z.py\n@@ -1,1 +1,1 @@\n-old\n+fix_z",
      turns: 1,
      files: ["pkg/z.py"],
      baseValidatedRed: true,
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py"]),
      mode: "clean",
      ports: {
        generate: async (i) => [ownerBig, driftSmall][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.requiredContractsSatisfied).toBe(0)
  })

  it("CLEAN: a supplied PUBLIC owner contract DOES dominate size — bigger contract-satisfying patch beats smaller drift", async () => {
    const ownerBig: Candidate = {
      id: "cand-0",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,1 +1,1 @@\n-old\n+fix_a\n" +
        "diff --git a/pkg/c.py b/pkg/c.py\n--- a/pkg/c.py\n+++ b/pkg/c.py\n@@ -1,1 +1,1 @@\n-old\n+fix_c",
      turns: 1,
      files: ["pkg/a.py", "pkg/c.py"],
      baseValidatedRed: true,
    }
    const driftSmall: Candidate = {
      id: "cand-1",
      patch:
        "diff --git a/pkg/z.py b/pkg/z.py\n--- a/pkg/z.py\n+++ b/pkg/z.py\n@@ -1,1 +1,1 @@\n-old\n+fix_z",
      turns: 1,
      files: ["pkg/z.py"],
      baseValidatedRed: true,
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py"]),
      mode: "clean",
      publicContracts: issueOwnerContracts("pkg/a.py"),
      ports: {
        generate: async (i) => [ownerBig, driftSmall][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })
})

describe("clean-mode early accept (T-SEL-13 executable-only)", () => {
  it("CLEAN: a DRIFTING candidate (outside owners) WITH executed proof early-accepts — no owner gating", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/owner.py"]),
      mode: "clean",
      earlyAccept: true,
      ports: {
        generate: async () => cand0Of({ patch: fileDiff("pkg/drift.py"), files: ["pkg/drift.py"] }),
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(r.earlyAccepted).toBe(true)
  })

  it("CLEAN: a candidate INSIDE owners but WITHOUT executed proof does NOT early-accept (static owner can't stop)", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/owner.py"]),
      mode: "clean",
      earlyAccept: true,
      ports: { generate: async () => cand0Of({}), applyClean: async () => true },
    })
    expect(r.earlyAccepted).toBe(false)
  })

  it("RESEARCH: a drifting candidate with proof does NOT early-accept (legacy owner gating intact)", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/owner.py"]),
      earlyAccept: true,
      ports: {
        generate: async () => cand0Of({ patch: fileDiff("pkg/drift.py"), files: ["pkg/drift.py"] }),
        applyClean: async () => true,
        resolvedKofN: async () => ({ votes: 1, k: 1 }),
      },
    })
    expect(r.earlyAccepted).toBe(false)
  })
})

describe("clean-mode api-surface contract (T-CON-10 symbol tier)", () => {
  it("CLEAN: proof tied — a candidate touching the issue's named symbol beats one that does not", async () => {
    // cand-0 modifies the BODY of `target_fn` (hunk header names it); cand-1 touches another symbol.
    const touchesSymbol: Candidate = {
      id: "cand-0",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -10,3 +10,3 @@ def target_fn(x):\n-    return x\n+    return x + 1",
      turns: 1,
      files: ["pkg/a.py"],
      baseValidatedRed: true,
    }
    const wrongSymbol: Candidate = {
      id: "cand-1",
      patch:
        "diff --git a/pkg/a.py b/pkg/a.py\n--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -40,3 +40,3 @@ def other_fn(y):\n-    return y\n+    return y - 1",
      turns: 1,
      files: ["pkg/a.py"],
      baseValidatedRed: true,
    }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/a.py"]),
      mode: "clean",
      publicContracts: issueApiContracts("target_fn"),
      ports: {
        generate: async (i) => [touchesSymbol, wrongSymbol][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })
})

describe("clean-mode multi-site authority (public provenance only)", () => {
  const smallBaseOnly: Candidate = {
    id: "cand-0",
    patch:
      "diff --git a/pkg/base.py b/pkg/base.py\n--- a/pkg/base.py\n+++ b/pkg/base.py\n@@ -1,1 +1,1 @@\n-old\n+fix_base",
    turns: 1,
    files: ["pkg/base.py"],
    baseValidatedRed: true,
  }
  const multiSitePatch: Candidate = {
    id: "cand-1",
    patch:
      "diff --git a/pkg/base.py b/pkg/base.py\n--- a/pkg/base.py\n+++ b/pkg/base.py\n@@ -1,1 +1,1 @@\n-old\n+fix_base\n" +
      "diff --git a/pkg/backend.py b/pkg/backend.py\n--- a/pkg/backend.py\n+++ b/pkg/backend.py\n@@ -1,1 +1,1 @@\n-old\n+fix_backend",
    turns: 1,
    files: ["pkg/base.py", "pkg/backend.py"],
    baseValidatedRed: true,
  }
  const multiSiteFamily: CandidateFamily = {
    familyId: "multi-site",
    ownerFiles: ["pkg/base.py", "pkg/backend.py"],
    reason: "shared public symbol `runshell` spans multiple owner files",
    seed: "Cover every owner file defining `runshell` if the bug is in that override family.",
    sourceEvidence: ["static-symbol-witness"],
  }

  it("CLEAN: a supplied STATIC-WITNESS multi-site contract is ignored", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      publicContracts: {
        contracts: buildMultiSiteFamilyContract(["pkg/base.py", "pkg/backend.py"]),
      },
      ports: {
        generate: async (i) => [smallBaseOnly, multiSitePatch][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.requiredContractsSatisfied).toBe(0)
  })

  it("CLEAN: partial co-change family patch is inadmissible", async () => {
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      candidateFamilies: [multiSiteFamily],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      ports: {
        generate: async () => smallBaseOnly,
        applyClean: async () => true,
      },
    })
    const entry = r.scored[0]
    expect(entry?.candidate.familyId).toBe("multi-site")
    expect(entry?.verdict.admissible).toBe(false)
    expect(entry?.verdict.reasons).toContain(
      "hard:familyCoverageMissing=pkg/backend.py (typed co-change family postcondition not satisfied)",
    )
  })

  it("CLEAN: required PUBLIC multi-site contract beats smaller single-site patch", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      publicContracts: publicMultiSiteContracts(["pkg/base.py", "pkg/backend.py"]),
      ports: {
        generate: async (i) => [smallBaseOnly, multiSitePatch][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.requiredContractsSatisfied).toBe(1)
  })

  it("CLEAN: executable proof still beats required contract count — no set-level contract floor", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      publicContracts: publicMultiSiteContracts(["pkg/base.py", "pkg/backend.py"]),
      ports: {
        generate: async (i) => [smallBaseOnly, multiSitePatch][i] as Candidate,
        applyClean: async () => true,
        resolvedKofN: async (c) => (c.id === "cand-0" ? { votes: 1, k: 1 } : null),
      },
    })
    expect(r.winner?.id).toBe("cand-0")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.admissible).toBe(true)
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.requiredContractsSatisfied).toBe(1)
  })

  it("CLEAN: static sanity rejects a contract-satisfying but structurally invalid patch", async () => {
    const invalidMultiSite = { ...multiSitePatch, id: "cand-0" }
    const validBaseOnly = { ...smallBaseOnly, id: "cand-1" }
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      publicContracts: publicMultiSiteContracts(["pkg/base.py", "pkg/backend.py"]),
      ports: {
        generate: async (i) => [invalidMultiSite, validBaseOnly][i] as Candidate,
        applyClean: async () => true,
        staticSanity: async (c) =>
          c.id === "cand-0"
            ? ["hard:staticSanity=pythonCallbackArityMismatch(_callback:2->3)"]
            : [],
      },
    })
    expect(r.winner?.id).toBe("cand-1")
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).toContain(
      "hard:staticSanity=pythonCallbackArityMismatch(_callback:2->3)",
    )
  })

  it("CLEAN: family rank alone cannot bypass unproven multi-source drift gating", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      candidateFamilies: [undefined, multiSiteFamily],
      owners: new Set(["pkg/base.py", "pkg/backend.py"]),
      mode: "clean",
      ports: {
        generate: async (i) => [smallBaseOnly, multiSitePatch][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
    expect(r.scored.find((s) => s.candidate.id === "cand-1")?.verdict.reasons).toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
  })
})

describe("clean-mode selector authority (T-AUTH-01 / T-SEL-02 / T-SMK-04 live wiring)", () => {
  it("RESEARCH: smokeGreen=false rejects the candidate (legacy hard gate)", async () => {
    const r = await run("research", { smoke: async () => false })
    expect(r.winner).toBeNull()
  })

  it("CLEAN: smokeGreen=false does NOT reject — candidate still wins", async () => {
    const r = await run("clean", { smoke: async () => false })
    expect(r.winner?.id).toBe("cand-0")
  })

  it("RESEARCH: declaredExpected=false rejects (answer-key hard gate)", async () => {
    const r = await run("research", { declaredExpected: async () => false })
    expect(r.winner).toBeNull()
  })

  it("CLEAN: declaredExpected=false does NOT reject — answer-key has no clean authority", async () => {
    const r = await run("clean", { declaredExpected: async () => false })
    expect(r.winner?.id).toBe("cand-0")
  })

  it("CLEAN: structural/executable vetoes STILL apply (applyClean=false rejects)", async () => {
    const r = await run("clean", { applyClean: async () => false })
    expect(r.winner).toBeNull()
  })

  it("CLEAN: executed regression failure STILL rejects (executable authority survives)", async () => {
    const r = await run("clean", { regression: async () => false })
    expect(r.winner).toBeNull()
  })

  it("default mode is research (no mode ⇒ smoke=false rejects, byte-identical legacy)", async () => {
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(["pkg/owner.py"]),
      ports: ports({ smoke: async () => false }),
    })
    expect(r.winner).toBeNull()
  })
})
