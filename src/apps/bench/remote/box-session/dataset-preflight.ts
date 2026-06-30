/**
 * Local-side dataset + strict-LSP-grounding PREFLIGHT for full-remote runs.
 * Extracted from `box-session.ts`. PURE (reads the local dataset file only) — it
 * runs BEFORE a box is launched so an unreadable dataset / empty selection /
 * ungroundable task fails LOUDLY locally instead of after an expensive provision.
 */

import { readFileSync } from "node:fs"
import { lspServerBinForFile, PYRIGHT_LANGSERVER_BIN } from "@/lsp/server-registry"
import { byteCompare, filesFromUnifiedDiff } from "@/shared"
import { presetRequiresLiveLspGrounding } from "../../preset"

const PYRIGHT_LSP_BIN = PYRIGHT_LANGSERVER_BIN

interface RemoteStrictLspProbeTarget {
  readonly instanceId: string
  readonly bin: string
  readonly rel: string
  readonly count: number
}

export interface ParsedDatasetRow {
  readonly instanceId: string
  readonly record: Record<string, unknown>
}

type RemoteStrictGroundingSupport =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown-selection" }
  | {
      readonly kind: "unknown-task-language"
      readonly instanceId: string
      readonly files: readonly string[]
    }
  | { readonly kind: "ok"; readonly targets: readonly RemoteStrictLspProbeTarget[] }

export class UnsupportedRemoteStrictLspGroundingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedRemoteStrictLspGroundingError"
  }
}

export class RemoteDatasetSelectionPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RemoteDatasetSelectionPreflightError"
  }
}

export class RemoteDatasetPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RemoteDatasetPreflightError"
  }
}

const dominantRemoteStrictBinOf = (
  instanceId: string,
  rels: Iterable<string>,
): RemoteStrictLspProbeTarget | undefined => {
  const bins = new Map<string, { rel: string; count: number }>()
  for (const rel of rels) {
    const bin = lspServerBinForFile(rel)
    if (bin === null) continue
    const seen = bins.get(bin)
    if (seen === undefined) bins.set(bin, { rel, count: 1 })
    else seen.count += 1
  }
  let best: RemoteStrictLspProbeTarget | undefined
  for (const [bin, info] of bins) {
    if (
      best === undefined ||
      info.count > best.count ||
      (info.count === best.count && byteCompare(bin, best.bin) < 0)
    ) {
      best = { instanceId, bin, rel: info.rel, count: info.count }
    }
  }
  return best
}

const datasetTaskIdOf = (row: Record<string, unknown>): string | undefined => {
  const official = row.instance_id
  if (typeof official === "string" && official !== "") return official
  const custom = row.id
  return typeof custom === "string" && custom !== "" ? custom : undefined
}

const datasetGoldPatchOf = (row: Record<string, unknown>): string | undefined => {
  const official = row.patch
  if (typeof official === "string" && official.trim() !== "") return official
  const custom = row.goldPatch
  return typeof custom === "string" && custom.trim() !== "" ? custom : undefined
}

export const readParsedDatasetRows = (path: string): ParsedDatasetRow[] | undefined => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as unknown
          if (typeof row !== "object" || row === null) return []
          const record = row as Record<string, unknown>
          const instanceId = datasetTaskIdOf(record)
          return instanceId === undefined ? [] : [{ instanceId, record }]
        } catch {
          return []
        }
      })
  } catch {
    return undefined
  }
}

