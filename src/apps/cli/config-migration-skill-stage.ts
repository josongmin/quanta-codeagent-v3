/**
 * CLI host composer — RFC03-4 imported-skill STAGING port for the startup
 * external-config IMPORT flow.
 *
 * The `@/migration/external-config` slice is fenced from `@/skill` / `@/agent`
 * (it may only reach `@/skill/frontmatter`), so it cannot construct the real
 * `SkillProposalArtifactPort` / approval machine itself — it declares a
 * structural {@link SkillStagePort} and lets the host inject one. THIS file is
 * that host adapter: it composes the REAL `createSkillProposalArtifactPort`
 * (RFC03-2/3 CAS staging/promote, backed by `@/storage` sha256 + realpath-jail +
 * atomic write) with the REAL `createApprovalStateMachine`, mirroring the
 * in-agent `tier1/skill.ts#buildProposalStagePort` composition and the
 * `external-config-migration-skills-memory-frontdoor` proof.
 *
 * Behavior: an imported `.claude/skills/*​/SKILL.md` bytes are `put` into the CAS
 * store and an approval is opened bound to the EXACT artifact hash. NO live-dir
 * write happens here — promotion into `~/.quanta/skills` runs ONLY on an operator
 * approve (via the artifact port's CAS `promote`). Absent this port the migration
 * slice fails CLOSED (imported skills are NOT written anywhere) — so wiring it is
 * what turns a startup skill import from a silent drop into a staged proposal.
 *
 * NOTE (render surface): the approval this opens lives in a fresh in-process
 * approval machine created per import run. There is no startup approval-render
 * surface consuming it yet, so the staged proposal persists as a content-
 * addressed CAS artifact (durable, inert) while its approval binding is
 * in-memory. That is the deliberate fail-safe boundary — bytes are staged and
 * reviewable, never live-written without approval; surfacing the pending
 * approval to the operator at startup is a separate render decision (see handoff).
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
      // Bind an approval to EXACTLY these bytes — the operator approve handler
      // re-verifies + CAS-promotes at `args.targetPath`.
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
