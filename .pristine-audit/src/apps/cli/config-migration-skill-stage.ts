/**
 * CLI host composer — RFC03-4 imported-skill STAGING port for the startup
 * external-config IMPORT flow.
 *
 * The `@/migration/external-config` slice is fenced from `@/skill` / `@/agent`
 * (it may only reach `@/skill/frontmatter`), so it cannot construct the real
 * `SkillProposalArtifactPort` / approval machine itself — it declares a
 * structural {@link SkillStagePort} and lets the host inject one. THIS file is
 * that host adapter: it composes the REAL `createSkillProposalArtifactPort`
 * (RFC03-2/3) with the REAL `createApprovalStateMachine`, mirroring the in-agent
 * `tier1/skill.ts#buildProposalStagePort` composition and the
 * `external-config-migration-skills-memory-frontdoor` proof. The artifact port's
 * CAS `promote` (the only step that touches disk) writes via `@/storage`
 * sha256 + realpath-jail + atomic write; the pre-promote `staging` (`put`) uses
 * the artifact port's DEFAULT store — an in-process map, NOT disk.
 *
 * Behavior: an imported `.claude/skills/*​/SKILL.md`'s bytes are `put` into the
 * (in-process) staging store and an approval is opened bound to the EXACT
 * artifact hash. NO live-dir write happens here — promotion into `~/.quanta/skills`
 * runs ONLY on an operator approve (the artifact port's CAS `promote`). Absent
 * this port the migration slice fails CLOSED (imported skills are NOT written
 * anywhere) — so wiring it turns a startup skill import from a silent drop into
 * a staged, review-bound proposal.
 *
 * PROMOTE ACTUATOR (RFC03-def, this file) — the import→approve→promote loop is
 * now CLOSED via {@link buildImportSkillReview}. {@link composeImportSkillStage}
 * returns a `review` surface bound to the SAME approval machine + artifact port +
 * staging store the stage populated. `review.list()` enumerates the PENDING
 * staged proposals; `review.approve(id)` settles the approval AND drives the
 * EXISTING CAS `promote` (hash-verified, realpath-jailed, fail-closed);
 * `review.deny(id)` settles `deny` and NEVER writes. Security posture unchanged:
 * NO live-dir write happens at stage time or on `list()`; the ONLY write path is
 * an explicit operator `approve`, and it re-verifies the bound artifact hash
 * (`promote` refuses `hash_mismatch` on a tampered staged artifact) before the
 * atomic write. The approval is bound by artifact HASH, never a tool-name string.
 *
 * ⚠️ DURABILITY (unchanged, by design): the staging store + approval machine are
 * still fresh PER import run (production omits the `staging` arg ⇒ an in-memory
 * Map). The review surface consumes them WITHIN the same process lifetime; a
 * skill not reviewed before the process exits is simply re-staged on the next
 * gated import. This is fail-SAFE (never an unapproved write). On-disk durable
 * staging is a separate follow-up; do NOT claim it here.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import type { SkillStagePort } from "@/migration/external-config"
import { errMessage } from "@/shared"
import {
  ABSENT_PREIMAGE,
  createSkillProposalArtifactPort,
  type PromoteResult,
  type PromoteStorageIo,
  type StagingStore,
} from "@/skill"
import {
  FsJailError,
  resolveJailed,
  sha256Hex,
  readFile as storageReadFile,
  writeFileAtomic,
} from "@/storage"

/** The host storage primitives the CAS artifact port needs — all from the
 *  real `@/storage` owner (sha256 / realpath-jail / atomic write). Mirrors the
 *  private `HOST_PROMOTE_STORAGE_IO` in `tier1/skill.ts` and the front-door
 *  proof's `HOST_IO`. */
const HOST_PROMOTE_STORAGE_IO: PromoteStorageIo = {
  sha256: (c) => sha256Hex(c),
  resolveJailed: (rel, root) => resolveJailed(rel, root),
  writeFileAtomic: (abs, c) => writeFileAtomic(abs, c),
  readFile: (abs) => storageReadFile(abs),
  isJailError: (e) => e instanceof FsJailError,
  errMessage: (e) => errMessage(e),
}

/** A stable thread id for the startup-import approval binding (diagnostics /
 *  filter only — the approval is bound by artifact hash, not this id). */
const IMPORT_THREAD_ID = "config-migration-import"

/** The step label the import approval carries. A review surface consumes it as
 *  the guard that an approval is a promotable staged-skill proposal (never
 *  promotes an approval that is not this exact step). */
export const PROMOTE_IMPORTED_SKILL_STEP = "promote-imported-skill"

