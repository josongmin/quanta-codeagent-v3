/**
 * RFC03-2 — evidence-to-proposal compiler (pure domain service).
 *
 * Turns a typed draft input + cited evidence anchors into an immutable,
 * content-addressed {@link SkillProposal}. It NEVER writes to the live skill
 * directory — that is the promotion step's job (RFC03-3), gated by the existing
 * approval machine. The compiler:
 *
 *   1. Rejects vacuous invention — evidence[] must be non-empty AND every cited
 *      path must resolve under an allowed root (jailed). This structurally
 *      forbids "invent a skill from nothing".
 *   2. Renders normalized SKILL.md bytes via the SAME `renderSkillMarkdown` +
 *      `validateScaffold` the runtime discovery schema uses (no drift).
 *   3. Refuses a `new` proposal whose name collides with a SYSTEM skill and an
 *      `improvement` whose target is not a discovered skill (system-shadow /
 *      unknown-target admission — the read-time registry precedence stays
 *      user-wins; shadow refusal lives HERE, at proposal admission).
 *   4. Binds the proposal to the target's preimage hash at compile time.
 *
 * All hashing / canonicalization is DELEGATED to an injected {@link ProposalIo}
 * port whose host adapter reuses `@/storage` (sha256Hex / canonicalizePath /
 * readFile) — the compiler does NOT reimplement hash / jail.
 */

import { renderSkillMarkdown, validateScaffold } from "../skill-creator"
import { MAX_SKILL_SIZE_BYTES } from "../skill-size"
import {
  ABSENT_PREIMAGE,
  type CompileResult,
  type SkillEvidenceAnchor,
  type SkillProposalDraftInput,
  type SkillProposalError,
} from "./types"

/** Re-validated kebab-case skill name (mirrors skill-creator NAME_RE). Path
 *  safety: a name that fails can never become a directory segment. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Injected IO the compiler needs, all reusing `@/storage` in the host adapter:
 *   - `sha256`: content hash (== storage `sha256Hex`).
 *   - `resolveUnderRoots`: canonicalize `path` and confirm it is inside ONE of
 *     the allowed roots; returns the canonical path or `null` on escape.
 *   - `readIfExists`: read a file's bytes, or `null` when absent.
 *   - `systemSkillNames` / `discoveredSkillNames`: the pinned snapshot's names
 *     for shadow / unknown-target admission.
 */
export interface ProposalIo {
  sha256(content: string): string
  resolveUnderRoots(path: string): string | null
  readIfExists(path: string): Promise<string | null>
  readonly systemSkillNames: ReadonlySet<string>
  readonly discoveredSkillNames: ReadonlySet<string>
}

/** Validate + hash the cited evidence. Returns resolved anchors or a typed
 *  refusal. Empty evidence ⇒ `no_evidence`; any unresolved path ⇒
 *  `evidence_unresolved` (anti-vacuous core). */
const resolveEvidence = async (
  io: ProposalIo,
  paths: readonly string[],
): Promise<{ ok: true; anchors: SkillEvidenceAnchor[] } | { ok: false; detail: string }> => {
  if (paths.length === 0) return { ok: false, detail: "no evidence cited" }
  const anchors: SkillEvidenceAnchor[] = []
  for (const p of paths) {
    const canonical = io.resolveUnderRoots(p)
    if (canonical === null)
      return { ok: false, detail: `evidence path escapes allowed roots: ${p}` }
    const bytes = await io.readIfExists(canonical)
    if (bytes === null) return { ok: false, detail: `evidence path does not resolve: ${p}` }
    anchors.push({ path: canonical, sha256: io.sha256(bytes) })
  }
  return { ok: true, anchors }
}

/** system-shadow (new) / unknown-target (improvement) admission. Returns a
 *  refusal detail keyed by error, or `null` when admitted. */
const checkAdmission = (
  io: ProposalIo,
  input: SkillProposalDraftInput,
): { error: "system_shadow" | "unknown_target"; detail: string } | null => {
  if (input.kind === "new") {
    return io.systemSkillNames.has(input.name)
      ? { error: "system_shadow", detail: `"${input.name}" shadows a system skill` }
      : null
  }
  // improvement
  const target = input.target ?? input.name
  if (!io.discoveredSkillNames.has(target)) {
    return { error: "unknown_target", detail: `no discovered skill "${target}"` }
  }
  if (io.systemSkillNames.has(target)) {
    return { error: "system_shadow", detail: `cannot overwrite system skill "${target}"` }
  }
  return null
}

/** Render normalized bytes via the SAME discovery schema/renderer + size cap.
 *  Returns the rendered bytes or a typed refusal. */
const renderDraft = (
  input: SkillProposalDraftInput,
):
  | { ok: true; bytes: string; byteLength: number }
  | { ok: false; error: SkillProposalError; detail: string } => {
  const fields = {
    name: input.name,
    description: input.description,
    body: input.body,
    userInvocable: input.userInvocable ?? true,
    allowedTools: input.allowedTools ?? [],
    category: input.category ?? ("skill" as const),
    stability: input.stability ?? ("experimental" as const),
  }
  const invalid = validateScaffold(fields)
  if (invalid !== null) return { ok: false, error: "invalid_frontmatter", detail: invalid }
  const bytes = renderSkillMarkdown(fields)
  const byteLength = Buffer.byteLength(bytes, "utf8")
  if (byteLength > MAX_SKILL_SIZE_BYTES) {
    return { ok: false, error: "too_large", detail: `${byteLength} > ${MAX_SKILL_SIZE_BYTES}` }
  }
  return { ok: true, bytes, byteLength }
}

/**
 * Compile a draft + evidence into an immutable proposal. Pure except for the
 * injected IO reads. NEVER throws — every failure is a typed {@link CompileResult}.
 */
export const compileSkillProposal = async (
  io: ProposalIo,
  input: SkillProposalDraftInput,
  evidencePaths: readonly string[],
  generatorVersion: string,
): Promise<CompileResult> => {
  // 0. name path-safety.
  if (!NAME_RE.test(input.name)) {
    return { ok: false, error: "invalid_name", detail: `not kebab-case: ${input.name}` }
  }
  // 1. anti-vacuous evidence gate.
  const ev = await resolveEvidence(io, evidencePaths)
  if (!ev.ok) {
    return {
      ok: false,
      error: evidencePaths.length === 0 ? "no_evidence" : "evidence_unresolved",
      detail: ev.detail,
    }
  }
  // 2. admission: system-shadow / unknown-target.
  const admission = checkAdmission(io, input)
  if (admission !== null) return { ok: false, error: admission.error, detail: admission.detail }
  // 3. render normalized bytes (schema + size).
  const rendered = renderDraft(input)
  if (!rendered.ok) return { ok: false, error: rendered.error, detail: rendered.detail }

  // 4. target preimage binding — the target's CURRENT bytes at compile time.
  const targetPath = `${input.name}/SKILL.md`
  const targetCanonical = io.resolveUnderRoots(targetPath)
  const existing = targetCanonical === null ? null : await io.readIfExists(targetCanonical)
  const targetPreimageHash = existing === null ? ABSENT_PREIMAGE : io.sha256(existing)
  const draftHash = io.sha256(rendered.bytes)
  return {
    ok: true,
    proposal: {
      proposalId: draftHash,
      kind: input.kind,
      name: input.name,
      targetPath,
      draftHash,
      targetPreimageHash,
      sources: ev.anchors,
      generatorVersion,
      validationReceipt: {
        frontmatterValid: true,
        byteLength: rendered.byteLength,
        withinSizeCap: true,
      },
      draftBytes: rendered.bytes,
    },
  }
}
