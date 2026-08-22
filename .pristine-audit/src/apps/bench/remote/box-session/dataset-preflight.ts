/**
 * Local-side dataset + strict-LSP-grounding PREFLIGHT for full-remote runs.
 * Extracted from `box-session.ts`. PURE (reads the local dataset file only) — it
 * runs BEFORE a box is launched so an unreadable dataset / empty selection /
 * ungroundable task fails LOUDLY locally instead of after an expensive provision.
 */

import {
  lspServerBinForExtension,
  lspServerBinForFile,
  PYRIGHT_LANGSERVER_BIN,
} from "@/lsp/server-registry"
import { byteCompare, filesFromUnifiedDiff } from "@/shared"
import type { DatasetFamily } from "../../dataset-family-token"
import { presetRequiresLiveLspGrounding } from "../../preset"
import {
  loadFamilyCorpusRowsOrThrow,
  readFamilyCorpusFile,
  readFamilyDatasetInstanceIds,
} from "../../profiles/corpus-read"
import type { FamilyCorpusRow } from "../../profiles/corpus-row"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"

// The refusal TYPE lives in the family-agnostic leaf `./dataset-rows` so the
// profile-layer shape checks can throw it without importing a consumer.
// Re-exported here so the historical import surface (box-session.ts, tests) is
// unchanged. PMX-02 retired that leaf's JSONL-only ROW READER — dataset reading
// now has one owner, `DatasetFamilyProfile.readCorpus`.
export { RemoteDatasetPreflightError } from "./dataset-rows"

const PYRIGHT_LSP_BIN = PYRIGHT_LANGSERVER_BIN

interface RemoteStrictLspProbeTarget {
  readonly instanceId: string
  readonly bin: string
  readonly rel: string
  readonly count: number
}

type RemoteStrictGroundingSupport =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown-selection" }
  | {
      readonly kind: "unknown-task-language"
      readonly instanceId: string
      readonly files: readonly string[]
      /** Set when the row PUBLISHED a language that maps to no configured
       *  language server — a different, more actionable failure than "the diff
       *  headers were unreadable", and never a reason to consult the gold patch. */
      readonly publicLanguage?: string
    }
  | { readonly kind: "ok"; readonly targets: readonly RemoteStrictLspProbeTarget[] }

/**
 * PUBLIC language label → a representative source-file extension.
 *
 * aug-22 G3. This maps only LABEL → EXTENSION; the extension → language-server
 * decision stays with `@/lsp/server-registry`, which is the one routing SSOT, so
 * this table can never disagree with the servers the box actually bootstraps.
 * Keys are the lowercase upstream spellings (SWE-Bench-ProMax publishes exactly
 * c / c++ / go / java / python / rust / typescript); `java` is deliberately
 * PRESENT and deliberately maps to an extension the registry does not serve, so
 * a Java task is refused by NAME rather than silently falling through.
 */
const PUBLIC_LANGUAGE_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["c", ".c"],
  ["c++", ".cpp"],
  ["cpp", ".cpp"],
  ["go", ".go"],
  ["java", ".java"],
  ["javascript", ".js"],
  ["python", ".py"],
  ["rust", ".rs"],
  ["typescript", ".ts"],
])

/** The probe target implied by a row's PUBLIC language, or null when that
 *  language maps to no configured language server. */
const strictBinForPublicLanguage = (
  instanceId: string,
  language: string,
): RemoteStrictLspProbeTarget | null => {
  const ext = PUBLIC_LANGUAGE_EXTENSION.get(language.trim().toLowerCase())
  const bin = ext !== undefined ? lspServerBinForExtension(ext) : null
  return bin === null ? null : { instanceId, bin, rel: `language=${language}`, count: 1 }
}

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

const datasetGoldPatchOf = (row: Record<string, unknown>): string | undefined => {
  const official = row.patch
  if (typeof official === "string" && official.trim() !== "") return official
  const custom = row.goldPatch
  return typeof custom === "string" && custom.trim() !== "" ? custom : undefined
}

const filesFromPatch = (patch: string): string[] => filesFromUnifiedDiff(patch)

/**
 * The probe target ONE row implies, or the `unknown-task-language` refusal it
 * produces.
 *
 * aug-22 G3 — the whole per-row policy is here, in one place: a family that
 * PUBLISHES a language grounds on it, EXCLUSIVELY. There is deliberately no gold
 * fallback for such a row — falling back would re-open the leak this closes, and
 * would silently ground a Rust task as Pyright whenever its gold patch happened
 * to touch a `.py` helper. Families that publish no language keep the historical
 * diff-header derivation, byte-identically.
 */
