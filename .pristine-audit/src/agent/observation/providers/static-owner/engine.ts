/**
 * static-owner ENGINE seam (jul-6 S2). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (프로바이더 카탈로그 —
 * `static-owner` / semantica def-use).
 *
 * This is the ADAPTER PORT the `staticOwnerProvider` reasons over: a def-use /
 * AST engine that, given the issue text + the repo file tree, returns the
 * locations its static analysis implicates as OWNERS of the bug, each with the
 * concrete def-use BASIS and an ORDINAL strength.
 *
 * Deliverable here = the SEAM + a deterministic FAKE. Real semantica is wired
 * behind this interface by main (S2 return note) — NOT integrated here.
 *
 * HARD invariants (audit-derived — the fake is the reference contract):
 *   - NO numeric confidence. Strength is the ordinal `EvidenceStrength` enum.
 *     Static engines do not emit calibrated probabilities.
 *   - NO fabricated paths. `owners()` MUST only return files present in the
 *     query's `repoFiles` — the fake enforces this fence itself so a
 *     mis-configured fixture cannot leak a path, and main's real engine MUST
 *     honour the same contract.
 *   - DETERMINISTIC. Same query ⇒ identical, order-stable facts (replay-safe).
 *   - PURE leaf: no @/llm, no IO, no env.
 */

import type { EvidenceStrength } from "../../fragment"

/** One def-use / AST fact the engine implicates. `basis` is the OBSERVED
 *  evidence sentence (e.g. the def-use edge), never an assertion of ownership.
 *  `strength` is ordinal — NEVER a number. */
export interface StaticOwnerFact {
  readonly file: string
  readonly symbol?: string
  /** The concrete static-analysis basis (def-use edge / raise site / caller). */
  readonly basis: string
  readonly strength: EvidenceStrength
}

/** What the engine is asked. Plain, leak-safe: only the public issue text + the
 *  repo file tree (the fence for path validity) + the language. */
export interface StaticOwnerQuery {
  readonly issueText: string
  readonly repoFiles: readonly string[]
  readonly language?: string
}

/** The def-use/AST engine seam. Real semantica implements this; the fake is the
 *  deterministic reference used in tests. */
export interface StaticOwnerEngine {
  /** Pure predicate: does the engine analyse this language? Exact match — the
   *  provider's `applicable` gate relies on this being side-effect-free. */
  supportsLanguage(language: string): boolean
  /** Deterministic def-use facts for the query. MUST NOT return a file absent
   *  from `query.repoFiles` (hallucination fence). Empty ⇒ no signal. */
  owners(query: StaticOwnerQuery): readonly StaticOwnerFact[]
}

/** Configuration for the deterministic fake. `facts` is the fixture the fake
 *  would "discover"; the fake still FENCES them against the query's repoFiles
 *  (a fact whose file is not in the tree is dropped — the fence is code, not a
 *  promise the fixture must keep). */
export interface FakeStaticOwnerConfig {
  readonly languages: readonly string[]
  readonly facts: readonly StaticOwnerFact[]
}

/**
 * Build a deterministic fake engine. It returns exactly the configured facts,
 * in configured order, INTERSECTED with the query's `repoFiles` — so it can
 * never surface a path the caller didn't already know about. This mirrors the
 * contract real semantica must satisfy (its owners come from resolved AST nodes,
 * which are by construction files in the checkout).
 */
export const makeFakeStaticOwnerEngine = (config: FakeStaticOwnerConfig): StaticOwnerEngine => {
  const langs = new Set(config.languages)
  return {
    supportsLanguage: (language: string): boolean => langs.has(language),
    owners: (query: StaticOwnerQuery): readonly StaticOwnerFact[] => {
      const inTree = new Set(query.repoFiles)
      // Fence: drop any fact whose file is not in the query tree. Order-stable.
      return config.facts.filter((f) => inTree.has(f.file))
    },
  }
}
