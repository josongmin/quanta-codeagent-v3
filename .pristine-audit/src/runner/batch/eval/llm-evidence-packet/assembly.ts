/**
 * OPC-07 — typed evidence assembly (shared by all builders).
 *
 * Owns symbol-slice extraction (bounded, decorator-aware, ambiguity-typed),
 * owner-evidence assembly from public issue + static witnesses, public issue
 * fact description, static-witness diagnostic facts, per-file owner-slice
 * missing-evidence, and the VerificationPlan → active-proof-target flattening.
 */

import { extractIssueHint } from "@/agent/issue-hint"
import type { VerificationPlan, VerificationStep } from "@/agent/verification-plan"
import { normalizePublicIssueText } from "@/shared"
import type { StaticWitness } from "../static-witness"
import type { StaticWitnessDiagnostic } from "../static-witness-adapter"
import { assertEvidenceTextBlind } from "./guards"
import {
  boundHead,
  escapeRe,
  firstNonEmptyLine,
  fmtList,
  looksNonSource,
  uniqueLines,
  uniqueObjects,
} from "./text-utils"
import type {
  LlmEvidencePacketStage,
  MissingEvidenceFact,
  OwnerEvidenceFact,
  OwnerSourceSlice,
  StaticFact,
  SymbolSliceMiss,
  SymbolSliceResult,
  VerificationStepFact,
  VerificationTargetFact,
} from "./types"

/**
 * Per-file `owner_slice` missingEvidence for owners whose source slice could not
 * be resolved (B2). SAME emission `candidate_generation` already does
 * (llm-evidence-packet.ts), now SHARED so repair_seed / candidate_post_review
 * make a missing slice VISIBLE instead of silently dropping it.
 */
export const ownerSliceMissingEvidence = (
  ownerEvidence: readonly OwnerEvidenceFact[],
): MissingEvidenceFact[] => {
  const filesWithSlice = new Set(
    ownerEvidence.filter((o) => o.sourceSlice !== undefined).map((o) => o.file),
  )
  const seenMissing = new Set<string>()
  return ownerEvidence
    .filter((o) => o.sourceSlice === undefined && !filesWithSlice.has(o.file))
    .filter((o) => {
      if (seenMissing.has(o.file)) return false
      seenMissing.add(o.file)
      return true
    })
    .map((o) => ({
      kind: "owner_slice",
      // B4: distinguish a binary/non-source file from a genuine symbol-not-found.
      // Default (not_found / unknown) keeps the established `no_resolvable_slice:`
      // reason so existing consumers/tests stay stable.
      reason:
        o.sliceMiss === "non_source"
          ? `non_source_file:${o.file}`
          : `no_resolvable_slice:${o.file}`,
    }))
}

export const staticWitnessDiagnosticsFacts = (
  diagnostics: readonly StaticWitnessDiagnostic[] | undefined,
): {
  readonly staticFacts: readonly StaticFact[]
  readonly missingEvidence: readonly MissingEvidenceFact[]
} => {
  if (diagnostics === undefined || diagnostics.length === 0) {
    return { staticFacts: [], missingEvidence: [] }
  }
  return {
    staticFacts: diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      value: `${diagnostic.file}: ${diagnostic.reason}`,
    })),
    missingEvidence: diagnostics.map((diagnostic) => ({
      kind: "static_witness",
      reason: `${diagnostic.kind}:${diagnostic.file}`,
    })),
  }
}

/** Actual normalized public issue facts — never a placeholder pointer. */
export const describeIssueFacts = (
  problemStatement: string,
  stage: LlmEvidencePacketStage = "intake",
): string[] => {
  assertEvidenceTextBlind(stage, [problemStatement])
  const normalized = normalizePublicIssueText(problemStatement)?.trim() ?? problemStatement.trim()
  const hint = extractIssueHint(problemStatement)
  return [
    `issue summary: ${boundHead(firstNonEmptyLine(normalized) ?? "<empty issue text>")}`,
    `issue symbols: ${fmtList(hint.symbols)}`,
    `issue files: ${fmtList(hint.files)}`,
  ]
}

/**
 * B4: file-level slice-miss classification. Given the file source (null when
 * unreadable) and whichever per-symbol resolution succeeded, returns the
 * distinguishable miss reason, or undefined when a slice WAS resolved.
 *  - resolved slice present ⇒ undefined (no miss).
 *  - source null/unreadable ⇒ undefined (handled by other missingEvidence, not a slice miss).
 *  - binary/non-source file ⇒ `non_source`.
 *  - readable source, symbol absent ⇒ `not_found`.
 */
