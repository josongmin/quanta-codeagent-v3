/**
 * Observation renderer (jul-6 S3). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§4, the
 * `<quanta_observations>` schema example, adversarial-audit section).
 *
 * Two render modes, one bundle:
 *   - `renderObservations`  — the kernel `<quanta_observations>` block. Carries
 *     the audit's overtrust antidote IN ITS STRUCTURE (routing-hint header +
 *     always-present `anti_signals` + top-k candidates, never top-1 + ordinal
 *     strength, NO numeric confidence).
 *   - `renderObservationsLegacy` — a byte-identical passthrough to the existing
 *     `composeAgentlessHint` markdown, reconstructed from the bundle owners. This
 *     is what lets the live issue-hint seam be routed through the kernel with the
 *     kernel OFF and stay byte-identical to today's `## Issue Hints`.
 *
 * HARD invariants (audit-derived — pinned by red-on-injection tests):
 *   - The block is presence-evidence, NEVER authoritative. The header says so.
 *   - `anti_signals` is ALWAYS present when any owner renders.
 *   - Candidates are top-k; NEVER narrowed to 1 when ≥2 exist.
 *   - Ordinal strength only; NO numeric confidence anywhere in the output.
 *   - Empty bundle ⇒ empty string (byte-identical no-inject sentinel).
 */

import type { ObservationBundle, OwnerHint } from "../fragment"

/** The routing-hint header — presence-evidence framing, NOT authoritative.
 *  This exact string is the audit's A1/A2 mitigation and is source-fenced. */
const ROUTING_HEADER =
  "# routing hints — verify against source before editing (presence evidence, not proof)"

/** The anchor-antidote lines. ALWAYS rendered when any owner renders so a lone
 *  or confident-looking static owner never reads as THE owner (A1). */
const ANTI_SIGNAL_LINES: readonly string[] = [
  "dynamic dispatch / reflection may bypass the static owner above",
  "verify with read/LSP before editing; a candidate is a locator, not the owner",
]

/** Render one candidate owner as YAML-ish lines under `candidate_owners:`. The
 *  leading `- file:` shape is what the top-k count test anchors on. */
const renderOwner = (o: OwnerHint): string[] => {
  const lines: string[] = [`  - file: ${o.file}`]
  if (o.symbol !== undefined && o.symbol !== "") lines.push(`    symbol: ${o.symbol}`)
  // Ordinal strength only — never a number.
  if (o.strength !== undefined) lines.push(`    strength: ${o.strength}`)
  if (o.evidence !== "") lines.push(`    evidence: ${o.evidence}`)
  lines.push(`    source: ${o.source}`)
  return lines
}

/**
 * The kernel `<quanta_observations>` block. Empty bundle (no owners) ⇒ "".
 * The scaffolding here (header, anti_signals, top-k) is the audit antidote and
 * MUST NOT be omissible — dropping any of it is a red-on-injection failure.
 */
export const renderObservations = (bundle: ObservationBundle): string => {
  const owners = bundle.owners
  if (owners.length === 0) return ""

  const lines: string[] = [ROUTING_HEADER, "<quanta_observations>"]

  // top-k candidates — NEVER narrowed to 1. We render EVERY owner the pipeline
  // ranked in; the pipeline (budget) decides k, the renderer never collapses.
  lines.push("candidate_owners:")
  for (const o of owners) lines.push(...renderOwner(o))

  // anti_signals — ALWAYS present when any owner renders (anchor antidote).
  lines.push("anti_signals:")
  for (const s of ANTI_SIGNAL_LINES) lines.push(`  - ${s}`)

  const impact = bundle.impact
  if (impact !== undefined) {
    lines.push("impact_surface:")
    lines.push(`  likely_runtime_paths: [${impact.likelyRuntimePaths.join(", ")}]`)
    lines.push(`  risky_callers: [${impact.riskyCallers.join(", ")}]`)
    lines.push(`  tests_not_to_edit: [${impact.testsNotToEdit.join(", ")}]`)
  }

  const scope = bundle.scope
  if (scope !== undefined) {
    lines.push("recommended_scope:")
    lines.push(`  allow: [${scope.allow.join(", ")}]`)
    lines.push(`  avoid: [${scope.avoid.join(", ")}]`)
  }

  lines.push("</quanta_observations>")
  return lines.join("\n")
}

/**
 * Byte-identical legacy passthrough. Reconstructs the EXACT
 * `composeAgentlessHint` markdown from the bundle owners so that routing the
 * live issue-hint seam through the kernel is byte-identical when the kernel is
 * OFF. Owner `file` ⇒ path, owner `evidence` ⇒ the per-file rationale (empty
 * evidence ⇒ the "path only" branch, mirroring `rationales[i] ?? ""`).
 *
 * Kept in lock-step with `composeAgentlessHint` by a byte-identity test that
 * compares against the REAL composer for several inputs.
 */
export const renderObservationsLegacy = (bundle: ObservationBundle): string => {
  const owners = bundle.owners
  if (owners.length === 0) return ""
  const lines: string[] = ["## Issue Hints (Agentless localization)", ""]
  lines.push(`Top-${owners.length} files most likely to contain the bug:`)
  for (let i = 0; i < owners.length; i++) {
    const o = owners[i]
    if (o === undefined) continue
    const reason = o.evidence
    if (reason !== "") lines.push(`${i + 1}. \`${o.file}\` — ${reason}`)
    else lines.push(`${i + 1}. \`${o.file}\``)
  }
  lines.push("")
  lines.push("Use these as starting points but verify with your own tools.")
  return lines.join("\n")
}
