/**
 * OPC-07 HELLGATE — executable acceptance gates for the typed LLM evidence
 * packet pipeline. Authored by the hellgate/adversarial-audit arm; the impl is
 * owned separately. These gates must hold before OPC-07 is "done".
 *
 * Design constraint: assertions are made on INPUT→RENDERED-OUTPUT seams and on
 * module exports / source wiring, NOT on the inner packet field shapes. That
 * keeps the gate valid across the string-bag → typed-objects schema migration
 * (ticket "Packet schema decision").
 *
 * Expected colour at authoring time (RED = the real defect this pins):
 *   - blindness red-on-injection ............ RED  (no chokepoint guard exists)
 *   - shared generation builder exported .... RED  (duplicated inline in 2 drivers)
 *   - generation builder duplication ........ RED  (defined verbatim in both drivers)
 *   - live apps driver attaches evidence .... RED  (wired only to the dead runner twin)
 *   - placeholder absence (intake/explain) .. GREEN (control: these stages are fine)
 *   - instanceIdHash consistency ............ GREEN (control: 4/5 stages already agree)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import * as packet from "@/runner/batch/eval/llm-evidence-packet"
import {
  buildIntakeLlmEvidencePacket,
  buildSelectionExplanationPacket,
  opaqueInstanceIdHash,
  renderLlmEvidencePacket,
} from "@/runner/batch/eval/llm-evidence-packet"

const REPO_ROOT = process.cwd()
const readSrc = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8")

/** Structural SWE-bench dataset keys that must NEVER reach a rendered prompt. */
const FORBIDDEN_MARKERS = ["FAIL_TO_PASS", "PASS_TO_PASS", "test_patch"] as const

/** The forbidden "points back to ambient prompt text" self-containedness smell. */
const PLACEHOLDER_SMELL = "already attached in the main task prompt"

const minimalIntake = (problemStatement: string) =>
  buildIntakeLlmEvidencePacket({
    problemStatement,
    localizeCandidates: ["pkg/mod/target.py"],
  })

const minimalExplanation = (problemStatement: string) =>
  buildSelectionExplanationPacket({
    problemStatement,
    ownerFiles: ["pkg/mod/target.py"],
    winnerId: "cand-0",
    candidates: [
      { id: "cand-0", files: ["pkg/mod/target.py"], admissible: true, reasons: [] },
    ],
  })

describe("OPC-07 hellgate — benchmark blindness (red-on-injection)", () => {
  // A rendered packet must never carry a structural benchmark dataset key, even
  // when one is injected into the public issue text. The ticket calls this a
  // HARD guard (answer-key leakage is the cardinal sin). A guard that either
  // strips the marker or throws both satisfy the gate; what is NOT allowed is
  // the marker surviving into the rendered prompt.
  const renderOrThrow = (build: () => packet.LlmEvidencePacket): string | "threw" => {
    try {
      return renderLlmEvidencePacket(build())
    } catch {
      return "threw"
    }
  }

  for (const marker of FORBIDDEN_MARKERS) {
    test(`intake packet must not leak "${marker}" injected via issue text`, () => {
      const injected = `Bug: crash in ${marker} pkg/tests/test_x.py::case when run.\n\nFull description of the public issue.`
      const out = renderOrThrow(() => minimalIntake(injected))
      if (out === "threw") return // guard rejected the leak — acceptable
      expect(out).not.toContain(marker)
    })
  }

  test(`selection_explanation packet must not leak "test_patch" injected via issue text`, () => {
    const injected = "Apply test_patch to reproduce the failure described in this public issue."
    const out = renderOrThrow(() => minimalExplanation(injected))
    if (out === "threw") return
    expect(out).not.toContain("test_patch")
  })
})

describe("OPC-07 hellgate — self-containedness (no ambient-prompt placeholder)", () => {
  // Control: intake + selection_explanation already pass — they emit real issue
  // facts. This pins the bar that the generation/repair builders must also meet.
  test("intake packet carries real issue facts, not the placeholder", () => {
    const rendered = renderLlmEvidencePacket(
      minimalIntake("NullPointer in resolve_owner when config is empty (public issue)."),
    )
    expect(rendered).not.toContain(PLACEHOLDER_SMELL)
    expect(rendered).toContain("resolve_owner")
  })

  test("selection_explanation packet carries real issue facts, not the placeholder", () => {
    const rendered = renderLlmEvidencePacket(
      minimalExplanation("NullPointer in resolve_owner when config is empty (public issue)."),
    )
    expect(rendered).not.toContain(PLACEHOLDER_SMELL)
  })

  // GATE (expected RED until impl owner extracts the shared generation builder):
  // the candidate_generation packet is currently built by a private inline
  // function duplicated in both drivers. The ticket (acceptance: "shared from
  // one helper, not duplicated") requires a single exported builder. Once it is
  // exported here, the self-containedness assertion below must also hold.
  test("shared candidate_generation packet builder is exported from one helper", () => {
    const fn = (packet as Record<string, unknown>).buildSelectionGenerationPacket
    expect(typeof fn).toBe("function")
  })

  test("shared generation builder, once exported, is self-contained (carries issue facts)", () => {
    const fn = (packet as Record<string, unknown>).buildSelectionGenerationPacket as
      | ((args: {
          problemStatement: string
          ownerFiles: readonly string[]
          contractIds: readonly string[]
          closureHint?: string
          seed?: string
          reproHint?: string
        }) => string)
      | undefined
    if (fn === undefined) {
      throw new Error(
        "OPC-07: buildSelectionGenerationPacket is not exported — still duplicated inline in apps + runner drivers (acceptance: one shared helper).",
      )
    }
    const rendered = fn({
      problemStatement: "NullPointer in resolve_owner when config is empty (public issue).",
      ownerFiles: ["pkg/mod/owner.py"],
      contractIds: [],
    })
    expect(rendered).not.toContain(PLACEHOLDER_SMELL)
    expect(rendered).toContain("resolve_owner")
  })
})

