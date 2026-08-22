/**
 * T-201 — bench adapter for FaultEvidencePacket. Assembles the blind builder
 * inputs the driver already has (stage-1 ranking, issue-named files, bounded LSP
 * owner-resolve) and renders a COMPACT owner hint — the bounded replacement for
 * the old unbounded raw-source blob injection.
 *
 * Gated by `QUANTA_BENCH_FAULT_EVIDENCE` at the driver call site (default-OFF ⇒
 * byte-identical). EVAL-LABEL-FREE: inputs are blind (issue + repo structure).
 */
import {
  buildFaultEvidencePacket,
  type FaultEvidenceInput,
  type FaultEvidencePacket,
} from "@/agent/fault-evidence/build"

export type { FaultEvidenceInput, FaultEvidencePacket }
export { buildFaultEvidencePacket }

/** Assemble + build in one step from the driver-gathered blind inputs. */
export const assembleFaultEvidence = (input: FaultEvidenceInput): FaultEvidencePacket =>
  buildFaultEvidencePacket(input)

/**
 * Render the packet as a compact, bounded owner hint for prompt injection.
 * NEVER emits file bodies — only paths, provenance and symbol names. Returns ""
 * for an empty packet so the caller can skip injection entirely.
 */
export const renderFaultEvidenceHint = (packet: FaultEvidencePacket): string => {
  if (packet.candidates.length === 0) return ""
  const lines: string[] = ["Likely fault owners (ranked; verify before editing):"]
  for (const c of packet.candidates) {
    const syms = c.symbols.length > 0 ? `  [${c.symbols.join(", ")}]` : ""
    lines.push(`- ${c.file}${syms}`)
  }
  if (packet.issueSymbols.length > 0) {
    lines.push(`Issue symbols: ${packet.issueSymbols.join(", ")}`)
  }
  if (packet.partial) lines.push("(partial evidence — localization signals incomplete)")
  return lines.join("\n")
}
