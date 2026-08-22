/**
 * PMX-05 — THE official-grade aggregation owner for the SWE report branch.
 *
 * ONE function turns a PMX-03 {@link OfficialGradeReceipt} into the totals every
 * display surface reads. Report JSON, the CLI summary, the markdown export and
 * the dashboard all consume the SAME persisted result; none of them folds raw
 * per-instance rows a second time. That is the whole point: a second fold is a
 * second scoring authority, and two authorities disagree the moment a filter,
 * a shard boundary or a display bug touches one of them.
 *
 * ## The honest denominator
 *
 * ```text
 * assigned      = resolved + model_miss + infra_invalid + ambiguous + missing
 * attempted     = assigned - missing
 * grading_valid = resolved + model_miss
 *
 * official_valid_rate = resolved / grading_valid
 * coverage            = grading_valid / assigned
 * raw_rate            = resolved / assigned
 * ```
 *
 * The three rates are ALWAYS rendered together. A smaller valid denominator
 * flatters `official_valid_rate`; it must never do so without the matching
 * `coverage` loss being visible in the same breath. A zero denominator is `null`
 * — never `0`, never `NaN` — and renders as {@link OFFICIAL_GRADE_RATE_UNAVAILABLE},
 * because "nothing was measured" and "zero percent succeeded" are different claims.
 *
 * ## What this module is NOT
 *
 * It does not classify. PMX-03 (`eval/official-grade/`) already decided each
 * instance's state and reason from the grader's own output, and it is the only
 * place `missing` may be derived. This module SERIALIZES that decision and
 * validates the covering partition; it never re-maps a raw upstream reason.
 *
 * Generic by construction: nothing here knows the word ProMax. Any future
 * official grader profile that produces a PMX-03 receipt gets these totals.
 */
import {
  deriveMissingInstanceIds,
  OFFICIAL_GRADE_STATE_BY_REASON,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReason,
  type OfficialGradeReceipt,
  type OfficialGradeState,
  summarizeOfficialGrade,
} from "./eval/official-grade"

/** Language bucket for an instance whose corpus row carried no language. */
export const OFFICIAL_GRADE_UNKNOWN_LANGUAGE = "unknown"

/** How a rate with a ZERO denominator renders on every surface. Deliberately not
 *  a percentage: `0%` would read as "measured, and nothing passed". */
export const OFFICIAL_GRADE_RATE_UNAVAILABLE = "unavailable"

/** The persisted section's schema version. Bumped only on a breaking change. */
export const OFFICIAL_GRADE_SCHEMA_VERSION = 1

// ── totals ──────────────────────────────────────────────────────────────────

/** One row of the per-language table. Same covering partition as the campaign,
 *  scoped to the instances whose assigned manifest row carried this language —
 *  INCLUDING its invalid and missing rows, so a language cannot look clean by
 *  having its broken instances quietly excluded. */
export interface OfficialGradeLanguageTotals {
  readonly assigned: number
  readonly attempted: number
  readonly grading_valid: number
  readonly resolved: number
  readonly model_miss: number
  readonly infra_invalid: number
  readonly ambiguous: number
  readonly missing: number
  readonly official_valid_rate: number | null
  readonly coverage: number | null
  readonly raw_rate: number | null
}

/**
 * The PMX-05 score contract. Field names are the on-disk names (snake_case) so
 * the report JSON, the ticket, and every reader speak one vocabulary.
 */
export interface OfficialGradeTotals {
  readonly assigned: number
  readonly attempted: number
  readonly grading_valid: number
  readonly resolved: number
  readonly model_miss: number
  readonly infra_invalid: number
  readonly ambiguous: number
  readonly missing: number
  /** resolved / grading_valid — `null` when nothing was validly graded. */
  readonly official_valid_rate: number | null
  /** grading_valid / assigned — `null` when nothing was assigned. */
  readonly coverage: number | null
  /** resolved / assigned — `null` when nothing was assigned. */
  readonly raw_rate: number | null
  readonly by_language: Readonly<Record<string, OfficialGradeLanguageTotals>>
  /** Disposition counts keyed by the PMX-03 reason, VERBATIM. Never re-mapped. */
  readonly by_reason: Readonly<Partial<Record<OfficialGradeReason, number>>>
}

// ── per-instance receipt ────────────────────────────────────────────────────

/** An immutable artifact pointer as persisted (snake_case on-disk names). */
export interface OfficialGradeArtifactRef {
  readonly path: string
  readonly sha256: string
  readonly byte_length: number
}

export interface OfficialGradeImageReceipt {
  /** The tag/ref the run asked for. A mutable tag alone is NOT replay evidence. */
  readonly source_ref: string
  readonly registry_digest: string
  readonly local_image_id: string
  readonly platform: string
}

