/**
 * PMX-06 — THE FROZEN CAMPAIGN RECORD.
 *
 * The ticket's "Frozen campaign inputs" list is not documentation: *"Before
 * PMX-7, record …"*, and *"Do not use the implicit current default preset."*
 * This module is what makes "recorded" checkable — one typed, content-addressed
 * document produced BEFORE the first gate, and a precondition every gate reads.
 *
 * ## Why a record rather than a set of flags
 *
 * Every field here is something a campaign can quietly change between the canary
 * and the Full-170 run: a preset, a knob, a budget, the sample draw, the
 * continuation rule. A run that re-reads its configuration at each stage cannot
 * prove it ran ONE experiment. So the inputs are frozen once, hashed, and every
 * later stage cites the digest. The digest is what turns "we predeclared the
 * continuation rule" from a claim into an artefact: a rule edited after results
 * exist changes `sha256`, and the results no longer belong to this record (see
 * `gates.ts`, gate 4).
 *
 * ## The two refusals that carry the most weight
 *
 *  - PRESET. `preset: undefined` means "whatever the repo default is today",
 *    which is `agentless-v3-thin-strict` — the Pyright-only strict posture. Six
 *    of ProMax's seven languages cannot even launch under it, so the one that
 *    could would silently BE the cross-language headline. An absent preset is
 *    refused (`preset_implicit`), a preset that requires live LSP grounding is
 *    refused (`preset_not_portable`), and a preset no registry defines is
 *    refused (`preset_unknown`) because the resolver silently drops unknown
 *    ids — a typo'd arm would run as the bare baseline under a frozen name.
 *  - REASONING EFFORT. The record stores the DECISION, never the requested
 *    string. `decideReasoningEffort` is total and has no silent-drop arm, so a
 *    campaign that asks for `max` on the Responses wire (session vocabulary, not
 *    wire vocabulary) or for any effort at all on Anthropic Messages (no such
 *    field) is refused BEFORE it can publish a row claiming an effort the
 *    provider never received.
 *
 * PURE: data in, record out. No clock (`frozenAt` is supplied), no env, no
 * filesystem, no network. Nothing in this module can spend.
 */

import { decideReasoningEffort, isReasoningEffortHonest, type ReasoningEffortSurface } from "@/llm"
import { KNOB_PRESETS } from "@/runner/knobs"
import { errMessage } from "@/shared"
import { presetRequiresLiveLspGrounding } from "../../preset"
import {
  canonicalJson,
  PROMAX_SAMPLE_SPECS,
  type ProMaxSampleManifest,
  proMaxSampleManifestDigest,
} from "../corpus"
import { PROMAX_V1_SNAPSHOT, type ProMaxFrozenSnapshot, sha256Hex } from "../provenance"
import type { ProMaxOwnerAuditCounters, ProMaxOwnerAuditReceipt } from "./owner-audit"

export const PROMAX_CAMPAIGN_RECORD_VERSION = 1

// ── the frozen shapes ───────────────────────────────────────────────────────

export type ProMaxCampaignArmRole = "control" | "candidate"

/** One A/B arm, separately NAMED and frozen with its RESOLVED knob snapshot. */
export interface ProMaxCampaignArm {
  readonly role: ProMaxCampaignArmRole
  readonly name: string
  readonly preset: string
  readonly knobs: Readonly<Record<string, string>>
}

/** Arm as SUPPLIED: `preset` may be absent, which is exactly the hazard. */
export interface ProMaxCampaignArmInput extends Omit<ProMaxCampaignArm, "preset"> {
  readonly preset: string | undefined
}

export interface ProMaxCampaignBudgets {
  readonly maxTurns: number
  readonly maxTokens: number
  readonly wallClockMs: number
}

export interface ProMaxCampaignConcurrency {
  readonly patchGeneration: number
  readonly grading: number
}

export interface ProMaxCampaignModelInput {
  readonly provider: string
  readonly model: string
  readonly surface: ReasoningEffortSurface
  readonly reasoningEffortRequested: string | undefined
}

/** The recorded effort DECISION. `decision` is the discriminant of
 *  {@link decideReasoningEffort}; `delivered` is what reaches the wire. */
