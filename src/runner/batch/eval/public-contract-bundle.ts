/**
 * Public contract bundle — PURE builders + evaluator (T-CON-10).
 *
 * Derives a typed {@link PublicContractBundle} from GENERIC, typed inputs only:
 *  - an issue-declared expected value (public issue text),
 *  - public test names already present in the repo,
 *  - whether a validated repro is present,
 *  - a static witness of owner files / API symbols.
 *
 * It NEVER derives obligations from a known-instance patch or file-path regex,
 * from an issue-family regex tuned to a benchmark miss, or from a hidden oracle
 * label (hidden pass/fail test lists, gold patches, or gold file paths). Those forbidden sources
 * cannot enter: every builder takes only the generic typed inputs above. The
 * accompanying test greps THIS source for any benchmark path / instance-id
 * literal and asserts none are present (self-policing).
 *
 * PURE + deterministic: no I/O, no LLM, no clock/random.
 */

import type {
  ContractCandidate,
  ContractProvenance,
  ContractSatisfaction,
  PublicContract,
  PublicContractBundle,
  PublicContractKind,
  PublicContractStrength,
} from "@/runner/batch/eval/public-contract-types"

/** Trim + drop empties; preserve order, drop duplicates. Generic list hygiene. */
const cleanList = (xs: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of xs) {
    const v = raw.trim()
    if (v === "" || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const mkContract = (args: {
  kind: PublicContractKind
  strength: PublicContractStrength
  provenance: ContractProvenance
  subjectFiles?: readonly string[]
  subjectSymbols?: readonly string[]
  /** stable discriminator so two owner-must-touch contracts get distinct ids */
  discriminator: string
}): PublicContract => ({
  contractId: `${args.kind}:${args.discriminator}`,
  kind: args.kind,
  strength: args.strength,
  provenance: args.provenance,
  subjectFiles: cleanList(args.subjectFiles ?? []),
  subjectSymbols: cleanList(args.subjectSymbols ?? []),
})

/**
 * exact-output contract from a public issue-declared expected value. The VALUE
 * itself is not an obligation subject (the candidate is judged by executable
 * proof, not by this contract), so this contract carries no file/symbol subject:
 * it records that the issue declared a concrete expected output (provenance
 * `public-issue-text`). `undefined`/empty declared value ⇒ no contract.
 */
export const buildExactOutputContract = (
  declaredExpected: { readonly kind?: string | undefined; readonly value: string } | undefined,
): PublicContract[] => {
  if (declaredExpected === undefined) return []
  if (declaredExpected.value.trim() === "") return []
  return [
    mkContract({
      kind: "exact-output",
      strength: "supporting",
      provenance: "public-issue-text",
      discriminator:
        (declaredExpected.kind ?? "").trim() === ""
          ? "declared"
          : (declaredExpected.kind ?? "").trim(),
    }),
  ]
}

/**
 * api-surface contract(s) from static-witness API symbols. Each symbol the
 * witness names as part of the affected public API becomes a `supporting`
 * obligation: a satisfying candidate touches that symbol.
 */
export const buildApiSurfaceContracts = (apiSymbols: readonly string[]): PublicContract[] =>
  cleanList(apiSymbols).map((symbol) =>
    mkContract({
      kind: "api-surface",
      strength: "supporting",
      provenance: "static-witness",
      subjectSymbols: [symbol],
      discriminator: symbol,
    }),
  )

/**
 * owner-must-touch contract(s) from static-witness owner files. Each owner file
 * becomes a `required` obligation: a satisfying candidate touches that file.
 * `required` because owner non-coverage is a strong (generic) demotion signal in
 * the contract-dominance tier.
 */
export const buildOwnerMustTouchContracts = (ownerFiles: readonly string[]): PublicContract[] =>
  cleanList(ownerFiles).map((file) =>
    mkContract({
      kind: "owner-must-touch",
      strength: "required",
      provenance: "static-witness",
      subjectFiles: [file],
      discriminator: file,
    }),
  )

/**
 * owner-must-touch contract(s) from owner files the PUBLIC ISSUE TEXT named.
 * These are the clean-path owner obligations: issue-file authority only, never
 * stage1 / owner-resolve / static-only structure.
 */
const buildIssueOwnerMustTouchContracts = (ownerFiles: readonly string[]): PublicContract[] =>
  cleanList(ownerFiles).map((file) =>
    mkContract({
      kind: "owner-must-touch",
      strength: "required",
      provenance: "public-issue-text",
      subjectFiles: [file],
      discriminator: file,
    }),
  )

/**
 * AUTHORITATIVE owner-must-touch contracts (T-OWN-12 clean slice): only owner
 * files the PUBLIC ISSUE TEXT named (`issue-file` evidence source) become a
 * `required` contract. The additive-score `stage1` / `owner-resolve` proposals
 * are heuristic/advisory and are EXCLUDED — they must not drive the clean
 * contract-dominance tier. Returns `[]` when the issue named no owner file (the
 * tier then stays empty rather than promoting a heuristic owner).
 */
export const authoritativeIssueOwnerContracts = (
  candidates: readonly { readonly file: string; readonly sources: readonly string[] }[],
): PublicContract[] =>
  buildIssueOwnerMustTouchContracts([
    ...new Set(candidates.filter((c) => c.sources.includes("issue-file")).map((c) => c.file)),
  ])

/**
 * Clean-selection public contracts assembled from SAFE public inputs only:
 *   - exact-output from issue-declared expected behavior,
 *   - owner-must-touch only for files the issue text explicitly named,
 *   - api-surface from the issue's named symbols (a candidate that touches the
 *     symbol the issue is about beats one that does not; `supporting` so it ranks
 *     below the required owner contract, with `public-issue-text` provenance).
 *
 * Stage1-only, owner-resolve-only, and static-only multi-site families remain
 * exploration evidence and are deliberately excluded from contract authority.
 * Empty inputs => `undefined`.
 */
export const buildCleanSelectionPublicContracts = (args: {
  readonly declaredExpected?:
    | { readonly kind?: string | undefined; readonly value: string }
    | undefined
  readonly candidates?:
    | readonly { readonly file: string; readonly sources: readonly string[] }[]
    | undefined
  readonly apiSymbols?: readonly string[] | undefined
}): PublicContractBundle | undefined => {
  const contracts = [
    ...buildExactOutputContract(args.declaredExpected),
    ...authoritativeIssueOwnerContracts(args.candidates ?? []),
    ...buildIssueApiSurfaceContracts(args.apiSymbols ?? []),
  ]
  if (contracts.length === 0) return undefined
  const byId = new Map<string, PublicContract>()
  for (const contract of contracts) {
    if (!byId.has(contract.contractId)) byId.set(contract.contractId, contract)
  }
  return { contracts: [...byId.values()] }
}

/** Clean-path api-surface contracts sourced from issue text, not static witness. */
const buildIssueApiSurfaceContracts = (apiSymbols: readonly string[]): PublicContract[] =>
  cleanList(apiSymbols).map((symbol) =>
    mkContract({
      kind: "api-surface",
      strength: "supporting",
      provenance: "public-issue-text",
      subjectSymbols: [symbol],
      discriminator: symbol,
    }),
  )

/**
 * lifecycle-owner contract(s) from static-witness lifecycle files (setup /
 * teardown / state-reset owners). Each becomes a `required` obligation that a
 * satisfying candidate touches that file.
 */
export const buildLifecycleOwnerContracts = (lifecycleFiles: readonly string[]): PublicContract[] =>
  cleanList(lifecycleFiles).map((file) =>
    mkContract({
      kind: "lifecycle-owner",
      strength: "required",
      provenance: "static-witness",
      subjectFiles: [file],
      discriminator: file,
    }),
  )

/**
 * multi-site-family contract from a static-witness family of co-changing files.
 * A satisfying candidate must touch EVERY file in the family (a single-site patch
 * that ignores the rest of the family violates it). One contract carries the
 * whole family as its subject. A family of <2 files yields no contract (no
 * multi-site obligation to express).
 */
export const buildMultiSiteFamilyContract = (familyFiles: readonly string[]): PublicContract[] => {
  const files = cleanList(familyFiles)
  if (files.length < 2) return []
  return [
    mkContract({
      kind: "multi-site-family",
      strength: "required",
      provenance: "static-witness",
      subjectFiles: files,
      discriminator: files.join("|"),
    }),
  ]
}

/** Merge contract bundles, preserving first occurrence of each stable id. */
export const mergePublicContractBundles = (
  ...bundles: readonly (PublicContractBundle | undefined)[]
): PublicContractBundle | undefined => {
  const byId = new Map<string, PublicContract>()
  for (const bundle of bundles) {
    for (const contract of bundle?.contracts ?? []) {
      if (!byId.has(contract.contractId)) byId.set(contract.contractId, contract)
    }
  }
  if (byId.size === 0) return undefined
  return { contracts: [...byId.values()] }
}

/**
 * state-reset-semantics contract derived from the presence of a validated repro
 * that exercises reset behaviour, scoped to a static-witness owner file. The
 * contract is `required` and provenance `validated-repro`. No repro ⇒ none.
 */
export const buildStateResetContract = (args: {
  readonly validatedReproPresent: boolean
  readonly resetOwnerFile: string | undefined
}): PublicContract[] => {
  if (!args.validatedReproPresent) return []
  const file = (args.resetOwnerFile ?? "").trim()
  if (file === "") return []
  return [
    mkContract({
      kind: "state-reset-semantics",
      strength: "required",
      provenance: "validated-repro",
      subjectFiles: [file],
      discriminator: file,
    }),
  ]
}

/**
 * Public-test contract(s) — owner-must-touch obligations whose provenance is a
 * public test name already present in the repo, scoped to the file the test is
 * understood to cover. Generic: just (testName, coveredFile) pairs.
 */
export const buildPublicTestContracts = (
  publicTests: readonly { readonly testName: string; readonly coveredFile: string }[],
): PublicContract[] => {
  const out: PublicContract[] = []
  const seen = new Set<string>()
  for (const t of publicTests) {
    const name = t.testName.trim()
    const file = t.coveredFile.trim()
    if (name === "" || file === "") continue
    const disc = `${name}->${file}`
    if (seen.has(disc)) continue
    seen.add(disc)
    out.push(
      mkContract({
        kind: "owner-must-touch",
        strength: "required",
        provenance: "public-test",
        subjectFiles: [file],
        discriminator: disc,
      }),
    )
  }
  return out
}

/** Generic typed inputs to {@link buildPublicContractBundle}. All optional. */
export interface PublicContractInputs {
  readonly declaredExpected?: { readonly kind: string; readonly value: string }
  readonly apiSymbols?: readonly string[]
  readonly ownerFiles?: readonly string[]
  readonly lifecycleFiles?: readonly string[]
  readonly multiSiteFamily?: readonly string[]
  readonly validatedReproPresent?: boolean
  readonly resetOwnerFile?: string
  readonly publicTests?: readonly { readonly testName: string; readonly coveredFile: string }[]
}

/**
 * Assemble the full {@link PublicContractBundle} from generic typed inputs.
 * Empty inputs ⇒ `{ contracts: [] }`. Duplicate contractIds are collapsed (a
 * file that is both an owner and a public-test target keeps one obligation per
 * distinct id).
 */
export const buildPublicContractBundle = (inputs: PublicContractInputs): PublicContractBundle => {
  const all: PublicContract[] = [
    ...buildExactOutputContract(inputs.declaredExpected),
    ...buildApiSurfaceContracts(inputs.apiSymbols ?? []),
    ...buildOwnerMustTouchContracts(inputs.ownerFiles ?? []),
    ...buildLifecycleOwnerContracts(inputs.lifecycleFiles ?? []),
    ...buildMultiSiteFamilyContract(inputs.multiSiteFamily ?? []),
    ...buildStateResetContract({
      validatedReproPresent: inputs.validatedReproPresent ?? false,
      resetOwnerFile: inputs.resetOwnerFile,
    }),
    ...buildPublicTestContracts(inputs.publicTests ?? []),
  ]

  const byId = new Map<string, PublicContract>()
  for (const c of all) {
    if (!byId.has(c.contractId)) byId.set(c.contractId, c)
  }
  return { contracts: [...byId.values()] }
}

/**
 * PURE evaluator: does `candidate` satisfy `contract`?
 *
 *  - `owner-must-touch` / `lifecycle-owner` / `state-reset-semantics`:
 *    the candidate must touch the contract's subject file(s) (all of them).
 *  - `multi-site-family`: the candidate must touch EVERY file in the family.
 *  - `api-surface`: the candidate must touch the contract's subject symbol(s).
 *  - `exact-output`: this contract carries no structural subject (the value is
 *    judged by executable proof, not here); it is structurally satisfied — it
 *    contributes provenance/telemetry, never a structural veto.
 *
 * A contract with no subject of its relevant axis is treated as satisfied (no
 * obligation to check) — except `exact-output`, which is always satisfied here
 * by design.
 */
export const evaluateContractSatisfaction = (
  contract: PublicContract,
  candidate: ContractCandidate,
): ContractSatisfaction => {
  const touchedFiles = new Set(candidate.touchedFiles.map((f) => f.trim()))
  const touchedSymbols = new Set(candidate.touchedSymbols.map((s) => s.trim()))

  const satisfied: boolean = ((): boolean => {
    switch (contract.kind) {
      case "exact-output":
        return true
      case "api-surface":
        return contract.subjectSymbols.every((s) => touchedSymbols.has(s.trim()))
      case "owner-must-touch":
      case "lifecycle-owner":
      case "state-reset-semantics":
      case "multi-site-family":
        return contract.subjectFiles.every((f) => touchedFiles.has(f.trim()))
    }
  })()

  return {
    contractId: contract.contractId,
    kind: contract.kind,
    strength: contract.strength,
    satisfied,
  }
}

/** Evaluate every contract in a bundle against one candidate. */
export const evaluateBundle = (
  bundle: PublicContractBundle,
  candidate: ContractCandidate,
): ContractSatisfaction[] => bundle.contracts.map((c) => evaluateContractSatisfaction(c, candidate))

/**
 * Count how many of the bundle's contracts a candidate satisfies — the input to
 * the selector's contract-dominance tier (more satisfied contracts dominates).
 */
export const contractsSatisfiedCount = (
  bundle: PublicContractBundle,
  candidate: ContractCandidate,
): number =>
  bundle.contracts.reduce(
    (n, c) => n + (evaluateContractSatisfaction(c, candidate).satisfied ? 1 : 0),
    0,
  )

/**
 * Count satisfied `required` contracts only — a candidate that violates a
 * `required` contract is distinguishable from one that satisfies it even when the
 * total satisfied counts coincide.
 */
export const requiredContractsSatisfiedCount = (
  bundle: PublicContractBundle,
  candidate: ContractCandidate,
): number =>
  bundle.contracts.reduce((n, c) => {
    if (c.strength !== "required") return n
    return n + (evaluateContractSatisfaction(c, candidate).satisfied ? 1 : 0)
  }, 0)
