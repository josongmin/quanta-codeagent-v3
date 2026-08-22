/**
 * BFND-01 — benchmark-suite discriminator + typed `BenchRunConfig` union.
 *
 * The bench composition root resolves ONE typed config that nests the T2
 * `DatasetFamily` (owned by `./run-config`) under a top-level `benchmarkSuite`
 * axis. The two axes are ORTHOGONAL:
 *
 *   - `benchmarkSuite` = which benchmark ("swe-bench" | "terminal-bench").
 *     Terminal-Bench is a SUITE, not a dataset family.
 *   - `datasetFamily`  = which SWE dataset variant ("verified" | "live" | "pro").
 *     ProMax is a FUTURE dataset family (T4 registry), so it must NEVER appear
 *     in `BENCHMARK_SUITES`.
 *
 * The SWE branch NESTS the family so family selection stays T4-compatible
 * without leaking the family axis into the suite axis. The terminal branch
 * carries a `benchmarkVersion` and CANNOT carry a `datasetFamily` — by shape
 * (compile error) AND at runtime (the decoder refuses it).
 *
 * Import the canonical `DatasetFamily` from `./dataset-family`; do NOT repeat
 * the family union here. T2's `resolveBenchRunConfig` (`./run-config`) owns the
 * fail-closed family parse; this module wraps it under the suite discriminator.
 */
import type { DatasetFamily } from "./dataset-family"
import { knownDatasetFamilyTokens, normalizeDatasetFamilyToken } from "./dataset-family-token"
import {
  resolveBenchRunConfig as resolveSweRunConfig,
  type BenchRunConfig as SweBenchRunConfig,
} from "./run-config"

export type { SweBenchRunConfig }

/** Top-level benchmark discriminator. Terminal-Bench is a SUITE; ProMax is NOT
 *  (it is a future SWE `datasetFamily`) and must never appear here. */
export type BenchmarkSuite = "swe-bench" | "terminal-bench"

export const BENCHMARK_SUITES: readonly BenchmarkSuite[] = ["swe-bench", "terminal-bench"] as const

/** Type-guard / decoder-refusal predicate. `"promax"` is deliberately excluded:
 *  ProMax is a dataset family, not a suite. */
export const isBenchmarkSuite = (raw: unknown): raw is BenchmarkSuite =>
  typeof raw === "string" && (BENCHMARK_SUITES as readonly string[]).includes(raw)

/** Terminal-Bench branch config (versioned; carries NO datasetFamily). */
export interface TerminalBenchRunConfig {
  /** Harbor dataset ref (immutable-pinned). Optional at resolve time — the
   *  terminal command layer fills it; the discriminator is what BFND-02/03 key on. */
  readonly datasetRef?: string
  readonly profile?: string
  readonly sandbox?: string
  readonly k?: number
}

/** The ONE resolved config every bench command produces at the composition root.
 *  Discriminated on `benchmarkSuite`; the SWE branch nests the typed
 *  `datasetFamily` (and the full T2 `swe` config) so family selection is
 *  T4-compatible without leaking family into the suite axis. */
export type BenchRunConfig =
  | {
      readonly benchmarkSuite: "swe-bench"
      readonly datasetFamily: DatasetFamily
      readonly swe: SweBenchRunConfig
    }
  | {
      readonly benchmarkSuite: "terminal-bench"
      readonly benchmarkVersion: "2.1"
      readonly terminal: TerminalBenchRunConfig
    }

/** Map a CLI subcommand to its benchmark suite. `terminal` ⇒ terminal-bench;
 *  everything else (including a leading flag / absent) ⇒ swe-bench (byte-compat
 *  with the historical `index.ts --swebench …` entry). */
export const resolveSuiteFromSubcommand = (subcommand: string | undefined): BenchmarkSuite => {
  if (subcommand === "terminal") return "terminal-bench"
  return "swe-bench"
}

/** The presence of a family selector (argv flag OR env var). Used to REFUSE a
 *  family selector on the terminal branch, where the family axis does not exist. */
const familySelectorPresent = (input: {
  readonly argvFamily: string | undefined
  readonly env: NodeJS.ProcessEnv
}): boolean =>
  input.argvFamily !== undefined || input.env.QUANTA_SWEBENCH_DATASET_FAMILY !== undefined

/**
 * Resolve the ONE typed `BenchRunConfig` at the composition root — parse
 * subcommand → suite, then (SWE only) the fail-closed family EXACTLY ONCE.
 *
 * FROZEN rules:
 *  - subcommand `terminal` ⇒ terminal-bench/2.1; a family selector (argv OR env)
 *    on that branch THROWS (family is a SWE-only axis).
 *  - any other subcommand ⇒ swe-bench, delegating the fail-closed family parse
 *    to T2's `resolveBenchRunConfig`.
 *  - ABSENT family ⇒ verified (byte-identical legacy default);
 *    EXPLICIT-unknown/blank family ⇒ throw.
 */
