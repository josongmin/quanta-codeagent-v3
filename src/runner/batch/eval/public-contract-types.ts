/**
 * Selection contract bundle — typed obligations / hints the clean selector may
 * use, with EXPLICIT provenance (T-CON-10).
 *
 * A `SelectionContract` expresses *what must hold* about a repair, derived ONLY
 * from public, generic inputs:
 *  - public issue text (e.g. a declared expected output),
 *  - public tests already present in the repo,
 *  - validated repro scripts,
 *  - a static witness bundle (owner files/symbols from lsp_definition /
 *    find_references / repo-map / closure evidence).
 *
 * IMPORTANT: not every contract provenance is submit authority. Public issue /
 * test / validated-repro contracts can participate in clean selector authority;
 * static-witness contracts are bounded STRUCTURAL ADVICE only and must be
 * filtered out before any clean submit decision.
 *
 * It is DELIBERATELY NOT an issue-family regex tuned to recover a known
 * benchmark miss, NOT a known-instance patch/file-path match, and NEVER carries
 * a hidden oracle label (hidden pass/fail test lists, gold patch, or gold file path). Those are
 * the README forbidden sources; the builders in `public-contract-bundle.ts`
 * accept only generic typed inputs so such sources cannot enter through the
 * type surface.
 *
 * Types only — no logic, no I/O. Builders/evaluators live in
 * `public-contract-bundle.ts`.
 */

/** Kind of obligation a contract expresses. Generic across instances. */
export type SelectionContractKind =
  | "exact-output"
  | "api-surface"
  | "owner-must-touch"
  | "lifecycle-owner"
  | "state-reset-semantics"
  | "multi-site-family"

/**
 * How strongly the contract binds. `required` contracts participate in the
 * selector's contract-dominance tier (an unsatisfied `required` contract demotes
 * a candidate); `supporting` contracts are advisory tie-break signal only.
 */
export type SelectionContractStrength = "required" | "supporting"

/**
 * Where the obligation came from. Provenance is carried through so the clean
 * selector can NAME, in telemetry, which public evidence backs each obligation —
 * and so an auditor can confirm no obligation traces to a forbidden source.
 *  - `public-issue-text`: declared expectation, named API symbols, or explicit
 *    owner files extracted from the problem statement.
 *  - `public-test`: a test name already present in the repo.
 *  - `validated-repro`: presence of a validated reproduction script.
 *  - `static-witness`: owner files/symbols from the static witness bundle.
 */
export type AuthorityContractProvenance = "public-issue-text" | "public-test" | "validated-repro"
export type AdvisoryContractProvenance = "static-witness"
export type ContractProvenance = AuthorityContractProvenance | AdvisoryContractProvenance

export const AUTHORITY_CONTRACT_PROVENANCE: ReadonlySet<AuthorityContractProvenance> = new Set([
  "public-issue-text",
  "public-test",
  "validated-repro",
])

export const isAuthorityContractProvenance = (
  provenance: ContractProvenance,
): provenance is AuthorityContractProvenance =>
  provenance === "public-issue-text" ||
  provenance === "public-test" ||
  provenance === "validated-repro"

export const isAdvisoryContractProvenance = (
  provenance: ContractProvenance,
): provenance is AdvisoryContractProvenance => provenance === "static-witness"

/** A single typed, provenance-carrying selector obligation or advisory hint. */
export interface SelectionContract {
  readonly contractId: string
  readonly kind: SelectionContractKind
  readonly strength: SelectionContractStrength
  readonly provenance: ContractProvenance
  /** Files the obligation is about (e.g. an owner file that must be touched). */
  readonly subjectFiles: readonly string[]
  /** Symbols the obligation is about (e.g. an API surface that must change). */
  readonly subjectSymbols: readonly string[]
}

/** A typed bundle of selector contracts for one instance's clean selection. */
export interface SelectionContractBundle {
  readonly contracts: readonly SelectionContract[]
}

/** Back-compat names retained while runtime callers migrate. */
export type PublicContractKind = SelectionContractKind
export type PublicContractStrength = SelectionContractStrength
export type PublicContract = SelectionContract
export type PublicContractBundle = SelectionContractBundle

/**
 * The observable facts about a candidate patch that a contract is evaluated
 * against. GENERIC: just the files and symbols the candidate touched. No oracle
 * label, no gold path — the same shape any candidate can report about itself.
 */
export interface ContractCandidate {
  readonly touchedFiles: readonly string[]
  readonly touchedSymbols: readonly string[]
}

/** Result of evaluating one contract against one candidate. */
export interface ContractSatisfaction {
  readonly contractId: string
  readonly kind: SelectionContractKind
  readonly strength: SelectionContractStrength
  readonly satisfied: boolean
}

/**
 * Keep only the submit-authoritative subset of a bundle. Structural
 * static-witness contracts are deliberately excluded here.
 */
export const filterAuthorityContractBundle = (
  bundle: SelectionContractBundle | undefined,
): SelectionContractBundle | undefined => {
  if (bundle === undefined) return undefined
  const contracts = bundle.contracts.filter((contract) =>
    isAuthorityContractProvenance(contract.provenance),
  )
  return contracts.length === 0 ? undefined : { contracts }
}

/**
 * Render a contract label for model-facing packets.
 *
 * Static-witness contracts remain useful as bounded structural guidance, but
 * they are ADVISORY on the clean path. Prefix them so packets do not present
 * them with the same wording as executable/public submit authority.
 */
export const renderContractAuthorityLabel = (
  contract: Pick<SelectionContract, "provenance" | "strength">,
): string =>
  isAdvisoryContractProvenance(contract.provenance)
    ? `advisory:${contract.provenance}/${contract.strength}`
    : `${contract.provenance}/${contract.strength}`