export interface OfficialGradeDigestPair {
  readonly source_sha256: string | null
  readonly derived_sha256: string | null
}

/**
 * Per-instance replay metadata the report layer receives ALONGSIDE the PMX-03
 * receipt. Keyed by assigned instance id — including ids with no disposition, so
 * a `missing` row still contributes its language to the per-language table.
 */
export interface OfficialGradeInstanceMeta {
  readonly language?: string | undefined
  readonly predictionSha256?: string | null | undefined
  readonly goldenSourceSha256?: string | null | undefined
  readonly goldenDerivedSha256?: string | null | undefined
  readonly evalSourceSha256?: string | null | undefined
  readonly evalDerivedSha256?: string | null | undefined
  readonly image?:
    | {
        readonly sourceRef: string
        readonly registryDigest: string
        readonly localImageId: string
        readonly platform: string
      }
    | undefined
  readonly runId?: string | undefined
  readonly chunkId?: string | undefined
  readonly boxId?: string | undefined
  readonly attempts?: number | undefined
}

/** Campaign-wide replay provenance: which Quanta, which model, which budgets. */
export interface OfficialGradeCampaignMeta {
  readonly quantaSha: string
  /** Whether the tree was dirty. A dirty overlay is not a benchmark result. */
  readonly quantaDirty: boolean
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly preset?: string | undefined
  readonly turnBudget?: number | null | undefined
  readonly tokenWall?: number | null | undefined
  readonly runId?: string | undefined
  readonly chunkId?: string | undefined
  readonly boxId?: string | undefined
}

/** Per-instance run identity as persisted. */
export interface OfficialGradeRunReceipt {
  readonly provider: string
  readonly model: string
  readonly reasoning_effort: string | null
  readonly preset: string | null
  readonly turn_budget: number | null
  readonly token_wall: number | null
  readonly run_id: string | null
  readonly chunk_id: string | null
  readonly box_id: string | null
  readonly attempts: number
}

/**
 * The compact per-instance receipt. Everything an operator needs to say what
 * happened and to replay it — and NOTHING unbounded: grader stdout/stderr stay
 * in the retained artifact and are referenced by path + digest.
 */
export interface OfficialGradeInstanceReceipt {
  readonly instance_id: string
  readonly state: OfficialGradeState
  readonly reason: OfficialGradeReason
  readonly grading_valid: boolean
  readonly language: string
  readonly official: {
    /** The grader's own pass flag, AUDIT-ONLY (never the state's source). */
    readonly passed: boolean | null
    readonly model_final_result: string | null
    readonly golden_final_result: string | null
  }
  readonly raw_artifact: OfficialGradeArtifactRef | null
  readonly prediction_sha256: string | null
  readonly golden_digests: OfficialGradeDigestPair | null
  readonly eval_digests: OfficialGradeDigestPair | null
  readonly evaluator: {
    readonly id: string
    readonly upstream_commit: string
    readonly sha256: string
  }
  readonly image: OfficialGradeImageReceipt | null
  readonly quanta: { readonly sha: string; readonly dirty: boolean }
  readonly run: OfficialGradeRunReceipt
}

/** Campaign-level evaluator identity + observed invocation. */
export interface OfficialGradeEvaluatorReceipt {
  readonly id: string
  readonly upstream_commit: string
  readonly path: string
  readonly sha256: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly exit_code: number | null
  readonly output_artifact: OfficialGradeArtifactRef | null
}

/** The persisted `officialGrade` section of a SWE report. */
export interface OfficialGradeSection {
  readonly schema_version: number
  readonly totals: OfficialGradeTotals
  readonly evaluator: OfficialGradeEvaluatorReceipt
  readonly instances: readonly OfficialGradeInstanceReceipt[]
  /** Assigned ids with NO disposition. Named, never dropped — the coverage gap. */
  readonly missing_instance_ids: readonly string[]
}

// ── the covering-partition guard ────────────────────────────────────────────

/** Thrown when a totals object is not a covering partition of its assigned set,
 *  or when a rate disagrees with the counts it claims to summarize. */
