/**
 * ADR-0538 Phase 1 — `verifyRuleGraph()`, the build-time graph verifier (the
 * SOTA++ core), restricted to the checks that apply to the migrated tool-use
 * slice. Runs over the full reachable `PromptContext` surface and returns
 * STRUCTURED violations (empty ⇒ the graph is sound).
 *
 * Checks implemented here (ADR §Build-time verifier 1,2,3,7):
 *   1. CONFLICT-FREEDOM   — no two `conflictsWith` variants co-render in the
 *                           SAME channel for any reachable ctx.
 *   2. SUPERSEDE-SOUNDNESS — a superseded variant and its superseder never
 *                            co-render (the supersede must actually suppress).
 *   3. COVERAGE           — every variant fires in ≥1 reachable ctx (dead-rule
 *                           / inert-variant detection).
 *   7. NO-HIDDEN-ASSUMPTION LINT — an atom whose text asserts a context premise
 *                            (install / do-not-install / graded / frozen env /
 *                            read-only) MUST declare the matching matcher facet.
 *
 * The remaining ADR checks (cached-section budget, static/dynamic separation,
 * authority placement, manifest/snapshot parity) apply to channels/atoms not
 * yet migrated and land with the Phase 2 body migration.
 *
 * PURE: no IO/clock/env.
 */

import { matches } from "./matches"
import { selectAtoms } from "./render"
import type {
  AtomMatcher,
  AuthorityLayer,
  GraphViolation,
  InstructionAtom,
  PromptChannel,
  PromptContext,
} from "./types"

/** The four `system.*` cached channels (ADR-0326 4-section budget). */
const SYSTEM_CHANNELS: readonly PromptChannel[] = [
  "system.base",
  "system.project_md",
  "system.session_ctx",
  "system.user_append",
]
const isSystemChannel = (c: PromptChannel): boolean => SYSTEM_CHANNELS.includes(c)

/** Presence facets — a matcher referencing ANY of these is PER-TURN-natured (it
 *  reads state that varies within a session), so its atom may NOT ride a cached
 *  `system.*` channel (ADR §5 static/dynamic separation). `mode`/`brief`/the
 *  axis facets are static session posture, so they are NOT here. */
const PER_TURN_FACETS: readonly (keyof AtomMatcher)[] = [
  "hasRepoRules",
  "hasGlobRules",
  "hasSessionCtx",
  "hasMemorySummary",
  "hasWorkingState",
  "hasActiveSkills",
  "hasContextEvents",
  "hasMentionInjection",
  "hasHookInjects",
  "hasImages",
  "untrustedEnvelope",
  "hasLanguageHint",
  "hasEnvBlock",
  "hasRepoRulesDynamic",
  "hasTaskBudget",
  "hasDirectives",
]

/** Authority layers that may NOT occupy `system.base` (ADR §6 authority
 *  placement) — repo/skill/user/working-state content is lower-authority and
 *  per-context, so it rides the dynamic channels, never the frozen system base. */
const NON_BASE_AUTHORITIES: readonly AuthorityLayer[] = [
  "L6_repo",
  "L7_skill",
  "L8_user",
  "L9_working_state",
]

/**
 * No-hidden-assumption keyword table. If an atom's rendered text contains a
 * keyword (case-insensitive) asserting a context premise, the atom MUST declare
 * the paired matcher facet — otherwise the premise can render in a ctx that
 * abolished it (exactly the jul-10 contradiction class). Each entry names the
 * facet KEY that must be present on `when`.
 *
 * We check facet PRESENCE (the atom scoped itself on that axis), not a specific
 * value, because the correct value differs per premise (frozen for a
 * do-not-install rule, non-frozen for an install rule) — presence is the
 * invariant that prevents an unconditioned premise leaking everywhere.
 */
type AssumptionFacet = "envPosture" | "verifyStrategy" | "mode"

interface AssumptionRule {
  readonly keywords: readonly string[]
  /** The atom must declare at LEAST ONE of these facets — the premise is
   *  legitimately scoped by any of them (e.g. a "read-only" premise is scoped
   *  by the verify axis under grader-only OR by the mode axis under
   *  plan/review/audit/architect). */
  readonly requiredFacets: readonly AssumptionFacet[]
  readonly label: string
}

