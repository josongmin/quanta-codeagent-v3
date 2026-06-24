/**
 * T0 — Frozen baseline for the jun-24 scaffold SOTA absorption plan.
 *
 * Two jobs, no behavior change to production:
 *
 *  1. CHARACTERIZE the live false-winner shape with the REAL selector machinery,
 *     using fully SYNTHETIC files (zero gold). This is the load-bearing
 *     measurement: it proves the seam T1 must invert actually exhibits the
 *     false-winner TODAY. Each such test asserts current behavior and is labelled
 *     `BASELINE(T0)`; T1 flips the matching assertion.
 *
 *  2. FENCE the frozen fixtures + slice manifest (gold-independence + drift +
 *     overfitting guards) so the measurement foundation cannot rot or smuggle an
 *     answer key.
 *
 * If a `BASELINE(T0)` test ever flips on its own (without T1), the substrate
 * changed underneath the plan — re-measure before building on it.
 */

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  authoritativeIssueOwnerContracts,
  buildMultiSiteFamilyContract,
} from "@/runner/batch/eval/public-contract-bundle"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"
import {
  ALL_TARGET_INSTANCE_IDS,
  assertNoAnswerKey,
  BROAD_REGRESSION_SLICE,
  CANONICAL_FAIL_FIXTURES,
  CANONICAL_FAIL_FIXTURES as FIXTURES,
  FROZEN_SLICE_MANIFEST,
  type ObservedFailFixture,
} from "../fixtures/scaffold-absorb-jun24/manifest"

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  patch: "+++ b/x.py\n+changed",
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
  ...over,
})

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

const genOnce =
  (c: Candidate): SelectionPorts["generate"] =>
  async () =>
    c

// AUTHORITY owner contracts as the driver actually builds them
// (`buildCleanSelectionAuthorityContracts`, public-issue-text provenance) — the
// ONLY kind that survives clean-mode sanitization and moves
// `requiredContractsSatisfied`. Static-witness multi-site-family contracts do
// NOT (see the sanitize test below), so they are the wrong tool to characterize
// the selection-layer gap.
const authorityOwnerContracts = (files: readonly string[]) => ({
  contracts: authoritativeIssueOwnerContracts(
    files.map((file) => ({ file, sources: ["issue-file"] as const })),
  ),
})

