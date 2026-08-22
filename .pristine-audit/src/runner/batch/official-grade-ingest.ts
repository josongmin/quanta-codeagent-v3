/**
 * PMX-04/05 — the ONE document a grader phase hands the report layer.
 *
 * ## Why a document, and why here
 *
 * PMX-05 threaded `BatchArtifactMeta.officialGrade` through the composition root
 * and stopped. Nothing produced it, so every campaign report would have rendered
 * an empty official-grade section and the covering-partition guard would never
 * have run on a real number.
 *
 * The producer cannot be "the local grade loop", because an OFFICIAL grader is by
 * definition out of process — a pinned upstream script, run on a box, outside the
 * agent's workspace, possibly long after generation finished. The only thing that
 * crosses that boundary honestly is a FILE. So this module owns its shape:
 *
 * ```jsonc
 * { "schema_version": 1,
 *   "receipt":  { …the PMX-03 receipt document… },
 *   "instanceMeta": { "<instance_id>": { language, image, digests, … } },
 *   "campaign": { quantaSha, quantaDirty, provider, model, … } }
 * ```
 *
 * ## Fail-closed, in every direction
 *
 * The receipt half is re-validated by {@link parseOfficialGradeReceipt}, so a
 * drifted state, a duplicated disposition or a verdict for an unassigned id is
 * refused on the way IN — the report layer never sees it.
 *
 * The metadata half is validated here for one specific reason: `instanceMeta` is
 * what supplies the per-LANGUAGE table, and a key that is not in the campaign's
 * assigned set would contribute a language row for an instance the campaign never
 * ran. That is a silently-wrong denominator, so it is a refusal.
 *
 * Campaign identity is required, not optional: a benchmark number whose report
 * cannot say which Quanta build, provider and model produced it is not a
 * benchmark result. `quantaDirty` is carried explicitly for the same reason — a
 * dirty tree is a disclosure, not a footnote.
 *
 * Generic by construction: nothing here knows the word ProMax.
 */
import { parseOfficialGradeReceipt, serializeOfficialGradeReceipt } from "./eval/official-grade"
import type {
  AggregateOfficialGradeInput,
  OfficialGradeCampaignMeta,
  OfficialGradeInstanceMeta,
} from "./report-official-grade"

export const OFFICIAL_GRADE_INGEST_SCHEMA_VERSION = 1

/** Closed classification of every way the document can be refused. */
export type OfficialGradeIngestFailureCode =
  | "document_unparseable"
  | "schema_version_unsupported"
  | "receipt_rejected"
  | "campaign_meta_invalid"
  | "instance_meta_unassigned"
  | "instance_meta_invalid"

export interface OfficialGradeIngestFailure {
  readonly code: OfficialGradeIngestFailureCode
  readonly message: string
}

export type OfficialGradeIngestResult =
  | { readonly ok: true; readonly input: AggregateOfficialGradeInput }
  | { readonly ok: false; readonly failures: readonly OfficialGradeIngestFailure[] }

const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === ""

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const optionalNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const optionalNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return optionalNumber(value)
}

const readImage = (value: unknown): OfficialGradeInstanceMeta["image"] => {
  if (value === null || typeof value !== "object") return undefined
  const r = value as Record<string, unknown>
  if (
    isBlank(r.sourceRef) ||
    isBlank(r.registryDigest) ||
    isBlank(r.localImageId) ||
    isBlank(r.platform)
  ) {
    return undefined
  }
  return {
    sourceRef: String(r.sourceRef),
    registryDigest: String(r.registryDigest),
    localImageId: String(r.localImageId),
    platform: String(r.platform),
  }
}

const readInstanceMeta = (value: unknown): OfficialGradeInstanceMeta => {
  const r = (value ?? {}) as Record<string, unknown>
  const image = readImage(r.image)
  return {
    ...(optionalString(r.language) !== undefined ? { language: optionalString(r.language) } : {}),
    ...(optionalNullableString(r.predictionSha256) !== undefined
      ? { predictionSha256: optionalNullableString(r.predictionSha256) }
      : {}),
    ...(optionalNullableString(r.goldenSourceSha256) !== undefined
      ? { goldenSourceSha256: optionalNullableString(r.goldenSourceSha256) }
      : {}),
    ...(optionalNullableString(r.goldenDerivedSha256) !== undefined
      ? { goldenDerivedSha256: optionalNullableString(r.goldenDerivedSha256) }
      : {}),
    ...(optionalNullableString(r.evalSourceSha256) !== undefined
      ? { evalSourceSha256: optionalNullableString(r.evalSourceSha256) }
      : {}),
    ...(optionalNullableString(r.evalDerivedSha256) !== undefined
      ? { evalDerivedSha256: optionalNullableString(r.evalDerivedSha256) }
      : {}),
    ...(image !== undefined ? { image } : {}),
    ...(optionalString(r.runId) !== undefined ? { runId: optionalString(r.runId) } : {}),
    ...(optionalString(r.chunkId) !== undefined ? { chunkId: optionalString(r.chunkId) } : {}),
    ...(optionalString(r.boxId) !== undefined ? { boxId: optionalString(r.boxId) } : {}),
    ...(optionalNumber(r.attempts) !== undefined ? { attempts: optionalNumber(r.attempts) } : {}),
  }
}