export interface ProMaxRecordedReasoningEffort {
  readonly requested: string | null
  readonly decision: "absent" | "delivered" | "rejected" | "unsupported"
  readonly delivered: string | null
  readonly surface: ReasoningEffortSurface
}

export interface ProMaxCampaignModel {
  readonly provider: string
  readonly model: string
  readonly reasoning_effort: ProMaxRecordedReasoningEffort
}

/**
 * The PMX-40 → Full-170 continuation rule. Every threshold is OPERATOR-DECLARED
 * — this module invents none, because a default threshold is a hidden decision
 * about when a campaign may spend.
 */
export interface ProMaxContinuationRule {
  /** ISO instant the rule was written. Must precede the freeze. */
  readonly declaredAt: string
  /** The rule in the operator's own words, retained verbatim for review. */
  readonly text: string
  readonly minPairedInstances: number
  /** candidate − control, in RESOLVED instances, required to continue. */
  readonly minResolvedDelta: number
  /** the cost/quality ceiling: candidate − control total spend, in USD. */
  readonly maxCostUsdDelta: number
}

/**
 * The retry policy. `exhaustedDisposition` is the literal `"missing"` — a TYPE,
 * not a value choice: the ticket says *"exhausted rows remain `missing`, never
 * model misses"*, so a policy that declared otherwise is a compile error rather
 * than a runtime argument.
 */
export interface ProMaxRetryPolicy {
  readonly maxChunkAttempts: number
  readonly exhaustedDisposition: "missing"
}

/**
 * The upstream-exception policy. Three of its four fields are literal types for
 * the same reason: *"Do not delete exceptions from assigned."*
 */
export interface ProMaxUpstreamExceptionPolicy {
  readonly manifestVersion: number
  readonly requiresOwner: true
  readonly requiresUpstreamReference: true
  readonly deletesFromAssigned: false
}

/** One frozen sample: the digest, the chain link, and the ORDERED ids. */
export interface ProMaxCampaignSampleRecord {
  readonly name: string
  readonly sha256: string
  readonly parentSubsetSha256: string | null
  readonly instanceIds: readonly string[]
}

export interface ProMaxCampaignUpstreamRecord {
  readonly git_commit: string
  readonly hf_dataset_revision: string
  readonly dataset_sha256: string
  readonly eval_sha256: string
  readonly evaluator_sha256: string
  readonly ids_sha256: string
  readonly dataset_count: number
}

/** The document. Field names are snake_case because this IS the on-disk record,
 *  exactly as PMX-00's manifest and PMX-04's freeze receipt are. */
export interface ProMaxFrozenCampaignRecord {
  readonly record_version: 1
  readonly campaign_id: string
  readonly frozen_at: string
  readonly quanta: { readonly sha: string; readonly dirty: boolean }
  readonly upstream: ProMaxCampaignUpstreamRecord
  readonly samples: readonly ProMaxCampaignSampleRecord[]
  readonly arms: readonly ProMaxCampaignArm[]
  readonly model: ProMaxCampaignModel
  readonly budgets: ProMaxCampaignBudgets
  readonly concurrency: ProMaxCampaignConcurrency
  readonly continuation_rule: ProMaxContinuationRule
  readonly retry_policy: ProMaxRetryPolicy
  readonly exception_policy: ProMaxUpstreamExceptionPolicy
  /**
   * The source-owner audit's verdict AND its ratchet counters.
   *
   * The ticket asks the freeze to record *"baseline and final counts of raw
   * family env reads, `family === "promax"` branches outside the registered
   * profile, and legacy verdict-bucket consumers"*. The digest binds those
   * numbers cryptographically, but a digest is not readable: an operator opening
   * `campaign-record.json` a month later, or a later ticket claiming the counts
   * went DOWN, needs the numbers themselves in the artefact.
   */
  readonly owner_audit: {
    readonly ok: true
    readonly digest: string
    readonly baseline: ProMaxOwnerAuditCounters
    readonly final: ProMaxOwnerAuditCounters
  }
  /** sha256 over the canonical form of every field above. */
  readonly sha256: string
}

