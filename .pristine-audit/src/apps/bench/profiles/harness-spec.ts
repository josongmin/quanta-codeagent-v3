/**
 * LEAF — the family-AGNOSTIC swebench harness-build primitives the per-family
 * profiles compose into their `harnessSpec` port.
 *
 * aug-22 HIGH-4: these bodies used to live in `remote/box-session/ec2-lifecycle.ts`
 * (a CONSUMER) as `isLiveRun` / `resolveSwebenchPipSpec` / `resolveSwebenchNamespace`,
 * each carrying its OWN raw `family === "live"` compare, and the profile registry
 * imported them BACK from that consumer — an inverted dependency that left the
 * remote-env port with zero production consumers. The family decision now lives
 * in the profile (`LIVE_PROFILE` passes `liveHarness: true`); what remains here
 * is pure data + a dataset-NAME heuristic with no notion of a family at all.
 *
 * Leaf by construction: NO imports.
 */

/** Stock PyPI harness — knows the ORIGINAL SWE-bench repos only. */
export const STOCK_PIP_SPEC = "swebench"
/** The SWE-bench-Live fork — registers the Live repos, so `make_test_spec` does
 *  not KeyError on e.g. `conan-io/conan`. */
export const LIVE_PIP_SPEC = "git+https://github.com/SWE-bench-Live/SWE-bench-Live"
/** Default DockerHub org publishing prebuilt images. */
export const STOCK_NAMESPACE = "swebench"
/** SWE-bench-Live publishes its prebuilt images here, NOT under `swebench`. */
export const LIVE_NAMESPACE = "starryzhang"

/**
 * RFC jun-29 — is this dataset NAME a SWE-bench-Live one? Case-insensitive +
 * tolerant of the common spellings (canonical HF id `SWE-bench-Live/SWE-bench-Live`,
 * plus `swebench-live` / `swe_bench_live` for local JSONL paths). The earlier exact
 * `includes("SWE-bench-Live")` silently fell back to stock on any case/spelling
 * drift → KeyError counted as a model miss (the worst failure direction).
 * Verified/Pro names never contain "live", so no false-positive. The trailing
 * `(?![a-z])` blocks the `…liveness…` substring false-positive (audit r2 a).
 *
 * NOTE this is a DATASET-NAME heuristic, not a family decision: it exists because
 * a Verified-family run pointed at a Live dataset name must still pull the fork.
 */
export const isLiveDataset = (datasetName: string): boolean =>
  /swe[-_]?bench[-_]live(?![a-z])/i.test(datasetName)

/**
 * Resolve the pip-spec + image namespace for a family whose harness is either the
 * stock build or the Live fork. `liveHarness` is the PROFILE's own answer (the
 * Live profile passes `true`); the dataset-name heuristic still forces the fork
 * for a stock-family run aimed at a Live dataset name. Explicit operator
 * overrides win over both, unchanged.
 */
export const stockOrLiveHarnessSpec = (
  liveHarness: boolean,
  input: {
    readonly datasetName: string
    readonly pipSpecOverride?: string | undefined
    readonly namespaceOverride?: string | undefined
  },
): { readonly pipSpec: string; readonly namespace: string } => {
  const live = liveHarness || isLiveDataset(input.datasetName)
  return {
    pipSpec: input.pipSpecOverride ?? (live ? LIVE_PIP_SPEC : STOCK_PIP_SPEC),
    namespace: input.namespaceOverride ?? (live ? LIVE_NAMESPACE : STOCK_NAMESPACE),
  }
}