export class OfficialGradePartitionError extends Error {
  constructor(message: string) {
    super(`official-grade partition: ${message}`)
    this.name = "OfficialGradePartitionError"
  }
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator

/** Rates are compared with a tolerance: a JSON round trip of an IEEE double is
 *  exact, but a hand-written report or a future re-serializer need not be. */
const RATE_EPSILON = 1e-12

const rateAgrees = (claimed: number | null, expected: number | null): boolean => {
  if (expected === null || claimed === null) return claimed === expected
  return Math.abs(claimed - expected) <= RATE_EPSILON
}

const checkPartition = (
  what: string,
  t: OfficialGradeLanguageTotals,
  fail: (message: string) => never,
): void => {
  const states = t.resolved + t.model_miss + t.infra_invalid + t.ambiguous
  if (states + t.missing !== t.assigned) {
    fail(
      `${what} assigned=${t.assigned} but resolved+model_miss+infra_invalid+ambiguous+missing=${
        states + t.missing
      }`,
    )
  }
  if (t.attempted !== t.assigned - t.missing) {
    fail(`${what} attempted=${t.attempted} but assigned-missing=${t.assigned - t.missing}`)
  }
  if (t.grading_valid !== t.resolved + t.model_miss) {
    fail(
      `${what} grading_valid=${t.grading_valid} but resolved+model_miss=${t.resolved + t.model_miss}`,
    )
  }
  if (!rateAgrees(t.official_valid_rate, rate(t.resolved, t.grading_valid))) {
    fail(`${what} official_valid_rate disagrees with resolved/grading_valid`)
  }
  if (!rateAgrees(t.coverage, rate(t.grading_valid, t.assigned))) {
    fail(`${what} coverage disagrees with grading_valid/assigned`)
  }
  if (!rateAgrees(t.raw_rate, rate(t.resolved, t.assigned))) {
    fail(`${what} raw_rate disagrees with resolved/assigned`)
  }
}

/**
 * Validate a totals object end to end: the campaign partition, every rate, and
 * the per-language table summing back to the campaign.
 *
 * Called at aggregation time AND at decode time, so a report that was hand-edited
 * — or produced by a future writer with a bug — fails closed instead of putting a
 * flattering number on a dashboard.
 */
export const assertOfficialGradeCoveringPartition = (totals: OfficialGradeTotals): void => {
  const fail = (message: string): never => {
    throw new OfficialGradePartitionError(message)
  }
  checkPartition("campaign", totals, fail)

  const sums = {
    assigned: 0,
    attempted: 0,
    grading_valid: 0,
    resolved: 0,
    model_miss: 0,
    infra_invalid: 0,
    ambiguous: 0,
    missing: 0,
  }
  for (const [language, row] of Object.entries(totals.by_language)) {
    checkPartition(`by_language[${language}]`, row, fail)
    sums.assigned += row.assigned
    sums.attempted += row.attempted
    sums.grading_valid += row.grading_valid
    sums.resolved += row.resolved
    sums.model_miss += row.model_miss
    sums.infra_invalid += row.infra_invalid
    sums.ambiguous += row.ambiguous
    sums.missing += row.missing
  }
  for (const key of Object.keys(sums) as (keyof typeof sums)[]) {
    if (sums[key] !== totals[key]) {
      fail(`by_language ${key} sums to ${sums[key]} but the campaign says ${totals[key]}`)
    }
  }

  const reasonTotal = Object.values(totals.by_reason).reduce<number>((a, b) => a + (b ?? 0), 0)
  if (reasonTotal !== totals.attempted) {
    fail(`by_reason counts ${reasonTotal} dispositions but attempted=${totals.attempted}`)
  }
}

// ── aggregation ─────────────────────────────────────────────────────────────

interface MutableCounts {
  assigned: number
  resolved: number
  model_miss: number
  infra_invalid: number
  ambiguous: number
  missing: number
}

const emptyCounts = (): MutableCounts => ({
  assigned: 0,
  resolved: 0,
  model_miss: 0,
  infra_invalid: 0,
  ambiguous: 0,
  missing: 0,
})

const finish = (c: MutableCounts): OfficialGradeLanguageTotals => {
  const grading_valid = c.resolved + c.model_miss
  return {
    assigned: c.assigned,
    attempted: c.assigned - c.missing,
    grading_valid,
    resolved: c.resolved,
    model_miss: c.model_miss,
    infra_invalid: c.infra_invalid,
    ambiguous: c.ambiguous,
    missing: c.missing,
    official_valid_rate: rate(c.resolved, grading_valid),
    coverage: rate(grading_valid, c.assigned),
    raw_rate: rate(c.resolved, c.assigned),
  }
}

/** `state` → the counter it increments. `Record<OfficialGradeState, …>` makes a
 *  fifth PMX-03 state a COMPILE error here rather than a row that silently
 *  vanishes from every bucket. */
const COUNTER_BY_STATE: Record<OfficialGradeState, keyof MutableCounts> = {
  resolved: "resolved",
  model_miss: "model_miss",
  infra_invalid: "infra_invalid",
  ambiguous: "ambiguous",
}

/**
 * Fold K persisted sections' totals into ONE campaign row.
 *
 * The dashboard's campaign rollup — the ranking surface — needs this, and it may
 * not compute it: a rate divided anywhere in `tools/leaderboard-dashboard/**` is
 * a second scoring authority, which a structural rail forbids and which is how
 * the two surfaces drift. So the fold lives here, beside the aggregation whose
 * `finish()` it reuses, and every rate is recomputed from the SUMMED counters
 * rather than averaged (averaging rates weights a 3-instance sidecar like a
 * 100-instance one).
 *
 * OVERLAP is deliberately NOT de-duplicated: these are totals, not ids, so an
 * instance graded in two sidecars is counted twice. That inflates the
 * DENOMINATOR — the conservative direction, which can only understate a rate —
 * and the coverage figure the caller shows beside it makes the inflation
 * visible. Silently picking one sidecar would be the flattering choice.
 *
 * Returns `undefined` for an empty list, and refuses (throws
 * {@link OfficialGradePartitionError}) if the sum is not a covering partition —
 * two legal sections always sum to one, so a violation means a member was
 * written by a producer with a bug and NEITHER number may be published.
 */
export const sumOfficialGradeTotals = (
  sections: readonly OfficialGradeTotals[],
): OfficialGradeTotals | undefined => {
  if (sections.length === 0) return undefined
  const campaign = emptyCounts()
  const byLanguage = new Map<string, MutableCounts>()
  const byReason: Record<string, number> = {}
  const add = (into: MutableCounts, row: OfficialGradeLanguageTotals): void => {
    into.assigned += row.assigned
    into.resolved += row.resolved
    into.model_miss += row.model_miss
    into.infra_invalid += row.infra_invalid
    into.ambiguous += row.ambiguous
    into.missing += row.missing
  }
  for (const section of sections) {
    add(campaign, section)
    for (const [language, row] of Object.entries(section.by_language)) {
      let bucket = byLanguage.get(language)
      if (bucket === undefined) {
        bucket = emptyCounts()
        byLanguage.set(language, bucket)
      }
      add(bucket, row)
    }
    for (const [reason, count] of Object.entries(section.by_reason)) {
      byReason[reason] = (byReason[reason] ?? 0) + (count ?? 0)
    }
  }
  const totals: OfficialGradeTotals = {
    ...finish(campaign),
    by_language: Object.fromEntries(
      [...byLanguage.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, finish(v)]),
    ),
    by_reason: byReason as OfficialGradeTotals["by_reason"],
  }
  assertOfficialGradeCoveringPartition(totals)
  return totals
}

