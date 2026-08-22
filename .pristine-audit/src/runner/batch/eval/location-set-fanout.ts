/**
 * Strategy tool #7 — multi-location-set fanout (Agentless §4.2 "edit per location").
 *
 * Agentless samples a patch for EACH of the top-K predicted edit locations, giving
 * the candidate pool LOCATION diversity (not just temperature/lane diversity). Our
 * repair-breadth fan-out (repair-breadth.ts) already forks B candidates, but every
 * fork gets the SAME seed message — so the only diversity is model stochasticity.
 * This tool makes candidate `i` LEAD with a different ranked file, so the pool
 * explores distinct edit sites instead of N resamples of the top-1 localization.
 *
 * REUSE, NOT REBUILD: the fork+lane+validate machinery is repair-breadth.ts; the
 * ranked files come from `agentlessLocalize` (driver). This module is ONLY the pure
 * partition (ranked list → N location-sets) + the seed-hint renderer behind the
 * `perCandidateSeed` seam. No I/O, no clock/random — deterministic.
 *
 * NO-MAGIC: the partition is a pure ROTATION over the ranked list — candidate `i`
 * leads with `files[i % len]` and keeps EVERY other file as related context (never
 * blinds a candidate to a file localization surfaced). There is no threshold, no
 * score, no issue-text inspection. NO-LEAK: operates only on the localizer's public
 * ranked files. Default-OFF (the driver builds the seeder only when the knob is on)
 * ⇒ `perCandidateSeed` undefined ⇒ byte-identical.
 */

/** A candidate's location focus: one LEAD file + the rest of the ranked files as
 *  related context (so no file is hidden — the lead only changes emphasis). */
export interface LocationSet {
  readonly lead: string
  readonly related: readonly string[]
}

/**
 * Partition a RANKED file list into `n` location-sets by rotation. Set `i` leads
 * with `files[i % files.length]`; `related` is every OTHER file in ranked order.
 *
 * Returns `[]` (⇒ no fanout benefit, caller falls back to the base seed) when there
 * is nothing to diversify: no files, or a single file (every set would be identical
 * so the rotation buys no location diversity). `n` is clamped to ≥0; `n` larger than
 * the file count wraps (Agentless reuses locations when sampling more patches).
 */
export const partitionLocationSets = (
  rankedFiles: readonly string[],
  n: number,
): readonly LocationSet[] => {
  const files = rankedFiles.filter((f) => f.trim() !== "")
  if (files.length < 2 || n < 1) return []
  const sets: LocationSet[] = []
  for (let i = 0; i < n; i++) {
    const lead = files[i % files.length] as string
    sets.push({ lead, related: files.filter((f) => f !== lead) })
  }
  return sets
}

/** Render the location focus as a seed-hint suffix. Names the LEAD file as the
 *  primary edit site and lists the related files so the candidate keeps full
 *  context. Deterministic; safe to append to any seed message. */
export const renderLocationHint = (set: LocationSet): string => {
  const related = set.related.length > 0 ? set.related.join(", ") : "(none)"
  return [
    "",
    "<location-focus>",
    `Focus your fix PRIMARILY on \`${set.lead}\`. This candidate explores that file`,
    "as the most likely edit site for the issue. Other files that may need related",
    `changes: ${related}. Do not feel constrained to edit every file — prefer the`,
    "minimal correct change rooted at the primary file.",
    "</location-focus>",
  ].join("\n")
}

/** A SYMBOL-level focus within a single file — the granularity fix for the common
 *  single-file instance, where file-rotation buys nothing but the issue still names
 *  multiple candidate symbols (functions/classes). Mirrors Agentless's
 *  function-level `found_edit_locs` (we steer by symbol name; we don't have AST line
 *  intervals, so this is the symbol-name approximation). */
export interface SymbolLocationSet {
  readonly file: string
  readonly lead: string
  readonly otherSymbols: readonly string[]
}

/** Rotate the LEAD symbol within `file`. Returns `[]` when there is nothing to
 *  diversify (no file / <2 symbols). `n` wraps over the symbols. */
export const partitionSymbolSets = (
  file: string,
  symbols: readonly string[],
  n: number,
): readonly SymbolLocationSet[] => {
  const syms = symbols.filter((s) => s.trim() !== "")
  if (file.trim() === "" || syms.length < 2 || n < 1) return []
  const sets: SymbolLocationSet[] = []
  for (let i = 0; i < n; i++) {
    const lead = syms[i % syms.length] as string
    sets.push({ file, lead, otherSymbols: syms.filter((s) => s !== lead) })
  }
  return sets
}

export const renderSymbolHint = (set: SymbolLocationSet): string => {
  const others = set.otherSymbols.length > 0 ? set.otherSymbols.join(", ") : "(none)"
  return [
    "",
    "<location-focus>",
    `Focus your fix PRIMARILY on \`${set.lead}\` in \`${set.file}\`. This candidate`,
    "explores that symbol as the most likely edit site for the issue. Other symbols",
    `that may be involved: ${others}. Prefer the minimal correct change rooted there.`,
    "</location-focus>",
  ].join("\n")
}

/** Typed candidate-local location focus, carried alongside the textual seed so
 *  downstream selection/review can compare WHICH owner surface each breadth fork
 *  explored without reparsing prompt strings. SOURCE-ONLY: derived solely from the
 *  localizer/owner-ranked files and optional same-file symbols. */
export interface CandidateLocationFocus {
  readonly leadFile: string
  readonly relatedFiles: readonly string[]
  readonly leadSymbol?: string
  readonly otherSymbols?: readonly string[]
}

/** The `perCandidateSeed` port shape (matches repair-breadth's optional seam).
 *  `focusOf(index)` is OPTIONAL typed metadata for the same candidate rotation.
 *  Callers that only need the seed remain byte-identical. */
