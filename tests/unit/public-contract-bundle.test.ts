import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  buildApiSurfaceContracts,
  buildCleanSelectionPublicContracts,
  buildMultiSiteFamilyContract,
  buildOwnerMustTouchContracts,
  buildPublicContractBundle,
  contractsSatisfiedCount,
  evaluateContractSatisfaction,
  requiredContractsSatisfiedCount,
} from "@/runner/batch/eval/public-contract-bundle"
import type { ContractCandidate, PublicContract } from "@/runner/batch/eval/public-contract-types"

/** A candidate that touches the given files/symbols (generic, no oracle label). */
const candidate = (
  touchedFiles: readonly string[],
  touchedSymbols: readonly string[] = [],
): ContractCandidate => ({ touchedFiles, touchedSymbols })

describe("builders: empty inputs derive []", () => {
  it("empty input bundle has no contracts (no obligation invented from nothing)", () => {
    expect(buildPublicContractBundle({}).contracts).toEqual([])
  })

  it("each builder returns [] for empty/whitespace inputs", () => {
    expect(buildOwnerMustTouchContracts([])).toEqual([])
    expect(buildOwnerMustTouchContracts(["", "   "])).toEqual([])
    expect(buildApiSurfaceContracts([])).toEqual([])
    expect(buildMultiSiteFamilyContract([])).toEqual([])
    // a single-file "family" is not a multi-site obligation.
    expect(buildMultiSiteFamilyContract(["pkg/only.py"])).toEqual([])
  })
})

describe("owner-must-touch teeth", () => {
  const [contract] = buildOwnerMustTouchContracts(["pkg/owner.py"])
  if (contract === undefined) throw new Error("expected one owner contract")

  it("required strength + static-witness provenance carried through", () => {
    expect(contract.kind).toBe("owner-must-touch")
    expect(contract.strength).toBe("required")
    expect(contract.provenance).toBe("static-witness")
    expect(contract.subjectFiles).toEqual(["pkg/owner.py"])
  })

  it("satisfied when candidate touches the subject file", () => {
    const ev = evaluateContractSatisfaction(contract, candidate(["pkg/owner.py", "pkg/other.py"]))
    expect(ev.satisfied).toBe(true)
    // provenance/strength are reflected on the satisfaction record too.
    expect(ev.strength).toBe("required")
  })

  it("violated when candidate does NOT touch the subject file", () => {
    const ev = evaluateContractSatisfaction(contract, candidate(["pkg/other.py"]))
    expect(ev.satisfied).toBe(false)
  })

  it("mutation teeth: an empty-touch candidate violates (not vacuously satisfied)", () => {
    expect(evaluateContractSatisfaction(contract, candidate([])).satisfied).toBe(false)
  })
})

describe("api-surface teeth", () => {
  const [contract] = buildApiSurfaceContracts(["MyClass.reset"])
  if (contract === undefined) throw new Error("expected one api contract")

  it("satisfied when candidate touches the subject symbol", () => {
    expect(evaluateContractSatisfaction(contract, candidate([], ["MyClass.reset"])).satisfied).toBe(
      true,
    )
  })

  it("violated when candidate touches a DIFFERENT symbol only", () => {
    expect(evaluateContractSatisfaction(contract, candidate([], ["MyClass.other"])).satisfied).toBe(
      false,
    )
  })

  it("touching the right file but NOT the symbol still violates (symbol axis is checked)", () => {
    expect(evaluateContractSatisfaction(contract, candidate(["MyClass.reset"], [])).satisfied).toBe(
      false,
    )
  })
})

describe("multi-site-family requires every site", () => {
  const [contract] = buildMultiSiteFamilyContract(["pkg/a.py", "pkg/b.py"])
  if (contract === undefined) throw new Error("expected one family contract")

  it("subject carries the full family", () => {
    expect(contract.kind).toBe("multi-site-family")
    expect([...contract.subjectFiles].sort()).toEqual(["pkg/a.py", "pkg/b.py"])
  })

  it("a single-site candidate violates; touching both satisfies", () => {
    expect(evaluateContractSatisfaction(contract, candidate(["pkg/a.py"])).satisfied).toBe(false)
    expect(
      evaluateContractSatisfaction(contract, candidate(["pkg/a.py", "pkg/b.py"])).satisfied,
    ).toBe(true)
  })
})

describe("required-contract violation distinguishes candidates (selector dominance)", () => {
  // generic static witness: one owner file + one API symbol.
  const bundle = buildPublicContractBundle({
    ownerFiles: ["pkg/owner.py"],
    apiSymbols: ["api_fn"],
  })

  const satisfies = candidate(["pkg/owner.py"], ["api_fn"])
  const violatesRequired = candidate(["pkg/elsewhere.py"], ["api_fn"])

  it("candidate satisfying the required contract scores strictly higher on required count", () => {
    expect(requiredContractsSatisfiedCount(bundle, satisfies)).toBe(1)
    expect(requiredContractsSatisfiedCount(bundle, violatesRequired)).toBe(0)
    expect(requiredContractsSatisfiedCount(bundle, satisfies)).toBeGreaterThan(
      requiredContractsSatisfiedCount(bundle, violatesRequired),
    )
  })

  it("total satisfied count also separates the two candidates", () => {
    // both touch the api symbol (supporting), but only one touches the owner file.
    expect(contractsSatisfiedCount(bundle, satisfies)).toBe(2)
    expect(contractsSatisfiedCount(bundle, violatesRequired)).toBe(1)
  })

  it("a candidate violating a required contract cannot tie the satisfying one", () => {
    expect(contractsSatisfiedCount(bundle, satisfies)).toBeGreaterThan(
      contractsSatisfiedCount(bundle, violatesRequired),
    )
  })
})

