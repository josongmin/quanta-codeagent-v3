/**
 * Multi-Auth Fleet (jun-20) — T-7 bench account login.
 *
 * The fleet CONSUMES per-account `chatgpt.json` files but nothing PRODUCED the
 * extra ones — you had to log in once, copy the file, log in again, copy again.
 * This closes the loop: `quanta-bench auth login --auth-label acct-b` runs the
 * SAME ChatGPT OAuth flow the main CLI's `/login` uses, writes the token to a
 * per-label path, and auto-registers the account in the pool manifest.
 *
 * The whole flow is dependency-injected (fetch / browser-callback / fs) so it is
 * driven end-to-end in tests with no real browser or issuer — mirroring the
 * `buildLoginCmd` test seam.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  exchangeCode,
  type FetchLike,
  isClientIdConfigured,
  type OAuthCallbackProvider,
  resolveOAuthConfig,
  resolveQuantaHome,
  runBrowserFlow,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { parseAuthPoolManifest } from "./load"
import type { AuthPoolEntry } from "./types"

/** Default per-account slot budget when the operator doesn't pass `--max-parallel`. */
export const DEFAULT_LOGIN_MAX_PARALLEL = 6

const sanitizeLabel = (label: string): string => label.replace(/[^A-Za-z0-9_-]+/g, "_")

/** Per-label credential path: `<quantaHome>/auth/chatgpt-<label>.json`. Distinct
 *  from the single-account default so accounts never clobber each other. */
export const benchAccountAuthFile = (env: Record<string, string | undefined>, label: string): string =>
  join(resolveQuantaHome(env), "auth", `chatgpt-${sanitizeLabel(label)}.json`)

/** Default manifest the fleet auto-builds when no `--auth-pool` is given. */
export const defaultBenchManifestPath = (env: Record<string, string | undefined>): string =>
  join(resolveQuantaHome(env), "auth", "bench-pool.yaml")

export interface BenchLoginOpts {
  readonly label: string
  /** Explicit token path override (else the per-label default). */
  readonly authFile?: string
  /** Manifest to register into (else {@link defaultBenchManifestPath}). */
  readonly manifestPath?: string
  readonly maxParallel?: number
}

export interface BenchLoginDeps {
  readonly env: Record<string, string | undefined>
  readonly fetchImpl?: FetchLike
  readonly opener?: (url: string) => void
  readonly callbackProvider?: OAuthCallbackProvider
  readonly nowMs?: () => number
  readonly timeoutMs?: number
  readonly onLog?: (m: string) => void
  /** fs seams (default node fs) for offline tests. */
  readonly writeTokenImpl?: (path: string, rec: TokenRecord) => Promise<void>
  readonly readFileImpl?: (path: string) => string
  readonly writeFileImpl?: (path: string, text: string) => void
}

export interface BenchLoginResult {
  readonly label: string
  readonly authFile: string
  readonly plan: string
  readonly accountId?: string
  readonly manifestPath: string
  /** True when the account was ADDED to the manifest (false ⇒ already present,
   *  i.e. a token refresh that left the roster unchanged). */
  readonly manifestAdded: boolean
  readonly accountCount: number
}

/** snake_case manifest serialization (the operator-facing convention). */
const toManifestEntry = (e: AuthPoolEntry): Record<string, unknown> => ({
  label: e.label,
  auth_file: e.authFile,
  max_parallel: e.maxParallel,
  ...(e.maxBoxes !== undefined ? { max_boxes: e.maxBoxes } : {}),
  ...(e.cooldownBaseSec !== undefined ? { cooldown_base_sec: e.cooldownBaseSec } : {}),
  ...(e.weight !== undefined ? { weight: e.weight } : {}),
  ...(e.disabled !== undefined ? { disabled: e.disabled } : {}),
})

const readExistingAccounts = (
  manifestPath: string,
  readFile: (p: string) => string,
): readonly AuthPoolEntry[] => {
  let text: string
  try {
    text = readFile(manifestPath)
  } catch {
    return [] // absent ⇒ fresh manifest
  }
  if (text.trim() === "") return []
  // Parse errors propagate — we must NOT silently wipe a malformed manifest.
  const src = parseAuthPoolManifest(text)
  return src.kind === "pool" ? src.accounts : []
}

/**
 * Add (or no-op confirm) the account in the manifest. Throws if the label already
 * exists but points at a DIFFERENT auth file (ambiguous — operator must resolve).
 */
const registerAccount = (
  manifestPath: string,
  entry: AuthPoolEntry,
  deps: BenchLoginDeps,
): { added: boolean; count: number } => {
  const readFile = deps.readFileImpl ?? ((p) => readFileSync(p, "utf8"))
  const writeFile = deps.writeFileImpl ?? ((p, t) => writeFileSync(p, t))
  const existing = readExistingAccounts(manifestPath, readFile)
  const prior = existing.find((a) => a.label === entry.label)
  if (prior !== undefined) {
    if (prior.authFile !== entry.authFile) {
      throw new Error(
        `auth-pool: account "${entry.label}" already in ${manifestPath} with a different auth_file ` +
          `(${prior.authFile}). Pass --auth-file to match, or edit the manifest.`,
      )
    }
    return { added: false, count: existing.length } // idempotent re-login
  }
  const accounts = [...existing, entry]
  writeFile(manifestPath, `${Bun.YAML.stringify({ accounts: accounts.map(toManifestEntry) })}`)
  return { added: true, count: accounts.length }
}

/**
 * Drive the ChatGPT OAuth flow for ONE bench account, persist its stripped-at-
 * ship token bundle to a per-label file, and register it in the pool manifest.
 */
export const runBenchLogin = async (
  opts: BenchLoginOpts,
  deps: BenchLoginDeps,
): Promise<BenchLoginResult> => {
  const label = opts.label.trim()
  if (label === "") throw new Error("auth-pool: --auth-label requires a non-empty account label")
  const cfg = resolveOAuthConfig(deps.env)
  if (!isClientIdConfigured(cfg)) {
    throw new Error(
      "auth-pool: OAuth client_id is not configured — set QUANTA_OAUTH_CLIENT_ID and retry",
    )
  }
  const authFile = opts.authFile ?? benchAccountAuthFile(deps.env, label)
  const manifestPath = opts.manifestPath ?? defaultBenchManifestPath(deps.env)
  const maxParallel = opts.maxParallel ?? DEFAULT_LOGIN_MAX_PARALLEL
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
    throw new Error(`auth-pool: --max-parallel must be a positive integer (got ${maxParallel})`)
  }

  deps.onLog?.(`[auth] opening browser to sign in account "${label}"…`)
  const flow = await runBrowserFlow({
    cfg,
    ...(deps.opener !== undefined ? { opener: deps.opener } : {}),
    ...(deps.callbackProvider !== undefined ? { callbackProvider: deps.callbackProvider } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  })
  deps.onLog?.("[auth] exchanging authorization code for tokens…")
  const record = await exchangeCode({
    cfg,
    code: flow.code,
    verifier: flow.verifier,
    redirectUri: flow.redirectUri,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    nowMs: () => deps.nowMs?.() ?? Date.now(),
  })

  const writeTokenImpl = deps.writeTokenImpl ?? writeToken
  await writeTokenImpl(authFile, record)

  const reg = registerAccount(
    manifestPath,
    { label, authFile, maxParallel },
    deps,
  )

  return {
    label,
    authFile,
    plan: record.plan_type ?? "unknown",
    ...(record.account_id !== undefined ? { accountId: record.account_id } : {}),
    manifestPath,
    manifestAdded: reg.added,
    accountCount: reg.count,
  }
}
