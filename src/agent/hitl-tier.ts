/**
 * HITL 4-tier annotation surface (ADR-0047 — borrowed from Codex Computer Use
 * SKILL.md's confirmation policy).
 *
 * Per-tool HITL annotations classify the inherent sensitivity of an operation
 * independently of mode / approval policy / reviewer-tier. This is the data
 * shape; the matching dispatch logic lives in `hitl-tier-registry.ts`
 * (`getToolHitlTier`) and is consumed by `admissibility-gate.ts`.
 *
 * Relationship to neighbours:
 *   - `HITLTier` (canonical literal union) is re-exported from
 *     `@/permission` so the dispatch seam already speaks the vocabulary —
 *     this module only adds an annotation wrapper carrying optional rationale
 *     + handoff message.
 *   - `Tool.hitlTier?(input)` (in `@/tool/types`) is per-tool, self-declared.
 *     The registry here is per-tool-NAME and ALWAYS overrides the tool's
 *     own declaration (so a host can opt a single deployment into a stricter
 *     stance without forking the tool implementation).
 *   - `ReviewerTier` (ADR-0029) is orthogonal — it selects WHO decides when
 *     confirmation is required; `HitlTier` classifies WHETHER and HOW.
 */

import type { HITLTier } from "@/permission"

/**
 * Re-export of the canonical 4-tier literal union (defined in `@/permission`
 * to stay close to the gate that enforces it). Re-exported here so callers
 * that consume the registry don't have to reach across slices for the type.
 */
export type HitlTier = HITLTier

/**
 * Per-tool HITL annotation. `tier` is mandatory; the optional fields are
 * UI/rationale payloads the dispatch gate forwards on a deny.
 *
 * - `reason`           — short, human-readable rationale shown in the deny
 *                        block content (joined onto the standard message).
 * - `handoffMessage`   — caller-facing message used only when
 *                        `tier === "hand-off-required"`. Surfaces to the UI
 *                        so the operator sees WHY the agent gave up and WHAT
 *                        they should do; replaces the generic suffix when
 *                        present.
 */
export interface ToolHitlAnnotation {
  readonly tier: HitlTier
  readonly reason?: string
  readonly handoffMessage?: string
}