/**
 * The totals of a campaign member that produced NO official section at all.
 *
 * C-C (aug-22): the rollup summed the members that HAD a section and dropped the
 * rest, so a campaign of eight sidecars with one graded file published
 * `resolved/assigned` over that one file — and a coverage string computed over
 * the same fraction. A member whose grader never delivered is not outside the
 * campaign; it is the campaign's coverage LOSS, which is exactly what `missing`
 * means. So its instances enter as assigned-and-missing: the denominator grows,
 * coverage falls, and the rate can only understate.
 *
 * The language is `unknown` because that is what it is — the member carries no
 * per-instance grade rows to attribute one from — and it keeps the per-language
 * table summing back to the campaign, which {@link assertOfficialGradeCoveringPartition}
 * requires.
 */
export const uncoveredOfficialGradeTotals = (assignedCount: number): OfficialGradeTotals => {
  const counts = emptyCounts()
  counts.assigned = assignedCount
  counts.missing = assignedCount
  const row = finish(counts)
  return {
    ...row,
    by_language: { [OFFICIAL_GRADE_UNKNOWN_LANGUAGE]: row },
    by_reason: {} as OfficialGradeTotals["by_reason"],
  }
}

export interface AggregateOfficialGradeInput {
  readonly receipt: OfficialGradeReceipt
  /** Per-assigned-instance replay metadata. Absent entries degrade to `unknown`
   *  language and null digests — never to a dropped row. */
  readonly instanceMeta?: ReadonlyMap<string, OfficialGradeInstanceMeta> | undefined
  readonly campaign: OfficialGradeCampaignMeta
}

const digestPair = (
  source: string | null | undefined,
  derived: string | null | undefined,
): OfficialGradeDigestPair | null =>
  source === undefined && derived === undefined
    ? null
    : { source_sha256: source ?? null, derived_sha256: derived ?? null }