export interface FreezeProMaxCampaignInput {
  readonly campaignId: string
  readonly frozenAt: string
  readonly quanta: { readonly sha: string; readonly dirty: boolean }
  readonly upstream: ProMaxFrozenSnapshot
  readonly samples: readonly ProMaxSampleManifest[]
  readonly arms: readonly ProMaxCampaignArmInput[]
  readonly model: ProMaxCampaignModelInput
  readonly budgets: ProMaxCampaignBudgets
  readonly concurrency: ProMaxCampaignConcurrency
  readonly continuationRule: ProMaxContinuationRule
  readonly retryPolicy: ProMaxRetryPolicy
  readonly exceptionPolicy: ProMaxUpstreamExceptionPolicy
  /**
   * The source-owner audit's VERDICT — a role view (`Pick`), not the whole
   * receipt: the freeze needs to know whether live spend is admitted and what to
   * cite, and taking the full receipt would let this module start depending on
   * the audit's internal shape.
   */
  readonly ownerAudit: Pick<
    ProMaxOwnerAuditReceipt,
    "ok" | "digest" | "unclassified" | "baseline" | "final"
  >
}

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * Every way a campaign can fail to freeze. Closed, and each member carries a
 * human reason: `Record<Code, string>` makes an unexplained refusal a COMPILE
 * error, and the runtime companion pins the other direction.
 */
export const PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS = {
  campaign_id_invalid: "the campaign id is absent or blank",
  quanta_sha_not_exact: "the Quanta commit is not an exact 40-hex object name",
  quanta_tree_dirty: "the tree was dirty — a dirty overlay is not a benchmark result",
  upstream_snapshot_drift: "the declared upstream identity differs from this build's frozen pin",
  sample_family_incomplete: "the nested sample family is not exactly PMX-7 ⊂ 14 ⊂ 40 ⊂ 170",
  sample_not_nested: "a sample does not CONTAIN the sample below it",
  sample_parent_digest_broken: "a sample does not name the digest of the sample it contains",
  sample_digest_invalid: "a sample manifest does not match its own sha256",
  sample_revision_mismatch: "a sample was drawn from a different dataset revision",
  preset_implicit: "an arm named no preset, which would inherit the implicit repo default",
  preset_unknown: "an arm named a preset no registry defines (the resolver drops it silently)",
  preset_not_portable: "an arm's preset requires live LSP grounding, which ProMax cannot provide",
  arm_roles_invalid: "the arms are not exactly one control and one candidate",
  arms_indistinguishable: "the two arms are the same configuration — a paired run with no variable",
  reasoning_effort_dishonest: "the requested reasoning effort will never reach the provider",
  budget_invalid: "a turn/token/wall budget is not a positive integer",
  concurrency_invalid: "a concurrency is not a positive integer",
  continuation_rule_not_predeclared: "the continuation rule was not written before the freeze",
  continuation_rule_incomplete: "the continuation rule is missing a declared threshold",
  retry_policy_invalid: "the retry policy allows fewer than one chunk attempt",
  owner_audit_unclassified: "the source-owner audit left an unclassified duplicate owner",
  owner_audit_counter_rose:
    "a source-owner ratchet counter rose above its baseline — the counts may only go down",
  record_unparseable: "the record document is not a well-formed frozen campaign record",
  record_digest_mismatch: "the record does not match its own sha256",
} as const satisfies Record<string, string>

export type ProMaxCampaignRecordFailureCode = keyof typeof PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS

export const PROMAX_CAMPAIGN_RECORD_FAILURE_CODES = Object.keys(
  PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS,
) as readonly ProMaxCampaignRecordFailureCode[]

export interface ProMaxCampaignRecordFailure {
  readonly code: ProMaxCampaignRecordFailureCode
  readonly message: string
}

export type ProMaxCampaignRecordResult =
  | { readonly ok: true; readonly record: ProMaxFrozenCampaignRecord }
  | { readonly ok: false; readonly failures: readonly ProMaxCampaignRecordFailure[] }

// ── the freeze ──────────────────────────────────────────────────────────────