describe("scaffold-absorb jun24 — T0 baseline (false-winner characterization)", () => {
  // NOTE ON SCOPE: these are SELECTION-LAYER mechanism probes on `runSelection`,
  // not a reproduction of the full bench run. The production preset
  // (`agentless-v4-proof-clean`) layers proof-required, N=5, structural-repair
  // ports, and `cha-multisite-steer` on top — and on the real receipts 14315's
  // sibling-miss surfaces UPSTREAM as empty_patch, not as a selection-accept.
  // What these tests pin is the precise selector property T1 changes: a required
  // owner contract is RANKING-only, never a hard veto. The end-to-end receipt is
  // owned by T6 (remote rerun), not unit tests.

  it("BASELINE(T0): a required owner contract is RANKING-only — a lone candidate missing one required owner (1/2) is still admissible and still WINS", async () => {
    // Synthetic. `producer.py` + `consumer.py` are both issue-named owners ⇒ two
    // authority `owner-must-touch` required contracts. The candidate touches only
    // the producer (the 14315 shape: producer edited, consumer missed).
    const producerOnly = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py"]),
      files: ["pkg/producer.py"],
    })
    const contracts = authorityOwnerContracts(["pkg/producer.py", "pkg/consumer.py"])
    expect(contracts.contracts).toHaveLength(2)
    expect(contracts.contracts.every((c) => c.strength === "required")).toBe(true)

    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      publicContracts: contracts,
      ports: { generate: genOnce(producerOnly) },
    })

    // CURRENT TRUTH: missing a required owner only LOWERS the rank (1 of 2
    // satisfied); it does NOT veto. With one candidate the incomplete patch wins.
    // This exact "ranking-not-veto" is what T1 promotes to a hard rejection.
    expect(r.scored[0]?.requiredContractsSatisfied).toBe(1)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
    expect(r.winner?.files).toEqual(["pkg/producer.py"])
  })

  it("BASELINE(T0): a COMPLETE candidate satisfies all required owners (2/2) and also wins — completeness must stay acceptable (false-positive pole)", async () => {
    // Same two authority owner contracts, candidate touches BOTH. The authority
    // contract is also what exempts a 2-file patch from the multi-source drift
    // veto, so the complete fix is admissible. T1 must keep this acceptance.
    const complete = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py", "pkg/consumer.py"]),
      files: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      publicContracts: authorityOwnerContracts(["pkg/producer.py", "pkg/consumer.py"]),
      ports: { generate: genOnce(complete) },
    })
    expect(r.scored[0]?.requiredContractsSatisfied).toBe(2)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
    expect(r.winner?.files).toEqual(["pkg/producer.py", "pkg/consumer.py"])
  })

  it("BASELINE(T0): a static-witness multi-site-family contract is sanitized OUT of clean authority — handing the selector one is INERT", async () => {
    // The obvious-but-wrong T1 design: build a `multi-site-family` contract from a
    // static witness and pass it in. In clean mode it is filtered before scoring,
    // so it cannot move `requiredContractsSatisfied` and a 2-file patch carrying
    // it is still vetoed as unproven multi-source drift. T1 must therefore route
    // coverage through AUTHORITY provenance (or a new hard gate), not a static
    // family bundle. Proof = identical outcome with the contract removed.
    const complete = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py", "pkg/consumer.py"]),
      files: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const staticFamily = {
      contracts: buildMultiSiteFamilyContract(["pkg/producer.py", "pkg/consumer.py"]),
    }
    const base = {
      n: 1 as const,
      mode: "clean" as const,
      seeds: [undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      ports: { generate: genOnce(complete) },
    }
    const withFamily = await runSelection({ ...base, publicContracts: staticFamily })
    const without = await runSelection(base)

    // Inert: contract registers nothing and the drift veto fires either way.
    expect(withFamily.scored[0]?.requiredContractsSatisfied).toBe(0)
    expect(withFamily.winner).toBeNull()
    expect(withFamily.scored[0]?.verdict.reasons).toContain(
      "hard:unprovenMultiSourceDriftRisk=true (multi-source patch lacks executable proof or public contract)",
    )
    expect(without.winner).toBeNull()
    expect(without.scored[0]?.requiredContractsSatisfied).toBe(
      withFamily.scored[0]?.requiredContractsSatisfied,
    )
  })

  it("BASELINE(T0): a genuinely single-file fix with NO owner contract is accepted (false-positive pole)", async () => {
    // No contract at all ⇒ a single-file patch is the complete fix. T1's coverage
    // gate must leave this untouched (empty required set ⇒ no rejection).
    const single = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/only.py"]),
      files: ["pkg/only.py"],
    })
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/only.py"]),
      ports: { generate: genOnce(single) },
    })
    expect(r.winner?.files).toEqual(["pkg/only.py"])
  })
})