export interface PerCandidateSeed {
  (index: number, baseSeed: string | undefined): string | undefined
  focusOf?: (index: number) => CandidateLocationFocus | undefined
}

const normalizeFileKey = (raw: string): string => {
  let file = raw.trim().replaceAll("\\", "/")
  while (file.startsWith("./")) file = file.slice(2)
  while (file.startsWith("/")) file = file.slice(1)
  return file
}

const cleanUniqueFiles = (files: readonly string[]): readonly string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of files) {
    const file = raw.trim()
    const key = normalizeFileKey(file)
    if (key === "" || seen.has(key)) continue
    seen.add(key)
    out.push(file)
  }
  return out
}

const cleanUniqueSymbols = (symbols: readonly string[]): readonly string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of symbols) {
    const symbol = raw.trim()
    if (symbol === "" || seen.has(symbol)) continue
    seen.add(symbol)
    out.push(symbol)
  }
  return out
}

/** Repair breadth must fan out over the WHOLE owner surface already discovered by
 *  prepare/closure, not just the raw localizer list. Otherwise a single-file
 *  localize hit plus explicit sibling/witness evidence collapses back to N
 *  resamples of that one file — the exact Pro multi-file ceiling failure class.
 *  This preserves the stage-1/localizer rank first, then appends widened owner
 *  evidence without hiding any file or inventing new ones. */
export const buildRepairFanoutFiles = (args: {
  readonly localizeCandidates: readonly string[]
  readonly stage1Files?: readonly { file: string }[] | undefined
  readonly ownerResolved?: readonly { file: string }[] | undefined
  readonly witnessOwners?: readonly { file: string }[] | undefined
}): readonly string[] =>
  cleanUniqueFiles([
    ...(args.stage1Files?.map((entry) => entry.file) ?? args.localizeCandidates),
    ...(args.ownerResolved?.map((owner) => owner.file) ?? []),
    ...(args.witnessOwners?.map((owner) => owner.file) ?? []),
  ])

/** Agentless diversifies not only across files but across finer edit locations.
 *  Our single-file fallback originally used ONLY issue-text symbols, so a case
 *  with one localized file and symbol evidence discovered later by owner/witness
 *  analysis still collapsed to one seed. Lift those same-file symbols into the
 *  symbol-rotation input so single-file repair breadth keeps working after the
 *  file-localization stage. Multi-file fanout ignores this list (file rotation
 *  wins), so the symbol merge is intentionally scoped to the single-file case. */
export const buildRepairFanoutSymbols = (args: {
  readonly issueSymbols: readonly string[]
  readonly fanoutFiles: readonly string[]
  readonly ownerResolved?: readonly { file: string; forSymbol?: string }[] | undefined
  readonly witnessOwners?: readonly { file: string; forSymbol?: string }[] | undefined
}): readonly string[] => {
  if (args.fanoutFiles.length !== 1) return cleanUniqueSymbols(args.issueSymbols)
  const onlyFile = args.fanoutFiles[0] as string
  return cleanUniqueSymbols([
    ...args.issueSymbols,
    ...(args.ownerResolved
      ?.filter((owner) => owner.file.trim() === onlyFile)
      .map((owner) => owner.forSymbol ?? "") ?? []),
    ...(args.witnessOwners
      ?.filter((owner) => owner.file.trim() === onlyFile)
      .map((owner) => owner.forSymbol ?? "") ?? []),
  ])
}

/**
 * Build the per-candidate seeder for repair-breadth. Candidate `index` gets the base
 * seed with a rotation's location-hint appended. Diversity is taken at the COARSEST
 * level that has ≥2 options:
 *   - ≥2 ranked files     → rotate the LEAD FILE (file-level)
 *   - 1 file + ≥2 symbols → rotate the LEAD SYMBOL within that file (the common
 *                           single-file case Agentless covers at function level)
 *   - otherwise           → `undefined` (no diversity ⇒ base seed ⇒ byte-identical)
 * `issueSymbols` is the localizer/issue-hint symbol list (reused, not recomputed).
 */
export const buildLocationSeeder = (
  rankedFiles: readonly string[],
  n: number,
  issueSymbols: readonly string[] = [],
): PerCandidateSeed | undefined => {
  const fileSets = partitionLocationSets(rankedFiles, n)
  if (fileSets.length > 0) {
    const seed: PerCandidateSeed = (index, baseSeed) => {
      const set = fileSets[index % fileSets.length]
      return set === undefined ? baseSeed : `${baseSeed ?? ""}${renderLocationHint(set)}`
    }
    seed.focusOf = (index) => {
      const set = fileSets[index % fileSets.length]
      return set === undefined
        ? undefined
        : {
            leadFile: set.lead,
            relatedFiles: set.related,
          }
    }
    return seed
  }
  // Single-file fallback: rotate the lead SYMBOL so the fanout is not inert when the
  // issue localizes to one file but names several candidate symbols.
  const onlyFile = rankedFiles.filter((f) => f.trim() !== "")[0]
  if (onlyFile !== undefined) {
    const symbolSets = partitionSymbolSets(onlyFile, issueSymbols, n)
    if (symbolSets.length > 0) {
      const seed: PerCandidateSeed = (index, baseSeed) => {
        const set = symbolSets[index % symbolSets.length]
        return set === undefined ? baseSeed : `${baseSeed ?? ""}${renderSymbolHint(set)}`
      }
      seed.focusOf = (index) => {
        const set = symbolSets[index % symbolSets.length]
        return set === undefined
          ? undefined
          : {
              leadFile: set.file,
              relatedFiles: [],
              leadSymbol: set.lead,
              otherSymbols: set.otherSymbols,
            }
      }
      return seed
    }
  }
  return undefined
}