const EXACT_SHA = /^[0-9a-f]{40}$/
const positiveInt = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value > 0

const SAMPLE_FAMILY_NAMES = PROMAX_SAMPLE_SPECS.map((spec) => spec.name)

/** The three Foundation-gate counters, as the KEYS the ratchet iterates. */
const OWNER_AUDIT_COUNTER_KEYS = [
  "rawFamilyEnvReads",
  "promaxBranchesOutsideProfile",
  "legacyVerdictConsumers",
] as const satisfies readonly (keyof ProMaxOwnerAuditCounters)[]

/** Digest over the record BODY (everything except `sha256`). */
const recordDigest = (record: Omit<ProMaxFrozenCampaignRecord, "sha256">): string =>
  sha256Hex(canonicalJson(record))

const auditSamples = (
  samples: readonly ProMaxSampleManifest[],
  add: (code: ProMaxCampaignRecordFailureCode, message: string) => void,
): void => {
  const names = samples.map((s) => s.name)
  if (
    names.length !== SAMPLE_FAMILY_NAMES.length ||
    names.some((n, i) => n !== SAMPLE_FAMILY_NAMES[i])
  ) {
    add(
      "sample_family_incomplete",
      `the campaign froze [${names.join(", ")}] but invariant 8 requires exactly ` +
        `[${SAMPLE_FAMILY_NAMES.join(", ")}] in nesting order`,
    )
    return
  }
  samples.forEach((sample, index) => {
    const recomputed = proMaxSampleManifestDigest(sample)
    if (recomputed !== sample.sha256) {
      add(
        "sample_digest_invalid",
        `${sample.name} declares sha256 ${sample.sha256} but its body hashes to ${recomputed} — ` +
          "a hand-edited manifest, not a drawn sample",
      )
    }
    if (sample.datasetRevision !== PROMAX_V1_SNAPSHOT.hf_dataset_revision) {
      add(
        "sample_revision_mismatch",
        `${sample.name} was drawn from dataset revision ${sample.datasetRevision}, but this build ` +
          `grades ProMax against ${PROMAX_V1_SNAPSHOT.hf_dataset_revision}`,
      )
    }
    const parent = index === 0 ? null : (samples[index - 1] ?? null)
    if (parent === null) {
      if (sample.parentSubsetSha256 !== null) {
        add(
          "sample_parent_digest_broken",
          `${sample.name} is the smallest sample but names a parent subset digest`,
        )
      }
      return
    }
    if (sample.parentSubsetSha256 !== parent.sha256) {
      add(
        "sample_parent_digest_broken",
        `${sample.name} names parent digest ${String(sample.parentSubsetSha256)} but the sample it ` +
          `must contain (${parent.name}) hashes to ${parent.sha256}`,
      )
    }
    const contained = new Set(sample.instanceIds)
    const escaped = parent.instanceIds.filter((id) => !contained.has(id))
    if (escaped.length > 0) {
      add(
        "sample_not_nested",
        `${parent.name} ⊄ ${sample.name}: ${escaped.length} instance(s) are in the smaller sample ` +
          `but not the larger (${escaped.slice(0, 3).join(", ")}) — these are independent draws, ` +
          "not one nested family",
      )
    }
  })
}

