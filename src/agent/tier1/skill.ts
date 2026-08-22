/**
 * Tier-1 per-subsystem builder: SKILL block (ADR-0011).
 *
 * Discovers user + bundled system skills, registers the `Skill` / `ToolSearch`
 * tools, builds the author-declared tool-allowlist map and
 * `{model?, effort?}` override map, and emits the per-turn suggestion
 * inventory (filtered by `changedPaths` when host wiring opts in).
 *
 * Behavior preserved verbatim from the previous `buildSkillFeatures` +
 * `skillOverrideEntry` helpers — only the *location* of these slices has
 * moved. The composer still gates the whole block on `config.skills`.
 *
 * DEFAULT-OFF: `config.skills` absent ⇒ this builder returns `undefined`
 * (byte-identical, RFC §1.2).
 */

import { errMessage, runtimeConfig } from "@/shared"
import {
  canonicalizePath,
  FsJailError,
  readFile,
  resolveJailed,
  sha256Hex,
  writeFileAtomic,
} from "@/storage"
import type { Tool } from "@/tool"
import type {
  PromoteStorageIo,
  ProposalIo,
  Skill,
  SkillProposalStagePort,
  SkillRegistry,
  SkillRuntimeAuthority,
  SkillRuntimeReader,
} from "../../skill"
import {
  buildSkillSnapshot,
  createAuthoritySkillResolver,
  createInMemoryDisabledStore,
  createSkillCreatorTool,
  createSkillProposalArtifactPort,
  createSkillRuntimeAuthority,
  createSkillRuntimeReader,
  createSkillTool,
  createToolSearchTool,
  skillEffortOverride,
  skillModelOverride,
  skillToolAllowlist,
} from "../../skill"
import type { ApprovalStateMachinePort } from "../approval-state-machine"
import type { SkillTurnOverride } from "../loop"
import type { AgentConfig } from "../types"

/** RFC03-2 — the generator provenance stamp for compiled proposals. */
const SKILL_PROPOSAL_GENERATOR = "quanta-skill-creator@rfc03"

/** RFC03-2 — the storage primitives the host injects into the artifact port.
 *  `@/skill` may not reach `@/storage`, so `@/agent` (this composition) threads
 *  the existing storage owner's functions in. NO reimplementation. */
const HOST_PROMOTE_STORAGE_IO: PromoteStorageIo = {
  sha256: (content) => sha256Hex(content),
  resolveJailed: (rel, root) => resolveJailed(rel, root),
  writeFileAtomic: (abs, content) => writeFileAtomic(abs, content),
  readFile: (abs) => readFile(abs),
  isJailError: (e) => e instanceof FsJailError,
  errMessage: (e) => errMessage(e),
}

/**
 * RFC03-2 — build the `ProposalIo` the compiler needs, reusing `@/storage`
 * (sha256 / canonicalize / readFile). Evidence roots gate cited paths; the
 * snapshot supplies system + discovered names for shadow/unknown admission.
 * `readIfExists` returns `null` on any read failure (a missing evidence path
 * must be a clean refusal, never a throw).
 */
const buildProposalIo = (registry: SkillRegistry, evidenceRoots: string[]): ProposalIo => {
  const canonRoots = evidenceRoots.map((r) => canonicalizePath(r))
  const systemNames = new Set(registry.bySope("system").map((s) => s.name))
  const discoveredNames = new Set(registry.entries.map((e) => e.skill.name))
  return {
    sha256: (content) => sha256Hex(content),
    resolveUnderRoots: (path) => {
      const canonical = canonicalizePath(path)
      return canonRoots.some((r) => canonical === r || canonical.startsWith(`${r}/`))
        ? canonical
        : null
    },
    readIfExists: async (path) => {
      try {
        return await readFile(path)
      } catch {
        return null
      }
    },
    systemSkillNames: systemNames,
    discoveredSkillNames: discoveredNames,
  }
}

/**
 * RFC03-2 cutover — compose the `SkillProposalStagePort` from the artifact port
 * (stage bytes) and the EXISTING approval machine (open a review bound to the
 * artifact hash). NO live write — promotion runs later, on approve, via the
 * artifact port's CAS `promote`. When no approval machine is wired the proposal
 * is still staged (bytes are content-addressed + inert) so the tool degrades to
 * "staged, review pending host wiring" rather than silently writing to disk. */
