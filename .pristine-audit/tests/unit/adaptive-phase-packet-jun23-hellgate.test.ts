import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAdaptivePhasePacket } from "@/runner/batch/eval/driver"
import { renderLlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"

const withSandbox = (source: string, run: (sandbox: string) => void): void => {
  const sandbox = mkdtempSync(join(tmpdir(), "adaptive-phase-packet-"))
  try {
    writeFileSync(join(sandbox, "widget.ts"), source)
    run(sandbox)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

describe("adaptive phase packet live evidence (jun-23)", () => {
  test("thin post-review path carries candidateEditSurface and static-witness diagnostics into the router packet", () => {
    withSandbox("function render() {\n  return 1\n}\n", (sandbox) => {
      const packet = buildAdaptivePhasePacket({
        instance: { id: "inst-1", problemStatement: "Fix render() in widget.ts." } as never,
        phase: {
          patch: [
            "diff --git a/widget.ts b/widget.ts",
            "--- a/widget.ts",
            "+++ b/widget.ts",
            "@@",
            "-function render() {",
            "-  return 1",
            "+function render() {",
            "+  return 2",
            " }",
            "",
          ].join("\n"),
          stopReason: "done",
        } as never,
        prepared: {
          closureSession: undefined,
          ownerResolved: undefined,
          localizeCandidates: ["widget.ts"],
          verificationPlan: undefined,
          reproTest: undefined,
        } as never,
        sandbox,
      })

      expect(packet.stage).toBe("phase_routing")
      expect(packet.candidateEditSurface?.touchedFiles).toContain("widget.ts")
      expect(packet.candidateEditSurface?.touchedSymbols).toBeDefined()
      expect(
        packet.staticFacts.some((fact) => fact.kind === "static_witness_unsupported_language"),
      ).toBe(true)
      expect(packet.missingEvidence.some((missing) => missing.kind === "static_witness")).toBe(true)

      const rendered = renderLlmEvidencePacket(packet)
      expect(rendered).toContain("phase_routing")
      expect(rendered).toContain('"candidateEditSurface"')
      expect(rendered).toContain("static_witness_unsupported_language")
    })
  })

  test("selection-telemetry routing path keeps winner-local edit surface and static-witness diagnostics", () => {
    withSandbox("function render() {\n  return 1\n}\n", (sandbox) => {
      const packet = buildAdaptivePhasePacket({
        instance: { id: "inst-2", problemStatement: "Fix render() in widget.ts." } as never,
        phase: {
          patch: "",
          selectionTelemetry: {
            ownerFiles: ["widget.ts"],
            winnerId: "cand-1",
            candidates: [
              {
                id: "cand-1",
                files: ["widget.ts"],
                touchedSymbols: ["render"],
                admissible: true,
                score: 1,
                reasons: ["proof_positive"],
              },
            ],
          },
        } as never,
        prepared: {
          ownerResolved: undefined,
          localizeCandidates: ["widget.ts"],
        } as never,
        sandbox,
      })

      expect(packet.stage).toBe("phase_routing")
      expect(packet.candidateEditSurface?.touchedFiles).toEqual(["widget.ts"])
      expect(packet.candidateEditSurface?.touchedSymbols).toEqual(["render"])
      expect(
        packet.staticFacts.some((fact) => fact.kind === "static_witness_unsupported_language"),
      ).toBe(true)

      const rendered = renderLlmEvidencePacket(packet)
      expect(rendered).toContain("phase_routing")
      expect(rendered).toContain('"candidateEditSurface"')
      expect(rendered).toContain("static_witness_unsupported_language")
    })
  })
})