const auditArms = (
  arms: readonly ProMaxCampaignArmInput[],
  add: (code: ProMaxCampaignRecordFailureCode, message: string) => void,
): void => {
  const roles = arms.map((a) => a.role)
  if (arms.length !== 2 || !roles.includes("control") || !roles.includes("candidate")) {
    add(
      "arm_roles_invalid",
      `a paired campaign has exactly one control and one candidate arm; got [${roles.join(", ")}]`,
    )
  }
  for (const arm of arms) {
    const preset = arm.preset?.trim()
    if (preset === undefined || preset === "") {
      add(
        "preset_implicit",
        `arm "${arm.name}" named no preset, so it would inherit whatever the repo default is at ` +
          "launch time — the ticket forbids the implicit current default preset",
      )
      continue
    }
    if (!Object.hasOwn(KNOB_PRESETS, preset)) {
      add(
        "preset_unknown",
        `arm "${arm.name}" names preset "${preset}", which no preset registry defines — the knob ` +
          "resolver drops unknown ids silently, so this arm would run as the bare baseline",
      )
    }
    if (presetRequiresLiveLspGrounding(preset)) {
      add(
        "preset_not_portable",
        `arm "${arm.name}" names preset "${preset}", which requires LIVE LSP grounding; the remote ` +
          "box proves only pyright, and ProMax spans C / C++ / Go / Java / Python / Rust / TypeScript",
      )
    }
  }
  if (arms.length === 2) {
    const [a, b] = arms as readonly [ProMaxCampaignArmInput, ProMaxCampaignArmInput]
    if (a.preset === b.preset && canonicalJson(a.knobs) === canonicalJson(b.knobs)) {
      add(
        "arms_indistinguishable",
        `arms "${a.name}" and "${b.name}" resolve to the same preset and knob snapshot — a paired ` +
          "experiment with no independent variable measures nothing",
      )
    }
  }
}

/**
 * The POLICY half of the freeze: budgets, concurrency, retry policy, and the
 * continuation rule. Extracted so each clause is named — and so the freeze reads
 * as identity → samples → arms → model → policy rather than one long wall.
 */
const auditPolicies = (
  input: FreezeProMaxCampaignInput,
  add: (code: ProMaxCampaignRecordFailureCode, message: string) => void,
): void => {
  for (const [name, value] of Object.entries(input.budgets)) {
    if (!positiveInt(value)) add("budget_invalid", `budget "${name}" is ${String(value)}`)
  }
  for (const [name, value] of Object.entries(input.concurrency)) {
    if (!positiveInt(value)) add("concurrency_invalid", `concurrency "${name}" is ${String(value)}`)
  }
  if (!positiveInt(input.retryPolicy.maxChunkAttempts)) {
    add(
      "retry_policy_invalid",
      `maxChunkAttempts is ${String(input.retryPolicy.maxChunkAttempts)} — a chunk must be allowed ` +
        "at least one attempt before its rows may be called missing",
    )
  }
  const rule = input.continuationRule
  if (rule.declaredAt.trim() === "" || rule.declaredAt >= input.frozenAt) {
    add(
      "continuation_rule_not_predeclared",
      `the continuation rule is dated ${rule.declaredAt || "(absent)"} but the campaign froze at ` +
        `${input.frozenAt} — the rule must exist BEFORE the campaign that will be judged by it`,
    )
  }
  if (
    rule.text.trim() === "" ||
    !Number.isFinite(rule.minPairedInstances) ||
    !Number.isFinite(rule.minResolvedDelta) ||
    !Number.isFinite(rule.maxCostUsdDelta)
  ) {
    add(
      "continuation_rule_incomplete",
      PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS.continuation_rule_incomplete,
    )
  }
}

/**
 * Freeze the campaign, or refuse it with EVERY defect at once (an operator
 * fixing a frozen record should not discover its problems one launch at a time).
 */