/** A single PENDING staged-skill proposal, as the review surface surfaces it.
 *  Carries the approval `id` (the review key), the skill `name`, the relative
 *  `targetPath` the CAS promote would write, and the bound `artifactHash` (the
 *  hash `promote` re-verifies — the binding is by content, not a tool name). */
export interface StagedSkillProposal {
  readonly id: string
  readonly name: string
  readonly targetPath: string
  readonly artifactHash: string
}

/** Outcome of a `review.approve(id)` — the promote result on success, or a
 *  typed refusal reason on any fail-closed miss (unknown/denied approval, no
 *  staged artifact, hash mismatch, jail escape, preimage drift, write error). */
export type SkillReviewApproveResult =
  | { readonly ok: true; readonly path: string; readonly name: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string }

/** Outcome of a `review.deny(id)` — always drops (never writes). */
export type SkillReviewDenyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * The review/approve surface for staged imported-skill proposals. Bound to the
 * SAME approval machine + artifact port + staging store the stage populated.
 *
 *   - `list()`    — the PENDING staged proposals (settled ones drop out). Pure
 *                   read; NEVER touches disk.
 *   - `approve(id)` — settle the approval `approve` AND drive the EXISTING CAS
 *                   `promote` (hash-verified, jailed, atomic). The ONLY write
 *                   path. Fail-closed: a non-pending / unknown / non-import
 *                   approval, or a promote precondition miss, returns a typed
 *                   refusal and writes NOTHING.
 *   - `deny(id)`  — settle `deny`; NEVER promotes.
 */
export interface ImportSkillReview {
  list(): readonly StagedSkillProposal[]
  approve(id: string): Promise<SkillReviewApproveResult>
  deny(id: string): SkillReviewDenyResult
}

/** Per-approval promote metadata captured at stage time (the approval record
 *  itself carries only the hash — the review needs the target path too). */
interface StagedMeta {
  readonly name: string
  readonly targetPath: string
  readonly artifactHash: string
}

/**
 * Build the review/approve surface over an approval machine + the artifact port
 * that shares the SAME staging store the proposals were `put` into. `metaById`
 * maps an approval id → the promote metadata captured at stage time.
 *
 * The standalone factory is exported so a review can be reconstructed over an
 * approval machine + staging store (e.g. a surface that holds them separately);
 * it re-derives the metadata from the machine's pending records. When a shared
 * `metaById` is passed (the composer path) that authoritative map is used.
 */
export const buildImportSkillReview = (
  approval: ApprovalStateMachinePort,
  skillsDir: string,
  staging: StagingStore,
  metaById?: ReadonlyMap<string, StagedMeta>,
): ImportSkillReview => {
  const artifact = createSkillProposalArtifactPort(skillsDir, HOST_PROMOTE_STORAGE_IO, staging)

  /** Resolve the promote metadata for a pending import approval, or undefined
   *  when the id is not a promotable staged-skill proposal. */
  const metaFor = (id: string): StagedMeta | undefined => {
    const fromMap = metaById?.get(id)
    if (fromMap !== undefined) return fromMap
    // Fallback: reconstruct from the approval record. The target path is parsed
    // from the `proposedAction` ("write <targetPath>") the stage stamped.
    const req = approval.get(id)
    if (req === undefined || req === null) return undefined
    if (req.resumeStep !== PROMOTE_IMPORTED_SKILL_STEP) return undefined
    if (req.artifactHash === undefined) return undefined
    const targetPath = req.proposedAction.startsWith("write ")
      ? req.proposedAction.slice("write ".length)
      : ""
    if (targetPath === "") return undefined
    const name = targetPath.split("/")[0] ?? ""
    return { name, targetPath, artifactHash: req.artifactHash }
  }

  const toReason = (r: PromoteResult): string => (r.ok ? "ok" : r.reason)

  return {
    list(): readonly StagedSkillProposal[] {
      // Only PENDING import-skill approvals with a resolvable staged artifact.
      const out: StagedSkillProposal[] = []
      for (const req of approval.pending()) {
        if (req.resumeStep !== PROMOTE_IMPORTED_SKILL_STEP) continue
        const meta = metaFor(req.id)
        if (meta === undefined) continue
        out.push({
          id: req.id,
          name: meta.name,
          targetPath: meta.targetPath,
          artifactHash: meta.artifactHash,
        })
      }
      return out
    },

    async approve(id: string): Promise<SkillReviewApproveResult> {
      // Refuse anything that is not a PENDING import-skill proposal — a denied /
      // already-settled / unknown / foreign approval never promotes.
      const req = approval.get(id)
      if (req === null || req.status !== "pending") {
        return { ok: false, reason: "not_pending", detail: `approval ${id} is not pending` }
      }
      const meta = metaFor(id)
      if (meta === undefined) {
        return { ok: false, reason: "unknown_proposal", detail: `no staged proposal for ${id}` }
      }
      // Settle FIRST so a re-approve after this cannot double-fire; the promote
      // is the actuator bound to the just-approved decision.
      const settled = approval.settle(id, "approve")
      if (settled === null || settled.decision !== "approve") {
        return { ok: false, reason: "settle_failed", detail: `could not approve ${id}` }
      }
      // The EXISTING CAS promote — hash re-verify + realpath jail + atomic write.
      // A `new` imported skill's target does not exist ⇒ ABSENT_PREIMAGE.
      const result = await artifact.promote({
        hash: meta.artifactHash,
        targetPath: meta.targetPath,
        expectedPreimageHash: ABSENT_PREIMAGE,
      })
      if (!result.ok) return { ok: false, reason: toReason(result), detail: result.detail }
      return { ok: true, path: result.path, name: meta.name }
    },

    deny(id: string): SkillReviewDenyResult {
      const req = approval.get(id)
      if (req === null || req.status !== "pending") {
        return { ok: false, reason: "not_pending" }
      }
      // Settle `deny` — NO promote path is reachable from here.
      const settled = approval.settle(id, "deny")
      if (settled === null || settled.decision !== "deny") {
        return { ok: false, reason: "settle_failed" }
      }
      return { ok: true }
    },
  }
}

