/**
 * Generic, typed static-witness IR.
 *
 * A static witness is a piece of STRUCTURAL evidence (from AST / LSP / a static
 * engine / a repo map / a validated repro / public issue text) about a relation
 * between files and symbols — e.g. "this symbol is uniquely defined here", "these
 * files form an override family", "this file produces what that file consumes".
 *
 * It is deliberately NOT a numeric heuristic score and deliberately carries NO
 * benchmark-shaped authority: the provenance union below EXCLUDES gold-patch /
 * fail-to-pass / pass-to-pass / instance-id / known-file-regex / issue-family-regex.
 * Downstream tickets feed these witnesses into generation, candidate families, and
 * public contracts; "clean authority" is decided from `authority + provenance + kind`,
 * never from a magic threshold or a benchmark string match.
 *
 * No-source-body invariant: a witness carries path/symbol NAMES only. There is no
 * field for raw source text anywhere in this IR.
 */

export type StaticWitnessKind =
  | "unique-symbol-definer"
  | "override-family"
  | "producer-consumer"
  | "registration-callback"
  | "lifecycle-owner"

export type StaticWitnessAuthority = "authoritative" | "advisory"

export type StaticWitnessProvenance =
  | "ast"
  | "lsp"
  | "static-engine"
  | "repo-map"
  | "validated-repro"
  | "public-issue-text"

export interface StaticWitness {
  readonly witnessId: string
  readonly kind: StaticWitnessKind
  readonly authority: StaticWitnessAuthority
  readonly provenance: StaticWitnessProvenance
  readonly subjectFiles: readonly string[]
  readonly subjectSymbols: readonly string[]
  readonly fromFile?: string
  readonly reason: string
}

/**
 * Provenance values that must NEVER confer clean authority. These are benchmark /
 * grader-shaped sources. They are intentionally absent from `StaticWitnessProvenance`
 * so they cannot be constructed through the type at all; this runtime set is the
 * paired guard for the case where an `unknown`-typed string is cast past the type.
 */
export const STATIC_WITNESS_FORBIDDEN_PROVENANCE: ReadonlySet<string> = new Set([
  "gold-patch",
  "fail-to-pass",
  "pass-to-pass",
  "instance-id",
  "known-file-regex",
  "issue-family-regex",
])

const ALLOWED_PROVENANCE: ReadonlySet<string> = new Set<StaticWitnessProvenance>([
  "ast",
  "lsp",
  "static-engine",
  "repo-map",
  "validated-repro",
  "public-issue-text",
])

/** Kinds that express a structural OWNER / FAMILY obligation over files. */
const OWNER_FAMILY_KINDS: ReadonlySet<StaticWitnessKind> = new Set<StaticWitnessKind>([
  "override-family",
  "lifecycle-owner",
])

/**
 * True only for an allowed provenance that is NOT in the forbidden set. Accepts a
 * plain string so an `unknown`-typed (cast-through) provenance still fails closed.
 */
export function isCleanAuthorityProvenance(p: string): p is StaticWitnessProvenance {
  return ALLOWED_PROVENANCE.has(p) && !STATIC_WITNESS_FORBIDDEN_PROVENANCE.has(p)
}

function isOwnerFamilyKind(kind: StaticWitnessKind): boolean {
  return OWNER_FAMILY_KINDS.has(kind)
}

/** Normalize a list of names: trim, drop empties, dedup, stable sort. */
function normalizeNames(names: readonly string[] | undefined): string[] {
  if (!names) return []
  const seen = new Set<string>()
  for (const raw of names) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    seen.add(trimmed)
  }
  return [...seen].sort()
}

/** Deterministic id derived from kind + sorted subjects + fromFile. No clock/random. */
function deriveWitnessId(
  kind: StaticWitnessKind,
  files: readonly string[],
  symbols: readonly string[],
  fromFile: string | undefined,
): string {
  const from = fromFile?.trim() ?? ""
  return `${kind}:${files.join("|")}:${symbols.join("|")}:${from}`
}

export interface MakeStaticWitnessArgs {
  readonly kind: StaticWitnessKind
  readonly authority: StaticWitnessAuthority
  readonly provenance: StaticWitnessProvenance
  readonly subjectFiles: readonly string[]
  readonly subjectSymbols?: readonly string[]
  readonly fromFile?: string
  readonly reason: string
}

/**
 * Pure constructor. Normalizes subject lists (trim / drop-empty / dedup / stable
 * sort) and derives a STABLE `witnessId`.
 *
 * REJECTS (throws) an AUTHORITATIVE owner/family witness with EMPTY subjectFiles:
 * an authoritative obligation that names no files is meaningless.
 */
export function makeStaticWitness(args: MakeStaticWitnessArgs): StaticWitness {
  const subjectFiles = normalizeNames(args.subjectFiles)
  const subjectSymbols = normalizeNames(args.subjectSymbols)
  const fromFileTrimmed = args.fromFile?.trim()
  const fromFile = fromFileTrimmed && fromFileTrimmed.length > 0 ? fromFileTrimmed : undefined

  if (args.authority === "authoritative" && isOwnerFamilyKind(args.kind) && subjectFiles.length === 0) {
    throw new Error(
      `makeStaticWitness: authoritative ${args.kind} witness must name at least one subject file`,
    )
  }

  return {
    witnessId: deriveWitnessId(args.kind, subjectFiles, subjectSymbols, fromFile),
    kind: args.kind,
    authority: args.authority,
    provenance: args.provenance,
    subjectFiles,
    subjectSymbols,
    ...(fromFile ? { fromFile } : {}),
    reason: args.reason,
  }
}

/**
 * Runtime guard: can this witness legitimately confer CLEAN authority?
 *
 * True only when the witness is authoritative, its provenance is an allowed
 * (non-forbidden) source, and — for owner/family kinds — it names at least one file.
 * A witness whose provenance was cast in from an `unknown` string fails here.
 */
export function canBeCleanAuthority(witness: StaticWitness): boolean {
  if (witness.authority !== "authoritative") return false
  if (!isCleanAuthorityProvenance(witness.provenance)) return false
  if (isOwnerFamilyKind(witness.kind) && witness.subjectFiles.length === 0) return false
  return true
}

/**
 * True only when the witness names >= 2 files. A single-file witness can never be a
 * multi-site-family obligation.
 */
export function canBeMultiSiteObligation(witness: StaticWitness): boolean {
  return witness.subjectFiles.length >= 2
}

/** Collapse witnesses sharing a `witnessId` to one, preserving first-seen stable order. */
export function dedupeWitnesses(list: readonly StaticWitness[]): StaticWitness[] {
  const byId = new Map<string, StaticWitness>()
  for (const w of list) {
    if (!byId.has(w.witnessId)) byId.set(w.witnessId, w)
  }
  return [...byId.values()]
}
