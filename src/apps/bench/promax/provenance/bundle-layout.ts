/**
 * PMX-00 — the ONE on-disk shape of a frozen ProMax bundle.
 *
 * Names are fixed so a bundle directory is self-describing. This lives in the
 * provenance owner (not in the operator tool) because two different consumers
 * now depend on it: `verify-bundle` READS this layout, and the assembler WRITES
 * it. A second spelling of "dataset.json" in either one would let an assembled
 * bundle drift out of the shape the validator consumes — which is exactly the
 * hand-copy hazard the assembler exists to remove.
 *
 * `tools/bench-promax/verify-bundle.ts` re-exports this as `BUNDLE_FILES`.
 */
import { join } from "node:path"

export const PROMAX_BUNDLE_FILES = Object.freeze({
  manifest: "manifest.json",
  dataset: "dataset.json",
  evalMeta: "eval.json",
  evaluator: "evaluator.py",
  hfDataset: join("hf", "dataset.json"),
  hfEvalMeta: join("hf", "eval.json"),
})

/** Every file a bundle directory contains. Closed — see `assemble.ts`. */
export type ProMaxBundleFileKey = keyof typeof PROMAX_BUNDLE_FILES

export const PROMAX_BUNDLE_FILE_KEYS = Object.keys(
  PROMAX_BUNDLE_FILES,
) as readonly ProMaxBundleFileKey[]