const ASSUMPTION_TABLE: readonly AssumptionRule[] = [
  {
    label: "install-prohibition (env premise)",
    keywords: ["do not install", "declare the environment unavailable"],
    requiredFacets: ["envPosture"],
  },
  {
    label: "install-permitted (env premise)",
    // Distinctive install-permitting phrases. "not a graded sandbox" is an ENV
    // premise (it negates grading to justify installing), so it is keyed to
    // envPosture here — NOT to the verify axis.
    keywords: ["you own this environment", "install dependencies", "not a graded sandbox"],
    requiredFacets: ["envPosture"],
  },
  {
    label: "hidden-grader / graded-harness premise",
    // The hidden-grader premise is verify-strategy-scoped. Keywords are the
    // SPECIFIC hidden-grader phrasings — a bare "graded" is deliberately NOT
    // here (it collides with the env "not a graded sandbox" negation above).
    keywords: ["hidden-grader", "hidden grader", "an automated grader runs hidden tests"],
    requiredFacets: ["verifyStrategy"],
  },
  {
    label: "local-verification-disabled premise (verify axis)",
    // The grader-only "no local run" premise — verify-strategy-scoped ONLY.
    keywords: ["local verification is intentionally disabled"],
    requiredFacets: ["verifyStrategy"],
  },
  {
    label: "read-only deliverable / read-only tools premise (mode OR verify axis)",
    // A "read-only" DELIVERABLE / TOOLS premise is scoped by EITHER the mode
    // axis (plan/review/audit/architect — the notice + completion-bar read-only
    // variant) OR the verify axis (grader-only's read-only source-diff posture).
    // Keywords are the SPECIFIC premise phrasings — a bare "read-only" is
    // deliberately NOT here (it benignly appears in e.g. git "Read-only
    // inspection", which asserts no context premise).
    keywords: ["read-only mode", "read-only tools", "in a read-only", "read-only source"],
    requiredFacets: ["mode", "verifyStrategy"],
  },
]

const textOf = (a: InstructionAtom): string => a.lines.join("\n").toLowerCase()

const anyFacetDeclared = (a: InstructionAtom, facets: readonly AssumptionFacet[]): boolean =>
  facets.some((f) => a.when?.[f] !== undefined)

/**
 * A minimal manifest view for the snapshot-parity check (ADR §Build-time
 * verifier 9). The compiler's `CompiledPromptArtifact.manifest` structurally
 * satisfies this; we type it narrowly here so the verifier stays decoupled from
 * the full artifact type (and pure).
 */
export interface ManifestParityView {
  readonly firedVariantIds: readonly string[]
  readonly byChannel: Readonly<Record<PromptChannel, readonly string[]>>
  readonly policy: {
    readonly firedAtomIds?: readonly string[]
    readonly byChannel?: Readonly<Partial<Record<string, readonly string[]>>>
  }
}

/**
 * Verify the migrated atom graph over `reachableContexts`. Returns every
 * violation found (empty array ⇒ sound). Does NOT throw — callers (the hellgate)
 * assert on the returned array so the failure surface is the structured list.
 *
 * When `manifest` is supplied, the SNAPSHOT-PARITY check (ADR §9) additionally
 * verifies the manifest can reconstruct the observability snapshot: every
 * variantId in `byChannel` traces to a declared atom (manifest completeness over
 * the RENDERED spans, not just the atom set), and the policy's
 * `firedAtomIds` (the DYNAMIC notice channel it reports) is exactly the reminder
 * channel's notice atoms.
 */
