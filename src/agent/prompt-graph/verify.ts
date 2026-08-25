/**
 * ADR-0538 — `verifyRuleGraph()`, the build-time graph verifier (the SOTA++
 * core). Runs over the full reachable `PromptContext` surface and returns
 * STRUCTURED violations (empty ⇒ the graph is sound). Each check names, where
 * relevant, the test that proves it FIRES on injection (red-on-injection) so
 * none is a silent tautology.
 *
 * Checks (ADR §Build-time verifier):
 *   1. CONFLICT-FREEDOM — no two `conflictsWith` variants co-render in the SAME
 *      channel for any reachable ctx. This carries the mutual-exclusivity load
 *      for the env-posture + verify-strategy variants (declared with
 *      `conflictsWith`, disjoint `when` matchers make co-render impossible, this
 *      check WITNESSES it). [red-on-injection: overlap two conflicting atoms]
 *   2. SUPERSEDE-SOUNDNESS — an applicable superseder must actually suppress its
 *      loser (selectAtoms tripwire). DORMANT: no variant uses `supersedes` today
 *      (exclusivity is via disjoint matchers + `conflictsWith`, stronger); kept
 *      for a future overlapping-matcher edge.
 *   2b. SUPERSEDE/CONFLICT/REQUIRES EDGE INTEGRITY — no dangling target (a typo'd
 *      edge silently does nothing). [red-on-injection: edge to a phantom variant]
 *   3. COVERAGE — every variant fires in ≥1 reachable ctx (dead/inert-rule).
 *   4. CACHED-SECTION BUDGET — ≤4 live `system.*` cache sections in the manifest
 *      (checked on the ARTIFACT, where the caller-data sections are visible — the
 *      atom graph alone can never witness this; see the note in the body).
 *   5. STATIC/DYNAMIC SEPARATION — a per-turn-natured atom may not ride a cached
 *      `system.*` channel. 6. AUTHORITY PLACEMENT — repo/skill/user/working-state
 *      authority may not ride `system.base`.
 *   7. NO-HIDDEN-ASSUMPTION LINT — an atom whose text asserts a context premise
 *      (install / do-not-install / graded / frozen env / read-only) MUST declare
 *      the matching matcher facet. BEST-EFFORT (keyword table — see note there;
 *      false-negatives possible, so it is a lint, not a proof). This is the
 *      static guard against the jul-10 contradiction class.
 *      [red-on-injection: a premise atom with no facet]
 *   8. MANIFEST COMPLETENESS — every variantId non-empty + unique.
 *   8b. DYNAMIC-CONTENT PLACEMENT — a `contentKey` atom must ride the reminder
 *      channel with empty `lines`. 9. SNAPSHOT PARITY — the compile manifest
 *      reconstructs the observability snapshot (checks run when a manifest is
 *      supplied).
 *
 * PURE: no IO/clock/env.
 */

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
 *
 * SCOPE (honest): this is a BEST-EFFORT lint, not a proof. It is keyword-matched,
 * so a premise phrased OUTSIDE the table escapes (a false-negative). It is a
 * tripwire for the KNOWN contradiction phrasings (the jul-10 audit's classes) and
 * a forcing-function for new premise atoms to scope themselves; it does not
 * certify the absence of ALL hidden premises. Keep the keyword set current as new
 * premise wording lands. The structural (non-lint) guarantee that contradictory
 * variants never co-render is check (1) conflict-freedom over `conflictsWith`.
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

// Join with SPACE and collapse whitespace (NOT "\n") so a premise phrase that
// wraps across two `lines[]` entries — e.g. "declare the\n  environment
// unavailable" — still matches the keyword table. Joining on "\n" made the lint's
// coverage depend on cosmetic line-wrapping (the same premise class was guarded on
// one atom and silently unguarded on another purely by where the wrap fell).
const textOf = (a: InstructionAtom): string => a.lines.join(" ").replace(/\s+/g, " ").toLowerCase()

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
/**
 * ADR-0538 (7) — NO-HIDDEN-ASSUMPTION lint, STATIC per-atom.
 *
 * ONE unit because it is the whole keyword-table pass: an atom whose text
 * asserts a context premise must declare the matching matcher facet, or the
 * premise renders where an axis abolished it. BEST-EFFORT (see
 * {@link ASSUMPTION_TABLE}) — a lint, not a proof. Pure.
 */
const checkHiddenAssumptions = (atoms: readonly InstructionAtom[]): GraphViolation[] => {
  const violations: GraphViolation[] = []
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
  return violations
}

/**
 * ADR-0538 (5)+(6) — STATIC/DYNAMIC SEPARATION and AUTHORITY PLACEMENT, both
 * STATIC per-atom (context-independent).
 *
 * ONE unit because both answer the same question — "may this atom ride the
 * channel it declares?" — over the same single pass: a per-turn-natured atom
 * (matcher references a presence facet) may NOT ride a cached `system.*`
 * channel, and a repo/skill/user/working-state authority atom may NOT ride
 * `system.base`. Pure.
 */
const checkChannelPlacement = (atoms: readonly InstructionAtom[]): GraphViolation[] => {
  const violations: GraphViolation[] = []
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
  return violations
}

/**
 * ADR-0538 (8) — MANIFEST COMPLETENESS, STATIC per-atom. Every atom must carry
 * a non-empty, UNIQUE variantId so every rendered text span is traceable; a
 * blank/duplicate id would make the fired-atom manifest ambiguous.
 *
 * ONE unit because both violations are facts about the SAME id-uniqueness
 * bookkeeping, and the `seen` set only makes sense while that pass owns it.
 * Pure. Order within an atom is blank-then-duplicate (both can fire).
 */
const checkVariantIdIntegrity = (atoms: readonly InstructionAtom[]): GraphViolation[] => {
  const violations: GraphViolation[] = []
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
  return violations
}

/**
 * ADR-0538 (3) — COVERAGE: every declared variant must fire in ≥1 reachable
 * ctx. Reads the `everFired` set {@link checkPerContext} accumulated, so it is
 * a projection of that sweep rather than a pass of its own. Pure.
 */
const checkCoverage = (
  atoms: readonly InstructionAtom[],
  everFired: ReadonlySet<string>,
): GraphViolation[] => {
  const violations: GraphViolation[] = []
  for (const a of atoms) {
    if (!everFired.has(a.variantId)) {
      violations.push({
        kind: "coverage",
        message: `variant ${a.variantId} never fires in any reachable ctx (dead/inert rule)`,
        variantIds: [a.variantId],
      })
    }
  }
  return violations
}

export const verifyRuleGraph = (
  atoms: readonly InstructionAtom[],
  reachableContexts: readonly PromptContext[],
  manifest?: ManifestParityView,
): readonly GraphViolation[] => {
  const violations: GraphViolation[] = []
  const byVariant = new Map<string, InstructionAtom>()
  for (const a of atoms) byVariant.set(a.variantId, a)

  // The verifier is a PIPELINE of independent checks appended in a fixed order —
  // callers (the hellgate) assert on the concatenated list, so the order below
  // is part of the contract. Each check is its own unit; this function owns the
  // ORDER and the two pieces of shared bookkeeping (`byVariant`, `everFired`).

  // ── (7) No-hidden-assumption lint — static, per-atom (context-independent). ──
  violations.push(...checkHiddenAssumptions(atoms))

  // (1) Conflict-freedom + (2) supersede-soundness over every reachable ctx,
  // plus the coverage bookkeeping (3) consumes (which variants ever fire) --
  // extracted to checkPerContext (this per-ctx sweep was the bulk of the fn).
  const { violations: perContextViolations, everFired } = checkPerContext(
    atoms,
    reachableContexts,
    byVariant,
  )
  violations.push(...perContextViolations)

  // ── (2b) Supersede/conflict/requires EDGE INTEGRITY — extracted helper. ──
  violations.push(...checkEdgeIntegrity(atoms, byVariant))

  // ── (3) Coverage — every declared variant fires in ≥1 reachable ctx. ──
  violations.push(...checkCoverage(atoms, everFired))

  // ── (5) Static/dynamic separation + (6) authority placement — STATIC per-atom. ──
  violations.push(...checkChannelPlacement(atoms))

  // ── (8) Manifest completeness — non-empty + unique variantIds. ──
  violations.push(...checkVariantIdIntegrity(atoms))

  // ── (8b/Phase-3) Dynamic-content placement — extracted helper. ──
  violations.push(...checkDynamicContentPlacement(atoms))

  // ── (4) Cached-section budget — see `checkSnapshotParity`. ──
  //
  // The budget (≤4 Anthropic cache breakpoints, ADR-0326) is a property of the
  // RENDERED sections, NOT of the atom graph: every migrated atom rides
  // `system.base` (the tool-use rails + body) — the other three cached sections
  // (`project_md` / `session_ctx` / `user_append`) hold CALLER DATA that is
  // deliberately NOT atomized (ADR-0538 §Cache key). So a per-ctx count over
  // ATOM channels can only ever see `{system.base}` (size ≤ 1) — it is
  // structurally incapable of exceeding 4 and would be a tautology here. The
  // real budget is checked where the real sections live: (a) the 4-member
  // `system.*` channel enum caps it by construction, (b) `validateSectionsCache
  // Budget` guards the assembled sections in `compile`, and (c) the manifest-
  // level check below (`checkSnapshotParity`) counts the DISTINCT non-empty
  // `system.*` channels the compiled artifact reports — the only place the
  // caller-data sections are visible to the verifier — so a future 5th cached
  // section surfaces as a `cached-section-budget` violation.

  // ── (9) Snapshot parity + (4) cached-section budget — ONLY when a manifest is
  //        supplied (both extracted; the budget is a manifest-level property). ──
  if (manifest !== undefined) {
    violations.push(...checkSnapshotParity(atoms, manifest))
    violations.push(...checkCachedSectionBudget(manifest))
  }

  return violations
}

/**
 * ADR-0538 — (1) conflict-freedom for ONE context: a conflict pair must not
 * co-render in the SAME channel. The edge may be declared on only one side, so
 * we report from whichever firing atom carries it, de-duped by UNORDERED pair
 * key. Pure — extracted from {@link checkPerContext}.
 */
const checkConflictFreedom = (
  fired: readonly InstructionAtom[],
  firedSet: ReadonlySet<string>,
  byVariant: ReadonlyMap<string, InstructionAtom>,
  ctx: PromptContext,
): GraphViolation[] => {
  const violations: GraphViolation[] = []
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
      const key = [a.variantId, foe].sort().join("\x00")
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
  return violations
}

/**
 * ADR-0538 — (2) supersede-soundness for ONE context: a superseded variant must
 * not co-render with an APPLICABLE superseder. A TRIPWIRE for the `supersedes`
 * primitive + selectAtoms suppression (fires only when a superseder and its
 * declared loser actually co-apply). Pure — extracted from {@link checkPerContext}.
 */
const checkSupersedeSoundness = (
  atoms: readonly InstructionAtom[],
  ctx: PromptContext,
  firedSet: ReadonlySet<string>,
): GraphViolation[] => {
  const violations: GraphViolation[] = []
  // ── (2) Supersede soundness — a superseded variant must NOT co-render with
  //        an APPLICABLE superseder (if both a superseder and its declared loser
  //        match this ctx yet the loser survived selection, selectAtoms failed to
  //        suppress). This is a TRIPWIRE for the `supersedes` primitive +
  //        selectAtoms suppression; it fires only when a superseder and loser
  //        actually CO-APPLY. The current variant set uses none (mutually-
  //        exclusive variants are selected by disjoint `when` matchers + declared
  //        with `conflictsWith`, which the check (1) proves — stronger than
  //        supersede, since co-render is then structurally impossible rather than
  //        suppression-dependent). Kept live so a FUTURE overlapping-matcher
  //        supersede edge is verified; integrity of the edges themselves (no
  //        dangling target) is checked statically below. ──
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
  return violations
}

/**
 * ADR-0538 — per-context sweep: (1) conflict-freedom + (2) supersede-soundness
 * over every reachable context, plus the coverage bookkeeping check (3) consumes
 * (which variants ever fire). Pure — returns the violations found and the set of
 * variantIds that fired in ≥1 ctx.
 */
const checkPerContext = (
  atoms: readonly InstructionAtom[],
  reachableContexts: readonly PromptContext[],
  byVariant: ReadonlyMap<string, InstructionAtom>,
): { violations: GraphViolation[]; everFired: Set<string> } => {
  const violations: GraphViolation[] = []
  const everFired = new Set<string>()

  for (const ctx of reachableContexts) {
    const fired = selectAtoms(atoms, ctx)
    const firedSet = new Set(fired.map((a) => a.variantId))
    for (const v of firedSet) everFired.add(v)
    violations.push(...checkConflictFreedom(fired, firedSet, byVariant, ctx))
    violations.push(...checkSupersedeSoundness(atoms, ctx, firedSet))
  }

  return { violations, everFired }
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
 * The two channels that carry REAL atoms. The other six are CALLER-DATA channels
 * (`project_md` / `session_ctx` / `user_append` hold user text; `hook_context` /
 * `context_update` / `mention_injection` hold user messages) — that data is
 * deliberately NOT atomized (ADR-0538 §Cache key), so the manifest marks their
 * PRESENCE with a synthetic placeholder id (`SECTION-*` / `MSG-*`), not an atom.
 * Atom-traceability (parity check a) is enforced only where atoms actually live.
 */
const ATOM_BEARING_CHANNELS: ReadonlySet<string> = new Set([
  "system.base",
  "message.system_reminder",
])

/** The `system.*` cache-section channels — the manifest may report at most FOUR
 *  of these non-empty (the ADR-0326 / Anthropic 4-breakpoint budget). */
const isSystemChannelName = (ch: string): boolean => ch.startsWith("system.")

/**
 * ADR-0538 Phase 3 — (9) snapshot-parity over the COMPILED MANIFEST (extracted).
 * The manifest must reconstruct the observability snapshot: (a) every variantId
 * on an ATOM-bearing channel traces to a declared atom (the caller-data channels
 * carry `SECTION-*`/`MSG-*` presence markers by design and are exempt);
 * (b) `firedVariantIds` equals the union of all `byChannel` lists; (c) the
 * policy's `firedAtomIds` are all in the reminder channel (the pre-Phase-3 notice
 * snapshot the loop emits — parity, not drift). The (4) cached-section budget is
 * a sibling manifest check ({@link checkCachedSectionBudget}).
 * (Historical note: the ARTIFACT is where the caller-data sections are visible —
 * the atom graph alone can never witness this, see the note in verifyRuleGraph).
 */
const parity = (message: string, id: string): GraphViolation => ({
  kind: "snapshot-parity",
  message,
  variantIds: [id],
})

/**
 * Both directions of the `firedVariantIds` ↔ channel-union agreement.
 *
 * A unit because a set EQUALITY is only meaningful as both inclusions at once: check
 * one direction alone and a manifest that lists a variant in a channel but omits it
 * from `firedVariantIds` reads as merely "extra", which is exactly the drift this
 * parity check exists to catch.
 */
const checkFiredVariantParity = (
  firedVariantIds: readonly string[],
  unionOfChannels: ReadonlySet<string>,
): readonly GraphViolation[] => {
  const out: GraphViolation[] = []
  const flat = new Set(firedVariantIds)
  for (const id of unionOfChannels) {
    if (!flat.has(id))
      out.push(parity(`manifest lists ${id} in a channel but not firedVariantIds`, id))
  }
  for (const id of flat) {
    if (!unionOfChannels.has(id))
      out.push(parity(`manifest firedVariantIds carries ${id} which appears in no channel`, id))
  }
  return out
}

const checkSnapshotParity = (
  atoms: readonly InstructionAtom[],
  manifest: ManifestParityView,
): readonly GraphViolation[] => {
  const out: GraphViolation[] = []
  const declared = new Set(atoms.map((a) => a.variantId))
  const unionOfChannels = new Set<string>()
  // (a) every ATOM-bearing-channel span traces to a declared atom.
  for (const [ch, ids] of Object.entries(manifest.byChannel)) {
    for (const id of ids) {
      unionOfChannels.add(id)
      if (ATOM_BEARING_CHANNELS.has(ch) && !declared.has(id)) {
        out.push(parity(`manifest byChannel[${ch}] lists ${id} which is not a declared atom`, id))
      }
    }
  }
  // (b) firedVariantIds == the channel union (both directions).
  out.push(...checkFiredVariantParity(manifest.firedVariantIds, unionOfChannels))
  // (c) policy.firedAtomIds ⊆ the reminder channel (the notice snapshot parity).
  const reminder = new Set(manifest.byChannel["message.system_reminder"] ?? [])
  for (const id of manifest.policy.firedAtomIds ?? []) {
    if (!reminder.has(id))
      out.push(parity(`policy.firedAtomIds reports ${id} not in the reminder channel (drift)`, id))
  }
  return out
}

/**
 * ADR-0538 — (4) cached-section budget over the COMPILED MANIFEST. At most FOUR
 * distinct `system.*` channels may be non-empty (the ADR-0326 / Anthropic
 * 4-breakpoint cap). Checked on the artifact — where the caller-data cache
 * sections become visible — because every atom rides `system.base`, so a per-ctx
 * count over the atom graph could only ever see `{system.base}` and would be a
 * tautology (see the note in {@link verifyRuleGraph}).
 */
const checkCachedSectionBudget = (manifest: ManifestParityView): readonly GraphViolation[] => {
  const live = Object.entries(manifest.byChannel)
    .filter(([ch, ids]) => isSystemChannelName(ch) && ids.length > 0)
    .map(([ch]) => ch)
  if (live.length <= 4) return []
  return [
    {
      kind: "cached-section-budget",
      message: `${live.length} distinct system.* cache sections are live (>4 exceeds the ADR-0326 breakpoint budget): ${live.join(", ")}`,
      variantIds: live,
    },
  ]
}

/**
 * ADR-0538 — (2b) supersede/conflict/requires EDGE INTEGRITY (STATIC per-atom).
 * Every `supersedes` / `conflictsWith` / `requires` target must reference a
 * DECLARED variant; a dangling target (typo/rename) silently does nothing and is
 * a bug. This is the red-on-injection half of the supersede-family check (the
 * co-render soundness half is dormant — no variant uses `supersedes` today).
 */
const checkEdgeIntegrity = (
  atoms: readonly InstructionAtom[],
  byVariant: ReadonlyMap<string, InstructionAtom>,
): readonly GraphViolation[] => {
  const out: GraphViolation[] = []
  for (const a of atoms) {
    for (const [rel, targets] of [
      ["supersedes", a.supersedes],
      ["conflictsWith", a.conflictsWith],
      ["requires", a.requires],
    ] as const) {
      for (const target of targets ?? []) {
        if (!byVariant.has(target)) {
          out.push({
            kind: "supersede-unsound",
            message: `atom ${a.variantId} declares ${rel} ${target} which is not a declared variant (dangling edge — does nothing)`,
            variantIds: [a.variantId, target],
          })
        }
      }
    }
  }
  return out
}
