import { createHash, randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const BIOME_RECEIPT_SCHEMA = 1 as const
export type BiomeDiagnostic = {
  readonly severity?: unknown
  readonly category?: string
  readonly message?: unknown
  readonly location?: { readonly path?: unknown; readonly start?: unknown; readonly end?: unknown }
  readonly advices?: unknown
}

type BiomeReport = {
  readonly summary?: unknown
  readonly diagnostics?: readonly BiomeDiagnostic[]
  readonly command?: unknown
}

export type BiomeReceiptKey = {
  readonly command: "check"
  readonly scanMode: "explicit-target-manifest"
  readonly targetManifestSha256: string
  readonly configSha256: string
  readonly biomeVersion: string
  readonly lockSha256: string
  readonly targetSelectionAuthoritySha256: string
  readonly inputContentSha256: string
}

type BiomeReceiptPayload = {
  readonly schemaVersion: typeof BIOME_RECEIPT_SCHEMA
  readonly status: "success"
  readonly exitCode: 0
  readonly key: BiomeReceiptKey
  readonly targetManifest: readonly string[]
  readonly summary: unknown
  readonly diagnostics: readonly BiomeDiagnostic[]
}

export type BiomeDiagnosticsReceipt = BiomeReceiptPayload & {
  readonly receiptSha256: string
}

export type BiomeScanResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly report: BiomeReport
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

const stableJson = (value: unknown): string => JSON.stringify(value)

const fileSha256 = (path: string): string => sha256(readFileSync(path))

const readRequired = (path: string): string => readFileSync(path, "utf8")

const normalizeRel = (path: string): string => path.replaceAll("\\", "/")

const inputContentSha256 = (repoRoot: string, targets: readonly string[]): string => {
  const entries: Array<readonly [string, string]> = []
  for (const target of targets) {
    const absolute = join(repoRoot, target)
    const stat = lstatSync(absolute)
    if (stat.isFile()) entries.push([normalizeRel(target), fileSha256(absolute)])
    else if (stat.isSymbolicLink()) {
      entries.push([normalizeRel(target), sha256(`symlink:${readlinkSync(absolute)}`)])
    }
  }
  return sha256(stableJson(entries))
}

const biomeVersion = (repoRoot: string): string => {
  const parsed = JSON.parse(
    readRequired(join(repoRoot, "node_modules/@biomejs/biome/package.json")),
  ) as { version?: unknown }
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error("biome receipt: @biomejs/biome package has no version")
  }
  return parsed.version
}

export const defaultBiomeReceiptPath = (repoRoot: string): string =>
  process.env.QUANTA_BIOME_RECEIPT ?? join(repoRoot, ".cache/biome/diagnostics-receipt.json")

export const buildBiomeReceiptKey = (
  repoRootInput: string,
  targets: readonly string[],
): BiomeReceiptKey => {
  const repoRoot = resolve(repoRootInput)
  return {
    command: "check",
    scanMode: "explicit-target-manifest",
    targetManifestSha256: sha256(stableJson(targets)),
    configSha256: fileSha256(join(repoRoot, "biome.json")),
    biomeVersion: biomeVersion(repoRoot),
    lockSha256: fileSha256(join(repoRoot, "bun.lock")),
    targetSelectionAuthoritySha256: fileSha256(join(repoRoot, "tools/dev/biome-targets.ts")),
    inputContentSha256: inputContentSha256(repoRoot, targets),
  }
}

const payloadSha256 = (payload: BiomeReceiptPayload): string => sha256(stableJson(payload))

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isDiagnosticArray = (value: unknown): value is readonly BiomeDiagnostic[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (!("category" in item) ||
        (item as { readonly category?: unknown }).category === undefined ||
        typeof (item as { readonly category?: unknown }).category === "string"),
  )

const sameKey = (left: BiomeReceiptKey, right: BiomeReceiptKey): boolean =>
  stableJson(left) === stableJson(right)

