/**
 * Permission inspector — slash-command facade (Codex-inspired 5-axis stack).
 *
 * Read-only programmatic surface for `/permission explain <tool>` and similar
 * inspector UIs. Composes the EXISTING decision primitives:
 *
 *   - HARD_DENY rules from {@link ./policy-rules}     (axis 2: security boundary)
 *   - `evaluate` mode policy from {@link ./policy}    (axis 5: global default)
 *   - `evaluateStack` 5-axis precedence semantics      (axes 1-5: full stack)
 *   - HITL 4-tier taxonomy from {@link @/shared}      (orthogonal annotation)
 *
 * Why a separate module (vs extending the existing `inspector.ts`):
 *   - `inspector.ts` requires a {@link PermissionStore} and answers "what
 *     would the stack do for THIS thread/host?". The slash command needs a
 *     STATELESS, store-free answer: "what is the policy SHAPE for this tool
 *     across all modes?". Different question ⇒ different surface.
 *   - The slash command must NEVER expose HARD_DENY regex literals
 *     (jailbreak path). This module enforces the description-only contract.
 *
 * Slice discipline: lives in `@/permission`. Imports only sibling files +
 * `@/shared` (the `HITLTier` SSOT). NO `@/tool` import — caller (apps/cli)
 * supplies `isReadOnly`/`hitlTier`/`shellCommand` if they have them. An
 * unknown tool surfaces as `unmapped` and the rendered explanation says so.
 *
 * Security: `hardDenyMatched` reports `name` + `description` from
 * `HARD_DENY_RULES` — the raw `RegExp` pattern is NEVER returned. A jailbreak
 * crafter could not use this surface to enumerate the exact catch patterns.
 */

import { hardDenyReason } from "./policy"
import { HARD_DENY_RULES } from "./policy-rules"
import type {
  HITLTier,
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  ToolAction,
} from "./types"

/** Closed enum of the 5 precedence axes. Mirrors `evaluateStack`'s ordering
 *  in `policy.ts` (HARD_DENY at level 2 sits ABOVE the rule-based axes;
 *  read-only is the level-1 short-circuit). A UI iterates this in display
 *  order to render the precedence pipeline. */
export type PermissionAxis =
  | "read-only-bypass"
  | "hard-deny"
  | "hitl-tier"
  | "mode-policy"
  | "global-default"

/** The 5 axes in their precedence order (highest-priority first), for UI
 *  pipeline rendering. Frozen so a caller can't mutate the array. */
export const PERMISSION_AXES: readonly PermissionAxis[] = Object.freeze([
  "read-only-bypass",
  "hard-deny",
  "hitl-tier",
  "mode-policy",
  "global-default",
])

/** Per-axis outcome on a single inspection. `n/a` means the axis did not
 *  apply (e.g. HARD_DENY when no `shellCommand` was supplied). */
export type AxisOutcome = "allow" | "deny" | "ask" | "n/a"

/** Per-axis verdict surfaced in the rendered pipeline. */
export interface AxisStep {
  readonly axis: PermissionAxis
  readonly outcome: AxisOutcome
  /** Plain-English explanation. NEVER includes a raw HARD_DENY regex
   *  pattern — only the rule's `name` + `description`. */
  readonly reason: string
}

/** Closed set of mode policy verdicts surfaced in the per-mode matrix. */
export type ModeVerdict = "allow" | "deny" | "ask"

/** Per-mode decision matrix. Mirrors the 4 modes that `PermissionContext`
 *  supports (`default | acceptEdits | bypass | auto`). The HITL tier overlay
 *  is applied on top of the base `evaluate` policy so the matrix is the
 *  END verdict, not the raw mode-policy verdict. */
export interface ModePolicyMatrix {
  readonly default: ModeVerdict
  readonly acceptEdits: ModeVerdict
  readonly bypass: ModeVerdict
  readonly auto: ModeVerdict
}

/** Matched HARD_DENY rule descriptor surfaced to the CLI. Note the absence
 *  of `pattern` — see security note in the module header. */
export interface MatchedHardDenyRule {
  readonly name: string
  readonly description: string
}

/** Full inspection record returned by {@link inspectPermission}. */
export interface PermissionInspection {
  readonly tool: string
  /** `true` ⇒ the caller supplied an `isReadOnly` flag AND/OR a known
   *  hitlTier; `false` ⇒ unmapped tool (default-policy explanation). */
  readonly mapped: boolean
  readonly isReadOnly: boolean
  /** HITL tier hint. Caller-supplied or inferred. `undefined` ⇒ unmapped. */
  readonly hitlTier?: HITLTier
  /** Whether ANY HARD_DENY rule matched the caller-supplied shellCommand
   *  (or `false` when no shellCommand was supplied — the gate is not
   *  triggered then). */
  readonly hardDenyMatched: boolean
  /** Matched rule descriptors (name + description ONLY — no regex). Empty
   *  when no shellCommand or no match. */
  readonly hardDenyRules: readonly MatchedHardDenyRule[]
  /** Per-mode decision matrix — END verdict including HITL overlay. */
  readonly modePolicy: ModePolicyMatrix
  /** The 5-axis pipeline trace, in precedence order, ready for rendering. */
  readonly pipeline: readonly AxisStep[]
}