export const verifyRuleGraph = (
  atoms: readonly InstructionAtom[],
  reachableContexts: readonly PromptContext[],
  manifest?: ManifestParityView,
): readonly GraphViolation[] => {
  const violations: GraphViolation[] = []
  const byVariant = new Map<string, InstructionAtom>()
  for (const a of atoms) byVariant.set(a.variantId, a)

  // ── (7) No-hidden-assumption lint — static, per-atom (context-independent). ──
  for (const a of atoms) {
    const text = textOf(a)
    for (const rule of ASSUMPTION_TABLE) {
      if (!rule.keywords.some((k) => text.includes(k))) continue
      if (!anyFacetDeclared(a, rule.requiredFacets)) {
        violations.push({
          kind: "hidden-assumption",
          message: `atom ${a.variantId} asserts a ${rule.label} but does not declare any of \`when.${rule.requiredFacets.join("` / `when.")}\` (unconditioned premise can render where an axis abolished it)`,
          variantIds: [a.variantId],
        })
      }
    }
  }

  // ── Coverage bookkeeping: which variants ever fire. ──
  const everFired = new Set<string>()

  for (const ctx of reachableContexts) {
    const fired = selectAtoms(atoms, ctx)
    const firedVariants = fired.map((a) => a.variantId)
    const firedSet = new Set(firedVariants)
    for (const v of firedVariants) everFired.add(v)

    // ── (1) Conflict-freedom — co-rendering conflict pair in the SAME channel. ──
    // The edge may be declared on only ONE side, so we report from whichever
    // firing atom carries it and de-dup by the UNORDERED pair key (a conflict is
    // symmetric — report each co-rendering pair once per ctx).
    const seenPairs = new Set<string>()
    for (const a of fired) {
      for (const foe of a.conflictsWith ?? []) {
        if (!firedSet.has(foe)) continue
        const foeAtom = byVariant.get(foe)
        // conflict is scoped to the SAME channel per ADR §1.
        if (foeAtom !== undefined && foeAtom.channel !== a.channel) continue
        const key = [a.variantId, foe].sort().join(" ")
        if (seenPairs.has(key)) continue
        seenPairs.add(key)
        violations.push({
          kind: "conflict",
          message: `conflicting variants co-render in ${a.channel}: ${a.variantId} ⟷ ${foe}`,
          variantIds: [a.variantId, foe].sort() as [string, string],
          ctx,
        })
      }
    }

    // ── (2) Supersede soundness — a superseded variant must NOT co-render with
    //        an applicable superseder. We recompute the pre-suppression
    //        applicable set: if BOTH the superseder and its declared loser would
    //        apply yet the loser survived selection, the supersede is unsound. ──
    const applicable = atoms.filter(
      (a) => selectAtoms([a], ctx).length > 0, // single-atom applicability = matches(when,ctx)
    )
    const applicableVariants = new Set(applicable.map((a) => a.variantId))
    for (const a of applicable) {
      for (const loser of a.supersedes ?? []) {
        if (applicableVariants.has(loser) && firedSet.has(loser)) {
          violations.push({
            kind: "supersede-unsound",
            message: `superseded variant ${loser} co-renders with its superseder ${a.variantId}`,
            variantIds: [a.variantId, loser],
            ctx,
          })
        }
      }
    }
  }

  // ── (3) Coverage — every declared variant fires in ≥1 reachable ctx. ──
  for (const a of atoms) {
    if (!everFired.has(a.variantId)) {
      violations.push({
        kind: "coverage",
        message: `variant ${a.variantId} never fires in any reachable ctx (dead/inert rule)`,
        variantIds: [a.variantId],
      })
    }
  }

  // ── (5) Static/dynamic separation + (6) authority placement — STATIC per-atom
  //        (context-independent). A per-turn-natured atom (matcher references a
  //        presence facet) may NOT ride a cached `system.*` channel; a
  //        repo/skill/user/working-state authority atom may NOT ride
  //        `system.base`. ──
  for (const a of atoms) {
    if (isSystemChannel(a.channel) && a.when !== undefined) {
      const leaked = PER_TURN_FACETS.filter((f) => a.when?.[f] !== undefined)
      if (leaked.length > 0) {
        violations.push({
          kind: "static-dynamic-separation",
          message: `atom ${a.variantId} rides cached channel ${a.channel} but conditions on per-turn facet(s) ${leaked.join(", ")} (a per-turn atom must not land in a system.* section)`,
          variantIds: [a.variantId],
        })
      }
    }
    if (a.channel === "system.base" && NON_BASE_AUTHORITIES.includes(a.authority)) {
      violations.push({
        kind: "authority-placement",
        message: `atom ${a.variantId} has authority ${a.authority} but occupies system.base (repo/skill/user/working-state authority may not ride the frozen system base)`,
        variantIds: [a.variantId],
      })
    }
  }

  // ── (8) Manifest completeness — STATIC per-atom. Every atom must carry a
  //        non-empty variantId so every rendered text span is traceable; a
  //        blank/duplicate id would make the fired-atom manifest ambiguous. ──
  const seenVariantIds = new Set<string>()
  for (const a of atoms) {
    if (a.variantId.length === 0) {
      violations.push({
        kind: "manifest-completeness",
        message: `atom ${a.atomId} has an empty variantId (rendered spans would be untraceable)`,
        variantIds: [a.variantId],
      })
    }
    if (seenVariantIds.has(a.variantId)) {
      violations.push({
        kind: "manifest-completeness",
        message: `duplicate variantId ${a.variantId} (a rendered span could not be uniquely attributed)`,
        variantIds: [a.variantId],
      })
    }
    seenVariantIds.add(a.variantId)
  }

  // ── (8b/Phase-3) Dynamic-content placement — extracted helper. ──
  violations.push(...checkDynamicContentPlacement(atoms))

  // ── (4) Cached-section budget — per-ctx, the number of DISTINCT system.*
  //        channels the fired atoms occupy must be ≤ 4 (the ADR-0326 / Anthropic
  //        cap). Verified over every reachable ctx. ──
  for (const ctx of reachableContexts) {
    const fired = atoms.filter((a) => matches(a.when, ctx))
    const cachedChannels = new Set(
      fired.filter((a) => isSystemChannel(a.channel)).map((a) => a.channel),
    )
    if (cachedChannels.size > 4) {
      violations.push({
        kind: "cached-section-budget",
        message: `${cachedChannels.size} distinct system.* channels fire in one ctx (>4 exceeds the ADR-0326 cache-section budget): ${[...cachedChannels].join(", ")}`,
        variantIds: fired.filter((a) => isSystemChannel(a.channel)).map((a) => a.variantId),
        ctx,
      })
    }
  }

  // ── (9) Snapshot parity — ONLY when a manifest is supplied (extracted). ──
  if (manifest !== undefined) {
    violations.push(...checkSnapshotParity(atoms, manifest))
  }

  return violations
}