export const freezeProMaxCampaignRecord = (
  input: FreezeProMaxCampaignInput,
): ProMaxCampaignRecordResult => {
  const failures: ProMaxCampaignRecordFailure[] = []
  const add = (code: ProMaxCampaignRecordFailureCode, message: string): void => {
    failures.push({ code, message })
  }

  if (input.campaignId.trim() === "") {
    add("campaign_id_invalid", PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS.campaign_id_invalid)
  }
  if (!EXACT_SHA.test(input.quanta.sha)) {
    add(
      "quanta_sha_not_exact",
      `quanta sha "${input.quanta.sha}" is not a 40-hex object name — an abbreviated or symbolic ` +
        "ref cannot identify the exact tree a campaign ran from",
    )
  }
  if (input.quanta.dirty) {
    add("quanta_tree_dirty", PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS.quanta_tree_dirty)
  }

  const drift = (Object.keys(PROMAX_V1_SNAPSHOT) as (keyof ProMaxFrozenSnapshot)[]).filter(
    (key) => canonicalJson(input.upstream[key]) !== canonicalJson(PROMAX_V1_SNAPSHOT[key]),
  )
  if (drift.length > 0) {
    add(
      "upstream_snapshot_drift",
      `the campaign declares upstream fields [${drift.join(", ")}] that differ from this build's ` +
        "frozen snapshot — a re-freeze is a reviewable manifest diff, never an in-place refresh",
    )
  }

  auditSamples(input.samples, add)
  auditArms(input.arms, add)

  const decision = decideReasoningEffort(input.model.reasoningEffortRequested, input.model.surface)
  if (!isReasoningEffortHonest(decision)) {
    add(
      "reasoning_effort_dishonest",
      `reasoning effort "${String(input.model.reasoningEffortRequested)}" is "${decision.kind}" on ` +
        `surface ${input.model.surface} — it will never reach the provider, and a campaign may not ` +
        "publish an effort it did not send",
    )
  }

  auditPolicies(input, add)

  if (!input.ownerAudit.ok) {
    add(
      "owner_audit_unclassified",
      `the source-owner audit reported ${input.ownerAudit.unclassified.length} unclassified hit(s) ` +
        `(${input.ownerAudit.unclassified.slice(0, 3).join("; ")}) — unclassified duplicates block ` +
        "live spend",
    )
  }
  // The counters are recorded so the ratchet is auditable; refusing a RISE here
  // is what makes recording them more than bookkeeping. (`auditProMaxSourceOwners`
  // reports the same rise as a problem, so a live audit fails first — this clause
  // is what stops a caller supplying counters by hand.)
  const risen = OWNER_AUDIT_COUNTER_KEYS.filter(
    (key) => input.ownerAudit.final[key] > input.ownerAudit.baseline[key],
  )
  if (risen.length > 0) {
    add(
      "owner_audit_counter_rose",
      `source-owner counter(s) ${risen
        .map((k) => `${k} ${input.ownerAudit.baseline[k]} → ${input.ownerAudit.final[k]}`)
        .join(
          ", ",
        )} rose above the recorded baseline — these counts are a ratchet and may only go down`,
    )
  }

  if (failures.length > 0) return { ok: false, failures }

  const body: Omit<ProMaxFrozenCampaignRecord, "sha256"> = {
    record_version: PROMAX_CAMPAIGN_RECORD_VERSION,
    campaign_id: input.campaignId,
    frozen_at: input.frozenAt,
    quanta: { sha: input.quanta.sha, dirty: input.quanta.dirty },
    upstream: {
      git_commit: input.upstream.upstream_git_commit,
      hf_dataset_revision: input.upstream.hf_dataset_revision,
      dataset_sha256: input.upstream.dataset_sha256,
      eval_sha256: input.upstream.eval_sha256,
      evaluator_sha256: input.upstream.evaluator_sha256,
      ids_sha256: input.upstream.ids_sha256,
      dataset_count: input.upstream.dataset_count,
    },
    samples: input.samples.map((s) => ({
      name: s.name,
      sha256: s.sha256,
      parentSubsetSha256: s.parentSubsetSha256,
      instanceIds: [...s.instanceIds],
    })),
    arms: input.arms.map((a) => ({
      role: a.role,
      name: a.name,
      preset: String(a.preset),
      knobs: { ...a.knobs },
    })),
    model: {
      provider: input.model.provider,
      model: input.model.model,
      reasoning_effort: {
        requested: input.model.reasoningEffortRequested ?? null,
        decision: decision.kind,
        delivered: decision.kind === "delivered" ? decision.effort : null,
        surface: input.model.surface,
      },
    },
    budgets: { ...input.budgets },
    concurrency: { ...input.concurrency },
    continuation_rule: { ...input.continuationRule },
    retry_policy: { ...input.retryPolicy },
    exception_policy: { ...input.exceptionPolicy },
    owner_audit: {
      ok: true,
      digest: input.ownerAudit.digest,
      baseline: { ...input.ownerAudit.baseline },
      final: { ...input.ownerAudit.final },
    },
  }
  return { ok: true, record: { ...body, sha256: recordDigest(body) } }
}

