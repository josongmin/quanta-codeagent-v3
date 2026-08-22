/**
 * jun-6 (Codex skill-creator parity) — an AGENT-CALLABLE tool that AUTHORS a
 * skill.
 *
 * RFC03-2 CUTOVER: `skill_create` no longer writes to the LIVE skill directory
 * on invoke. It COMPILES an immutable, content-addressed proposal (evidence →
 * deterministic draft) and STAGES it for human review through the injected
 * {@link SkillProposalStagePort}. Promotion into the live directory happens ONLY
 * on an operator approve, through the existing `ApprovalStateMachine` + CAS
 * artifact port (RFC03-3). The old direct live-dir writer is REMOVED — a
 * live-writer and a proposal pipeline must not coexist.
 *
 * Pipeline (pure except evidence/target reads via `ProposalIo` and the final
 * stage hop):
 *   1. COMPILE — {@link compileSkillProposal} renders normalized SKILL.md bytes
 *      via the SAME `renderSkillMarkdown` / `SkillFrontmatterSchema` discovery
 *      uses, enforces the size cap, gates on non-vacuous evidence (cited paths
 *      must resolve under an allowed root), and refuses system-shadow /
 *      unknown-target proposals. Same input ⇒ same `draftHash` (replayable).
 *   2. STAGE — the compiled bytes + hash are staged for review via the port; the
 *      approval is bound to the exact `artifactHash`. NOTHING reaches disk here.
 *
 * SECURITY / SAFETY:
 *   - The skill `name` is re-validated against the kebab-case regex (in the
 *     compiler) BEFORE it is ever a path segment.
 *   - Evidence is mandatory + path-resolving (anti-vacuous: no invented skills).
 *   - The stage port is REQUIRED; absent ⇒ the tool is never registered
 *     (default-OFF, `QUANTA_SKILL_CREATOR`), byte-identical default surface.
 *
 * Pure functions never throw; the tool surfaces every failure as a typed
 * `{ ok:false, output }` result.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { compileSkillProposal, type ProposalIo } from "./proposal/compiler"
import type { SkillProposalStagePort } from "./proposal/port"
import type { SkillProposalKind } from "./proposal/types"
import {
  SkillCategorySchema,
  SkillFrontmatterSchema,
  SkillStabilitySchema,
} from "./skill-frontmatter"

const schema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Kebab-case skill name (e.g. `pdf-extract`). Becomes <name>/SKILL.md."),
  description: z.string().min(1).describe("One-line description of what the skill does."),
  body: z
    .string()
    .min(1)
    .describe("The SKILL.md markdown body (the instructions the model follows)."),
  // RFC03-2 — mandatory, non-vacuous evidence. Each path MUST resolve under an
  // allowed root (memory/repo). Empty ⇒ the proposal is refused: a skill must be
  // distilled from an observed procedure, never invented from nothing.
  evidence: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Paths to the observed evidence this skill distills (e.g. a memory file). " +
        "REQUIRED and each must resolve — a skill cannot be proposed from nothing.",
    ),
  kind: z
    .enum(["new", "improvement"])
    .optional()
    .describe('"new" (default) creates a skill; "improvement" targets an existing one.'),
  target: z
    .string()
    .optional()
    .describe('For kind:"improvement" — the existing skill name being improved.'),
  userInvocable: z
    .boolean()
    .optional()
    .describe("Whether a user can invoke this skill via a slash command. Default true."),
  allowedTools: z
    .array(z.string().min(1))
    .optional()
    .describe("Advisory tool allowlist for the skill. Default [] (none declared)."),
  category: SkillCategorySchema.optional().describe('"skill" (default) or "extension".'),
  stability: SkillStabilitySchema.optional().describe(
    '"experimental" (default), "stable", or "deprecated".',
  ),
})

type Input = z.infer<typeof schema>

/** A typed scaffold object ready for {@link renderSkillMarkdown}. Carries the
 *  body alongside the frontmatter fields. */
interface ScaffoldFields {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly userInvocable: boolean
  readonly allowedTools: readonly string[]
  readonly category: "skill" | "extension"
  readonly stability: "experimental" | "stable" | "deprecated"
}

/** Quote a YAML scalar that needs it (contains `:` or leading/trailing space or
 *  a `#`). Conservative — when in doubt, double-quote. Pure. */