const buildProposalStagePort = (
  skillsDir: string,
  approval: ApprovalStateMachinePort | undefined,
  threadId: string,
): SkillProposalStagePort => {
  const artifact = createSkillProposalArtifactPort(skillsDir, HOST_PROMOTE_STORAGE_IO)
  return {
    stage: async (args) => {
      await artifact.put(args.bytes)
      // Bind an approval to EXACTLY these bytes. status/settle semantics are
      // unchanged. ⚠️ hellaudit A2: `resumeStep` is a LABEL, not a dispatched
      // action — no production consumer re-verifies + CAS-promotes on approve
      // yet, so the proposal is staged + review-bound but not yet promotable
      // live. Fail-SAFE (never an unapproved write); the approve→promote actuator
      // is an explicit RFC03 follow-up (a resumeStep→actuator resume-dispatch).
      approval?.request({
        threadId,
        kind: "permission",
        reason: `Install proposed skill "${args.name}" (${args.kind})`,
        proposedAction: `write ${args.targetPath}`,
        resumeStep: "promote-skill-proposal",
        artifactRef: args.proposalId,
        artifactHash: args.artifactHash,
      })
      return { proposalId: args.proposalId }
    },
  }
}

/** Materialized skill block. All fields are required (the builder either
 *  returns this whole block or `undefined`); `allowlists` / `overrides` are
 *  themselves nullable for the "no skill declared any" case. */
export interface SkillBlock {
  /** `[Skill, ToolSearch]` tools to merge into the registry. */
  tools: Tool[]
  /** Skill name → author-declared tool allowlist, including an explicit
   *  empty list meaning "no tools permitted". Absent when no skill declared
   *  any allowlist at all. */
  allowlists: Map<string, string[]> | undefined
  /** Skill name → author-declared `{model?, effort?}` override, for skills
   *  that declared at least one. Absent when no skill declared either. */
  overrides: Map<string, SkillTurnOverride> | undefined
  /** RFC-06 F3 — the LIVE per-turn discovery reader. The loop reads
   *  `runtime.activeInventory()` EVERY turn for the prompt "## Active skills"
   *  reminder (filtered by `changedPaths` + the MCP-deps gate over the CURRENT
   *  active projection), so a skill disabled after session start drops from the
   *  prompt on the next turn. Replaces the pre-F3 frozen `inventory` array. */
  runtime: SkillRuntimeReader
  /** RFC-06 F3 — the session's live skill runtime authority. Exposed so the
   *  composition/tests (and later F4/F5 surfaces) can drive `setEnabled` and
   *  observe the disable propagate to prompt + ToolSearch + the Skill spec. This
   *  is the SAME authority the `Skill` tool resolver, the ToolSearch searchable
   *  closure, the Skill tool `getSpec`, and `runtime` all read from. */
  authority: SkillRuntimeAuthority
}

/** ADR-0011 §6.2 → L4: the per-skill model/effort override entry, or
 *  `undefined` when the skill declares neither (a non-empty `model:` string
 *  AND/OR any defined `effort:`, including numeric 0). Extracted from the
 *  per-skill loop in {@link buildSkillBlock} so that loop stays a single
 *  branch (keeps the function under the cognitive-complexity budget). */
const skillOverrideEntry = (s: Skill): SkillTurnOverride | undefined => {
  const model = skillModelOverride(s)
  const effort = skillEffortOverride(s)
  if (model === undefined && effort === undefined) return undefined
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  }
}

/** Build the skill block from `config.skills`. Returns `undefined` when the
 *  block is absent so the composer can skip it. Pure except for
 *  `discoverSkills`'s directory IO. */