/** Compose the REAL imported-skill staging port + the approval machine that
 *  carries its pending approvals + the review/approve surface bound to BOTH (and
 *  to the artifact port's staging store). The `review` closes the
 *  import→approve→promote loop: `stage` populates it, an operator consumes it.
 *
 *  `skillsDir` is the live user skills directory — the CAS jail root the promote
 *  writes into on approve (canonically `<homeDir>/.quanta/skills`).
 *
 *  `staging` is a TEST SEAM (mirrors the artifact port's own optional staging
 *  store): a test passes a shared `Map` so it can promote the staged bytes with
 *  a sibling port over the SAME store. Production OMITS it ⇒ a fresh in-memory
 *  store per import run (byte-identical). Either way, the returned `review` is
 *  bound to the SAME store the stage `put`s into. */
export const composeImportSkillStage = (
  skillsDir: string,
  staging?: StagingStore,
): {
  readonly stage: SkillStagePort
  readonly approval: ApprovalStateMachinePort
  readonly review: ImportSkillReview
} => {
  // Own the staging store explicitly so the review promotes from the SAME store
  // the stage put into (production: a fresh per-run Map; test: the shared arg).
  const store: StagingStore = staging ?? new Map()
  const artifact = createSkillProposalArtifactPort(skillsDir, HOST_PROMOTE_STORAGE_IO, store)
  const approval = createApprovalStateMachine()
  const metaById = new Map<string, StagedMeta>()
  const stage: SkillStagePort = {
    stage: async (args) => {
      // Stage the exact imported bytes into the CAS store (content-addressed,
      // inert until promoted). NO live write.
      await artifact.put(args.bytes)
      // Bind a review-approval to EXACTLY these bytes. The approve→CAS-promote
      // ACTUATOR is `buildImportSkillReview` below (the review surface returned
      // from this composer) — an approve re-verifies this hash + promotes.
      const req = approval.request({
        threadId: IMPORT_THREAD_ID,
        kind: "permission",
        reason: `Install imported skill "${args.name}" (${args.kind})`,
        proposedAction: `write ${args.targetPath}`,
        resumeStep: PROMOTE_IMPORTED_SKILL_STEP,
        artifactRef: args.artifactHash,
        artifactHash: args.artifactHash,
      })
      // Capture the promote metadata keyed by the minted approval id so the
      // review can resolve the target path (the approval record carries only the
      // hash) without re-parsing.
      metaById.set(req.id, {
        name: args.name,
        targetPath: args.targetPath,
        artifactHash: args.artifactHash,
      })
      // proposalId is the content hash (deterministic, mirrors the front-door
      // proof) so a caller can correlate the pending approval to the artifact.
      const proposalId = createHash("sha256").update(args.bytes, "utf8").digest("hex")
      return { proposalId }
    },
  }
  const review = buildImportSkillReview(approval, skillsDir, store, metaById)
  return { stage, approval, review }
}

/** The canonical live user skills directory (CAS jail root) under a home dir. */
export const importSkillsDir = (homeDir: string): string => join(homeDir, ".quanta", "skills")
