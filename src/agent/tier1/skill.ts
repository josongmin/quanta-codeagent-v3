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
} from "../../skill"
import {
  buildSkillSnapshot,
  createSkillCreatorTool,
  createSkillProposalArtifactPort,
  createSkillTool,
  createToolSearchTool,
  skillEffortOverride,
  skillModelOverride,
  skillsActivatedFor,
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
      // unchanged; the host's approve handler re-verifies + CAS-promotes.
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
  /** Per-turn suggestion inventory (filtered by `changedPaths` when set).
   *  `rawDependencies` (ADR-0476) is propagated ONLY when the
   *  `QUANTA_SKILL_MCP_DEPS` gate is on AND the skill declared a deps block;
   *  the prompt renderer ignores it, so the field is byte-identical otherwise. */
  inventory: { name: string; description: string; rawDependencies?: unknown }[]
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
  const tools: Tool[] = [
    // `createSkillTool` ALWAYS receives the full discovered list — a user can
    // still invoke any skill by name. The `paths:` filter below only narrows
    // the per-turn SUGGESTION inventory, never the invocable surface (that
    // would silently strip authority).
    createSkillTool(skills),
    // RFC03-1 — ToolSearch gets the pinned snapshot's registry entries so its
    // additive `catalog:"skills"` mode reads the SAME resolved set (no second
    // discovery / scorer). `catalog` defaults to "tools" ⇒ byte-identical for
    // any call that does not opt into skill mode.
    createToolSearchTool(
      () => config.registry.specs(),
      () => snapshot.registry.entries,
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
  // Plain `{name, description}` shape so the prompt slice never imports
  // `@/skill` (slice isolation — Codex skills-audit mirror). Built ONCE here
  // (the loop calls buildSessionFeatures once at session start), then passed
  // through every turn without re-discovery.
  //
  // `paths:` conditional activation (L1→L2 host-driven wiring): when
  // `config.skills.changedPaths` is set, narrow the suggestion inventory to
  //   - every skill WITHOUT `paths:` (unconditional — always in the inventory),
  //   - plus every skill WITH `paths:` whose globs match any changed path
  //     (via `skillsActivatedFor` — the dedicated helper that already filters
  //     out unconditional skills).
  // `changedPaths` unset ⇒ identity, byte-identical with prior behavior —
  // RFC §1.2 default-OFF. The invocable surface (the `Skill` tool) is NEVER
  // narrowed — only the per-turn SUGGESTION inventory is filtered.
  const changedPaths = config.skills.changedPaths
  const activated =
    changedPaths !== undefined && changedPaths.length > 0
      ? [
          ...skills.filter((s) => s.paths === undefined || s.paths.length === 0),
          ...skillsActivatedFor(skills, changedPaths),
        ]
      : skills
  // ADR-0476 — propagate each skill's lifted `dependencies` block onto the
  // active-skill channel ONLY when the gate is on, so the per-turn reconcile can
  // resolve declared MCP servers. Gate off ⇒ field omitted ⇒ byte-identical.
  const wantDeps = runtimeConfig().skillMcpDeps
  const inventory = activated.map((s) =>
    wantDeps && s.rawDependencies !== undefined
      ? { name: s.name, description: s.description, rawDependencies: s.rawDependencies }
      : { name: s.name, description: s.description },
  )
  return {
    tools,
    allowlists: al.size > 0 ? al : undefined,
    overrides: ov.size > 0 ? ov : undefined,
    inventory,
  }
}
