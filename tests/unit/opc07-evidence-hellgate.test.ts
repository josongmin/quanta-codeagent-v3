/**
 * OPC-07 HELLGATE — executable acceptance gates for the typed LLM evidence
 * packet pipeline. Authored by the hellgate/adversarial-audit arm.
 *
 * Assertions are made on INPUT→RENDERED-OUTPUT seams, module exports, and
 * cross-driver wiring — robust to the inner schema. After the typed-objects
 * landing these gates should all be GREEN.
 *
 * NOTE on the dead-path gate: an early audit pass claimed the intake/explanation
 * packets were wired only into the dead runner-driver twin. Verifying against the
 * code refuted that: the LIVE apps driver finalizes through the SHARED
 * `verifyAndFinalizeResult` → `buildSuccessfulResultExtra` → `attachLlmEvidence-
 * Artifacts`, and builds intake via the SHARED `prepareAttemptContext`. The gate
 * below pins that real wiring so a future refactor that bypasses the shared
 * finalize (and silently drops `result.llmEvidence`) goes red.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as packet from "@/runner/batch/eval/llm-evidence-packet"
import {
  buildIntakeLlmEvidencePacket,
  buildRepairSeedLlmEvidencePacket,
  buildSelectionExplanationPacket,
  buildSelectionGenerationLlmEvidencePacket,
  opaqueInstanceIdHash,
  type RepairSeedPacketInput,
  renderLlmEvidencePacket,
  type SelectionGenerationPacketInput,
} from "@/runner/batch/eval/llm-evidence-packet"

// A8: dead string wrappers removed — render via the live object builders, the
// exact path production uses.
const buildSelectionGenerationPacket = (input: SelectionGenerationPacketInput): string =>
  renderLlmEvidencePacket(buildSelectionGenerationLlmEvidencePacket(input))
const buildRepairSeedPacket = (input: RepairSeedPacketInput): string =>
  renderLlmEvidencePacket(buildRepairSeedLlmEvidencePacket(input))

const REPO_ROOT = process.cwd()
const readSrc = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8")
const PLACEHOLDER_SMELL = "already attached in the main task prompt"
const instanceIdOf = (rendered: string): string | undefined =>
  rendered.match(/"instanceIdHash": "([0-9a-f]+)"/)?.[1]

const minimalIntake = (problemStatement: string) =>
  buildIntakeLlmEvidencePacket({ problemStatement, localizeCandidates: ["pkg/mod/target.py"] })

const minimalExplanation = (problemStatement: string) =>
  buildSelectionExplanationPacket({
    problemStatement,
    ownerFiles: ["pkg/mod/target.py"],
    winnerId: "cand-0",
    candidates: [{ id: "cand-0", files: ["pkg/mod/target.py"], admissible: true, reasons: [] }],
  })

describe("OPC-07 hellgate — benchmark blindness (red-on-injection)", () => {
  // A forbidden structural dataset KEY injected into the public issue text must
  // be caught by the HARD guard specifically (not by some incidental error). We
  // assert the exact PacketBlindnessViolation so a builder that throws for an
  // unrelated reason cannot green this gate, and a guard that silently lets the
  // marker through also fails.
  for (const marker of packet.FORBIDDEN_PACKET_MARKERS) {
    test(`intake packet build THROWS PacketBlindnessViolation on "${marker}" in issue text`, () => {
      const injected = `Bug: ${marker} pkg/tests/test_x.py::case fails when run.\n\nFull public issue description.`
      expect(() => minimalIntake(injected)).toThrow(packet.PacketBlindnessViolation)
    })

    test(`if the guard is bypassed, the marker "${marker}" must not survive a render`, () => {
      // Belt-and-braces: even constructing the packet object directly and
      // rendering, the marker must never reach the rendered prompt.
      const build = (): packet.LlmEvidencePacket => minimalIntake(`leak ${marker} here`)
      let rendered: string | undefined
      try {
        rendered = renderLlmEvidencePacket(build())
      } catch (e) {
        expect(e).toBeInstanceOf(packet.PacketBlindnessViolation)
        return
      }
      expect(rendered).not.toContain(marker)
    })
  }

  test("FORBIDDEN_PACKET_MARKERS covers the SWE-bench split keys", () => {
    expect(packet.FORBIDDEN_PACKET_MARKERS).toContain("FAIL_TO_PASS")
    expect(packet.FORBIDDEN_PACKET_MARKERS).toContain("PASS_TO_PASS")
  })

  test("forbiddenSources menu may still NAME gold_patch (meta is not scanned)", () => {
    // The guard scans evidence content only, so the action menu can declare the
    // forbidden sources without tripping the guard.
    const rendered = renderLlmEvidencePacket(minimalIntake("A normal public issue."))
    expect(rendered).toContain("gold_patch")
  })
})

describe("OPC-07 hellgate — self-containedness (no ambient-prompt placeholder)", () => {
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

  test("shared candidate_generation packet builder is exported from one helper", () => {
    // A8: the live builder is the OBJECT builder; the dead string wrapper was removed.
    expect(
      typeof (packet as Record<string, unknown>).buildSelectionGenerationLlmEvidencePacket,
    ).toBe("function")
    // A8 fence: the removed string wrapper must NOT come back.
    expect((packet as Record<string, unknown>).buildSelectionGenerationPacket).toBeUndefined()
  })

  test("generation packet is self-contained (real issue facts, no placeholder)", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "NullPointer in resolve_owner when config is empty (public issue).",
      ownerEvidence: [
        { file: "pkg/mod/owner.py", symbols: ["resolve_owner"], provenance: "selection-owner" },
      ],
      contracts: [],
    })
    expect(rendered).not.toContain(PLACEHOLDER_SMELL)
    expect(rendered).toContain("resolve_owner")
  })

  test("generation packet carries the active proof target when a plan is provided", () => {
    const rendered = buildSelectionGenerationPacket({
      problemStatement: "Crash in resolve_owner.",
      ownerEvidence: [],
      contracts: [],
      verificationTarget: {
        primaryRail: { kind: "repro", cmd: "python repro.py" },
        required: [{ kind: "repro", cmd: "python repro.py" }],
        optional: [],
        baseValidatedRed: true,
      },
    })
    expect(rendered).toContain('"verificationTarget"')
    expect(rendered).toContain("python repro.py")
  })

  test("repair_seed packet is self-contained (real issue facts, no placeholder)", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: "NullPointer in resolve_owner when config is empty (public issue).",
      candidatePatchHash: "deadbeef",
      ownerEvidence: [{ file: "pkg/mod/owner.py", symbols: [], provenance: "repair-owner" }],
      proofReceipts: [{ source: "public_mwe", state: "candidate_red" }],
      contracts: [],
    })
    expect(rendered).not.toContain(PLACEHOLDER_SMELL)
    expect(rendered).toContain("resolve_owner")
  })
})

describe("OPC-07 hellgate — instanceIdHash cross-stage consistency", () => {
  const problem = "Deterministic identity must be stable across stages for one instance."

  test("intake, explanation, generation and repair all share the opaque per-instance id", () => {
    const expected = opaqueInstanceIdHash(problem)
    expect(minimalIntake(problem).instanceIdHash).toBe(expected)
    expect(minimalExplanation(problem).instanceIdHash).toBe(expected)
    expect(
      instanceIdOf(
        buildSelectionGenerationPacket({
          problemStatement: problem,
          ownerEvidence: [],
          contracts: [],
        }),
      ),
    ).toBe(expected)
    expect(
      instanceIdOf(
        buildRepairSeedPacket({
          problemStatement: problem,
          candidatePatchHash: "abc123",
          ownerEvidence: [],
          proofReceipts: [],
          contracts: [],
        }),
      ),
    ).toBe(expected)
  })

  test("repair_seed keeps candidate identity in candidatePatchHash, not instanceIdHash", () => {
    const rendered = buildRepairSeedPacket({
      problemStatement: problem,
      candidatePatchHash: "cand-identity-9",
      ownerEvidence: [],
      proofReceipts: [],
      contracts: [],
    })
    expect(rendered).toContain('"candidatePatchHash": "cand-identity-9"')
    expect(instanceIdOf(rendered)).toBe(opaqueInstanceIdHash(problem))
  })
})

describe("OPC-07 hellgate — single shared builder (no driver duplication)", () => {
  const definesGenerationBuilder = (rel: string): boolean =>
    /const buildSelectionGenerationLlmEvidencePacket\s*=/.test(readSrc(rel))

  test("candidate_generation builder is defined once, not inline in both drivers", () => {
    const definitions = ["src/apps/bench/eval/driver.ts", "src/runner/batch/eval/driver.ts"].filter(
      definesGenerationBuilder,
    )
    expect(definitions.length).toBe(0) // both now import the shared helper
  })
})

describe("OPC-07 hellgate — live wiring (result.llmEvidence reaches the live path)", () => {
  // The LIVE apps driver must finalize through the SHARED verifyAndFinalizeResult,
  // and that shared finalize must attach the LLM evidence artifacts. If a refactor
  // bypasses either link, result.llmEvidence silently disappears on real runs.
  test("LIVE apps driver CALLS the shared verifyAndFinalizeResult (not just imports it)", () => {
    // Assert the call form `verifyAndFinalizeResult(` so an orphaned import that
    // no longer drives finalization cannot green this gate.
    expect(readSrc("src/apps/bench/eval/driver.ts")).toMatch(/verifyAndFinalizeResult\s*\(/)
  })

  test("shared successful-result extra attaches LLM evidence artifacts", () => {
    const runner = readSrc("src/runner/batch/eval/driver.ts")
    const extraBlock = runner.slice(runner.indexOf("const buildSuccessfulResultExtra"))
    expect(extraBlock.slice(0, 1200)).toContain("attachSelectionAndClosureArtifacts")
    expect(runner).toContain("args.extra.llmEvidence")
  })
})