const sliceMissForFile = (
  source: string | null,
  resolved: SymbolSliceResult | undefined,
): SymbolSliceMiss | undefined => {
  if (resolved?.slice !== undefined) return undefined
  if (source === null) return undefined
  return looksNonSource(source) ? "non_source" : "not_found"
}

/**
 * B4: precise, distinguishable symbol-slice resolution.
 *  1. Walks BACKWARD over contiguous `@decorator` lines directly above the matched
 *     `def`/`class` and includes them (the decorator is often the fix site).
 *  2. Reports `matchCount` so an ambiguous same-name redefinition is visible
 *     instead of silently returning the first match.
 *  3. Returns a typed `miss` (`non_source` vs `not_found`) so callers can emit a
 *     specific missingEvidence reason rather than conflating both as `undefined`.
 * Bounded by `maxLines` (decorators included in the budget).
 */
export const extractSymbolSliceResult = (
  source: string,
  symbol: string,
  maxLines = 40,
): SymbolSliceResult => {
  if (looksNonSource(source)) return { miss: "non_source", matchCount: 0 }
  const lines = source.split(/\r?\n/)
  const matches = symbolDefinitionMatches(lines, symbol)
  if (matches.length === 0) return { miss: "not_found", matchCount: 0 }
  const chosen = matches[0]
  if (chosen === undefined) return { miss: "not_found", matchCount: 0 }
  // EVERY matching site as its own bounded, labeled slice — so an ambiguous
  // symbol surfaces all candidate sites to the model, not just site 0. Each
  // slice is independently capped by `maxLines`.
  const slices: OwnerSourceSlice[] = matches.map((match) => ({
    label: `${symbol}@${match.index + 1}`,
    slice: symbolBlockLines(lines, match, maxLines).join("\n").trimEnd(),
  }))
  return {
    // `chosen` is non-undefined, so the first slice always exists.
    slice: symbolBlockLines(lines, chosen, maxLines).join("\n").trimEnd(),
    slices,
    matchCount: matches.length,
  }
}

const symbolDefinitionMatches = (
  lines: readonly string[],
  symbol: string,
): { readonly index: number; readonly indent: number }[] => {
  const re = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${escapeRe(symbol)}\\b`)
  return lines.flatMap((line, index) => {
    const m = line.match(re)
    return m === null ? [] : [{ index, indent: (m[1] ?? "").length }]
  })
}

const decoratorLinesBefore = (
  lines: readonly string[],
  index: number,
  indent: number,
  maxLines: number,
): readonly string[] => {
  const decoratorLines: string[] = []
  for (let k = index - 1; k >= 0; k--) {
    const prev = lines[k]
    if (prev === undefined) break
    const trimmed = prev.trim()
    if (trimmed === "") break
    const prevIndent = prev.length - prev.trimStart().length
    if (prevIndent !== indent || !trimmed.startsWith("@")) break
    decoratorLines.unshift(prev)
  }
  // BOUND: decorators + def must fit in maxLines. If a pathological decorator
  // stack overflows the budget, keep the def and the decorators CLOSEST to it
  // (the rest are dropped) — never exceed maxLines.
  const decoratorBudget = Math.max(0, maxLines - 1)
  const keptDecorators =
    decoratorLines.length > decoratorBudget
      ? decoratorLines.slice(decoratorLines.length - decoratorBudget)
      : decoratorLines
  return keptDecorators
}

const bodyLinesAfterDefinition = (
  lines: readonly string[],
  index: number,
  indent: number,
  remainingLines: number,
): readonly string[] => {
  const block: string[] = []
  for (let j = index + 1; j < lines.length && block.length < remainingLines; j++) {
    const ln = lines[j]
    if (ln === undefined) break
    if (ln.trim() === "") {
      block.push(ln)
      continue
    }
    const curIndent = ln.length - ln.trimStart().length
    if (curIndent <= indent) break
    block.push(ln)
  }
  return block
}

const symbolBlockLines = (
  lines: readonly string[],
  match: { readonly index: number; readonly indent: number },
  maxLines: number,
): readonly string[] => {
  const decorators = decoratorLinesBefore(lines, match.index, match.indent, maxLines)
  const definition = lines[match.index]
  if (definition === undefined) return decorators
  const remaining = Math.max(0, maxLines - decorators.length - 1)
  return [
    ...decorators,
    definition,
    ...bodyLinesAfterDefinition(lines, match.index, match.indent, remaining),
  ]
}

/**
 * Exact definition/symbol block for a Python `def`/`class` symbol — the bounded
 * source slice rule (no broad windows, no whole-file bodies). Returns undefined
 * when the symbol is not statically resolvable in the source. Thin back-compat
 * wrapper over {@link extractSymbolSliceResult} (now decorator-aware).
 */
export const extractSymbolSlice = (
  source: string,
  symbol: string,
  maxLines = 40,
): string | undefined => extractSymbolSliceResult(source, symbol, maxLines).slice

/**
 * Build typed owner evidence from owner files + issue symbols. When a sandbox
 * reader is supplied, attaches the EXACT symbol slice for each issue symbol
 * statically defined in the file (bounded). No reader / no resolvable symbol ⇒
 * path + symbols only (caller may add `missingEvidence` for the missing slice).
 */
export const assembleOwnerEvidence = (args: {
  readonly ownerFiles: readonly string[]
  readonly issueSymbols?: readonly string[]
  readonly provenance?: string
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] => {
  const provenance = args.provenance ?? "selection-owner"
  const issueSymbols = args.issueSymbols ?? []
  return args.ownerFiles.flatMap((file) =>
    file.trim() === ""
      ? []
      : [
          ownerEvidenceFact({
            file,
            provenance,
            issueSymbols,
            source: args.readSource?.(file) ?? null,
          }),
        ],
  )
}

const symbolDefinedInSource = (source: string, symbol: string): boolean =>
  new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escapeRe(symbol)}\\b`, "m").test(source)