const readCampaign = (
  value: unknown,
): { readonly meta?: OfficialGradeCampaignMeta; readonly failure?: OfficialGradeIngestFailure } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      failure: {
        code: "campaign_meta_invalid",
        message: "the document carries no `campaign` object",
      },
    }
  }
  const r = value as Record<string, unknown>
  if (isBlank(r.quantaSha) || isBlank(r.provider) || isBlank(r.model)) {
    return {
      failure: {
        code: "campaign_meta_invalid",
        message:
          "campaign identity needs a non-blank quantaSha, provider and model — a benchmark " +
          "number whose report cannot name the build that produced it is not a result",
      },
    }
  }
  if (typeof r.quantaDirty !== "boolean") {
    return {
      failure: {
        code: "campaign_meta_invalid",
        message:
          "campaign.quantaDirty must be an explicit boolean — a dirty working tree is a " +
          "disclosure, and `undefined` would silently read as clean",
      },
    }
  }
  return {
    meta: {
      quantaSha: String(r.quantaSha),
      quantaDirty: r.quantaDirty,
      provider: String(r.provider),
      model: String(r.model),
      ...(optionalString(r.reasoningEffort) !== undefined
        ? { reasoningEffort: optionalString(r.reasoningEffort) }
        : {}),
      ...(optionalString(r.preset) !== undefined ? { preset: optionalString(r.preset) } : {}),
      ...(optionalNullableNumber(r.turnBudget) !== undefined
        ? { turnBudget: optionalNullableNumber(r.turnBudget) }
        : {}),
      ...(optionalNullableNumber(r.tokenWall) !== undefined
        ? { tokenWall: optionalNullableNumber(r.tokenWall) }
        : {}),
      ...(optionalString(r.runId) !== undefined ? { runId: optionalString(r.runId) } : {}),
      ...(optionalString(r.chunkId) !== undefined ? { chunkId: optionalString(r.chunkId) } : {}),
      ...(optionalString(r.boxId) !== undefined ? { boxId: optionalString(r.boxId) } : {}),
    },
  }
}

/**
 * The per-instance metadata TABLE, keyed by instance id.
 *
 * `assigned` is the receipt's denominator when the receipt itself parsed. A key
 * outside it is a REFUSAL rather than a dropped row: metadata is what feeds the
 * per-language table, so an unassigned key would publish a language row for an
 * instance the campaign never ran.
 */
const readInstanceMetaTable = (
  raw: unknown,
  assigned: ReadonlySet<string> | undefined,
): {
  readonly table: Map<string, OfficialGradeInstanceMeta>
  readonly failures: readonly OfficialGradeIngestFailure[]
} => {
  const table = new Map<string, OfficialGradeInstanceMeta>()
  if (raw === undefined) return { table, failures: [] }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      table,
      failures: [
        {
          code: "instance_meta_invalid",
          message: "`instanceMeta` must be an object keyed by instance id",
        },
      ],
    }
  }
  const failures: OfficialGradeIngestFailure[] = []
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (assigned !== undefined && !assigned.has(id)) {
      failures.push({
        code: "instance_meta_unassigned",
        message:
          `instance metadata names "${id}", which the receipt never assigned — it would ` +
          "contribute a per-language row for an instance this campaign did not run",
      })
      continue
    }
    table.set(id, readInstanceMeta(value))
  }
  return { table, failures }
}

/** The on-disk document, produced from an aggregation input. Round-trips. */
export const serializeOfficialGradeIngestDocument = (input: AggregateOfficialGradeInput): string =>
  JSON.stringify(
    {
      schema_version: OFFICIAL_GRADE_INGEST_SCHEMA_VERSION,
      receipt: JSON.parse(serializeOfficialGradeReceipt(input.receipt)) as unknown,
      instanceMeta: Object.fromEntries(input.instanceMeta ?? new Map()),
      campaign: input.campaign,
    },
    null,
    2,
  )

/**
 * Parse a grader phase's document into the ONE aggregation input the report
 * layer consumes. Failures ACCUMULATE — an operator debugging a bad grading run
 * should see every defect at once.
 */
export const parseOfficialGradeIngestDocument = (value: unknown): OfficialGradeIngestResult => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      failures: [
        {
          code: "document_unparseable",
          message: "the official-grade ingest document is not a JSON object",
        },
      ],
    }
  }
  const doc = value as Record<string, unknown>
  const failures: OfficialGradeIngestFailure[] = []
  if (doc.schema_version !== OFFICIAL_GRADE_INGEST_SCHEMA_VERSION) {
    failures.push({
      code: "schema_version_unsupported",
      message:
        `official-grade ingest schema_version=${String(doc.schema_version)} is not ` +
        `${OFFICIAL_GRADE_INGEST_SCHEMA_VERSION} — refusing to half-read a document written ` +
        "by a different producer",
    })
  }

  const parsedReceipt = parseOfficialGradeReceipt(doc.receipt)
  if (!parsedReceipt.ok) {
    for (const f of parsedReceipt.failures) {
      failures.push({ code: "receipt_rejected", message: `${f.code}: ${f.message}` })
    }
  }

  const campaign = readCampaign(doc.campaign)
  if (campaign.failure !== undefined) failures.push(campaign.failure)

  const meta = readInstanceMetaTable(
    doc.instanceMeta,
    parsedReceipt.ok ? new Set(parsedReceipt.receipt.assignedInstanceIds) : undefined,
  )
  failures.push(...meta.failures)

  if (failures.length > 0) return { ok: false, failures }
  const instanceMeta = meta.table
  if (!parsedReceipt.ok || campaign.meta === undefined) {
    // Unreachable: both push failures above. Kept explicit so the narrowing is
    // the compiler's, not a cast.
    return {
      ok: false,
      failures: [{ code: "document_unparseable", message: "internal: incomplete ingest document" }],
    }
  }
  return {
    ok: true,
    input: {
      receipt: parsedReceipt.receipt,
      ...(instanceMeta.size > 0 ? { instanceMeta } : {}),
      campaign: campaign.meta,
    },
  }
}
