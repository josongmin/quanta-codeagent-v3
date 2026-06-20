/**
 * Multi-Auth Fleet (jun-20) — T-1 manifest parser + resolver.
 *
 * `parseAuthPoolManifest` turns YAML/JSON text into a validated pool `AuthSource`.
 * `resolveAuthSource` decides single-vs-pool from env + flags WITHOUT reading any
 * token file — only a manifest path is read, and only when pool mode is selected.
 */
import { readFileSync } from "node:fs"
import type { AuthPoolEntry, AuthSource } from "./types"

/** Default credential when no pool and no explicit `QUANTA_BENCH_AUTH_FILE`. */
export const defaultAuthFile = (env: NodeJS.ProcessEnv): string =>
  `${env.HOME ?? ""}/.quanta/auth/chatgpt.json`

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const reqString = (rec: Record<string, unknown>, key: string, ctx: string): string => {
  const v = rec[key]
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`auth-pool: ${ctx} requires non-empty string "${key}"`)
  }
  return v
}

const reqPositiveInt = (rec: Record<string, unknown>, key: string, ctx: string): number => {
  const v = rec[key]
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
    throw new Error(`auth-pool: ${ctx} requires positive integer "${key}" (got ${String(v)})`)
  }
  return v
}

const optPositiveInt = (rec: Record<string, unknown>, key: string, ctx: string): number | undefined => {
  const v = rec[key]
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
    throw new Error(`auth-pool: ${ctx} optional "${key}" must be a positive integer (got ${String(v)})`)
  }
  return v
}

const optPositiveNum = (rec: Record<string, unknown>, key: string, ctx: string): number | undefined => {
  const v = rec[key]
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`auth-pool: ${ctx} optional "${key}" must be a positive number (got ${String(v)})`)
  }
  return v
}

const optBool = (rec: Record<string, unknown>, key: string, ctx: string): boolean | undefined => {
  const v = rec[key]
  if (v === undefined) return undefined
  if (typeof v !== "boolean") {
    throw new Error(`auth-pool: ${ctx} optional "${key}" must be a boolean (got ${String(v)})`)
  }
  return v
}

const toEntry = (raw: unknown, idx: number): AuthPoolEntry => {
  const rec = asRecord(raw)
  const ctx = `accounts[${idx}]`
  const label = reqString(rec, "label", ctx)
  const authFile = reqString(rec, "authFile" in rec ? "authFile" : "auth_file", ctx)
  const maxParallel = reqPositiveInt(rec, "maxParallel" in rec ? "maxParallel" : "max_parallel", ctx)
  const maxBoxes = optPositiveInt(rec, "maxBoxes" in rec ? "maxBoxes" : "max_boxes", ctx)
  const cooldownBaseSec = optPositiveNum(
    rec,
    "cooldownBaseSec" in rec ? "cooldownBaseSec" : "cooldown_base_sec",
    ctx,
  )
  const weight = optPositiveNum(rec, "weight", ctx)
  const disabled = optBool(rec, "disabled", ctx)
  return {
    label,
    authFile,
    maxParallel,
    ...(maxBoxes !== undefined ? { maxBoxes } : {}),
    ...(cooldownBaseSec !== undefined ? { cooldownBaseSec } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  }
}

/**
 * Parse a pool manifest (YAML or JSON) into a validated `pool` AuthSource.
 * Fails fast on: missing/empty `accounts`, duplicate or empty labels,
 * non-positive `maxParallel`. NEVER reads any account's auth file.
 */
export const parseAuthPoolManifest = (text: string): AuthSource => {
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch (e) {
    throw new Error(`auth-pool: manifest is not valid YAML/JSON — ${(e as Error).message}`)
  }
  const root = asRecord(doc)
  const rawAccounts = root.accounts
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    throw new Error('auth-pool: manifest must define a non-empty "accounts" array')
  }
  const accounts = rawAccounts.map((a, i) => toEntry(a, i))
  const seen = new Set<string>()
  for (const a of accounts) {
    if (seen.has(a.label)) {
      throw new Error(`auth-pool: duplicate account label "${a.label}"`)
    }
    seen.add(a.label)
  }
  return { kind: "pool", accounts }
}

/** Read + parse a pool manifest file. Throws on unreadable path. */
export const loadAuthPoolFile = (path: string): AuthSource =>
  parseAuthPoolManifest(readFileSync(path, "utf8"))

export interface ResolveAuthOpts {
  readonly env: NodeJS.ProcessEnv
  /** `--auth-pool <path>` flag value, if any. Wins over the env manifest. */
  readonly authPoolArg?: string
  /** `--auth-file <path>` flag value, if any. Wins over `QUANTA_BENCH_AUTH_FILE`. */
  readonly authFileArg?: string
}

/**
 * The single resolver shared by `pool` and `grade --mode full`.
 *
 * - pool manifest present (flag or `QUANTA_BENCH_AUTH_POOL`) ⇒ `{ kind: "pool" }`
 * - otherwise ⇒ legacy `{ kind: "single" }`, byte-identical to the old path.
 *
 * Reads the manifest file only in pool mode; never reads a token file.
 */
export const resolveAuthSource = (opts: ResolveAuthOpts): AuthSource => {
  const { env, authPoolArg, authFileArg } = opts
  const poolPath =
    authPoolArg !== undefined && authPoolArg.trim() !== ""
      ? authPoolArg
      : env.QUANTA_BENCH_AUTH_POOL !== undefined && env.QUANTA_BENCH_AUTH_POOL.trim() !== ""
        ? env.QUANTA_BENCH_AUTH_POOL
        : undefined
  if (poolPath !== undefined) return loadAuthPoolFile(poolPath)
  const authFile =
    authFileArg !== undefined && authFileArg.trim() !== ""
      ? authFileArg
      : env.QUANTA_BENCH_AUTH_FILE !== undefined && env.QUANTA_BENCH_AUTH_FILE.trim() !== ""
        ? env.QUANTA_BENCH_AUTH_FILE
        : defaultAuthFile(env)
  return { kind: "single", authFile }
}

/** One-line operator summary of an AuthSource — labels only, NEVER token bytes
 *  or file contents. Safe for dry-run / logs / status. */
export const describeAuthSource = (src: AuthSource): string =>
  src.kind === "single"
    ? `auth: single (${src.authFile})`
    : `auth: pool of ${src.accounts.length} — ${src.accounts
        .map((a) => `${a.label}${a.disabled ? "(disabled)" : ""}×${a.maxParallel}`)
        .join(", ")}`