const definedIssueSymbols = (source: string | null, issueSymbols: readonly string[]): string[] =>
  source === null ? [] : issueSymbols.filter((symbol) => symbolDefinedInSource(source, symbol))

/**
 * Resolve issue symbols to bounded slices. Returns the FIRST resolved result
 * (for back-compat `slice`/`matchCount`/`miss`) PLUS `allSlices`: the union of
 * EVERY resolved site across EVERY symbol (each label already file-local as
 * `<symbol>@line`, here re-labeled below by caller). When more than one site
 * resolves, the caller surfaces them all so the model — not the scaffold —
 * picks the right one.
 */
const resolvedSymbolSlices = (
  source: string | null,
  symbols: readonly string[],
): { readonly first?: SymbolSliceResult; readonly allSlices: readonly OwnerSourceSlice[] } => {
  if (source === null) return { allSlices: [] }
  const resolved = symbols
    .map((symbol) => extractSymbolSliceResult(source, symbol))
    .filter((r) => r.slice !== undefined)
  const first = resolved[0]
  return {
    ...(first !== undefined ? { first } : {}),
    allSlices: resolved.flatMap((r) => r.slices ?? []),
  }
}

const ownerEvidenceFact = (args: {
  readonly file: string
  readonly provenance: string
  readonly issueSymbols: readonly string[]
  readonly source: string | null
}): OwnerEvidenceFact => {
  const symbols = definedIssueSymbols(args.source, args.issueSymbols)
  const { first: resolved, allSlices } = resolvedSymbolSlices(args.source, symbols)
  const miss = sliceMissForFile(args.source, resolved)
  return {
    file: args.file,
    symbols,
    provenance: args.provenance,
    ...(resolved?.slice !== undefined ? { sourceSlice: resolved.slice } : {}),
    ...multiSiteSlicesField(args.file, allSlices),
    ...(resolved !== undefined && resolved.matchCount > 1 ? { ambiguousSliceMatch: true } : {}),
    ...(miss !== undefined ? { sliceMiss: miss } : {}),
  }
}

/**
 * Build the `sourceSlices` field ONLY when there are multiple candidate sites —
 * one site is already fully carried by `sourceSlice`, so duplicating it would
 * just bloat the packet. Each label is prefixed with the owner file so the model
 * sees `file:symbol@line`. The per-slice cap was applied upstream; this only
 * relabels, never grows a slice.
 */
const multiSiteSlicesField = (
  file: string,
  allSlices: readonly OwnerSourceSlice[],
): { sourceSlices?: readonly OwnerSourceSlice[] } =>
  allSlices.length > 1
    ? { sourceSlices: allSlices.map((s) => ({ label: `${file}:${s.label}`, slice: s.slice })) }
    : {}