/** Caller-supplied tool metadata. Apps/cli typically passes the Tool's own
 *  `isReadOnly()` + `hitlTier(input)` outputs; tests can fabricate. All
 *  fields are optional — an absent field is interpreted as "unknown" and
 *  the inspection degrades gracefully (`mapped: false`). */
export interface InspectToolMeta {
  readonly isReadOnly?: boolean | undefined
  readonly hitlTier?: HITLTier | undefined
  /** Shell-equivalent command string, when the tool input represents one.
   *  Drives the HARD_DENY rule scan (description-only). Absent ⇒ no
   *  HARD_DENY axis activation. */
  readonly shellCommand?: string | undefined
}

/** Walk `HARD_DENY_RULES` and collect matching rule descriptors (NOT regex
 *  patterns). Order matches the catalog. Empty input ⇒ empty result.
 *
 *  Security: the returned descriptors are `name` + `description` from the
 *  static rule table. The raw `pattern: RegExp` field is INTENTIONALLY
 *  dropped — a jailbreak crafter must not be able to read this surface to
 *  enumerate the exact catch patterns. */
const matchHardDenyRules = (command: string | undefined): readonly MatchedHardDenyRule[] => {
  if (command === undefined || command.length === 0) return []
  const out: MatchedHardDenyRule[] = []
  for (const rule of HARD_DENY_RULES) {
    if (rule.pattern.test(command)) {
      out.push({ name: rule.name, description: rule.description })
    }
  }
  return out
}

/** Replay the base `evaluate(action, ctx)` for one mode + return its verdict.
 *  Uses the existing policy so the matrix can NEVER drift from runtime
 *  behavior. The HITL tier overlay is applied separately by the caller. */
const baseModeVerdict = (action: ToolAction, mode: PermissionMode): ModeVerdict => {
  // Inline the synchronous policy semantics — we avoid importing `evaluate`
  // directly because that path also fires `hardDeny`, which we account for
  // separately. The matrix here is the POST-HARD_DENY base verdict; the
  // pipeline composer combines this with the HARD_DENY axis verdict.
  if (action.isReadOnly) return "allow"
  if (mode === "bypass" || mode === "acceptEdits") return "allow"
  if (mode === "auto") return "ask" // synchronous degrade — see policy.ts
  return "ask"
}

/** Apply the HITL tier OVERLAY on top of the base mode verdict.
 *  Precedence (orthogonal to mode):
 *    - hand-off-required ⇒ deny (cannot be relaxed by any mode)
 *    - always-confirm    ⇒ ask  (confirm EVERY time, even under bypass)
 *    - pre-approval-ok   ⇒ base verdict (mode policy applies)
 *    - none              ⇒ allow
 *  `undefined` (unmapped tool) ⇒ base verdict only. */
const applyHitlOverlay = (base: ModeVerdict, tier: HITLTier | undefined): ModeVerdict => {
  if (tier === undefined) return base
  if (tier === "hand-off-required") return "deny"
  if (tier === "always-confirm") return "ask"
  if (tier === "none") return "allow"
  // pre-approval-ok
  return base
}

/** Build the 4-mode matrix in one pass. */
const buildModeMatrix = (action: ToolAction, tier: HITLTier | undefined): ModePolicyMatrix => ({
  default: applyHitlOverlay(baseModeVerdict(action, "default"), tier),
  acceptEdits: applyHitlOverlay(baseModeVerdict(action, "acceptEdits"), tier),
  bypass: applyHitlOverlay(baseModeVerdict(action, "bypass"), tier),
  auto: applyHitlOverlay(baseModeVerdict(action, "auto"), tier),
})

