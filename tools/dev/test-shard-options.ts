import { isSuiteName, type SuiteName } from "./test-shard-discovery"
import type { CacheMode } from "./verification-execution-policy"

export type { CacheMode, SuiteName }

export interface RunnerOptions {
  readonly suite: SuiteName
  readonly junitOut?: string
  readonly discoverOnly: boolean
  readonly cacheMode: CacheMode
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

export const parseShardRunnerOptions = (args: readonly string[]): RunnerOptions => {
  let suite: SuiteName = "full"
  let junitOut: string | undefined
  let discoverOnly = false
  let cacheMode = envCacheMode()
  for (const arg of args) {
    if (arg === "--parallel=1") continue
    if (arg === "--discover-only") {
      discoverOnly = true
      continue
    }
    const selectedCache = cacheModeOption(arg)
    if (selectedCache !== undefined) {
      cacheMode = selectedCache
      continue
    }
    const selectedSuite = suiteOption(arg)
    if (selectedSuite !== undefined) {
      suite = selectedSuite
      continue
    }
    const selectedJunit = junitOption(arg)
    if (selectedJunit !== undefined) {
      junitOut = selectedJunit
      continue
    }
    throw new Error(`unknown shard runner argument: ${arg}`)
  }
  if (junitOut !== undefined && suite !== "unit" && suite !== "full") {
    throw new Error("JUnit shard receipts are reserved for --suite=unit or --suite=full")
  }
  return junitOut === undefined
    ? { suite, discoverOnly, cacheMode }
    : { suite, junitOut, discoverOnly, cacheMode }
}
