/**
 * Public contract bundle — typed obligations a clean selector candidate must
 * honor, with EXPLICIT provenance (T-CON-10).
 *
 * A `PublicContract` expresses *what must hold* about a repair, derived ONLY
 * from public, generic inputs:
 *  - public issue text (e.g. a declared expected output),
 *  - public tests already present in the repo,
 *  - validated repro scripts,
 *  - a static witness bundle (owner files/symbols from lsp_definition /
 *    find_references / repo-map / closure evidence).
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
export type PublicContractKind =
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
export type PublicContractStrength = "required" | "supporting"

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
export type ContractProvenance =
  | "public-issue-text"
  | "public-test"
  | "validated-repro"
  | "static-witness"

/** A single typed, provenance-carrying public obligation. */
export interface PublicContract {
  readonly contractId: string
  readonly kind: PublicContractKind
  readonly strength: PublicContractStrength
  readonly provenance: ContractProvenance
  /** Files the obligation is about (e.g. an owner file that must be touched). */
  readonly subjectFiles: readonly string[]
  /** Symbols the obligation is about (e.g. an API surface that must change). */
  readonly subjectSymbols: readonly string[]
}

/** A typed bundle of public contracts for one instance's clean selection. */
export interface PublicContractBundle {
  readonly contracts: readonly PublicContract[]
}

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
  readonly kind: PublicContractKind
  readonly strength: PublicContractStrength
  readonly satisfied: boolean
}