/**
 * ADR-0538 Phase 3 — (8b) dynamic-content placement check (extracted from
 * {@link verifyRuleGraph} for complexity). A DYNAMIC-content atom (one carrying a
 * `contentKey`) MUST ride `message.system_reminder` AND carry EMPTY `lines` (its
 * wire text is per-turn DATA, not a static literal); a `system.*`-channel atom
 * may NOT carry a contentKey (a cached section can never hold per-turn data).
 */
const checkDynamicContentPlacement = (
  atoms: readonly InstructionAtom[],
): readonly GraphViolation[] => {
  const out: GraphViolation[] = []
  for (const a of atoms) {
    if (a.contentKey !== undefined && a.channel !== "message.system_reminder") {
      out.push({
        kind: "dynamic-content-placement",
        message: `atom ${a.variantId} carries a contentKey but rides ${a.channel} (dynamic content may only ride message.system_reminder)`,
        variantIds: [a.variantId],
      })
    }
    if (a.contentKey !== undefined && a.lines.length > 0) {
      out.push({
        kind: "dynamic-content-placement",
        message: `atom ${a.variantId} carries a contentKey AND non-empty lines (a dynamic atom's text is per-turn DATA, lines must be empty)`,
        variantIds: [a.variantId],
      })
    }
    if (isSystemChannel(a.channel) && a.contentKey !== undefined) {
      out.push({
        kind: "dynamic-content-placement",
        message: `atom ${a.variantId} places per-turn contentKey ${a.contentKey} on cached channel ${a.channel} (a dynamic atom must not land in a system.* section)`,
        variantIds: [a.variantId],
      })
    }
  }
  return out
}

/**
 * ADR-0538 Phase 3 — (9) snapshot-parity check (extracted). The manifest must
 * reconstruct the observability snapshot: (a) every variantId in ANY channel
 * traces to a declared atom; (b) `firedVariantIds` equals the union of all
 * `byChannel` lists; (c) the policy's `firedAtomIds` are all in the reminder
 * channel (the pre-Phase-3 notice snapshot the loop emits — parity, not drift).
 */
const parity = (message: string, id: string): GraphViolation => ({
  kind: "snapshot-parity",
  message,
  variantIds: [id],
})

const checkSnapshotParity = (
  atoms: readonly InstructionAtom[],
  manifest: ManifestParityView,
): readonly GraphViolation[] => {
  const out: GraphViolation[] = []
  const declared = new Set(atoms.map((a) => a.variantId))
  const unionOfChannels = new Set<string>()
  // (a) every byChannel span traces to a declared atom.
  for (const [ch, ids] of Object.entries(manifest.byChannel)) {
    for (const id of ids) {
      unionOfChannels.add(id)
      if (!declared.has(id)) {
        out.push(parity(`manifest byChannel[${ch}] lists ${id} which is not a declared atom`, id))
      }
    }
  }
  // (b) firedVariantIds == the channel union (both directions).
  const flat = new Set(manifest.firedVariantIds)
  for (const id of unionOfChannels) {
    if (!flat.has(id)) out.push(parity(`manifest lists ${id} in a channel but not firedVariantIds`, id))
  }
  for (const id of flat) {
    if (!unionOfChannels.has(id))
      out.push(parity(`manifest firedVariantIds carries ${id} which appears in no channel`, id))
  }
  // (c) policy.firedAtomIds ⊆ the reminder channel (the notice snapshot parity).
  const reminder = new Set(manifest.byChannel["message.system_reminder"] ?? [])
  for (const id of manifest.policy.firedAtomIds ?? []) {
    if (!reminder.has(id))
      out.push(parity(`policy.firedAtomIds reports ${id} not in the reminder channel (drift)`, id))
  }
  return out
}
