/**
 * PMX-00 — the FROZEN v1 upstream snapshot, re-verified against live upstream
 * at implementation start (2026-08-22) as the ticket's stop rule demands.
 *
 * Verification performed on 2026-08-22 by fetching, outside the source tree,
 * `~/.quanta/bench/promax-upstream/<commit>/`:
 *  - GitHub blobs at the pinned commit, hashed with sha256;
 *  - the Hugging Face data files at the pinned revision, hashed the same way;
 *  - both parsed to recount ids, compare the two id sets, recompute the set
 *    digest, and recount languages.
 * Every field below reproduced the value recorded in the packet README, and at
 * that moment BOTH `main` (GitHub) and the HF default revision still pointed at
 * the pinned commits — i.e. no drift, no in-place hash refresh was performed.
 *
 * These are FROZEN campaign constants, not "current upstream". Upstream is
 * actively maintained and advertises a v2; when v2 is adopted it gets its OWN
 * snapshot record and an explicit approval, and this one stays readable so old
 * campaign reports keep meaning what they said.
 *
 * NOT stored in git: the dataset, the eval metadata, the evaluator, and every
 * gold-bearing byte they contain. Only this identity record and the manifest
 * schema live here.
 */

/** An immutable, independently re-verified upstream identity record. */
export interface ProMaxFrozenSnapshot {
  readonly label: string
  readonly upstream_repo_url: string
  readonly upstream_git_commit: string
  readonly hf_repo_id: string
  readonly hf_dataset_revision: string
  readonly dataset_sha256: string
  readonly eval_sha256: string
  readonly evaluator_sha256: string
  readonly dataset_count: number
  readonly ids_sha256: string
  readonly language_counts: Readonly<Record<string, number>>
}

/**
 * `v1` — SWE-Bench-ProMax 170. Dataset and eval id sets are exactly equal and
 * the GitHub and Hugging Face data files are byte-identical at this snapshot
 * (their sha256s are the same value, which is what makes the cross-source
 * equality check meaningful rather than decorative).
 */
export const PROMAX_V1_SNAPSHOT: ProMaxFrozenSnapshot = Object.freeze({
  label: "promax-v1-170",
  upstream_repo_url: "https://github.com/key4127/SWE-Bench-ProMax",
  upstream_git_commit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  hf_repo_id: "swe-bench-promax/SWE-Bench-ProMax",
  hf_dataset_revision: "8ee33ee5321b3572cc6c20e3a2392f04683174b2",
  dataset_sha256: "f1f084836da779f58fe4150fb786d22c54d0f848d232dd3106aeff4b2dfcc7e9",
  eval_sha256: "5730a8003ebb7b720b3c6580d54d0c7c1b5a50970b771f4a3850144aaeb74bbf",
  evaluator_sha256: "af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d",
  dataset_count: 170,
  ids_sha256: "19944e595bcace14b7dd77a341367dc6b93f2d40758854472c50ba6c1adad8ff",
  language_counts: Object.freeze({
    c: 20,
    "c++": 22,
    go: 23,
    java: 26,
    python: 29,
    rust: 22,
    typescript: 28,
  }),
})

/**
 * Upstream paths of the three files a bundle is built from, at the frozen
 * commit. Recorded so the operator tool never has to guess a layout.
 */
export const PROMAX_V1_UPSTREAM_PATHS = Object.freeze({
  dataset: "data/swe-bench-promax.json",
  evalMeta: "data/eval.json",
  evaluator: "src/evaluation/test_run.py",
})