export const loadFreshBiomeReceipt = (args: {
  readonly repoRoot: string
  readonly targets: readonly string[]
  readonly receiptPath?: string
}): BiomeDiagnosticsReceipt | null => {
  const receiptPath = args.receiptPath ?? defaultBiomeReceiptPath(args.repoRoot)
  let parsed: unknown
  try {
    parsed = JSON.parse(readRequired(receiptPath))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const row = parsed as Partial<BiomeDiagnosticsReceipt>
  if (
    row.schemaVersion !== BIOME_RECEIPT_SCHEMA ||
    row.status !== "success" ||
    row.exitCode !== 0 ||
    row.key === undefined ||
    !isStringArray(row.targetManifest) ||
    !isDiagnosticArray(row.diagnostics) ||
    typeof row.receiptSha256 !== "string"
  ) {
    return null
  }
  const expectedKey = buildBiomeReceiptKey(args.repoRoot, args.targets)
  if (!sameKey(row.key, expectedKey)) return null
  if (stableJson(row.targetManifest) !== stableJson(args.targets)) return null
  const payload: BiomeReceiptPayload = {
    schemaVersion: row.schemaVersion,
    status: row.status,
    exitCode: row.exitCode,
    key: row.key,
    targetManifest: row.targetManifest,
    summary: row.summary,
    diagnostics: row.diagnostics,
  }
  if (payloadSha256(payload) !== row.receiptSha256) return null
  return { ...payload, receiptSha256: row.receiptSha256 }
}

export const invalidateBiomeReceipt = (path: string): void => {
  rmSync(path, { force: true })
}

export const writeSuccessfulBiomeReceipt = (args: {
  readonly repoRoot: string
  readonly targets: readonly string[]
  readonly report: BiomeReport
  readonly exitCode: number
  readonly receiptPath?: string
  readonly expectedKey?: BiomeReceiptKey
}): BiomeDiagnosticsReceipt | null => {
  const receiptPath = args.receiptPath ?? defaultBiomeReceiptPath(args.repoRoot)
  invalidateBiomeReceipt(receiptPath)
  if (args.exitCode !== 0 || !isDiagnosticArray(args.report.diagnostics)) return null
  const key = buildBiomeReceiptKey(args.repoRoot, args.targets)
  if (args.expectedKey !== undefined && !sameKey(args.expectedKey, key)) return null
  const payload: BiomeReceiptPayload = {
    schemaVersion: BIOME_RECEIPT_SCHEMA,
    status: "success",
    exitCode: 0,
    key,
    targetManifest: [...args.targets],
    summary: args.report.summary ?? null,
    diagnostics: args.report.diagnostics,
  }
  const receipt: BiomeDiagnosticsReceipt = { ...payload, receiptSha256: payloadSha256(payload) }
  mkdirSync(dirname(receiptPath), { recursive: true })
  const temporary = `${receiptPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx" })
    renameSync(temporary, receiptPath)
  } finally {
    rmSync(temporary, { force: true })
  }
  return receipt
}

export const runBiomeDiagnosticsScan = (args: {
  readonly repoRoot: string
  readonly biomeBin: string
  readonly targets: readonly string[]
}): BiomeScanResult => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-biome-receipt-"))
  const reportPath = join(dir, "report.json")
  try {
    const proc = Bun.spawnSync(
      [
        args.biomeBin,
        "check",
        "--reporter=json",
        `--reporter-file=${reportPath}`,
        "--max-diagnostics=100000",
        ...args.targets,
      ],
      { cwd: args.repoRoot, stdout: "ignore", stderr: "pipe" },
    )
    let raw: string
    try {
      raw = readRequired(reportPath)
    } catch {
      throw new Error(
        `biome produced no JSON report (exit ${proc.exitCode}). stderr:\n${proc.stderr.toString()}`,
      )
    }
    const report = JSON.parse(raw) as BiomeReport
    if (!isDiagnosticArray(report.diagnostics)) {
      throw new Error("biome JSON report has no `diagnostics` array — reporter shape drifted")
    }
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString(), report }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const diagnosticPath = (diagnostic: BiomeDiagnostic): string => {
  const path = diagnostic.location?.path
  if (typeof path === "string") return normalizeRel(path)
  if (path && typeof path === "object" && "file" in path) {
    return normalizeRel(String((path as { file: unknown }).file))
  }
  return ""
}