describe("scaffold-absorb jun24 — T1 finding: the best-effort 'leak' is benign; regeneration is the lever", () => {
  // VERIFIED (adversarial impl-audit + n=2 probe): a best-effort block on a
  // family-incomplete producer-consumer candidate is PURE DOWNSIDE.
  //  - When a complete sibling exists, normal best-effort ranking ALREADY prefers
  //    it (admissible > inadmissible) — a block changes nothing.
  //  - When no complete candidate exists (lone / all-incomplete), a block turns a
  //    PARTIAL submit into an EMPTY one. A partial grades 0-or-1; empty always 0.
  //    So blocking is ≤ current behaviour, with a PASS→FAIL tail when the consumer
  //    is a benign no-op caller. The block was implemented, proven net-negative,
  //    and REVERTED. The real lever is item-6 (regenerate a COMPLETE candidate),
  //    not suppressing the incomplete one.
  // KEPT from the increment: the relatedness guard in familyCoverageMissingHardReasons
  // (pure safety — stops a round-robin mis-tag from wrongly vetoing an unrelated fix).

  const familyMissing = (reasons: readonly string[] | undefined): boolean =>
    (reasons ?? []).some((x) => x.startsWith("hard:familyCoverageMissing="))

  it("a complete sibling ALREADY beats an incomplete producer-consumer via best-effort ranking — no block needed", async () => {
    const incomplete = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py"]),
      files: ["pkg/producer.py"],
      familyId: "producer-consumer",
      familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const complete = cand({
      id: "cand-1",
      patch: patchForFiles(["pkg/producer.py", "pkg/consumer.py"]),
      files: ["pkg/producer.py", "pkg/consumer.py"],
      familyId: "producer-consumer",
      familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const r = await runSelection({
      n: 2,
      mode: "clean",
      proofRequired: true,
      seeds: [undefined, undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      ports: {
        generate: async (i) => (i === 0 ? incomplete : complete),
        mweProof: async () => ({ state: "patched_green" }),
      },
    })
    // The complete candidate wins on its own merits; this is why a best-effort
    // block adds no value (and would only hurt the lone-incomplete case).
    expect(r.winner?.files).toEqual(["pkg/producer.py", "pkg/consumer.py"])
  })

  it("a lone incomplete producer-consumer candidate STILL submits its partial (benign — ≥ empty); the lever is regeneration not suppression", async () => {
    const incomplete = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py"]),
      files: ["pkg/producer.py"],
      familyId: "producer-consumer",
      familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      ports: { generate: genOnce(incomplete) },
    })
    // Inadmissible (veto fires) but best-effort submits the partial — NOT empty.
    expect(r.scored[0]?.verdict.admissible).toBe(false)
    expect(familyMissing(r.scored[0]?.verdict.reasons)).toBe(true)
    expect(r.winner?.files).toEqual(["pkg/producer.py"])
  })

  it("KEPT — relatedness guard: a candidate tagged with a producer-consumer family it touches NONE of is NOT vetoed", async () => {
    const mistagged = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/unrelated.py"]),
      files: ["pkg/unrelated.py"],
      familyId: "producer-consumer",
      familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/unrelated.py"]),
      ports: { generate: genOnce(mistagged) },
    })
    // Touches none of the family ⇒ spurious tag ⇒ veto suppressed ⇒ still wins.
    expect(familyMissing(r.scored[0]?.verdict.reasons)).toBe(false)
    expect(r.winner?.files).toEqual(["pkg/unrelated.py"])
  })

  it("KEPT — relatedness guard does NOT suppress a genuine miss: touching the producer but not the consumer still vetoes", async () => {
    // Related (touches the producer) but incomplete ⇒ the veto MUST still fire.
    // Guards against the relatedness guard over-suppressing.
    const related = cand({
      id: "cand-0",
      patch: patchForFiles(["pkg/producer.py"]),
      files: ["pkg/producer.py"],
      familyId: "producer-consumer",
      familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
    })
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["pkg/producer.py", "pkg/consumer.py"]),
      ports: { generate: genOnce(related) },
    })
    expect(familyMissing(r.scored[0]?.verdict.reasons)).toBe(true)
  })
})