const yamlScalar = (s: string): string => {
  const needsQuote = /[:#]|^\s|\s$|^$/.test(s)
  if (!needsQuote) return s
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Render a canonical SKILL.md from typed fields. Frontmatter order is fixed +
 * deterministic so two identical inputs always produce byte-identical output
 * (replay-friendly). The body is appended verbatim after a blank line. Pure.
 */
export const renderSkillMarkdown = (fields: ScaffoldFields): string => {
  const toolsLine =
    fields.allowedTools.length === 0
      ? "allowedTools: []"
      : `allowedTools:\n${fields.allowedTools.map((t) => `  - ${yamlScalar(t)}`).join("\n")}`
  const fm = [
    "---",
    `name: ${yamlScalar(fields.name)}`,
    `description: ${yamlScalar(fields.description)}`,
    `userInvocable: ${fields.userInvocable}`,
    toolsLine,
    `category: ${fields.category}`,
    `stability: ${fields.stability}`,
    "---",
  ].join("\n")
  // Trim a leading newline off the body so the blank line between fence + body
  // is exactly one (deterministic).
  return `${fm}\n\n${fields.body.replace(/^\n+/, "")}\n`
}

/** Validate the SCAFFOLDED fields against the SAME schema discovery uses, so an
 *  invalid skill is rejected with the schema's own message. Returns the first
 *  error string, or `null` when valid. Pure. */
export const validateScaffold = (fields: ScaffoldFields): string | null => {
  const parsed = SkillFrontmatterSchema.safeParse({
    name: fields.name,
    description: fields.description,
    userInvocable: fields.userInvocable,
    allowedTools: [...fields.allowedTools],
    category: fields.category,
    stability: fields.stability,
  })
  if (parsed.success) return null
  const first = parsed.error.issues[0]
  return first
    ? `${first.path.join(".") || "frontmatter"}: ${first.message}`
    : "invalid frontmatter"
}

/** Human-readable message for each compiler refusal. */
const COMPILE_ERROR_MSG: Record<string, string> = {
  no_evidence: "no evidence cited — a skill must be distilled from an observed procedure",
  evidence_unresolved: "a cited evidence path does not resolve under an allowed root",
  invalid_name: "the skill name must be kebab-case",
  invalid_frontmatter: "the rendered frontmatter failed the skill schema",
  too_large: "the rendered SKILL.md exceeds the size cap",
  unknown_target: "the improvement target is not a discovered skill",
  system_shadow: "the name/target collides with a system skill (system cannot be shadowed)",
}

/**
 * Dependencies the `skill_create` tool needs after the RFC03-2 cutover. No live
 * writer — the tool compiles an immutable proposal and STAGES it for review.
 *   - `io`               — evidence/target hashing + jail (host reuses `@/storage`).
 *   - `stage`            — the closed stage port (host composes artifact `put` +
 *                          existing approval `request`). NO live write here.
 *   - `generatorVersion` — provenance stamp (model/config/compiler id).
 */
export interface SkillCreatorDeps {
  readonly io: ProposalIo
  readonly stage: SkillProposalStagePort
  readonly generatorVersion: string
}

/**
 * Build the `skill_create` tool. The stage deps are REQUIRED — the composition
 * root only constructs (and registers) this when the operator opts in
 * (`QUANTA_SKILL_CREATOR`), so absent ⇒ the tool is never on the menu
 * (default-OFF, byte-identical default surface).
 */
/** The single terminal result shape the tool yields. */
type ToolResultShape = Extract<ToolEvent, { type: "result" }>["result"]

/** Map a compiler input from the tool's Zod input. Pure. */
const toDraftInput = (input: Input) => ({
  name: input.name,
  description: input.description,
  body: input.body,
  kind: (input.kind ?? "new") as SkillProposalKind,
  ...(input.target !== undefined ? { target: input.target } : {}),
  ...(input.userInvocable !== undefined ? { userInvocable: input.userInvocable } : {}),
  ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
  ...(input.category !== undefined ? { category: input.category } : {}),
  ...(input.stability !== undefined ? { stability: input.stability } : {}),
})

/** A structured error result (mirrors permission_propose_pattern). */
const errorResult = (output: string, modelVisibleError: string, e: unknown): ToolResultShape => ({
  ok: false,
  output,
  failure: { mode: "error", modelVisibleError, clientVisibleError: errMessage(e) },
})

/**
 * COMPILE the proposal then STAGE it for review. NEVER throws — a thrown
 * compiler / stage port maps to a typed `ok:false` result (the Tool contract
 * requires exactly one terminal result). NO live write happens here.
 */
const compileAndStage = async (deps: SkillCreatorDeps, input: Input): Promise<ToolResultShape> => {
  let compiled: Awaited<ReturnType<typeof compileSkillProposal>>
  try {
    compiled = await compileSkillProposal(
      deps.io,
      toDraftInput(input),
      input.evidence,
      deps.generatorVersion,
    )
  } catch (e) {
    return errorResult(
      "Skill proposal failed: the compiler threw unexpectedly.",
      "skill_create failed while compiling the proposal.",
      e,
    )
  }
  if (!compiled.ok) {
    const why = COMPILE_ERROR_MSG[compiled.error] ?? compiled.error
    return { ok: false, output: `Skill proposal rejected: ${why} (${compiled.detail}).` }
  }
  const p = compiled.proposal
  try {
    const staged = await deps.stage.stage({
      proposalId: p.proposalId,
      artifactHash: p.draftHash,
      bytes: p.draftBytes,
      name: p.name,
      targetPath: p.targetPath,
      kind: p.kind,
    })
    return {
      ok: true,
      output: `Proposed skill "${p.name}" (proposal ${staged.proposalId}, ${p.validationReceipt.byteLength} bytes) — staged for review. It is installed only after you approve it.`,
    }
  } catch (e) {
    return errorResult(
      "Skill proposal failed: the stage port threw unexpectedly.",
      "skill_create failed while staging the proposal.",
      e,
    )
  }
}

export const createSkillCreatorTool = (deps: SkillCreatorDeps): Tool<Input> => {
  return {
    name: "skill_create",
    description:
      "Propose a new skill (or an improvement to an existing one) distilled from " +
      "cited evidence. This does NOT write to disk: it compiles an immutable, " +
      "content-addressed proposal and stages it for human review + approval. The " +
      "skill is installed only after an operator approves the proposal.",
    inputSchema: schema,
    // Stages a proposal (no live write) but it is still a state-changing
    // authoring action gated behind review; keep it NOT read-only /
    // NOT concurrency-safe (two proposals for the same name race on review).
    isReadOnly: () => false,
    isConcurrencySafe: () => false,

    async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "result", result: await compileAndStage(deps, input) }
    },
  }
}
