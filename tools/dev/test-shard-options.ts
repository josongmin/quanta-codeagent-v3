import { isSuiteName, type SuiteName } from "./test-shard-discovery"
import type { CacheMode } from "./verification-execution-policy"
import { assertKnownTier, type VerificationTier } from "./verification-tier"

export type { CacheMode, SuiteName }

export interface RunnerOptions {
  readonly suite: SuiteName
  readonly tier?: Exclude<VerificationTier, "smoke">
  readonly junitOut?: string
  readonly discoverOnly: boolean
  readonly cacheMode: CacheMode
}

const shardTier = (value: string): Exclude<VerificationTier, "smoke"> => {
  const tier = assertKnownTier(value)
  if (tier === "smoke") throw new Error("smoke is not a shard-runner tier")
  return tier
}

const tierOption = (arg: string): Exclude<VerificationTier, "smoke"> | undefined => {
  if (!arg.startsWith("--tier=")) return undefined
  return shardTier(arg.slice("--tier=".length))
}

const suiteOption = (arg: string): SuiteName | undefined => {
  if (!arg.startsWith("--suite=")) return undefined
  const candidate = arg.slice("--suite=".length)
  if (!isSuiteName(candidate)) throw new Error(`unknown shard suite: ${candidate}`)
  return candidate
}

const junitOption = (arg: string): string | undefined => {
  if (!arg.startsWith("--junit-out=")) return undefined
  const candidate = arg.slice("--junit-out=".length)
  if (!candidate.startsWith(".cache/") || candidate.includes("..")) {
    throw new Error("--junit-out must be a safe .cache/ path")
  }
  return candidate
}

const cacheModeOption = (arg: string): CacheMode | undefined => {
  if (!arg.startsWith("--cache=")) return undefined
  const candidate = arg.slice("--cache=".length)
  if (candidate !== "off" && candidate !== "read-write") {
    throw new Error(`unknown cache mode: ${candidate}`)
  }
  return candidate
}

const envCacheMode = (): CacheMode =>
  process.env.QUANTA_TEST_CACHE === "off" ? "off" : "read-write"

interface MutableRunnerOptions {
  suite: SuiteName
  tier?: Exclude<VerificationTier, "smoke">
  junitOut?: string
  discoverOnly: boolean
  cacheMode: CacheMode
}

/**
 * The option name this argument sets, or `undefined` when it sets none.
 *
 * Returned so the caller can refuse a REPEAT. The parser already refuses
 * `--tier` contradicting `QUANTA_VERIFICATION_TIER` with "refusing to pick one
 * silently" — and then picked one silently when the contradiction was between
 * two flags on the SAME command line. Measured: `--tier=pr --tier=nightly`
 * discovered the nightly population (3,965 files) and printed
 * `"name": "full:nightly"`, while `--suite=unit --suite=full` ran the full
 * suite. Last-one-wins is exactly the "a command string means two different
 * runs" failure the env cross-check exists to close.
 */
const applyNamedOption = (
  state: MutableRunnerOptions,
  arg: string,
  onFlagTier: (tier: Exclude<VerificationTier, "smoke">) => void,
): "cache" | "suite" | "tier" | "junit-out" | undefined => {
  const cacheMode = cacheModeOption(arg)
  if (cacheMode !== undefined) {
    state.cacheMode = cacheMode
    return "cache"
  }
  const suite = suiteOption(arg)
  if (suite !== undefined) {
    state.suite = suite
    return "suite"
  }
  const tier = tierOption(arg)
  if (tier !== undefined) {
    state.tier = tier
    onFlagTier(tier)
    return "tier"
  }
  const junitOut = junitOption(arg)
  if (junitOut !== undefined) {
    state.junitOut = junitOut
    return "junit-out"
  }
  return undefined
}

/** Refuse a second value for one option, naming both. */
const recordOptionOnce = (seen: Map<string, string>, option: string, arg: string): void => {
  const first = seen.get(option)
  if (first !== undefined) {
    throw new Error(
      `[test:shards] --${option} given twice (${first}, then ${arg}); refusing to pick one ` +
        "silently. Two values for one option make a command string mean two different runs, " +
        "and the last one quietly won.",
    )
  }
  seen.set(option, arg)
}

export const parseShardRunnerOptions = (args: readonly string[]): RunnerOptions => {
  const state: MutableRunnerOptions = {
    suite: "full",
    discoverOnly: false,
    cacheMode: envCacheMode(),
  }
  // The env is a source AND a cross-check, never a silent default. `--tier`
  // and `QUANTA_VERIFICATION_TIER` disagreeing means the caller believes one
  // population and the gate arranged another; picking either silently is how a
  // command string comes to mean two different runs.
  const envTier =
    process.env.QUANTA_VERIFICATION_TIER === undefined
      ? undefined
      : shardTier(process.env.QUANTA_VERIFICATION_TIER)
  if (envTier !== undefined) state.tier = envTier
  let flagTier: Exclude<VerificationTier, "smoke"> | undefined
  /** Which value-bearing options were already given, and with what argument. */
  const seen = new Map<string, string>()
  for (const arg of args) {
    // `--parallel=<N>` is a REAL `bun test` flag (N worker processes, implies
    // --isolate), and three package scripts passed `--parallel=1` to this
    // runner believing it meant "serial". This runner swallowed it silently and
    // then chose its own intra-worker width — up to 8-wide for `pure` chunks.
    // So the command read as serial-isolated and executed as nothing of the
    // kind. Rejected rather than re-accepted: the shard runner's concurrency is
    // a scheduling decision made per dispatch from the CPU/memory budget, not a
    // caller argument, and an argument that silently means nothing is worse
    // than one that is refused.
    if (arg.startsWith("--parallel=") || arg === "--parallel") {
      throw new Error(
        `[test:shards] ${arg} is not a shard-runner option. It is a \`bun test\` flag and was ` +
          "accepted here as a silent no-op while the runner chose its own intra-worker width. " +
          "The shard runner derives concurrency per dispatch from the host CPU/memory budget.",
      )
    }
    if (arg === "--discover-only") {
      state.discoverOnly = true
      continue
    }
    const named = applyNamedOption(state, arg, (tier) => {
      flagTier = tier
    })
    if (named !== undefined) {
      recordOptionOnce(seen, named, arg)
      continue
    }
    throw new Error(`unknown shard runner argument: ${arg}`)
  }
  if (state.junitOut !== undefined && state.suite !== "unit" && state.suite !== "full") {
    throw new Error("JUnit shard receipts are reserved for --suite=unit or --suite=full")
  }
  // TVH item 7. An absent tier used to select the ENTIRE discovered universe:
  // measured on this tree, `--suite=full` with no tier runs 3,965 files where
  // `--tier=full` runs 3,951. So `bun test` and `bun run test:full:ci` ran the
  // NIGHTLY population by omission, and which population a command ran depended
  // on whether an ambient `QUANTA_VERIFICATION_TIER` happened to be set by
  // whoever invoked it. Two runs of the same command string, two different
  // meanings, and no receipt anywhere said which.
  if (state.tier === undefined) {
    throw new Error(
      "[test:shards] --tier is required: an absent tier selected the whole universe " +
        "(the nightly population) by omission. Pass --tier=prepush|pr|full|nightly, or run " +
        "through a gate that sets QUANTA_VERIFICATION_TIER.",
    )
  }
  if (flagTier !== undefined && envTier !== undefined && flagTier !== envTier) {
    throw new Error(
      `[test:shards] --tier=${flagTier} contradicts QUANTA_VERIFICATION_TIER=${envTier}; ` +
        "refusing to pick one silently",
    )
  }
  return state
}