const instanceReceipt = (
  d: OfficialGradeDisposition,
  meta: OfficialGradeInstanceMeta | undefined,
  evaluator: OfficialGradeEvaluatorMeta,
  campaign: OfficialGradeCampaignMeta,
): OfficialGradeInstanceReceipt => ({
  instance_id: d.instanceId,
  // VERBATIM from PMX-03 — this module never re-decides a disposition.
  state: d.state,
  reason: d.reason,
  grading_valid: d.gradingValid,
  language: meta?.language ?? OFFICIAL_GRADE_UNKNOWN_LANGUAGE,
  official: {
    passed: d.evaluator.passed,
    model_final_result: d.evaluator.model?.finalResult ?? null,
    golden_final_result: d.evaluator.golden?.finalResult ?? null,
  },
  raw_artifact:
    d.rawArtifact === null
      ? null
      : {
          path: d.rawArtifact.path,
          sha256: d.rawArtifact.sha256,
          byte_length: d.rawArtifact.byteLength,
        },
  prediction_sha256: meta?.predictionSha256 ?? null,
  golden_digests: digestPair(meta?.goldenSourceSha256, meta?.goldenDerivedSha256),
  eval_digests: digestPair(meta?.evalSourceSha256, meta?.evalDerivedSha256),
  evaluator: {
    id: evaluator.evaluatorId,
    upstream_commit: evaluator.upstreamCommit,
    sha256: evaluator.evaluatorSha256,
  },
  image:
    meta?.image === undefined
      ? null
      : {
          source_ref: meta.image.sourceRef,
          registry_digest: meta.image.registryDigest,
          local_image_id: meta.image.localImageId,
          platform: meta.image.platform,
        },
  quanta: { sha: campaign.quantaSha, dirty: campaign.quantaDirty },
  run: {
    provider: campaign.provider,
    model: campaign.model,
    reasoning_effort: campaign.reasoningEffort ?? null,
    preset: campaign.preset ?? null,
    turn_budget: campaign.turnBudget ?? null,
    token_wall: campaign.tokenWall ?? null,
    run_id: meta?.runId ?? campaign.runId ?? null,
    chunk_id: meta?.chunkId ?? campaign.chunkId ?? null,
    box_id: meta?.boxId ?? campaign.boxId ?? null,
    attempts: meta?.attempts ?? 1,
  },
})

/**
 * THE aggregation. Walks the assigned manifest exactly once, in assigned order,
 * so `missing` rows keep their place in the per-language table and no row can be
 * counted twice.
 *
 * The campaign counts are cross-checked against PMX-03's own
 * {@link summarizeOfficialGrade} before the section is returned: two independent
 * walks of the same receipt must agree, which is what makes this a projection of
 * PMX-03's authority rather than a second one.
 */
export const aggregateOfficialGrade = (
  input: AggregateOfficialGradeInput,
): OfficialGradeSection => {
  const { receipt, campaign } = input
  const meta = input.instanceMeta
  const campaignCounts = emptyCounts()
  const byLanguage = new Map<string, MutableCounts>()
  const byReason = new Map<OfficialGradeReason, number>()
  const instances: OfficialGradeInstanceReceipt[] = []

  for (const id of receipt.assignedInstanceIds) {
    const row = meta?.get(id)
    const language = row?.language ?? OFFICIAL_GRADE_UNKNOWN_LANGUAGE
    let bucket = byLanguage.get(language)
    if (bucket === undefined) {
      bucket = emptyCounts()
      byLanguage.set(language, bucket)
    }
    campaignCounts.assigned += 1
    bucket.assigned += 1

    const d = receipt.dispositionsByInstanceId.get(id)
    if (d === undefined) {
      // `missing` is DERIVED, never declared — this is the only branch that can
      // produce it, and it mirrors PMX-03's `deriveMissingInstanceIds` exactly.
      campaignCounts.missing += 1
      bucket.missing += 1
      continue
    }
    const counter = COUNTER_BY_STATE[d.state]
    campaignCounts[counter] += 1
    bucket[counter] += 1
    byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1)
    instances.push(instanceReceipt(d, row, receipt.evaluator, campaign))
  }

  const totals: OfficialGradeTotals = {
    ...finish(campaignCounts),
    by_language: Object.fromEntries(
      [...byLanguage.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, finish(v)]),
    ),
    by_reason: Object.fromEntries([...byReason.entries()]) as OfficialGradeTotals["by_reason"],
  }

  // Cross-check against PMX-03's own summary. A disagreement means one of the two
  // walks is wrong, and neither number may be published until that is resolved.
  const pmx03 = summarizeOfficialGrade(receipt)
  if (
    pmx03.assigned !== totals.assigned ||
    pmx03.resolved !== totals.resolved ||
    pmx03.modelMiss !== totals.model_miss ||
    pmx03.infraInvalid !== totals.infra_invalid ||
    pmx03.ambiguous !== totals.ambiguous ||
    pmx03.missing !== totals.missing ||
    pmx03.gradingValid !== totals.grading_valid
  ) {
    throw new OfficialGradePartitionError(
      "the report aggregation disagrees with the PMX-03 receipt summary — refusing to publish either",
    )
  }
  assertOfficialGradeCoveringPartition(totals)

  const out = receipt.evaluator.outputArtifact
  return {
    schema_version: OFFICIAL_GRADE_SCHEMA_VERSION,
    totals,
    evaluator: {
      id: receipt.evaluator.evaluatorId,
      upstream_commit: receipt.evaluator.upstreamCommit,
      path: receipt.evaluator.evaluatorPath,
      sha256: receipt.evaluator.evaluatorSha256,
      argv: [...receipt.evaluator.argv],
      cwd: receipt.evaluator.cwd,
      exit_code: receipt.evaluator.exitCode,
      output_artifact:
        out === null ? null : { path: out.path, sha256: out.sha256, byte_length: out.byteLength },
    },
    instances,
    missing_instance_ids: [...deriveMissingInstanceIds(receipt)],
  }
}

