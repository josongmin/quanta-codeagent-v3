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

const applyNamedOption = (state: MutableRunnerOptions, arg: string): boolean => {
  const cacheMode = cacheModeOption(arg)
  if (cacheMode !== undefined) state.cacheMode = cacheMode
  const suite = suiteOption(arg)
  if (suite !== undefined) state.suite = suite
  const tier = tierOption(arg)
  if (tier !== undefined) state.tier = tier
  const junitOut = junitOption(arg)
  if (junitOut !== undefined) state.junitOut = junitOut
  return (
    cacheMode !== undefined || suite !== undefined || tier !== undefined || junitOut !== undefined
  )
}

export const parseShardRunnerOptions = (args: readonly string[]): RunnerOptions => {
  const state: MutableRunnerOptions = {
    suite: "full",
    discoverOnly: false,
    cacheMode: envCacheMode(),
  }
  if (process.env.QUANTA_VERIFICATION_TIER !== undefined) {
    state.tier = shardTier(process.env.QUANTA_VERIFICATION_TIER)
  }
  for (const arg of args) {
    if (arg === "--parallel=1") continue
    if (arg === "--discover-only") {
      state.discoverOnly = true
      continue
    }
    if (applyNamedOption(state, arg)) continue
    throw new Error(`unknown shard runner argument: ${arg}`)
  }
  if (state.junitOut !== undefined && state.suite !== "unit" && state.suite !== "full") {
    throw new Error("JUnit shard receipts are reserved for --suite=unit or --suite=full")
  }
  return state
}
