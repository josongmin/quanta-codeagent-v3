import type { OwnerAdmission } from "@/agent/owner-admission"

/**
 * Round-0 owner hint for the agent prompt. Keys off the FEEDER's resolved
 * siblings (`siblingFiles` = ownerResolved files), NOT the overloaded
 * `coverageExpectation` boolean (which owner-admission sets `true` for ambiguous
 * / no-owner cases too). When the feeder found co-change sites, surface ALL of
 * them at round 0 — the only round that always runs — so a multi-site bug isn't
 * left half-fixed by a single-site edit. With no resolved sibling, fall back to
 * the original single-site one-liner (no false co-change claim).
 */
export const renderClosurePrompt = (
  owner: OwnerAdmission,
  siblingFiles: readonly string[] = [],
): string => {
  const siblings = [...new Set(siblingFiles.filter((f) => f !== owner.owner))]
  if (siblings.length > 0) {
    // Co-change sites resolved by the feeder — surface them REGARDLESS of the
    // single-owner admission (owner may be uncorroborated / null; the override
    // family is still real, and the repair-seed widen surfaces it unconditionally,
    // so the round-0 surface must match). Prepend the owner only when admitted.
    const head =
      owner.admit && owner.owner !== null ? [owner.owner, ...siblings] : siblings
    return [
      "First edit candidates — these override the SAME method (co-change); a single-site edit is INCOMPLETE, fix ALL:",
      ...head.map((f) => `- ${f}`),
    ].join("\n")
  }
  if (!owner.admit || owner.owner === null) return ""
  if (owner.coverageExpectation === "single-site") return `First edit candidate: ${owner.owner}`
  return ""
}