export const resolveBenchmarkRunConfig = (input: {
  readonly subcommand: string | undefined
  readonly argvFamily: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly terminal?: TerminalBenchRunConfig
}): BenchRunConfig => {
  const suite = resolveSuiteFromSubcommand(input.subcommand)
  if (suite === "terminal-bench") {
    if (familySelectorPresent(input)) {
      throw new Error(
        "bench: --dataset-family / QUANTA_SWEBENCH_DATASET_FAMILY is a SWE-only axis and " +
          "is not accepted on the `terminal` subcommand (Terminal-Bench is a SUITE, not a " +
          "dataset family). Drop the family selector for terminal runs.",
      )
    }
    return {
      benchmarkSuite: "terminal-bench",
      benchmarkVersion: "2.1",
      terminal: input.terminal ?? {},
    }
  }
  const swe = resolveSweRunConfig({ argvFamily: input.argvFamily, env: input.env })
  return { benchmarkSuite: "swe-bench", datasetFamily: swe.datasetFamily, swe }
}

/**
 * The refusal for a non-suite `benchmarkSuite`.
 *
 * The most common way to get this wrong is to promote a dataset FAMILY to the
 * suite axis (`benchmarkSuite: "promax"` / `"pro"`). The hint asks the ONE token
 * registry instead of string-comparing a family literal, so it covers every
 * family — including ones added after this line was written — and this module
 * keeps zero knowledge of which families exist.
 */
const unknownSuiteError = (suite: unknown): Error => {
  const misplacedFamily = typeof suite === "string" ? normalizeDatasetFamilyToken(suite) : undefined
  return new Error(
    `bench: unknown benchmarkSuite "${String(suite)}". ` +
      `Expected one of ${BENCHMARK_SUITES.join(", ")}. ` +
      (misplacedFamily !== undefined
        ? `"${misplacedFamily}" is a SWE datasetFamily, NOT a suite — encode it as ` +
          `{ benchmarkSuite: 'swe-bench', datasetFamily: '${misplacedFamily}' }.`
        : "REFUSING to infer a suite from other fields."),
  )
}

/**
 * Runtime identity decoder — validate an already-serialized `BenchRunConfig`
 * object (e.g. one read from a report or a wire envelope) into the typed union,
 * refusing malformed identities:
 *  - unknown / non-suite `benchmarkSuite` (including `"promax"`) ⇒ throw.
 *  - a terminal identity carrying `datasetFamily` ⇒ throw (shape violation).
 *  - a swe identity missing/invalid `datasetFamily` ⇒ throw.
 * NO inference from other fields — the discriminator must be explicit.
 */
export const decodeBenchRunConfig = (raw: unknown): BenchRunConfig => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("bench: BenchRunConfig identity must be an object")
  }
  const obj = raw as Record<string, unknown>
  const suite = obj.benchmarkSuite
  if (!isBenchmarkSuite(suite)) throw unknownSuiteError(suite)
  if (suite === "terminal-bench") {
    if ("datasetFamily" in obj) {
      throw new Error(
        "bench: a terminal-bench identity must NOT carry a datasetFamily (family is a " +
          "SWE-only axis). REFUSING the malformed identity.",
      )
    }
    if (obj.benchmarkVersion !== "2.1") {
      throw new Error(
        `bench: terminal-bench identity requires benchmarkVersion "2.1" (got ${String(obj.benchmarkVersion)}).`,
      )
    }
    const terminal =
      typeof obj.terminal === "object" && obj.terminal !== null
        ? (obj.terminal as TerminalBenchRunConfig)
        : {}
    return { benchmarkSuite: "terminal-bench", benchmarkVersion: "2.1", terminal }
  }
  // swe-bench — the datasetFamily discriminator must be an EXPLICIT valid family.
  //
  // aug-22 re-audit R5: this used to pass a non-string `datasetFamily` through as
  // `argvFamily: undefined`, which is the ABSENT-selector spelling — so a decoded
  // identity with `datasetFamily: 42`, `null`, or the key missing entirely came
  // back as a clean `verified` config. That is the exact silent-Verified fallback
  // the doc block above forbids ("a swe identity missing/invalid `datasetFamily`
  // ⇒ throw", "NO inference from other fields"), and it is the failure direction
  // that mis-grades: a Pro report whose family field was dropped or corrupted in
  // transit decodes as Verified instead of failing loudly. A decoder has no
  // operator to have "omitted the flag" — absent IS malformed here. Explicit
  // string tokens (including blank / unknown) still go to the fail-closed parser,
  // which owns the token-level error message.
  const family = obj.datasetFamily
  if (typeof family !== "string") {
    throw new Error(
      `bench: a swe-bench identity requires an explicit string datasetFamily (got ${
        family === undefined ? "no datasetFamily key" : `${typeof family} ${String(family)}`
      }). ` +
        `Expected one of ${knownDatasetFamilyTokens().join(", ")}. ` +
        "REFUSING to decode it as Verified — an identity that lost its family must fail, " +
        "not silently name the default.",
    )
  }
  const swe = resolveSweRunConfig({ argvFamily: family, env: {} })
  return { benchmarkSuite: "swe-bench", datasetFamily: swe.datasetFamily, swe }
}