const strictGroundingTargetOf = (
  row: FamilyCorpusRow,
):
  | { readonly ok: true; readonly target: RemoteStrictLspProbeTarget }
  | { readonly ok: false; readonly refusal: RemoteStrictGroundingSupport } => {
  const { instanceId, record, publicLanguage } = row
  if (publicLanguage !== undefined) {
    const byLanguage = strictBinForPublicLanguage(instanceId, publicLanguage)
    return byLanguage === null
      ? {
          ok: false,
          refusal: { kind: "unknown-task-language", instanceId, files: [], publicLanguage },
        }
      : { ok: true, target: byLanguage }
  }
  const patch = datasetGoldPatchOf(record)
  const files = patch !== undefined ? filesFromPatch(patch) : []
  const target = dominantRemoteStrictBinOf(instanceId, files)
  return target === undefined
    ? { ok: false, refusal: { kind: "unknown-task-language", instanceId, files } }
    : { ok: true, target }
}

const remoteStrictGroundingSupportOf = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly family: DatasetFamily
}): RemoteStrictGroundingSupport => {
  const rows = readFamilyCorpusFile(args.datasetPath, args.family)
  if (rows === undefined) return { kind: "unavailable" }
  const selected = args.instanceIds !== undefined ? new Set(args.instanceIds) : undefined
  const targets = new Map<string, RemoteStrictLspProbeTarget>()
  let sawSelected = false
  for (const row of rows) {
    if (selected !== undefined && !selected.has(row.instanceId)) continue
    sawSelected = true
    const resolved = strictGroundingTargetOf(row)
    if (!resolved.ok) return resolved.refusal
    if (!targets.has(resolved.target.bin)) targets.set(resolved.target.bin, resolved.target)
  }
  if (!sawSelected) return { kind: "unknown-selection" }
  return { kind: "ok", targets: [...targets.values()] }
}

export const assertRemoteDatasetSelectionExists = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
  readonly family: DatasetFamily
}): void => {
  if (args.instanceIds === undefined || args.instanceIds.length === 0) return
  const rows = loadFamilyCorpusRowsOrThrow({
    datasetPath: args.datasetPath,
    surface: args.surface,
    family: args.family,
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
  readonly family: DatasetFamily
}): void => {
  void loadFamilyCorpusRowsOrThrow(args)
}

/**
 * FAIL-CLOSED per-family dataset gradeability preflight — the callee of BOTH
 * `remote/full.ts` and `remote/pool.ts`. Resolves the family PROFILE and runs its
 * `preflight` port; Pro's port is the Scale-column shape check, verified/live are
 * no-ops (byte-identical).
 *
 * aug-22 HIGH-4: this used to be `assertProDatasetGradeable`, which early-returned
 * on `args.family !== "pro"` and then called a body the registry imported BACK from
 * this module — so the T4 `preflight` port had zero production consumers and a
 * family #4 would still have had to edit here. There is now no family string in
 * this module at all.
 */
export const assertDatasetGradeableForFamily = (args: {
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
  readonly family: DatasetFamily
}): void => {
  resolveDatasetFamilyProfile(args.family).preflight({
    datasetPath: args.datasetPath,
    ...(args.instanceIds !== undefined ? { instanceIds: args.instanceIds } : {}),
    surface: args.surface,
    // Lazily bound to the family's OWN reader: verified/live never call it, so
    // their preflight performs no read at all and stays byte-identical.
    readRows: (): readonly FamilyCorpusRow[] =>
      loadFamilyCorpusRowsOrThrow({
        datasetPath: args.datasetPath,
        surface: args.surface,
        family: args.family,
      }),
  })
}

export const assertRemoteStrictGroundingSupported = (args: {
  readonly preset: string
  readonly datasetPath: string
  readonly instanceIds?: readonly string[]
  readonly surface: string
  readonly family: DatasetFamily
}): void => {
  if (!presetRequiresLiveLspGrounding(args.preset)) return
  const support = remoteStrictGroundingSupportOf({
    datasetPath: args.datasetPath,
    ...(args.instanceIds !== undefined ? { instanceIds: args.instanceIds } : {}),
    family: args.family,
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
      support.publicLanguage !== undefined
        ? `its PUBLIC language "${support.publicLanguage}" maps to no configured language server`
        : support.files.length === 0
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

/** Every instance id in a dataset file, decoded through the FAMILY's reader.
 *  Best-effort (`[]` on an unreadable file) — its consumers are launch tags,
 *  status snapshots and relaunch reconciliation, none of which may throw. */
export const readDatasetInstanceIds = (path: string, family: DatasetFamily): string[] => [
  ...readFamilyDatasetInstanceIds(path, family),
]
