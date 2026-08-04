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
 * ⚠️ SCOPE — promote actuator DEFERRED (hellaudit A2, explicit follow-up, NOT a
 * silent dead-seam): the approval this opens carries `resumeStep:
 * "promote-skill-proposal"`, but there is currently NO production consumer that,
 * on approve, re-verifies + calls the artifact port's `promote`. `resumeStep` is
 * a label, not a dispatched action, and this staging store + approval machine are
 * fresh PER import run (both discarded when the run ends — the staged bytes are
 * NOT durable). So on this path a skill is staged + a review is opened but cannot
 * yet be promoted live. This is fail-SAFE (never an unapproved write) but the
 * import→approve→promote loop is OPEN. Closing it is a security-sensitive design
 * decision — a resume-dispatch (`resumeStep` → actuator) that re-verifies the
 * bound hash + CAS-promotes, driven by a chosen review surface (startup notice
 * vs. an interactive `skills review` command). Tracked in the RFC03 catalog as an
 * explicit follow-up; do NOT claim durable persistence or a working promote here.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import type { SkillStagePort } from "@/migration/external-config"
import { errMessage } from "@/shared"
import { createSkillProposalArtifactPort, type PromoteStorageIo, type StagingStore } from "@/skill"
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

/** Compose the REAL imported-skill staging port + the approval machine that
 *  carries its pending approvals. Returns both so the caller can (later) surface
 *  the pending proposals; today the machine is consumed only for the binding.
 *
 *  `skillsDir` is the live user skills directory — the CAS jail root the promote
 *  would write into on approve (canonically `<homeDir>/.quanta/skills`).
 *
 *  `staging` is a TEST SEAM (mirrors the artifact port's own optional staging
 *  store): a test passes a shared `Map` so it can promote the staged bytes with
 *  a sibling port over the SAME store. Production OMITS it ⇒ a fresh in-memory
 *  store per import run (byte-identical). */
export const composeImportSkillStage = (
  skillsDir: string,
  staging?: StagingStore,
): { readonly stage: SkillStagePort; readonly approval: ApprovalStateMachinePort } => {
  const artifact =
    staging !== undefined
      ? createSkillProposalArtifactPort(skillsDir, HOST_PROMOTE_STORAGE_IO, staging)
      : createSkillProposalArtifactPort(skillsDir, HOST_PROMOTE_STORAGE_IO)
  const approval = createApprovalStateMachine()
  const stage: SkillStagePort = {
    stage: async (args) => {
      // Stage the exact imported bytes into the CAS store (content-addressed,
      // inert until promoted). NO live write.
      await artifact.put(args.bytes)
      // Bind a review-approval to EXACTLY these bytes. ⚠️ hellaudit A2: the
      // approve→CAS-promote ACTUATOR is deferred (no production consumer of the
      // resumeStep dispatches to promote yet) — see the top-of-file SCOPE note.
      approval.request({
        threadId: IMPORT_THREAD_ID,
        kind: "permission",
        reason: `Install imported skill "${args.name}" (${args.kind})`,
        proposedAction: `write ${args.targetPath}`,
        resumeStep: "promote-imported-skill",
        artifactRef: args.artifactHash,
        artifactHash: args.artifactHash,
      })
      // proposalId is the content hash (deterministic, mirrors the front-door
      // proof) so a caller can correlate the pending approval to the artifact.
      const proposalId = createHash("sha256").update(args.bytes, "utf8").digest("hex")
      return { proposalId }
    },
  }
  return { stage, approval }
}

/** The canonical live user skills directory (CAS jail root) under a home dir. */
export const importSkillsDir = (homeDir: string): string => join(homeDir, ".quanta", "skills")