/** Build the 5-axis pipeline trace for the SPECIFIC mode in `ctx`. */
const buildPipeline = (
  action: ToolAction,
  ctx: PermissionContext,
  tier: HITLTier | undefined,
  hardDenyHits: readonly MatchedHardDenyRule[],
): readonly AxisStep[] => {
  const out: AxisStep[] = []

  // Axis 1: read-only bypass.
  if (action.isReadOnly) {
    out.push({
      axis: "read-only-bypass",
      outcome: "allow",
      reason: "Read-only action — bypass every axis except HARD_DENY",
    })
  } else {
    out.push({
      axis: "read-only-bypass",
      outcome: "n/a",
      reason: "Tool mutates state — fall through to the security boundary",
    })
  }

  // Axis 2: HARD_DENY.
  if (hardDenyHits.length > 0) {
    const names = hardDenyHits.map((r) => r.name).join(", ")
    out.push({
      axis: "hard-deny",
      outcome: "deny",
      reason: `HARD_DENY matched ${hardDenyHits.length} rule(s): ${names}`,
    })
  } else if (action.shellCommand === undefined || action.shellCommand === null) {
    out.push({
      axis: "hard-deny",
      outcome: "n/a",
      reason: "No shell command supplied — HARD_DENY gate not triggered",
    })
  } else {
    out.push({
      axis: "hard-deny",
      outcome: "n/a",
      reason: "No HARD_DENY pattern matched the supplied command",
    })
  }

  // Axis 3: HITL tier.
  if (tier === undefined) {
    out.push({
      axis: "hitl-tier",
      outcome: "n/a",
      reason: "Tool is unmapped in the HITL registry — default policy applies",
    })
  } else if (tier === "hand-off-required") {
    out.push({
      axis: "hitl-tier",
      outcome: "deny",
      reason: "Tier hand-off-required — agent must terminate; only a human proceeds",
    })
  } else if (tier === "always-confirm") {
    out.push({
      axis: "hitl-tier",
      outcome: "ask",
      reason: "Tier always-confirm — explicit confirm EVERY time, even under bypass",
    })
  } else if (tier === "pre-approval-ok") {
    out.push({
      axis: "hitl-tier",
      outcome: "n/a",
      reason: "Tier pre-approval-ok — defer to mode policy",
    })
  } else {
    // none
    out.push({
      axis: "hitl-tier",
      outcome: "allow",
      reason: "Tier none — reversible/harmless, allowed",
    })
  }

  // Axis 4: mode policy.
  const baseVerdict = baseModeVerdict(action, ctx.mode)
  out.push({
    axis: "mode-policy",
    outcome: baseVerdict,
    reason: `Mode '${ctx.mode}' base policy → ${baseVerdict}`,
  })

  // Axis 5: global default (always last fallback).
  out.push({
    axis: "global-default",
    outcome: "ask",
    reason: "No other axis decided — fall through to the global default (ask)",
  })

  return out
}

/** Produce a single PermissionDecision representing the final verdict for
 *  the SPECIFIC mode in `ctx`. The matrix already exposes the cross-mode
 *  view; this helper exists for callers that just want the one answer. */
export const finalDecisionFor = (
  inspection: PermissionInspection,
  mode: PermissionMode,
): PermissionDecision => {
  if (inspection.hardDenyMatched) {
    const first = inspection.hardDenyRules[0]
    const name = first?.name ?? "(unknown rule)"
    return { kind: "deny", reason: `HARD_DENY rule '${name}' matches the supplied command` }
  }
  const verdict = inspection.modePolicy[mode]
  if (verdict === "allow") return { kind: "allow" }
  if (verdict === "deny")
    return { kind: "deny", reason: `Mode '${mode}' refuses ${inspection.tool}` }
  return { kind: "ask", reason: `Mode '${mode}' requires confirmation for ${inspection.tool}` }
}

/**
 * Inspect a tool's permission policy SHAPE.
 *
 * Returns a stateless, store-free record describing:
 *   - whether the tool is read-only (axis 1)
 *   - whether the supplied shellCommand (if any) matches any HARD_DENY rule
 *     and the matching rule descriptors (NEVER the raw patterns)
 *   - the HITL tier (axis 3)
 *   - the 4-mode decision matrix (axes 4-5)
 *   - the 5-axis pipeline trace for the specific `ctx.mode`
 *
 * Pure and stateless — safe to call from a slash-command renderer, a test,
 * or a UI dashboard refresh loop.
 */
export const inspectPermission = (
  tool: string,
  ctx: PermissionContext,
  meta: InspectToolMeta = {},
): PermissionInspection => {
  const isReadOnly = meta.isReadOnly === true
  const hardDenyRules = matchHardDenyRules(meta.shellCommand)

  // Cross-check that our description-only matcher and the runtime gate
  // agree — we mirror `hardDenyReason`'s short-circuit so a future regex
  // change can't desync. `hardDenyReason` looks at `shellCommand` on the
  // ToolAction, so we synthesize a minimal action.
  const probeAction: ToolAction = {
    tool,
    input: null,
    isReadOnly,
    shellCommand: meta.shellCommand ?? null,
  }
  const hardDenyReasonStr = hardDenyReason(probeAction)
  const hardDenyMatched = hardDenyReasonStr !== null || hardDenyRules.length > 0

  const tier = meta.hitlTier
  const mapped = meta.isReadOnly !== undefined || meta.hitlTier !== undefined
  const modePolicy = buildModeMatrix(probeAction, tier)
  const pipeline = buildPipeline(probeAction, ctx, tier, hardDenyRules)

  const out: PermissionInspection = {
    tool,
    mapped,
    isReadOnly,
    hardDenyMatched,
    hardDenyRules,
    modePolicy,
    pipeline,
    ...(tier !== undefined ? { hitlTier: tier } : {}),
  }
  return out
}

/** Public read-only view of the HARD_DENY rule catalog — `name` +
 *  `description` ONLY. Surfaced for `/permission` summary commands.
 *  Security: never includes the raw `pattern: RegExp`. */
export const listHardDenyRuleDescriptors = (): readonly MatchedHardDenyRule[] =>
  HARD_DENY_RULES.map((r) => ({ name: r.name, description: r.description }))