describe("clean selection public contracts", () => {
  it("includes exact-output + issue-file owner contracts, but excludes stage1/owner-resolve-only files", () => {
    const bundle = buildCleanSelectionPublicContracts({
      declaredExpected: { kind: "stdout", value: "expected text" },
      candidates: [
        { file: "pkg/root.py", sources: ["issue-file", "stage1"] },
        { file: "pkg/sibling.py", sources: ["owner-resolve"] },
        { file: "pkg/localize_only.py", sources: ["stage1"] },
      ],
    })
    expect(bundle?.contracts.map((c) => c.contractId).sort()).toEqual([
      "exact-output:stdout",
      "owner-must-touch:pkg/root.py",
    ])
    expect(bundle?.contracts.find((c) => c.kind === "owner-must-touch")?.provenance).toBe(
      "public-issue-text",
    )
  })

  it("clean mode emits only issue/output/api contracts, never a static-only multi-site family", () => {
    const bundle = buildCleanSelectionPublicContracts({
      declaredExpected: { kind: "stdout", value: "expected text" },
      candidates: [{ file: "pkg/root.py", sources: ["issue-file"] }],
      apiSymbols: ["pkg.fn"],
    })
    expect(bundle?.contracts.map((c) => c.kind).sort()).toEqual([
      "api-surface",
      "exact-output",
      "owner-must-touch",
    ])
    expect(bundle?.contracts.find((c) => c.kind === "api-surface")?.provenance).toBe(
      "public-issue-text",
    )
  })

  it("returns undefined when no clean-authority contracts exist", () => {
    expect(
      buildCleanSelectionPublicContracts({
        candidates: [
          { file: "pkg/localize_only.py", sources: ["stage1"] },
          { file: "pkg/sibling.py", sources: ["owner-resolve"] },
        ],
      }),
    ).toBeUndefined()
  })
})

describe("provenance is carried through every kind", () => {
  it("exact-output ← public-issue-text; api/owner ← static-witness; reset ← validated-repro; test ← public-test", () => {
    const bundle = buildPublicContractBundle({
      declaredExpected: { kind: "stdout", value: "42" },
      apiSymbols: ["sym"],
      ownerFiles: ["pkg/o.py"],
      validatedReproPresent: true,
      resetOwnerFile: "pkg/reset.py",
      publicTests: [{ testName: "test_thing", coveredFile: "pkg/t.py" }],
    })
    const provOf = (kind: PublicContract["kind"]) =>
      bundle.contracts.filter((c) => c.kind === kind).map((c) => c.provenance)

    expect(provOf("exact-output")).toEqual(["public-issue-text"])
    expect(provOf("api-surface")).toEqual(["static-witness"])
    expect(provOf("state-reset-semantics")).toEqual(["validated-repro"])
    // owner-must-touch arises from BOTH the static owner file and the public test.
    expect(new Set(provOf("owner-must-touch"))).toEqual(new Set(["static-witness", "public-test"]))
  })

  it("no validated repro ⇒ no state-reset contract (provenance gate is real)", () => {
    const bundle = buildPublicContractBundle({
      validatedReproPresent: false,
      resetOwnerFile: "pkg/reset.py",
    })
    expect(bundle.contracts).toEqual([])
  })
})

describe("exact-output contributes telemetry, never a structural veto", () => {
  const bundle = buildPublicContractBundle({
    declaredExpected: { kind: "stdout", value: "expected text" },
  })

  it("is present as a supporting contract", () => {
    expect(bundle.contracts).toHaveLength(1)
    const [c] = bundle.contracts
    expect(c?.kind).toBe("exact-output")
    expect(c?.strength).toBe("supporting")
  })

  it("is satisfied by ANY candidate (judged by executable proof elsewhere)", () => {
    expect(contractsSatisfiedCount(bundle, candidate([]))).toBe(1)
    expect(contractsSatisfiedCount(bundle, candidate(["whatever.py"], ["whatever"]))).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SELF-POLICING: the module source must contain NO benchmark instance id and NO
// known gold file path. This is the README forbidden-source guard — if a future
// edit smuggles an instance-tuned literal in, this test goes RED.
// ---------------------------------------------------------------------------
describe("forbidden-source self-policing (grep the module source)", () => {
  const moduleSrc = readFileSync(
    fileURLToPath(
      new URL("../../src/runner/batch/eval/public-contract-bundle.ts", import.meta.url),
    ),
    "utf8",
  )
  const typesSrc = readFileSync(
    fileURLToPath(new URL("../../src/runner/batch/eval/public-contract-types.ts", import.meta.url)),
    "utf8",
  )
  const combined = `${moduleSrc}\n${typesSrc}`

  it("contains no known benchmark project path token", () => {
    // generic project roots that appear in SWE-bench gold file paths.
    const forbiddenPathTokens = [
      "django/",
      "sympy/",
      "sklearn/",
      "scikit-learn",
      "astropy/",
      "matplotlib/",
      "pytest",
      "requests/",
      "flask/",
      "xarray/",
      "pylint",
    ]
    for (const tok of forbiddenPathTokens) {
      expect(combined.toLowerCase().includes(tok.toLowerCase())).toBe(false)
    }
  })

  it("contains no benchmark instance-id literal (e.g. <project>__<repo>-<number>)", () => {
    // SWE-bench instance ids look like `django__django-12345`.
    expect(/[a-z0-9_]+__[a-z0-9_-]+-\d{3,}/i.test(combined)).toBe(false)
  })

  it("contains no PASS_TO_PASS / FAIL_TO_PASS / test_patch oracle-label literal", () => {
    for (const oracle of ["PASS_TO_PASS", "FAIL_TO_PASS", "test_patch", "gold_patch"]) {
      expect(combined.includes(oracle)).toBe(false)
    }
  })
})