export const buildSkillBlock = async (config: AgentConfig): Promise<SkillBlock | undefined> => {
  if (!config.skills) return undefined

  const dir = config.skills.dir
  // RFC03-0 — canonical discovery+precedence authority. The prompt block, the
  // `Skill` tool inventory, and the CLI `/skills` list all derive from the SAME
  // `buildSkillSnapshot` so they cannot disagree on the collision winner or the
  // ordering. `dir` OPTIONAL (ADR-0045): omitted ⇒ only bundled system skills.
  // Precedence (ADR-0134): user WINS over system on a name collision — the
  // canonical decision (§0134 "system: 사용자 disable 가능"). "System cannot be
  // shadowed" belongs to the proposal/import admission layer, not read-time.
  const snapshot = await buildSkillSnapshot(dir !== undefined ? { userDir: dir } : {})
  const skills = [...snapshot.skills]
  // RFC-06 F2 — the LIVE skill runtime authority for this session's invocation
  // path. The `Skill` tool resolves EVERY invocation through this authority at
  // action time (see `createAuthoritySkillResolver`), so a disable that lands
  // after tool construction immediately blocks an already-created handle and a
  // re-enable restores it at a higher revision — there is no captured snapshot.
  //
  // Interim store/policy (F2 scope): an in-process disabled-set store and no
  // admin policy (`policy: null`). This keys the same-session enable/disable
  // receipt F2 owns. The DURABLE, org-policy-loaded authority is constructed
  // once at the composition root (`buildSkillRuntimeAuthority`) and threaded to
  // every surface by F4; this local authority is F4's convergence target, not a
  // permanent second cache.
  const disabledStore = createInMemoryDisabledStore()
  const persisted = await disabledStore.read()
  const authority = createSkillRuntimeAuthority({
    snapshot,
    policy: null,
    disabledStore,
    persisted,
  })
  const tools: Tool[] = [
    // ACTION-TIME resolution: the tool never captures the discovered list — it
    // resolves each name through `authority` at invoke time. `catalogue` feeds
    // only the CONSTRUCTION-TIME (fallback) description; `liveCatalogue` (F3)
    // makes the advertised description track the LIVE active projection so a
    // disable drops from the Skill tool spec on the next model request.
    createSkillTool({
      resolve: createAuthoritySkillResolver(authority),
      catalogue: skills,
      liveCatalogue: () => authority.read().active,
    }),
    // RFC-06 F3 — ToolSearch's `catalog:"skills"` mode reads the LIVE `searchable`
    // projection (dereferenced on every ToolSearch call), NOT the frozen
    // `snapshot.registry.entries`. So a skill disabled after construction
    // disappears from ToolSearch on the next call — the same revision the prompt
    // and the Skill spec see. `catalog` defaults to "tools" ⇒ byte-identical for
    // any call that does not opt into skill mode.
    createToolSearchTool(
      () => config.registry.specs(),
      () => authority.read().searchable,
    ),
  ]
  // jun-6 + RFC03-2 — register the agent-callable `skill_create` tool ONLY when
  // the operator opts in (`QUANTA_SKILL_CREATOR`) AND a writable user skills
  // `dir` is configured. RFC03-2 CUTOVER: the tool no longer writes to the live
  // dir on invoke — it COMPILES an immutable proposal and STAGES it for review
  // (promotion happens on approve via the CAS artifact port). Default-OFF /
  // no-dir ⇒ the tool is NOT on the menu (byte-identical surface).
  if (runtimeConfig().skillCreator && dir !== undefined) {
    // Evidence roots: the user skills dir + the process cwd (memory/repo files
    // the model cites). The host reuses `@/storage` for hash/jail — no new impl.
    const io = buildProposalIo(snapshot.registry, [dir, process.cwd()])
    const stage = buildProposalStagePort(dir, config.approvalStateMachine, config.sessionId ?? "")
    tools.push(createSkillCreatorTool({ io, stage, generatorVersion: SKILL_PROPOSAL_GENERATOR }))
  }
  const al = new Map<string, string[]>()
  // ADR-0011 §6.2 → L4: build the per-skill model/effort override map alongside
  // the allowlist map. A skill contributes an entry only when it declares
  // `model:` AND/OR `effort:` (a non-empty model string, or any defined effort
  // including numeric 0). Skills with neither leave the map untouched, so an
  // all-advisory-free skill set yields `undefined` and the loop stays
  // byte-identical.
  const ov = new Map<string, SkillTurnOverride>()
  for (const s of skills) {
    const allow = skillToolAllowlist(s)
    if (allow) al.set(s.name, allow)
    const override = skillOverrideEntry(s)
    if (override) ov.set(s.name, override)
  }
  // RFC-06 F3 — the LIVE discovery reader over THIS session's authority. It
  // replaces the pre-F3 frozen `inventory` array: the loop reads
  // `runtime.activeInventory()` EVERY turn, so the prompt "## Active skills"
  // reminder tracks the CURRENT active projection (a disable drops the skill on
  // the next turn) instead of a construction-time copy.
  //
  // The `paths:` conditional-activation filter and the MCP-deps gate live INSIDE
  // the reader now (over the live active set), so this builder no longer copies a
  // skill array. `changedPaths` unset ⇒ identity (byte-identical with prior
  // behavior). The reader returns the plain `{name, description}` shape (no
  // `@/skill` value type leaks into the prompt slice).
  const runtime = createSkillRuntimeReader(authority, {
    ...(config.skills.changedPaths !== undefined
      ? { changedPaths: config.skills.changedPaths }
      : {}),
  })
  return {
    tools,
    allowlists: al.size > 0 ? al : undefined,
    overrides: ov.size > 0 ? ov : undefined,
    runtime,
    authority,
  }
}