// ── decode (the persisted section's read boundary) ──────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new OfficialGradePartitionError(`${what} must be a finite number (got ${String(v)})`)
  }
  return v
}

const maybeRate = (v: unknown, what: string): number | null => (v === null ? null : num(v, what))

const decodeLanguageTotals = (v: unknown, what: string): OfficialGradeLanguageTotals => {
  if (!isRecord(v)) throw new OfficialGradePartitionError(`${what} must be an object`)
  return {
    assigned: num(v.assigned, `${what}.assigned`),
    attempted: num(v.attempted, `${what}.attempted`),
    grading_valid: num(v.grading_valid, `${what}.grading_valid`),
    resolved: num(v.resolved, `${what}.resolved`),
    model_miss: num(v.model_miss, `${what}.model_miss`),
    infra_invalid: num(v.infra_invalid, `${what}.infra_invalid`),
    ambiguous: num(v.ambiguous, `${what}.ambiguous`),
    missing: num(v.missing, `${what}.missing`),
    official_valid_rate: maybeRate(v.official_valid_rate, `${what}.official_valid_rate`),
    coverage: maybeRate(v.coverage, `${what}.coverage`),
    raw_rate: maybeRate(v.raw_rate, `${what}.raw_rate`),
  }
}

/**
 * Cross-check the section's ROWS against the totals the partition just
 * validated.
 *
 * The partition checks are arithmetic on `totals` alone: they prove the numbers
 * are self-consistent, and a hand edit that shrinks BOTH the row lists and the
 * counts satisfies them completely. These three checks are what tie the counts
 * to named instances, so a section cannot claim a denominator it cannot list:
 *
 *  - `missing_instance_ids` must name exactly `totals.missing` DISTINCT
 *    instances — a dropped id hides which rows the campaign lost, and a
 *    duplicated one pads the count back up without a second real instance;
 *  - `instances` must carry exactly `totals.attempted` rows, because the
 *    aggregation emits one receipt per disposition and `attempted` IS the
 *    disposition count;
 *  - the two lists must be DISJOINT: an instance cannot be both graded and
 *    missing, and an overlap means one of the two walks counted it twice.
 */
const assertSectionRowsMatchTotals = (
  totals: OfficialGradeTotals,
  instances: readonly OfficialGradeInstanceReceipt[],
  missingIds: readonly string[],
): void => {
  const fail = (message: string): never => {
    throw new OfficialGradePartitionError(message)
  }
  const uniqueMissing = new Set(missingIds)
  if (uniqueMissing.size !== missingIds.length) {
    const dup = missingIds.filter((id, i) => missingIds.indexOf(id) !== i)
    fail(
      `missing_instance_ids repeats ${[...new Set(dup)].join(", ")} — a name may go missing once`,
    )
  }
  if (missingIds.length !== totals.missing) {
    fail(
      `missing_instance_ids names ${missingIds.length} instance(s) but totals.missing=${totals.missing} — ` +
        "a denominator that cannot be listed is not a denominator",
    )
  }
  if (instances.length !== totals.attempted) {
    fail(
      `section.instances carries ${instances.length} row(s) but totals.attempted=${totals.attempted} — ` +
        "the covering partition emits exactly one instance receipt per disposition",
    )
  }
  const graded = new Set(instances.map((i) => i.instance_id))
  // C-B (aug-22): `instances.length === attempted` counted ROWS, never NAMES, so
  // a duplicated receipt padded `attempted` — and therefore `assigned` — with a
  // second copy of one instance. The same rule the missing list already had:
  // a denominator must be a set of distinct instances, not a row count.
  if (graded.size !== instances.length) {
    const ids = instances.map((i) => i.instance_id)
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
    fail(
      `section.instances repeats ${[...new Set(dup)].join(", ")} — ` +
        "one instance receipt per disposition, so a name may be graded once",
    )
  }
  const both = [...uniqueMissing].filter((id) => graded.has(id))
  if (both.length > 0) {
    fail(
      `${both.join(", ")} appear(s) BOTH in section.instances and in missing_instance_ids — ` +
        "an instance is graded or missing, never both",
    )
  }
}

