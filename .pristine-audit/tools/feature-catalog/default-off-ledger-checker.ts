import { readFile } from "node:fs/promises"
import { parse } from "yaml"
import { CLI_FEATURE_GATE_NAMES } from "../../src/apps/cli/cli-feature-gates"
import { seedEnvVarsForSurface } from "../../src/tool/surface/manifest"
import {
  type DefaultOffLedger,
  type DefaultOffLedgerRow,
  DefaultOffLedgerSchema,
} from "./default-off-ledger-schema"
import { loadFeatures } from "./schema"

export type { DefaultOffLedger, DefaultOffLedgerRow } from "./default-off-ledger-schema"

export interface DefaultOffLedgerReport {
  readonly eligibleFeatureIds: readonly string[]
  readonly runtimeCliSeedCount: number
  readonly unknownSurfaceCount: number
  readonly unknownValueCount: number
  readonly summary: string
  readonly errors: readonly string[]
}

export interface CheckDefaultOffLedgerOptions {
  readonly catalogDir?: string
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort()

const duplicateValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

const countUnknownValues = (row: DefaultOffLedgerRow): number => {
  let count = 0
  const visit = (value: unknown): void => {
    if (value === "unknown") {
      count += 1
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(row)
  return count
}

const runtimeCliSeedGates = (): readonly string[] =>
  uniqueSorted([...CLI_FEATURE_GATE_NAMES, ...seedEnvVarsForSurface("cli")])

const checkSeedMappings = (
  ledger: DefaultOffLedger,
  runtimeGates: readonly string[],
  catalogIds: ReadonlySet<string>,
): string[] => {
  const errors: string[] = []
  const mappingGates = Object.keys(ledger.runtime_cli_seed_mappings).sort()
  for (const gate of runtimeGates.filter((candidate) => !mappingGates.includes(candidate))) {
    errors.push(`missing runtime CLI seed mapping: ${gate}`)
  }
  for (const gate of mappingGates.filter((candidate) => !runtimeGates.includes(candidate))) {
    errors.push(`unexpected runtime CLI seed mapping: ${gate}`)
  }
  for (const [gate, featureId] of Object.entries(ledger.runtime_cli_seed_mappings).sort()) {
    if (!catalogIds.has(featureId))
      errors.push(`runtime CLI seed mapping has no catalog row: ${gate} -> ${featureId}`)
  }
  return errors
}

const checkRowCoverage = (
  rows: readonly DefaultOffLedgerRow[],
  eligibleFeatureIds: readonly string[],
  catalogIds: ReadonlySet<string>,
): string[] => {
  const errors: string[] = []
  const rowIds = rows.map((row) => row.feature_id)
  for (const id of duplicateValues(rowIds)) errors.push(`duplicate feature_id: ${id}`)
  const rowById = new Map(rows.map((row) => [row.feature_id, row] as const))
  for (const id of eligibleFeatureIds) {
    if (!rowById.has(id)) errors.push(`missing eligible row: ${id}`)
  }
  for (const id of uniqueSorted(rowIds)) {
    if (!catalogIds.has(id)) errors.push(`ledger feature_id has no catalog row: ${id}`)
    if (!eligibleFeatureIds.includes(id)) errors.push(`row is outside bounded eligibility: ${id}`)
  }
  return errors
}

const checkRuntimeDefaults = (
  ledger: DefaultOffLedger,
  rows: readonly DefaultOffLedgerRow[],
  runtimeGates: readonly string[],
): string[] => {
  const errors: string[] = []
  const rowById = new Map(rows.map((row) => [row.feature_id, row] as const))
  const checkedFeatures = new Set<string>()
  for (const gate of runtimeGates) {
    const featureId = ledger.runtime_cli_seed_mappings[gate]
    if (featureId === undefined) continue
    const row = rowById.get(featureId)
    if (row === undefined) continue
    if (!row.gate_owner.includes(gate))
      errors.push(`runtime CLI gate owner mismatch: ${gate} -> ${featureId}`)
    if (checkedFeatures.has(featureId)) continue
    checkedFeatures.add(featureId)
    if (row.effective_default.cli !== "on") {
      errors.push(
        `runtime CLI default mismatch: ${featureId} expected on, ledger has ${row.effective_default.cli}`,
      )
    }
  }
  return errors
}

const checkRowInvariants = (
  rows: readonly DefaultOffLedgerRow[],
  catalogIds: ReadonlySet<string>,
): string[] => {
  const errors: string[] = []
  for (const row of rows) {
    if (row.proof.receipt !== null && row.proof.receipt.feature_id !== row.feature_id)
      errors.push(`proof receipt feature mismatch: ${row.feature_id}`)
    if (row.duplicate_of === row.feature_id)
      errors.push(`feature cannot duplicate itself: ${row.feature_id}`)
    if (row.duplicate_of !== null && !catalogIds.has(row.duplicate_of))
      errors.push(`duplicate target has no catalog row: ${row.feature_id} -> ${row.duplicate_of}`)
    if (
      row.decision === "delete-proven-duplicate" &&
      row.duplicate_of === null &&
      row.lifecycle_evidence === null
    )
      errors.push(`delete decision lacks duplicate or lifecycle evidence: ${row.feature_id}`)
    // DRIFT RATCHET (jul-18, Wave L): `reachability: wired` asserts a LIVE
    // consumer exists, which is logically incompatible with `activation:
    // unwired` (= no caller wires it). This exact contradiction was the driver
    // of ~19 stale rows (the codex-r2 wire family, fast-apply, effort-classifier,
    // …) where the label rotted out of sync with the source. Pinning the
    // invariant here fails RED the moment a row drifts back, forcing a
    // reachability downgrade or an activation correction — never a silent lie.
    if (row.reachability === "wired" && row.activation === "unwired")
      errors.push(
        `reachability=wired contradicts activation=unwired (a wired feature has a live consumer): ${row.feature_id}`,
      )
  }
  return errors
}

export async function loadDefaultOffLedger(path: string): Promise<DefaultOffLedger> {
  const source = await readFile(path, "utf8")
  return DefaultOffLedgerSchema.parse(parse(source, { maxAliasCount: 500, merge: true }))
}

export async function checkDefaultOffLedger(
  input: DefaultOffLedger,
  options: CheckDefaultOffLedgerOptions = {},
): Promise<DefaultOffLedgerReport> {
  const ledger = DefaultOffLedgerSchema.parse(input)
  const catalog = await loadFeatures(options.catalogDir)
  const catalogIds = new Set(catalog.map(({ feature }) => feature.id))
  const labelIds = catalog
    .filter(({ feature }) => feature.labels?.includes(ledger.scope.catalog_label))
    .map(({ feature }) => feature.id)
  const runtimeGates = runtimeCliSeedGates()
  const mappedFeatureIds = Object.values(ledger.runtime_cli_seed_mappings)
  const eligibleFeatureIds = uniqueSorted([...labelIds, ...mappedFeatureIds])
  const errors = [
    ...checkSeedMappings(ledger, runtimeGates, catalogIds),
    ...checkRowCoverage(ledger.rows, eligibleFeatureIds, catalogIds),
    ...checkRuntimeDefaults(ledger, ledger.rows, runtimeGates),
    ...checkRowInvariants(ledger.rows, catalogIds),
  ]

  const surfaceKeys = ["cli", "web", "bench", "headless", "daemon"] as const
  const unknownSurfaceCount = ledger.rows.reduce(
    (sum, row) =>
      sum + surfaceKeys.filter((surface) => row.effective_default[surface] === "unknown").length,
    0,
  )
  const unknownValueCount = ledger.rows.reduce((sum, row) => sum + countUnknownValues(row), 0)
  const summary =
    `eligible=${eligibleFeatureIds.length} runtime_cli_seeds=${runtimeGates.length} ` +
    `unknown_surfaces=${unknownSurfaceCount} unknown_values=${unknownValueCount}`

  return {
    eligibleFeatureIds,
    runtimeCliSeedCount: runtimeGates.length,
    unknownSurfaceCount,
    unknownValueCount,
    summary,
    errors,
  }
}

if (import.meta.main) {
  const ledger = await loadDefaultOffLedger(`${import.meta.dir}/default-off-ledger.yaml`)
  const report = await checkDefaultOffLedger(ledger)
  process.stdout.write(`${report.summary}\n`)
  for (const error of report.errors) process.stderr.write(`${error}\n`)
  if (report.errors.length > 0) process.exitCode = 1
}
