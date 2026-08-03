/**
 * RFC03-2 — evidence-to-proposal compiler types.
 *
 * "Self-improve" is NOT the agent live-mutating its own skill directory. It is
 * a compiler pipeline: evidence → deterministic draft → immutable proposal →
 * human decision (existing ApprovalStateMachine) → CAS promotion. This module
 * owns the immutable proposal shape only. Decision lifecycle stays in
 * `@/agent/approval-state-machine`; artifact bytes stay behind the ONE new port
 * (`SkillProposalArtifactPort`).
 *
 * A {@link SkillProposal} is content-addressed and immutable: the same input
 * always compiles to the same `draftHash`. The `targetPreimageHash` binds the
 * proposal to the exact state of the target path AT COMPILE TIME so a promotion
 * can refuse when the target drifted (fail-closed).
 *
 * Slice fence: this file is pure data + no imports from `@/agent` / `@/apps`.
 */

/** Kind of proposal. `new` creates a skill; `improvement` targets an existing
 *  discovered skill (the compiler validates the target resolves). */
export type SkillProposalKind = "new" | "improvement"

/**
 * A single evidence anchor. `path` is a source the model cited (a memory file,
 * a repo file). `sha256` is the content hash of that source AT COMPILE TIME so
 * the proposal records exactly what evidence it distilled from. The compiler
 * REJECTS a proposal whose evidence is empty or whose path does not resolve
 * under an allowed root (anti-vacuous: no "invent a skill from nothing").
 */
export interface SkillEvidenceAnchor {
  /** Canonical (jailed) absolute path of the cited source. */
  readonly path: string
  /** sha256 of the source content at compile time. */
  readonly sha256: string
}

/** The typed skill fields the compiler renders (mirrors `skill_create` input,
 *  but the compiler never writes — it only compiles bytes). */
export interface SkillProposalDraftInput {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly kind: SkillProposalKind
  /** For `improvement`: the existing skill name being improved. */
  readonly target?: string
  readonly userInvocable?: boolean
  readonly allowedTools?: readonly string[]
  readonly category?: "skill" | "extension"
  readonly stability?: "experimental" | "stable" | "deprecated"
}

/** Deterministic validation receipt captured at compile time. */
export interface SkillProposalValidationReceipt {
  /** true ⇒ the rendered frontmatter passed the SAME discovery schema. */
  readonly frontmatterValid: boolean
  /** Byte length of the rendered SKILL.md. */
  readonly byteLength: boolean | number
  /** true ⇒ under MAX_SKILL_SIZE_BYTES. */
  readonly withinSizeCap: boolean
}

/**
 * An immutable, content-addressed skill proposal. Produced by
 * {@link compileSkillProposal}. Carries everything a human review + CAS
 * promotion needs; the actual bytes live behind the artifact port keyed by
 * `draftHash`.
 */
export interface SkillProposal {
  /** Deterministic id (== `draftHash`, so identical inputs collapse). */
  readonly proposalId: string
  readonly kind: SkillProposalKind
  readonly name: string
  /** Relative target path under the skills dir (`<name>/SKILL.md`). */
  readonly targetPath: string
  /** sha256 of the normalized rendered SKILL.md bytes (the staged artifact). */
  readonly draftHash: string
  /**
   * sha256 of the target path's CURRENT bytes at compile time, or the sentinel
   * {@link ABSENT_PREIMAGE} when the target does not exist. A promotion
   * re-reads the target and refuses when this no longer matches (fail-closed
   * TOCTOU guard).
   */
  readonly targetPreimageHash: string
  /** The cited evidence anchors (non-empty, each path-resolved). */
  readonly sources: readonly SkillEvidenceAnchor[]
  /** Generator identity (model/config/compiler version) for provenance. */
  readonly generatorVersion: string
  readonly validationReceipt: SkillProposalValidationReceipt
  /** The normalized SKILL.md bytes (also staged via the artifact port). */
  readonly draftBytes: string
}

/** Sentinel `targetPreimageHash` for a target that does not yet exist. A
 *  promotion treats "absent → present" as the create case and "present with a
 *  different hash" as drift. */
export const ABSENT_PREIMAGE = "absent"

/** Reasons the compiler refuses to produce a proposal (fail-closed). */
export type SkillProposalError =
  | "no_evidence"
  | "evidence_unresolved"
  | "invalid_name"
  | "invalid_frontmatter"
  | "too_large"
  | "unknown_target"
  | "system_shadow"

/** Compiler result: a proposal or a typed refusal (never throws). */
export type CompileResult =
  | { readonly ok: true; readonly proposal: SkillProposal }
  | { readonly ok: false; readonly error: SkillProposalError; readonly detail: string }