/**
 * Static-witness-backed owner evidence. Carries witness kind/provenance/authority
 * and attaches an exact symbol slice when the witnessed symbol is statically
 * resolvable in that file.
 */
export const assembleStaticWitnessOwnerEvidence = (args: {
  readonly witnesses: readonly StaticWitness[]
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] => {
  return uniqueObjects(
    args.witnesses.flatMap((witness) =>
      uniqueLines(witness.subjectFiles).map((file) =>
        staticWitnessOwnerEvidenceFact(witness, file, args.readSource?.(file) ?? null),
      ),
    ),
  )
}

const staticWitnessOwnerEvidenceFact = (
  witness: StaticWitness,
  file: string,
  source: string | null,
): OwnerEvidenceFact => {
  const symbols = uniqueLines(witness.subjectSymbols)
  const { first: resolved, allSlices } = resolvedSymbolSlices(source, symbols)
  const miss = sliceMissForFile(source, resolved)
  return {
    file,
    symbols,
    provenance: `static-witness:${witness.kind}/${witness.provenance}/${witness.authority}`,
    ...(resolved?.slice !== undefined ? { sourceSlice: resolved.slice } : {}),
    ...multiSiteSlicesField(file, allSlices),
    ...(resolved !== undefined && resolved.matchCount > 1 ? { ambiguousSliceMatch: true } : {}),
    ...(miss !== undefined ? { sliceMiss: miss } : {}),
  }
}

/**
 * Shared owner evidence surface for candidate-generation packets: public issue
 * owners plus structural static-witness owners, deduped but otherwise preserving
 * their distinct provenance.
 */
export const buildSelectionOwnerEvidence = (args: {
  readonly ownerFiles: readonly string[]
  readonly issueSymbols?: readonly string[]
  readonly staticWitnesses?: readonly StaticWitness[]
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] =>
  uniqueObjects([
    ...assembleOwnerEvidence({
      ownerFiles: args.ownerFiles,
      ...(args.issueSymbols !== undefined ? { issueSymbols: args.issueSymbols } : {}),
      ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
    }),
    ...assembleStaticWitnessOwnerEvidence({
      witnesses: args.staticWitnesses ?? [],
      ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
    }),
  ])

/**
 * Flatten the typed VerificationPlan into the active proof target — ANSWER-KEY
 * SAFE BY CONSTRUCTION. Only `repro` step commands are surfaced (those are a
 * synthesized sandbox-temp script, blind by construction). `owner-test` /
 * `module-smoke` step commands are WITHHELD (cmdWithheld:true) because they can
 * encode a path to a hidden test — a leak the content scanner cannot detect.
 * The successPredicate is reduced to its discriminant `.type`, never its
 * selector/substring value. This fence must hold before OPC-04 wires
 * test-file-derived steps.
 */
export const verificationTargetFromPlan = (
  plan: VerificationPlan | undefined,
): VerificationTargetFact | undefined => {
  if (plan === undefined) return undefined
  const sanitizeReproCmd = (cmd: string): string | undefined => {
    const sandboxPath = /(?<![\w./-])\/[^\s'"]*\/reproduce_issue\.py/g
    const sanitized = cmd.replace(sandboxPath, "reproduce_issue.py")
    // Temp __repro_* paths are proof-port internals, not stable user-facing
    // commands. Do not let a stale fork path become prompt authority.
    if (/\/[^\s'"]*\/__repro_\d+_[^\s'"]+\.py/.test(sanitized)) return undefined
    return sanitized
  }
  const toStep = (step: VerificationStep): VerificationStepFact => {
    const cmdIsBlind = step.kind === "repro"
    const reproCmd = cmdIsBlind ? sanitizeReproCmd(step.cmd) : undefined
    return {
      kind: step.kind,
      ...(cmdIsBlind && reproCmd !== undefined ? { cmd: reproCmd } : { cmdWithheld: true }),
      ...(step.authority !== undefined ? { authority: step.authority } : {}),
      ...(step.successPredicate !== undefined
        ? { successPredicate: step.successPredicate.type }
        : {}),
    }
  }
  return {
    primaryRail: plan.primaryRail === null ? null : toStep(plan.primaryRail),
    required: plan.required.map(toStep),
    optional: plan.optional.map(toStep),
    baseValidatedRed: plan.baseValidatedRed,
  }
}