describe("OPC-07 hellgate — instanceIdHash cross-stage consistency", () => {
  const problem = "Deterministic identity must be stable across stages for one instance."

  test("intake and selection_explanation derive the same opaque instanceIdHash", () => {
    const intake = minimalIntake(problem)
    const explain = minimalExplanation(problem)
    expect(intake.instanceIdHash).toBe(opaqueInstanceIdHash(problem))
    expect(explain.instanceIdHash).toBe(intake.instanceIdHash)
  })

  // GATE (expected RED until repair_seed is fixed): repair_seed currently
  // derives instanceIdHash from candidate identity (candidatePatchHash of ids)
  // instead of opaqueInstanceIdHash(problemStatement), so it never matches the
  // other four stages. The repair builder is a private closure in
  // selection-executor.ts; pin the defect via source until it is extracted.
  test("repair_seed must derive instanceIdHash from the problem statement, not candidate ids", () => {
    const src = readSrc("src/runner/batch/eval/selection-executor.ts")
    // The repair packet block must NOT compute instanceIdHash from candidatePatchHash(...).
    const repairBlock = src.slice(src.indexOf('stage: "repair_seed"'))
    const head = repairBlock.slice(0, 600)
    const usesCandidateIdsForInstanceHash = /instanceIdHash:\s*candidatePatchHash\(/.test(head)
    expect(usesCandidateIdsForInstanceHash).toBe(false)
  })
})

describe("OPC-07 hellgate — single shared builder (no driver duplication)", () => {
  const definesGenerationBuilder = (rel: string): boolean =>
    /const buildSelectionGenerationPacket\s*=/.test(readSrc(rel))

  test("candidate_generation builder is defined once, not inline in both drivers", () => {
    const definitions = [
      "src/apps/bench/eval/driver.ts",
      "src/runner/batch/eval/driver.ts",
    ].filter(definesGenerationBuilder)
    // Acceptance: shared from one helper. Two inline copies = duplication.
    expect(definitions.length).toBeLessThan(2)
  })
})

// Acceptance (OPC-07 lines 346-351) names three failed cases whose packets must
// route to the right ask. These need the exported generation/repair builders +
// per-case inputs; the impl owner unskips each once the live builders exist.
// Kept as documented specs (visible skips) so the required behaviour is pinned.
describe.skip("OPC-07 hellgate — 3-case packet semantics (impl owner unskips)", () => {
  test("astropy env failure ⇒ packet asks for env/proof recovery, not candidate blame", () => {
    // proofReceipts state must be env_prep_failed/execution_failed (infra_blocked),
    // never candidate_red; question must request env/proof recovery.
    expect(true).toBe(true)
  })
  test("django 11138 contract-only multi-file drift ⇒ packet asks for public proof or bounded repair, not submit", () => {
    // contract-only coverage must yield repair_only, never proof_positive/submit.
    expect(true).toBe(true)
  })
  test("django 14315 shell/env ⇒ packet asks for runshell/env proof, not static owner approval", () => {
    expect(true).toBe(true)
  })
})

describe("OPC-07 hellgate — live wiring (dead-path detection)", () => {
  // P0: the intake + selection_explanation builders and the result.llmEvidence
  // artifact are wired ONLY into src/runner/batch/eval/driver.ts, which is the
  // documented "(dead) runner-driver twin". The LIVE bench command runs
  // src/apps/bench/eval/driver.ts. So the typed packets never reach a real run.
  // This gate fails until the live apps driver attaches the evidence artifacts.
  test("LIVE apps driver attaches LLM evidence artifacts to its result", () => {
    const apps = readSrc("src/apps/bench/eval/driver.ts")
    const wiresEvidence =
      /buildSelectionExplanationPacket|attachLlmEvidenceArtifacts|llmEvidence/.test(apps)
    expect(wiresEvidence).toBe(true)
  })
})