describe("scaffold-absorb jun24 — T0 frozen fixtures + slice manifest", () => {
  it("records exactly the three canonical fails with observed single-owner shapes", () => {
    expect(FIXTURES.map((f) => f.instanceId)).toEqual([
      "django__django-14315",
      "django__django-11138",
      "astropy__astropy-13033",
    ])
    // Most fixtures record a non-empty observed shape; 11138 is the deliberate
    // empty-capture exception (0 files = our real 0-byte submission).
    expect(
      FIXTURES.filter((f) => f.ourPatchTouchedFiles.length === 0).map((f) => f.instanceId),
    ).toEqual(["django__django-11138"])
    // 14315 / 11138 are the single-file false-winner shapes.
    const byId = (id: string): ObservedFailFixture =>
      FIXTURES.find((f) => f.instanceId === id) as ObservedFailFixture
    expect(byId("django__django-14315").ourPatchTouchedFiles).toEqual([
      "django/db/backends/postgresql/client.py",
    ])
    // 11138 was an EMPTY 0-byte submission (fork-worktree extraction bug). Our
    // receipt touched zero files; a gold file must never be laundered in here.
    expect(byId("django__django-11138").ourPatchTouchedFiles).toEqual([])
    expect(byId("django__django-11138").expectedFailureClass).toBe("fork-worktree-empty-capture")
    expect(byId("astropy__astropy-13033").ourPatchTouchedFiles).toEqual([
      "astropy/timeseries/core.py",
    ])
  })

  it("ANSWER-KEY: 11138 records no gold file as our own (gold-as-ours trap guard)", () => {
    // mysql/operations.py is GOLD file #1; it must not appear as our patch shape.
    const f = FIXTURES.find((x) => x.instanceId === "django__django-11138") as ObservedFailFixture
    expect(f.ourPatchTouchedFiles).not.toContain("django/db/backends/mysql/operations.py")
    expect(f.ourPatchTouchedFiles).toHaveLength(0)
  })

  it("ANSWER-KEY FENCE: no fixture carries a gold patch / PR diff / hidden-oracle field (red-on-injection)", () => {
    for (const f of FIXTURES) expect(() => assertNoAnswerKey(f)).not.toThrow()

    // Red-on-injection: a fixture mutated to carry diff text MUST throw.
    const poisoned: ObservedFailFixture = {
      ...CANONICAL_FAIL_FIXTURES[0],
      note: "diff --git a/secret.py b/secret.py\n+++ b/secret.py",
    } as ObservedFailFixture
    expect(() => assertNoAnswerKey(poisoned)).toThrow(/answer-key marker/)
  })

  it("freezes per-lever target slices that match the plan's promotion protocol", () => {
    expect(FROZEN_SLICE_MANIFEST.frozenAt).toBe("2026-06-24")
    // 11138 is NOT a coverage target (empty-capture infra bug → captureCorrectness).
    expect(FROZEN_SLICE_MANIFEST.target.coverageContract).toEqual(["django__django-14315"])
    expect(FROZEN_SLICE_MANIFEST.target.coverageContract).not.toContain("django__django-11138")
    expect(FROZEN_SLICE_MANIFEST.target.captureCorrectness).toEqual(["django__django-11138"])
    expect(FROZEN_SLICE_MANIFEST.target.specFidelity).toEqual(["astropy__astropy-13033"])
    expect(FROZEN_SLICE_MANIFEST.target.deeperLocalize).toEqual(["django__django-14315"])
    // Every target id has a recorded observed-fail fixture.
    for (const id of ALL_TARGET_INSTANCE_IDS) {
      expect(FIXTURES.some((f) => f.instanceId === id)).toBe(true)
    }
  })

  it("OVERFITTING GUARD: the broad medium/control slice is non-empty and disjoint from the target cases", () => {
    expect(BROAD_REGRESSION_SLICE.length).toBeGreaterThanOrEqual(10)
    for (const id of ALL_TARGET_INSTANCE_IDS) {
      expect(BROAD_REGRESSION_SLICE).not.toContain(id)
    }
    expect(FROZEN_SLICE_MANIFEST.control).toBe(BROAD_REGRESSION_SLICE)
    expect(FROZEN_SLICE_MANIFEST.medium).toBe(BROAD_REGRESSION_SLICE)
  })

  it("DRIFT GUARD: the broad slice stays in sync with the wired smoke picks-10", () => {
    const picksPath = join(import.meta.dir, "../smoke/swebench/picks-10.jsonl")
    // The smoke slice is the source of truth for the broad regression set; if it
    // moves, this manifest must be re-frozen deliberately, not drift silently.
    if (!existsSync(picksPath)) {
      throw new Error(`expected wired smoke slice at ${picksPath}`)
    }
    const picksIds = readFileSync(picksPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l).instance_id as string)
    expect([...BROAD_REGRESSION_SLICE].sort()).toEqual([...picksIds].sort())
  })
})
