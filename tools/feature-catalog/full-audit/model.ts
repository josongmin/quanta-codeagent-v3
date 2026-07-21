import type { LoadedFeature } from "../schema"
import type {
  AuditInputDigests,
  AuditPriority,
  AuditRecord,
  AuditSnapshot,
  AuditSnapshotEntry,
} from "./schema"

export interface SnapshotInputs {
  readonly features: readonly LoadedFeature[]
  readonly defaultOffIds: ReadonlySet<string>
  readonly reachabilityGrandfatheredIds: ReadonlySet<string>
  readonly snapshotHead: string
  readonly createdAt: string
  readonly inputDigests: AuditInputDigests
}

export interface AuditValidationReport {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export const priorityFor = (
  feature: LoadedFeature["feature"],
  defaultOffIds: ReadonlySet<string>,
  reachabilityGrandfatheredIds: ReadonlySet<string>,
): AuditPriority => {
  if (reachabilityGrandfatheredIds.has(feature.id) || feature.evidence.code.length === 0)
    return "P0"
  if (defaultOffIds.has(feature.id)) return "P1"
  if (feature.maturity === "L4" || feature.maturity === "L5") return "P2"
  return "P3"
}

const snapshotEntry = (loaded: LoadedFeature, inputs: SnapshotInputs): AuditSnapshotEntry => {
  const { feature } = loaded
  const priority = priorityFor(feature, inputs.defaultOffIds, inputs.reachabilityGrandfatheredIds)
  return {
    feature_id: feature.id,
    source_path: loaded.path,
    section: feature.section,
    maturity: feature.maturity,
    priority,
    proof_scope: priority === "P3" ? "static" : "dynamic",
    default_off_eligible: inputs.defaultOffIds.has(feature.id),
    reachability_grandfathered: inputs.reachabilityGrandfatheredIds.has(feature.id),
  }
}

export const buildAuditSnapshot = (inputs: SnapshotInputs): AuditSnapshot => {
  const entries = inputs.features.map((feature) => snapshotEntry(feature, inputs))
  const priorityCounts: Record<AuditPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const entry of entries) priorityCounts[entry.priority] += 1
  return {
    version: 2,
    snapshot_head: inputs.snapshotHead,
    created_at: inputs.createdAt,
    input_digests: inputs.inputDigests,
    catalog_total: entries.length,
    priority_counts: priorityCounts,
    entries,
  }
}

const validateCoverage = (
  snapshot: AuditSnapshot,
  currentFeatureIds: ReadonlySet<string>,
  errors: string[],
): Set<string> => {
  const snapshotIds = new Set(snapshot.entries.map((entry) => entry.feature_id))
  if (snapshot.catalog_total !== snapshot.entries.length) {
    errors.push("snapshot catalog_total does not match entries.length")
  }
  for (const id of snapshotIds) {
    if (!currentFeatureIds.has(id))
      errors.push(`snapshot feature missing from current catalog: ${id}`)
  }
  for (const id of currentFeatureIds) {
    if (!snapshotIds.has(id)) errors.push(`current catalog feature missing from snapshot: ${id}`)
  }
  return snapshotIds
}

const validateInputDigests = (
  snapshot: AuditSnapshot,
  currentInputDigests: AuditInputDigests,
  errors: string[],
): void => {
  for (const key of ["catalog_yaml", "default_off_ledger", "baseline"] as const) {
    if (snapshot.input_digests[key] !== currentInputDigests[key])
      errors.push(`audit snapshot input digest mismatch: ${key}`)
  }
}

const validateRecord = (
  record: AuditRecord,
  snapshot: AuditSnapshot,
  snapshotIds: ReadonlySet<string>,
  errors: string[],
): void => {
  if (!snapshotIds.has(record.feature_id))
    errors.push(`audit record is outside snapshot: ${record.feature_id}`)
  if (record.snapshot_head !== snapshot.snapshot_head)
    errors.push(`audit record snapshot mismatch: ${record.feature_id}`)
  const entry = snapshot.entries.find((candidate) => candidate.feature_id === record.feature_id)
  if (record.status === "closed" && record.verdict === "pass" && entry?.default_off_eligible) {
    if (record.off_identity_proof?.result !== "pass") {
      errors.push(`default-OFF PASS lacks OFF identity proof: ${record.feature_id}`)
    }
  }
}

export const validateAuditState = (
  snapshot: AuditSnapshot,
  records: readonly AuditRecord[],
  currentFeatureIds: ReadonlySet<string>,
  currentInputDigests: AuditInputDigests,
): AuditValidationReport => {
  const errors: string[] = []
  const warnings: string[] = []
  const snapshotIds = validateCoverage(snapshot, currentFeatureIds, errors)
  validateInputDigests(snapshot, currentInputDigests, errors)
  const recordIds = new Set<string>()

  for (const record of records) {
    if (recordIds.has(record.feature_id))
      errors.push(`duplicate audit record: ${record.feature_id}`)
    recordIds.add(record.feature_id)
    validateRecord(record, snapshot, snapshotIds, errors)
  }

  if (records.length === 0) warnings.push("no audit records yet; every snapshot entry is pending")
  return { errors, warnings }
}

export const auditStatus = (
  snapshot: AuditSnapshot,
  records: readonly AuditRecord[],
): Record<string, number> => {
  let pending = snapshot.catalog_total
  let inProgress = 0
  let closed = 0
  let reviewPending = 0
  let reviewed = 0
  const verdictCounts: Record<string, number> = {}
  for (const record of records) {
    pending -= 1
    if (record.status === "in-progress") inProgress += 1
    else {
      closed += 1
      if (record.review_state === "approved") reviewed += 1
      else reviewPending += 1
      const key = `verdict_${record.verdict.replaceAll("-", "_")}`
      verdictCounts[key] = (verdictCounts[key] ?? 0) + 1
    }
  }
  return {
    total: snapshot.catalog_total,
    pending,
    in_progress: inProgress,
    closed,
    review_pending: reviewPending,
    reviewed,
    ...verdictCounts,
  }
}