/**
 * Read a persisted `officialGrade` section back, re-running the SAME covering-
 * partition validation as construction, PLUS the row/total cross-checks. A
 * section whose numbers drifted — by a hand edit, a truncated merge, or a filter
 * that dropped rows before the writer saw them — is REFUSED here rather than
 * rendered.
 *
 * The per-instance receipts are passed through structurally: they are pure
 * provenance, and losing a digest by re-typing each field would be worse than
 * carrying an unexpected one.
 */
export const decodeOfficialGradeSection = (raw: unknown): OfficialGradeSection => {
  if (!isRecord(raw)) throw new OfficialGradePartitionError("section must be an object")
  if (!isRecord(raw.totals))
    throw new OfficialGradePartitionError("section.totals must be an object")
  const byLanguageRaw = isRecord(raw.totals.by_language) ? raw.totals.by_language : {}
  const totals: OfficialGradeTotals = {
    ...decodeLanguageTotals(raw.totals, "totals"),
    by_language: Object.fromEntries(
      Object.entries(byLanguageRaw).map(([k, v]) => [
        k,
        decodeLanguageTotals(v, `by_language[${k}]`),
      ]),
    ),
    by_reason: isRecord(raw.totals.by_reason)
      ? (raw.totals.by_reason as OfficialGradeTotals["by_reason"])
      : {},
  }
  assertOfficialGradeCoveringPartition(totals)
  if (!Array.isArray(raw.instances)) {
    throw new OfficialGradePartitionError("section.instances must be an array")
  }
  if (!isRecord(raw.evaluator)) {
    throw new OfficialGradePartitionError("section.evaluator must be an object")
  }
  const instances = raw.instances as readonly OfficialGradeInstanceReceipt[]
  const missingIds = Array.isArray(raw.missing_instance_ids)
    ? (raw.missing_instance_ids as readonly string[])
    : []
  assertSectionRowsMatchTotals(totals, instances, missingIds)
  return {
    schema_version: num(raw.schema_version, "schema_version"),
    totals,
    evaluator: raw.evaluator as unknown as OfficialGradeEvaluatorReceipt,
    instances,
    missing_instance_ids: missingIds,
  }
}

// ── display projection (the ONE formatter every surface shares) ─────────────

export interface OfficialGradeReasonRow {
  readonly reason: string
  readonly state: string
  readonly count: number
}

export interface OfficialGradeLanguageRow {
  readonly language: string
  readonly assigned: number
  readonly resolved: number
  readonly model_miss: number
  readonly infra_invalid: number
  readonly ambiguous: number
  readonly missing: number
  readonly official_valid_rate: string
  readonly coverage: string
  readonly raw_rate: string
}

/**
 * Pre-rendered strings for every display surface.
 *
 * The dashboard is a browser bundle and cannot import this module, so the SERVER
 * projects these strings once and the client prints them. That is what makes the
 * CLI, the markdown export and the dashboard byte-identical by construction
 * instead of by three copies of a `toFixed(1)`.
 */
export interface OfficialGradeDisplay {
  readonly score: string
  readonly assigned: string
  readonly attempted: string
  readonly grading_valid: string
  readonly official_valid_rate: string
  readonly coverage: string
  readonly raw_rate: string
  readonly resolved: string
  readonly model_miss: string
  readonly infra_invalid: string
  readonly ambiguous: string
  readonly missing: string
  readonly languages: readonly OfficialGradeLanguageRow[]
  readonly reasons: readonly OfficialGradeReasonRow[]
}

/** `65/168 → "38.7% (65/168)"`; a zero denominator → `"unavailable (0/0)"`. */
const fmtRate = (value: number | null, numerator: number, denominator: number): string =>
  value === null
    ? `${OFFICIAL_GRADE_RATE_UNAVAILABLE} (${numerator}/${denominator})`
    : `${(value * 100).toFixed(1)}% (${numerator}/${denominator})`

/** Reason → state, read off PMX-03's own table so the drilldown cannot invent
 *  one. A new PMX-03 reason shows up here for free; a renamed one breaks loudly. */
const stateOfReason = (reason: string): string => {
  const table: Record<string, string> = OFFICIAL_GRADE_STATE_BY_REASON
  return table[reason] ?? "unknown"
}

