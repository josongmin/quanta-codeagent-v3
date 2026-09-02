import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { arch, hostname, platform, release } from "node:os"
import { delimiter, dirname, join } from "node:path"

export const EXACT_RECEIPT_SCHEMA = "quanta.exact-verification-receipt.v1" as const
export const DEFAULT_RECEIPT_TTL_MS = 6 * 60 * 60_000

export interface VerificationContext {
  readonly head: string
  readonly statusSha256: string
  readonly manifestSha256: string
  readonly dependencySha256: string
  readonly toolchainSha256: string
  readonly environmentSha256: string
}

export interface ExactVerificationReceipt extends VerificationContext {
  readonly schema: typeof EXACT_RECEIPT_SCHEMA
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}

export type ReceiptValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

export const cleanStatusSha256 = sha256("")

export const mintExactVerificationReceipt = (
  context: VerificationContext,
  issuedAtMs = Date.now(),
  ttlMs = DEFAULT_RECEIPT_TTL_MS,
): ExactVerificationReceipt => ({
  schema: EXACT_RECEIPT_SCHEMA,
  ...context,
  issuedAtMs,
  expiresAtMs: issuedAtMs + ttlMs,
})

const contextFields = [
  "head",
  "statusSha256",
  "manifestSha256",
  "dependencySha256",
  "toolchainSha256",
  "environmentSha256",
] as const

export const validateExactVerificationReceipt = (
  candidate: unknown,
  current: VerificationContext,
  nowMs = Date.now(),
): ReceiptValidation => {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "receipt is not an object" }
  }
  const receipt = candidate as Partial<ExactVerificationReceipt>
  if (receipt.schema !== EXACT_RECEIPT_SCHEMA)
    return { ok: false, reason: "receipt schema mismatch" }
  if (!Number.isFinite(receipt.issuedAtMs) || !Number.isFinite(receipt.expiresAtMs)) {
    return { ok: false, reason: "receipt timestamps are invalid" }
  }
  if ((receipt.expiresAtMs ?? 0) < nowMs) return { ok: false, reason: "receipt expired" }
  if ((receipt.issuedAtMs ?? Number.POSITIVE_INFINITY) > nowMs + 60_000) {
    return { ok: false, reason: "receipt issued in the future" }
  }
  for (const field of contextFields) {
    if (receipt[field] !== current[field]) return { ok: false, reason: `${field} mismatch` }
  }
  if (receipt.statusSha256 !== cleanStatusSha256) {
    return { ok: false, reason: "receipt describes a dirty checkout" }
  }
  return { ok: true }
}

const hashFiles = (repoRoot: string, paths: readonly string[]): string => {
  const hash = createHash("sha256")
  for (const path of paths) {
    const absolute = join(repoRoot, path)
    hash.update(`${path}\0`)
    hash.update(existsSync(absolute) ? readFileSync(absolute) : Buffer.from("<missing>"))
    hash.update("\0")
  }
  return hash.digest("hex")
}

const canonicalPath = (value: string): string => {
  const seen = new Set<string>()
  return value
    .split(delimiter)
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
    .join(delimiter)
}

const relevantEnvironment = (env: NodeJS.ProcessEnv): readonly [string, string][] =>
  Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(
      ([key]) =>
        key === "CI" ||
        key === "NODE_ENV" ||
        key === "PATH" ||
        key === "REQUIRE_CONTRACT" ||
        key.startsWith("BUN_") ||
        key.startsWith("QUANTA_"),
    )
    .filter(([key]) => !key.startsWith("QUANTA_VERIFICATION_LEASE_"))
    // `bun run` prepends its node_modules/.bin search chain on every nesting
    // level, even when those exact entries already lead PATH. Duplicate PATH
    // entries are semantically inert, but hashing their raw spelling made the
    // inner gate's receipt impossible to reuse in the outer pre-lease probe.
    // Preserve first-occurrence order so a real search-order/path change still
    // invalidates the receipt.
    .map(([key, value]): [string, string] => [key, key === "PATH" ? canonicalPath(value) : value])
    .sort(([left], [right]) => left.localeCompare(right)) as [string, string][]

export const verificationDependencySha256 = (repoRoot: string): string =>
  hashFiles(repoRoot, ["package.json", "bun.lock", "bun.lockb", "bunfig.toml"])

export const verificationToolchainSha256 = (): string =>
  sha256(
    JSON.stringify({
      bun: Bun.version,
      node: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      host: hostname(),
    }),
  )

export const verificationEnvironmentSha256 = (env: NodeJS.ProcessEnv = process.env): string =>
  sha256(JSON.stringify(relevantEnvironment(env)))

const commonDirByRoot = new Map<string, string | undefined>()

const gitCommonDir = (repoRoot: string): string | undefined => {
  if (commonDirByRoot.has(repoRoot)) return commonDirByRoot.get(repoRoot)
  const result = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const dir = result.exitCode === 0 ? result.stdout.toString().trim() : ""
  const resolved = dir === "" ? undefined : dir
  commonDirByRoot.set(repoRoot, resolved)
  return resolved
}

/**
 * One cache root for every worktree of this repository: verification receipts
 * and shard results are keyed by exact HEAD + content + toolchain, so a green
 * minted in ANY checkout is valid for every other checkout at the same state.
 * With per-worktree .cache directories, 21 worktrees each re-verified the same
 * commit from scratch. Falls back to the checkout-local .cache outside Git.
 */
export const sharedVerificationCacheRoot = (repoRoot: string): string => {
  const common = gitCommonDir(repoRoot)
  return common === undefined
    ? join(repoRoot, ".cache", "verification")
    : join(common, "quanta-verification-cache")
}

export const verificationReceiptPath = (repoRoot: string): string =>
  join(sharedVerificationCacheRoot(repoRoot), "prepush-exact-v1.json")

export const readExactVerificationReceipt = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

export const writeExactVerificationReceipt = (
  path: string,
  receipt: ExactVerificationReceipt,
): void => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