const loadParsedDatasetRowsOrThrow = (args: {
  readonly datasetPath: string
  readonly surface: string
}): ParsedDatasetRow[] => {
  const rows = readParsedDatasetRows(args.datasetPath)
  if (rows === undefined) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] local dataset ${args.datasetPath} could not be read before launch. Refusing to spend a remote box on an unreadable dataset.`,
    )
  }
  if (rows.length === 0) {
    throw new RemoteDatasetPreflightError(
      `[${args.surface}] local dataset ${args.datasetPath} contains no parseable task rows. Refusing a remote empty-dataset run.`,
    )
  }
  return rows
}

const filesFromPatch = (patch: string): string[] => filesFromUnifiedDiff(patch)

const remoteStrictGroundingSupportOf = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
}): RemoteStrictGroundingSupport => {
  const rows = readParsedDatasetRows(args.datasetPath)
  if (rows === undefined) return { kind: "unavailable" }
  const selected = args.instanceIds !== undefined ? new Set(args.instanceIds) : undefined
  const targets = new Map<string, RemoteStrictLspProbeTarget>()
  let sawSelected = false
  for (const { instanceId, record } of rows) {
    if (selected !== undefined && !selected.has(instanceId)) continue
    sawSelected = true
    const patch = datasetGoldPatchOf(record)
    const files = patch !== undefined ? filesFromPatch(patch) : []
    const target = dominantRemoteStrictBinOf(instanceId, files)
    if (target === undefined) return { kind: "unknown-task-language", instanceId, files }
    if (!targets.has(target.bin)) targets.set(target.bin, target)
  }
  if (!sawSelected) return { kind: "unknown-selection" }
  return { kind: "ok", targets: [...targets.values()] }
}

export const assertRemoteDatasetSelectionExists = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
}): void => {
  if (args.instanceIds === undefined || args.instanceIds.length === 0) return
  const rows = loadParsedDatasetRowsOrThrow({
    datasetPath: args.datasetPath,
    surface: args.surface,
  })
  const available = new Set(rows.map((row) => row.instanceId))
  const missing = args.instanceIds.filter((id) => !available.has(id))
  if (missing.length === 0) return
  const preview = missing.slice(0, 5).join(", ")
  const suffix = missing.length > 5 ? ` (+${missing.length - 5} more)` : ""
  throw new RemoteDatasetSelectionPreflightError(
    `[${args.surface}] selected instanceIds are missing from ${args.datasetPath}: ${preview}${suffix}. Refusing a remote empty-selection run.`,
  )
}

export const assertRemoteDatasetLaunchable = (args: {
  readonly datasetPath: string
  readonly surface: string
}): void => {
  void loadParsedDatasetRowsOrThrow(args)
}

/** Columns Scale's `swe_bench_pro_eval.py` dereferences in `create_entryscript` (a KeyError on any
 *  absent one ⇒ that instance errors ⇒ `eval_results[id]=False` with NO run-marker ⇒ our verifier
 *  reads it as infra). A trimmed/derived JSONL, or a Verified-shaped file mislabeled
 *  `--dataset-family pro`, would pass the generic launchable check yet burn a box to all-infra. */
const PRO_REQUIRED_COLUMNS = ["before_repo_set_cmd", "selected_test_files_to_run"] as const

const proRowMissingFields = (row: Record<string, unknown>): string[] => {
  const missing: string[] = PRO_REQUIRED_COLUMNS.filter(
    (c) => row[c] === undefined || row[c] === null,
  )
  // LOWERCASE `fail_to_pass` specifically (non-null): Scale's create_entryscript reads
  // `eval(raw_sample["fail_to_pass"])` — lowercase-only, NO uppercase fallback. An uppercase-only
  // FAIL_TO_PASS row would KeyError in Scale, so the uppercase form does NOT satisfy this. (The
  // official Pro JSONL ships lowercase; a null decodes to the no-op grade selection.)
  if (row.fail_to_pass === undefined || row.fail_to_pass === null) missing.push("fail_to_pass")
  return missing
}

/** FAIL-CLOSED Pro-dataset shape check — only acts when `family === "pro"` (no-op otherwise, so the
 *  Verified/Live paths are byte-identical). Refuses LOCALLY (before a box) a Pro dataset whose rows
 *  lack the Scale-harness-required columns, rather than discovering it as an all-infra remote slice. */
export const assertProDatasetGradeable = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
  readonly family: string
}): void => {
  if (args.family !== "pro") return
  const rows = loadParsedDatasetRowsOrThrow({
    datasetPath: args.datasetPath,
    surface: args.surface,
  })
  // Only validate the OPERATOR-SELECTED rows when an `--instance` filter is provided — an
  // unselected malformed row must not refuse a run that targets a single sound instance. With no
  // filter (`instanceIds` absent/empty) the whole dataset is validated, unchanged.
  const selected =
    args.instanceIds !== undefined && args.instanceIds.length > 0
      ? new Set(args.instanceIds)
      : undefined
  const offenders: string[] = []
  for (const { instanceId, record } of rows) {
    if (selected !== undefined && !selected.has(instanceId)) continue
    const missing = proRowMissingFields(record)
    if (missing.length > 0) offenders.push(`${instanceId} (missing: ${missing.join(", ")})`)
  }
  if (offenders.length === 0) return
  const preview = offenders.slice(0, 5).join("; ")
  const suffix = offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ""
  throw new RemoteDatasetPreflightError(
    `[${args.surface}] dataset-family=pro but ${offenders.length} row(s) lack Scale-harness-required ` +
      `columns (before_repo_set_cmd / selected_test_files_to_run / fail_to_pass): ${preview}${suffix}. ` +
      "Refusing a remote run that would grade as all-infra. Use the official scaleapi Pro JSONL.",
  )
}

export const assertRemoteStrictGroundingSupported = (args: {
  readonly preset: string
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
}): void => {
  if (!presetRequiresLiveLspGrounding(args.preset)) return
  const support = remoteStrictGroundingSupportOf({
    datasetPath: args.datasetPath,
    ...(args.instanceIds !== undefined ? { instanceIds: args.instanceIds } : {}),
  })
  if (support.kind === "unavailable") return
  if (support.kind === "unknown-selection") {
    throw new UnsupportedRemoteStrictLspGroundingError(
      `[${args.surface}] preset ${args.preset} requires live LSP grounding, but no selected dataset row could be read from ${args.datasetPath}. Refusing a remote false-green run.`,
    )
  }
  if (support.kind === "unknown-task-language") {
    const preview = support.files.slice(0, 5).join(", ")
    const suffix = support.files.length > 5 ? ` (+${support.files.length - 5} more)` : ""
    const detail =
      support.files.length === 0
        ? "its gold patch exposed no parseable diff file headers"
        : `its gold patch touched ${preview}${suffix}, but none map to a configured language server`
    throw new UnsupportedRemoteStrictLspGroundingError(
      `[${args.surface}] preset ${args.preset} requires live LSP grounding, but selected task ${support.instanceId} cannot be grounded: ${detail}. The remote box only bootstraps/proves ${PYRIGHT_LSP_BIN} today, so task language cannot be identified fail-closed.`,
    )
  }
  const unsupported = support.targets.filter((target) => target.bin !== PYRIGHT_LSP_BIN)
  if (unsupported.length === 0) return
  const first = unsupported[0]
  throw new UnsupportedRemoteStrictLspGroundingError(
    `[${args.surface}] preset ${args.preset} requires live LSP grounding, but this remote executor only bootstraps/proves ${PYRIGHT_LSP_BIN} today. Selected task ${first?.instanceId} requires ${first?.bin} (${first?.rel}). Refusing a remote false-green run.`,
  )
}

export const readDatasetInstanceIds = (path: string): string[] =>
  readParsedDatasetRows(path)?.map((row) => row.instanceId) ?? []