export const serializeProMaxCampaignRecord = (record: ProMaxFrozenCampaignRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// ── reading a record back: SHAPE, then digest ───────────────────────────────

/**
 * The digest proves a document was not EDITED. It cannot prove the document was
 * ever a record: anything can be hashed, and a hand-authored or truncated file
 * carries a perfectly valid `sha256` over its own body. Every gate then reads
 * `record.samples`, `record.arms`, `record.continuation_rule` straight off the
 * parse result, so a digest-only parser turns a malformed artefact into a
 * TypeError inside the operator command — a CRASH where the contract is an exit
 * code, and a crash is not a refusal an operator can act on.
 *
 * So the parse validates the SHAPE of every field the gates read before it
 * returns `ok`. These predicates are deliberately structural, not semantic:
 * `freezeProMaxCampaignRecord` owns the policy (is the preset portable, is the
 * rule predeclared) and re-litigating it here would put the campaign's meaning
 * in two places.
 */
const isStr = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecordObject(value) ? value : null

const isSampleShape = (value: unknown): boolean => {
  const s = asRecord(value)
  return (
    s !== null &&
    isStr(s.name) &&
    isStr(s.sha256) &&
    (s.parentSubsetSha256 === null || isStr(s.parentSubsetSha256)) &&
    Array.isArray(s.instanceIds) &&
    s.instanceIds.every(isStr)
  )
}

const isArmShape = (value: unknown): boolean => {
  const a = asRecord(value)
  return (
    a !== null &&
    (a.role === "control" || a.role === "candidate") &&
    isStr(a.name) &&
    isStr(a.preset) &&
    asRecord(a.knobs) !== null
  )
}

const isModelShape = (value: unknown): boolean => {
  const m = asRecord(value)
  if (m === null || !isStr(m.provider) || !isStr(m.model)) return false
  const effort = asRecord(m.reasoning_effort)
  return (
    effort !== null &&
    (effort.requested === null || isStr(effort.requested)) &&
    isStr(effort.decision) &&
    (effort.delivered === null || isStr(effort.delivered)) &&
    isStr(effort.surface)
  )
}

const hasNumbers = (value: unknown, fields: readonly string[]): boolean => {
  const v = asRecord(value)
  return v !== null && fields.every((field) => isNum(v[field]))
}

const isRuleShape = (value: unknown): boolean => {
  const r = asRecord(value)
  return (
    r !== null &&
    isStr(r.declaredAt) &&
    isStr(r.text) &&
    hasNumbers(r, ["minPairedInstances", "minResolvedDelta", "maxCostUsdDelta"])
  )
}

const isRetryShape = (value: unknown): boolean => {
  const r = asRecord(value)
  return r !== null && isNum(r.maxChunkAttempts) && r.exhaustedDisposition === "missing"
}

const isExceptionPolicyShape = (value: unknown): boolean => {
  const p = asRecord(value)
  return (
    p !== null &&
    isNum(p.manifestVersion) &&
    p.requiresOwner === true &&
    p.requiresUpstreamReference === true &&
    p.deletesFromAssigned === false
  )
}

const UPSTREAM_STRING_FIELDS = [
  "git_commit",
  "hf_dataset_revision",
  "dataset_sha256",
  "eval_sha256",
  "evaluator_sha256",
  "ids_sha256",
] as const

/** Every structural defect at once, named by field. */
const recordShapeProblems = (body: Record<string, unknown>): readonly string[] => {
  const problems: string[] = []
  const need = (ok: boolean, what: string): void => {
    if (!ok) problems.push(what)
  }
  const quanta = asRecord(body.quanta)
  const upstream = asRecord(body.upstream)

  need(isStr(body.campaign_id), "`campaign_id` must be a non-blank string")
  need(isStr(body.frozen_at), "`frozen_at` must be a non-blank instant")
  need(
    quanta !== null && isStr(quanta.sha) && typeof quanta.dirty === "boolean",
    "`quanta` must carry a string `sha` and a boolean `dirty`",
  )
  need(
    upstream !== null &&
      UPSTREAM_STRING_FIELDS.every((field) => isStr(upstream[field])) &&
      isNum(upstream.dataset_count),
    "`upstream` must carry the frozen snapshot's identity fields",
  )
  need(
    Array.isArray(body.samples) && body.samples.every(isSampleShape),
    "`samples` must be an array of {name, sha256, parentSubsetSha256, instanceIds[]}",
  )
  need(
    Array.isArray(body.arms) && body.arms.every(isArmShape),
    "`arms` must be an array of {role, name, preset, knobs}",
  )
  need(
    isModelShape(body.model),
    "`model` must carry provider, model and a reasoning_effort DECISION",
  )
  need(
    hasNumbers(body.budgets, ["maxTurns", "maxTokens", "wallClockMs"]),
    "`budgets` must carry numeric maxTurns, maxTokens and wallClockMs",
  )
  need(
    hasNumbers(body.concurrency, ["patchGeneration", "grading"]),
    "`concurrency` must carry numeric patchGeneration and grading",
  )
  need(
    isRuleShape(body.continuation_rule),
    "`continuation_rule` must carry declaredAt, text and its three declared thresholds",
  )
  need(
    isRetryShape(body.retry_policy),
    '`retry_policy` must carry maxChunkAttempts and exhaustedDisposition "missing"',
  )
  need(
    isExceptionPolicyShape(body.exception_policy),
    "`exception_policy` must keep every excepted instance in `assigned`",
  )
  const audit = asRecord(body.owner_audit)
  need(
    audit !== null &&
      audit.ok === true &&
      isStr(audit.digest) &&
      hasNumbers(audit.baseline, OWNER_AUDIT_COUNTER_KEYS) &&
      hasNumbers(audit.final, OWNER_AUDIT_COUNTER_KEYS),
    "`owner_audit` must record an ADMITTING source-owner audit, its digest, and its baseline/final counters",
  )
  return problems
}

/**
 * Read a persisted record back, fail-closed.
 *
 * The digest check is the load-bearing half: a campaign artefact travels between
 * machines and sits on disk while its results are produced, so "this is the
 * record the run was frozen against" has to be a property of the BYTES. The
 * shape check above is what makes the digest's guarantee usable — see its doc.
 */
export const parseProMaxCampaignRecord = (text: string): ProMaxCampaignRecordResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          code: "record_unparseable",
          message: `not valid JSON (${errMessage(err)})`,
        },
      ],
    }
  }
  if (!isRecordObject(parsed) || parsed.record_version !== PROMAX_CAMPAIGN_RECORD_VERSION) {
    return {
      ok: false,
      failures: [
        {
          code: "record_unparseable",
          message: `not a version-${PROMAX_CAMPAIGN_RECORD_VERSION} frozen campaign record`,
        },
      ],
    }
  }
  const declared = parsed.sha256
  if (typeof declared !== "string" || !/^[0-9a-f]{64}$/.test(declared)) {
    return {
      ok: false,
      failures: [{ code: "record_unparseable", message: "the record carries no sha256" }],
    }
  }
  const { sha256: _declared, ...body } = parsed
  const shape = recordShapeProblems(body)
  if (shape.length > 0) {
    return {
      ok: false,
      failures: [
        {
          code: "record_unparseable",
          message:
            `the document carries a well-formed sha256 but is not a frozen campaign record: ` +
            `${shape.join("; ")} — a digest proves a file was not EDITED, never that it was ever a record`,
        },
      ],
    }
  }
  const recomputed = sha256Hex(canonicalJson(body))
  if (recomputed !== declared) {
    return {
      ok: false,
      failures: [
        {
          code: "record_digest_mismatch",
          message:
            `the record declares sha256 ${declared} but its body hashes to ${recomputed} — ` +
            "REFUSING an edited campaign record; re-freeze it instead of tuning it",
        },
      ],
    }
  }
  return { ok: true, record: parsed as unknown as ProMaxFrozenCampaignRecord }
}

/** The frozen sample a stage is accountable for, by name. */
export const proMaxCampaignSample = (
  record: ProMaxFrozenCampaignRecord,
  name: string,
): ProMaxCampaignSampleRecord | undefined => record.samples.find((s) => s.name === name)
