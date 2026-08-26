/**
 * The feature catalog's on-disk locations, anchored on THIS FILE.
 *
 * Every consumer previously declared its own copy:
 *
 * ```ts
 * const FEATURES_DIR = "tools/feature-catalog/features"   // cli.ts, surface-derive.ts, pm/check.ts
 * ```
 *
 * Three copies of a cwd-relative literal, passed explicitly at ten call sites in
 * `cli.ts` alone — which is why anchoring `loadFeaturesStrict`'s DEFAULT in an
 * earlier pass changed nothing. Run from anywhere but the repo root they resolved
 * to nothing, and "no features loaded" reads as a clean catalog to every caller:
 * `validate --strict` reported `0 feature(s), all evidence resolved` and exited 0.
 *
 * `import.meta.dir` is a property of this module, so it cannot drift with the
 * process. These are the only paths the catalog tooling may use.
 */

import { isAbsolute, join } from "node:path"

const HERE = import.meta.dir

/** The repo root this module lives in: `<root>/tools/feature-catalog/paths.ts`. */
export const REPO_ROOT = join(HERE, "..", "..")

/**
 * The catalog's paths under an arbitrary repo root.
 *
 * Exists so a TEST can point the tooling at a fixture tree without going through
 * the ambient cwd — which is how `feature-catalog-evidence-existence-hellgate`
 * used to inject its fixture, and the reason a cwd-anchored CLI looked necessary.
 * The root must be ABSOLUTE, so an override cannot reintroduce the defect.
 */
export const catalogPathsFor = (
  root: string,
): { featuresDir: string; proseDir: string; baselinePath: string } => {
  if (!isAbsolute(root)) {
    throw new Error(`feature catalog: repo root "${root}" is relative — pass an absolute path.`)
  }
  const base = join(root, "tools", "feature-catalog")
  return {
    featuresDir: join(base, "features"),
    proseDir: join(base, "prose"),
    baselinePath: join(base, "baseline.json"),
  }
}

/** `tools/feature-catalog/features` — the YAML catalog itself. */
export const FEATURES_DIR = join(HERE, "features")

/** `tools/feature-catalog/prose` — long-form sections merged into the render. */
export const PROSE_DIR = join(HERE, "prose")

/** `tools/feature-catalog/baseline.json` — the grandfathered-debt ledger. */
export const BASELINE_PATH = join(HERE, "baseline.json")