export const formatOfficialGradeTotals = (totals: OfficialGradeTotals): OfficialGradeDisplay => ({
  score: `${totals.resolved} / ${totals.grading_valid}`,
  assigned: String(totals.assigned),
  attempted: String(totals.attempted),
  grading_valid: String(totals.grading_valid),
  official_valid_rate: fmtRate(totals.official_valid_rate, totals.resolved, totals.grading_valid),
  coverage: fmtRate(totals.coverage, totals.grading_valid, totals.assigned),
  raw_rate: fmtRate(totals.raw_rate, totals.resolved, totals.assigned),
  resolved: String(totals.resolved),
  model_miss: String(totals.model_miss),
  infra_invalid: String(totals.infra_invalid),
  ambiguous: String(totals.ambiguous),
  missing: String(totals.missing),
  languages: Object.entries(totals.by_language).map(([language, row]) => ({
    language,
    assigned: row.assigned,
    resolved: row.resolved,
    model_miss: row.model_miss,
    infra_invalid: row.infra_invalid,
    ambiguous: row.ambiguous,
    missing: row.missing,
    official_valid_rate: fmtRate(row.official_valid_rate, row.resolved, row.grading_valid),
    coverage: fmtRate(row.coverage, row.grading_valid, row.assigned),
    raw_rate: fmtRate(row.raw_rate, row.resolved, row.assigned),
  })),
  reasons: Object.entries(totals.by_reason)
    .map(([reason, count]) => ({ reason, state: stateOfReason(reason), count: count ?? 0 }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
})

/**
 * The operator's CLI summary. Reads the PERSISTED section — it never touches a
 * per-instance row — and prints the three rates on consecutive lines so a
 * flattering valid rate can never be quoted without its coverage.
 */
export const renderOfficialGradeCliLines = (section: OfficialGradeSection): readonly string[] => {
  const d = formatOfficialGradeTotals(section.totals)
  const lines = [
    `official-grade  assigned ${d.assigned} | attempted ${d.attempted} | grading-valid ${d.grading_valid}`,
    `  official_valid_rate ${d.official_valid_rate}`,
    `  coverage            ${d.coverage}`,
    `  raw_rate            ${d.raw_rate}`,
    `  states  resolved ${d.resolved} | model_miss ${d.model_miss} | infra_invalid ${d.infra_invalid} | ambiguous ${d.ambiguous} | missing ${d.missing}`,
    `  evaluator ${section.evaluator.id}@${section.evaluator.upstream_commit} (${section.evaluator.sha256.slice(0, 12)})`,
  ]
  for (const row of d.reasons) lines.push(`  reason  ${row.state}/${row.reason} = ${row.count}`)
  for (const row of d.languages) {
    lines.push(
      `  lang    ${row.language}: assigned ${row.assigned} | resolved ${row.resolved} | invalid ${row.infra_invalid} | ambiguous ${row.ambiguous} | missing ${row.missing} | coverage ${row.coverage}`,
    )
  }
  return lines
}

/** The markdown export. Same persisted totals, same three adjacent rates. */
export const renderOfficialGradeMarkdown = (section: OfficialGradeSection): string => {
  const d = formatOfficialGradeTotals(section.totals)
  const out: string[] = [
    "## Official grade",
    "",
    `- assigned: **${d.assigned}** · attempted: ${d.attempted} · grading-valid: ${d.grading_valid}`,
    `- official_valid_rate: **${d.official_valid_rate}**`,
    `- coverage: **${d.coverage}**`,
    `- raw_rate: **${d.raw_rate}**`,
    `- states: resolved ${d.resolved} · model_miss ${d.model_miss} · infra_invalid ${d.infra_invalid} · ambiguous ${d.ambiguous} · missing ${d.missing}`,
    `- evaluator: \`${section.evaluator.id}@${section.evaluator.upstream_commit}\``,
    "",
    "### By reason",
    "",
    "| state | reason | count |",
    "|---|---|---:|",
  ]
  for (const row of d.reasons) out.push(`| ${row.state} | ${row.reason} | ${row.count} |`)
  out.push("", "### By language", "")
  out.push(
    "| language | assigned | resolved | model_miss | infra_invalid | ambiguous | missing | coverage |",
  )
  out.push("|---|---:|---:|---:|---:|---:|---:|---|")
  for (const row of d.languages) {
    out.push(
      `| ${row.language} | ${row.assigned} | ${row.resolved} | ${row.model_miss} | ${row.infra_invalid} | ${row.ambiguous} | ${row.missing} | ${row.coverage} |`,
    )
  }
  return `${out.join("\n")}\n`
}
