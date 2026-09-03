import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { arch, hostname, platform, release } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { externalToolchainFingerprint } from "./external-toolchain"
import { isVerdictRelevantEnvKey, verdictDotenvSha256 } from "./verdict-env"

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
  if (candidate === undefined) return { ok: false, reason: "no receipt stored" }
  if (candidate === null) return { ok: false, reason: "receipt file is unreadable" }
  if (typeof candidate !== "object") {
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
    // ONE definition, shared with the shard receipt. They were written
    // separately and drifted: the shard layer keyed TZ and LANG, this one did
    // not, so `TZ=Asia/Seoul bun run prepush` reused a green minted under UTC
    // without running a single date- or locale-sensitive test.
    .filter(([key]) => isVerdictRelevantEnvKey(key))
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
  sha256(
    JSON.stringify([
      hashFiles(repoRoot, ["package.json", "bun.lock", "bun.lockb", "bunfig.toml"]),
      // Untracked dotenv files become environment INSIDE the test process, so
      // no amount of hashing THIS process's env can see them. See
      // `verdict-env.ts` for the 13 cases they were hiding.
      verdictDotenvSha256(repoRoot),
    ]),
  )

/**
 * An exact receipt skips EVERY gate, `contract` and `real-toolchain-e2e`
 * included — the two that shell out to docker / python / the language servers.
 * So the host's capability set is part of the receipt's identity: a box that
 * has since lost docker must not replay a green it can no longer earn, and one
 * that just gained pyright must not keep reusing a green that skipped it.
 * (Measured gap: the fingerprint was wired into the shard cache first and left
 * out of the receipt that actually does the skipping.)
 */
export const verificationToolchainSha256 = (
  externalTools: Record<string, string> = externalToolchainFingerprint(),
): string =>
  sha256(
    JSON.stringify({
      bun: Bun.version,
      node: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      host: hostname(),
      externalTools,
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

/**
 * `undefined` = no receipt stored. `null` = a file is there and could not be
 * read as JSON.
 *
 * The two used to collapse, and the message they collapsed into was
 * "receipt is not an object" — so the ordinary first-run state, and the state
 * after a receipt is deliberately destroyed, both read as corruption. That is
 * the wrong thing to hand someone at the top of a 45-minute run.
 */
export const readExactVerificationReceipt = (path: string): unknown => {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return null
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
