#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { checkDefaultOffLedger, loadDefaultOffLedger } from "../default-off-ledger-checker"
import { loadFeaturesStrict } from "../schema"
import { stringifyYaml } from "../yaml"
import { loadAuditRecords, loadAuditSnapshot } from "./io"
import { auditStatus, buildAuditSnapshot, validateAuditState } from "./model"

const ROOT = process.cwd()
const BASE = join(ROOT, "tools/feature-catalog/full-audit")
const SNAPSHOT_PATH = join(BASE, "snapshot.json")
const RESULTS_DIR = join(BASE, "results")
const BASELINE_PATH = join(ROOT, "tools/feature-catalog/baseline.json")
const LEDGER_PATH = join(ROOT, "tools/feature-catalog/default-off-ledger.yaml")

const stdout = (value: string): void => {
  process.stdout.write(`${value}\n`)
}

const stderr = (value: string): void => {
  process.stderr.write(`${value}\n`)
}

const usage = (): never => {
  stderr("usage: bun fc:audit <snapshot|validate|status|queue|start> [args]")
  stderr("  snapshot --head <40hex> --date YYYY-MM-DD")
  stderr("  queue [--priority P0|P1|P2|P3] [--section N] [--limit N]")
  stderr("  start <feature-id>")
  process.exit(2)
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const loadBaselineGrandfathered = async (): Promise<Set<string>> => {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as {
    fc?: { l3_reachability_grandfathered?: string[] }
  }
  return new Set(baseline.fc?.l3_reachability_grandfathered ?? [])
}

const commandSnapshot = async (): Promise<void> => {
  const snapshotHead = flag("--head") ?? usage()
  const createdAt = flag("--date") ?? usage()
  const features = await loadFeaturesStrict()
  const ledger = await loadDefaultOffLedger(LEDGER_PATH)
  const defaultOff = await checkDefaultOffLedger(ledger)
  if (defaultOff.errors.length > 0)
    throw new Error(`default-OFF ledger is not authoritative:\n${defaultOff.errors.join("\n")}`)
  const snapshot = buildAuditSnapshot({
    features,
    defaultOffIds: new Set(defaultOff.eligibleFeatureIds),
    reachabilityGrandfatheredIds: await loadBaselineGrandfathered(),
    snapshotHead,
    createdAt,
  })
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`)
  stdout(`snapshot: ${snapshot.catalog_total} features at ${snapshot.snapshot_head}`)
  stdout(`priority: ${JSON.stringify(snapshot.priority_counts)}`)
}

const loadState = async () => {
  const [snapshot, records, features] = await Promise.all([
    loadAuditSnapshot(SNAPSHOT_PATH),
    loadAuditRecords(RESULTS_DIR),
    loadFeaturesStrict(),
  ])
  return { snapshot, records, featureIds: new Set(features.map(({ feature }) => feature.id)) }
}

const commandValidate = async (): Promise<void> => {
  const state = await loadState()
  const report = validateAuditState(state.snapshot, state.records, state.featureIds)
  for (const warning of report.warnings) stderr(`warn: ${warning}`)
  for (const error of report.errors) stderr(`error: ${error}`)
  stdout(
    `full-audit validate: ${state.snapshot.catalog_total} snapshot / ${state.records.length} record(s) / ${report.errors.length} error(s)`,
  )
  if (report.errors.length > 0) process.exitCode = 1
}

const commandStatus = async (): Promise<void> => {
  const state = await loadState()
  stdout(JSON.stringify(auditStatus(state.snapshot, state.records), null, 2))
}

const commandQueue = async (): Promise<void> => {
  const state = await loadState()
  const recorded = new Set(state.records.map((record) => record.feature_id))
  const priority = flag("--priority")
  const section = Number(flag("--section") ?? 0)
  const limit = Number(flag("--limit") ?? 25)
  const entries = state.snapshot.entries
    .filter((entry) => !recorded.has(entry.feature_id))
    .filter((entry) => priority === undefined || entry.priority === priority)
    .filter((entry) => section === 0 || entry.section === section)
    .slice(0, limit)
  for (const entry of entries)
    stdout(
      [entry.priority, entry.section, entry.maturity, entry.feature_id, entry.source_path].join(
        "\t",
      ),
    )
}

const commandStart = async (): Promise<void> => {
  const id = process.argv[3] ?? usage()
  const state = await loadState()
  const entry = state.snapshot.entries.find((candidate) => candidate.feature_id === id)
  if (entry === undefined) throw new Error(`feature not in snapshot: ${id}`)
  const output = join(RESULTS_DIR, entry.source_path.split("/").at(-2) ?? "unknown", `${id}.yaml`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    stringifyYaml({
      version: 1,
      feature_id: id,
      snapshot_head: state.snapshot.snapshot_head,
      status: "in-progress",
      notes: "Owner seam and live evidence audit started.",
    }),
  )
  stdout(`started: ${relative(ROOT, output)}`)
}

const command = process.argv[2] ?? usage()
if (command === "snapshot") await commandSnapshot()
else if (command === "validate") await commandValidate()
else if (command === "status") await commandStatus()
else if (command === "queue") await commandQueue()
else if (command === "start") await commandStart()
else usage()
