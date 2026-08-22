/**
 * PMX-04 — the `campaign-golden.json` derivation and its structural proof.
 *
 * ## Why this file exists at all
 *
 * The pinned evaluator is immutable (packet invariant 4), and at the pinned
 * commit it resolves an instance's image like this:
 *
 * ```python
 * image_name = golden_entry.get("image_name") or f"key4127/refactor-dockerhub:{instance_id}"
 * ...
 * run_command(f'docker pull {image_name}', timeout=300)
 * ```
 *
 * Both branches yield a MUTABLE TAG. Two runs of the "same" campaign can
 * therefore execute different image content, which packet invariant 6 forbids
 * ("mutable tags alone are not replay evidence"). We may not patch `test_run.py`
 * and we may not reimplement it, so the only legal repair is to change what the
 * evaluator READS: a campaign-local golden document in which each row's
 * `image_name` is already a digest-pinned reference. `docker pull repo@sha256:…`
 * is content-addressed, so the same campaign bundle reproduces the same image
 * bytes forever.
 *
 * ## Why the change must be PROVED, not asserted
 *
 * The golden document is also the evaluator's source of `patch` (the reference
 * patch), `language`, and `repo` — i.e. rewriting it is rewriting the ground
 * truth. A derivation that "helpfully" normalized `working_dir`, dropped an
 * unknown key, or reordered rows would silently fork the benchmark. So the
 * derivation is mechanical AND accompanied by {@link diffGoldenDocuments}, a
 * structural diff whose only permitted delta is `image_name`; everything else —
 * added key, removed key, changed value, changed row ORDER, changed row COUNT —
 * is a typed violation.
 *
 * Pure: bytes in, bytes + verdict out. No Docker, no filesystem, no clock.
 */
import { sha256Hex } from "@/apps/bench/promax/provenance"

/** The one field a campaign golden may differ from its source on. */
export const CAMPAIGN_GOLDEN_MUTABLE_FIELD = "image_name"

/** A digest-addressed image reference: `<name>@sha256:<64 lowercase hex>`. */
const DIGEST_REFERENCE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

/** Per-instance replacement: the digest-pinned reference the freeze resolved. */
export interface CampaignGoldenPin {
  readonly instanceId: string
  /** `repo@sha256:…`. A tag here would defeat the whole derivation. */
  readonly pinnedReference: string
}

export type GoldenDerivationFailureCode =
  | "source_unparseable"
  | "source_not_array"
  | "row_not_object"
  | "instance_id_invalid"
  | "instance_id_duplicated"
  | "image_name_absent"
  | "pin_missing"
  | "pin_not_digest"
  | "pin_unknown_instance"

export interface GoldenDerivationFailure {
  readonly code: GoldenDerivationFailureCode
  readonly message: string
}

export interface CampaignGoldenDerived {
  readonly ok: true
  /** The derived document's exact bytes (UTF-8 text). */
  readonly json: string
  /** sha256 of the EXACT source bytes supplied — campaign-receipt evidence. */
  readonly sourceSha256: string
  /** sha256 of the EXACT derived bytes emitted — campaign-receipt evidence. */
  readonly derivedSha256: string
  /** One entry per row: the `image_name` replacement that was performed. */
  readonly changes: readonly GoldenFieldChange[]
}

export interface CampaignGoldenRejected {
  readonly ok: false
  readonly failures: readonly GoldenDerivationFailure[]
}

export type CampaignGoldenDerivation = CampaignGoldenDerived | CampaignGoldenRejected

export interface DeriveCampaignGoldenInput {
  /** The VERIFIED upstream golden document (PMX-00 hashed these bytes). */
  readonly sourceText: string
  readonly pins: readonly CampaignGoldenPin[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""

/** Parse the document into an ordered row array, or a typed refusal. */
const parseRows = (
  text: string,
  label: string,
): { readonly ok: true; readonly rows: readonly unknown[] } | CampaignGoldenRejected => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          code: "source_unparseable",
          message: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failures: [
        {
          code: "source_not_array",
          message: `${label} is not a JSON array (upstream's \`--golden\` list form); got ${typeof value}`,
        },
      ],
    }
  }
  return { ok: true, rows: value }
}

/**
 * Derive the campaign golden document.
 *
 * The row objects are mutated IN PLACE on an already-parsed copy, so the
 * existing key keeps its position and every other key — including keys this code
 * has never heard of, which upstream rows genuinely have (rows are not
 * key-uniform at the pinned commit) — survives untouched.
 */
export const deriveCampaignGolden = (
  input: DeriveCampaignGoldenInput,
): CampaignGoldenDerivation => {
  const parsed = parseRows(input.sourceText, "source golden document")
  if (!parsed.ok) return parsed

  const pinByInstance = new Map<string, string>()
  const failures: GoldenDerivationFailure[] = []
  for (const pin of input.pins) {
    if (!nonBlank(pin.instanceId)) {
      failures.push({
        code: "instance_id_invalid",
        message: `a pin has an absent or blank instanceId: ${JSON.stringify(pin.instanceId)}`,
      })
      continue
    }
    pinByInstance.set(pin.instanceId, pin.pinnedReference)
  }

  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const changes: GoldenFieldChange[] = []

  parsed.rows.forEach((raw, index) => {
    if (!isRecord(raw)) {
      failures.push({
        code: "row_not_object",
        message: `golden row ${index} is not a JSON object (got ${Array.isArray(raw) ? "array" : typeof raw})`,
      })
      return
    }
    const row = { ...raw }
    const instanceId = row.instance_id
    if (!nonBlank(instanceId)) {
      failures.push({
        code: "instance_id_invalid",
        message: `golden row ${index} has an absent or blank instance_id`,
      })
      return
    }
    if (seen.has(instanceId)) {
      failures.push({
        code: "instance_id_duplicated",
        message: `instance "${instanceId}" appears more than once in the golden document — two rows would race for one image pin`,
      })
      return
    }
    seen.add(instanceId)

    const sourceImageName = row[CAMPAIGN_GOLDEN_MUTABLE_FIELD]
    if (!nonBlank(sourceImageName)) {
      // Upstream substitutes `key4127/refactor-dockerhub:<id>` for a falsy value,
      // so a blank here is not "no image" — it is a SILENT mutable tag.
      failures.push({
        code: "image_name_absent",
        message: `instance "${instanceId}" has an absent or blank \`image_name\`; the pinned evaluator would substitute a mutable tag`,
      })
      rows.push(row)
      return
    }

    const pinned = pinByInstance.get(instanceId)
    if (pinned === undefined) {
      failures.push({
        code: "pin_missing",
        message: `instance "${instanceId}" has no resolved image pin — deriving without one would leave the mutable tag "${sourceImageName}" in the campaign golden`,
      })
      rows.push(row)
      return
    }
    if (!DIGEST_REFERENCE_RE.test(pinned)) {
      failures.push({
        code: "pin_not_digest",
        message: `instance "${instanceId}" pin "${pinned}" is not digest-addressed (expected \`name@sha256:<64 hex>\`)`,
      })
      rows.push(row)
      return
    }

    row[CAMPAIGN_GOLDEN_MUTABLE_FIELD] = pinned
    changes.push({
      index,
      instanceId,
      field: CAMPAIGN_GOLDEN_MUTABLE_FIELD,
      from: sourceImageName,
      to: pinned,
    })
    rows.push(row)
  })

  for (const pin of input.pins) {
    if (nonBlank(pin.instanceId) && !seen.has(pin.instanceId)) {
      failures.push({
        code: "pin_unknown_instance",
        message: `image pin names instance "${pin.instanceId}", which is not in the golden document — a pin that matches nothing means the freeze and the corpus disagree`,
      })
    }
  }

  if (failures.length > 0) return { ok: false, failures }

  const json = JSON.stringify(rows, null, 2)
  return {
    ok: true,
    json,
    sourceSha256: sha256Hex(input.sourceText),
    derivedSha256: sha256Hex(json),
    changes,
  }
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface GoldenFieldChange {
  readonly index: number
  readonly instanceId: string
  readonly field: string
  readonly from: string
  readonly to: string
}

export type GoldenDiffViolationCode =
  | "row_count_changed"
  | "row_order_changed"
  | "field_added"
  | "field_removed"
  | "field_changed"

export interface GoldenDiffViolation {
  readonly code: GoldenDiffViolationCode
  readonly index: number
  readonly instanceId: string
  readonly field: string
  readonly detail: string
}

/**
 * Human reason per violation code. `Record<GoldenDiffViolationCode, string>` is
 * the exhaustiveness lever: a new code that is not classified here is a COMPILE
 * error, never a silently unexplained refusal.
 */
export const GOLDEN_DIFF_VIOLATION_REASONS: Record<GoldenDiffViolationCode, string> = {
  row_count_changed: "the derived golden has a different number of rows than its source",
  row_order_changed: "a derived row sits at a different array index than in its source",
  field_added: "the derived golden carries a key its source row does not have",
  field_removed: "the derived golden dropped a key its source row has",
  field_changed: "a field other than `image_name` has a different value",
}

/** Runtime drift guard companion — pins the table in the other direction. */
export const GOLDEN_DIFF_VIOLATION_CODES = Object.keys(
  GOLDEN_DIFF_VIOLATION_REASONS,
) as readonly GoldenDiffViolationCode[]

export interface GoldenStructuralDiffOk {
  readonly ok: true
  /** Permitted deltas: `image_name` replacements. */
  readonly changes: readonly GoldenFieldChange[]
  /** Everything else. A legal derivation has NONE. */
  readonly violations: readonly GoldenDiffViolation[]
}

export type GoldenStructuralDiff = GoldenStructuralDiffOk | CampaignGoldenRejected

/** Order-insensitive-on-KEYS, value-sensitive canonical form for comparison. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const idOf = (row: Record<string, unknown>, index: number): string =>
  nonBlank(row.instance_id) ? row.instance_id : `<row ${index}>`

/**
 * Structurally diff a source golden document against its derived campaign
 * golden. Parses BOTH from bytes so it can be run against the two files a
 * campaign actually shipped, not against in-memory objects the deriver produced.
 */
export const diffGoldenDocuments = (
  sourceText: string,
  derivedText: string,
): GoldenStructuralDiff => {
  const source = parseRows(sourceText, "source golden document")
  if (!source.ok) return source
  const derived = parseRows(derivedText, "derived campaign golden")
  if (!derived.ok) return derived

  if (source.rows.length !== derived.rows.length) {
    return {
      ok: true,
      changes: [],
      violations: [
        {
          code: "row_count_changed",
          index: -1,
          instanceId: "<document>",
          field: "<array>",
          detail: `source has ${source.rows.length} row(s), derived has ${derived.rows.length}`,
        },
      ],
    }
  }

  const changes: GoldenFieldChange[] = []
  const violations: GoldenDiffViolation[] = []

  source.rows.forEach((rawSource, index) => {
    const rawDerived = derived.rows[index]
    if (!isRecord(rawSource) || !isRecord(rawDerived)) {
      violations.push({
        code: "field_changed",
        index,
        instanceId: `<row ${index}>`,
        field: "<row>",
        detail: "a row is not a JSON object on one side of the comparison",
      })
      return
    }
    const instanceId = idOf(rawSource, index)
    if (canonical(rawSource.instance_id) !== canonical(rawDerived.instance_id)) {
      violations.push({
        code: "row_order_changed",
        index,
        instanceId,
        field: "instance_id",
        detail: `index ${index} is "${instanceId}" in the source but "${idOf(rawDerived, index)}" in the derived document`,
      })
      return
    }
    for (const key of Object.keys(rawDerived)) {
      if (!(key in rawSource)) {
        violations.push({
          code: "field_added",
          index,
          instanceId,
          field: key,
          detail: `derived row adds \`${key}\``,
        })
      }
    }
    for (const key of Object.keys(rawSource)) {
      if (!(key in rawDerived)) {
        violations.push({
          code: "field_removed",
          index,
          instanceId,
          field: key,
          detail: `derived row drops \`${key}\``,
        })
        continue
      }
      const before = canonical(rawSource[key])
      const after = canonical(rawDerived[key])
      if (before === after) continue
      if (key === CAMPAIGN_GOLDEN_MUTABLE_FIELD) {
        changes.push({
          index,
          instanceId,
          field: key,
          from: String(rawSource[key]),
          to: String(rawDerived[key]),
        })
        continue
      }
      violations.push({
        code: "field_changed",
        index,
        instanceId,
        field: key,
        detail: `\`${key}\` changed`,
      })
    }
  })

  return { ok: true, changes, violations }
}

/**
 * The GATE a campaign runs before it ships a derived golden: returns the
 * operator-facing problem strings, empty iff the derivation is legal.
 *
 * Returning strings rather than throwing keeps it usable both as a hard gate and
 * as a receipt field, and an unparseable document is itself a problem rather
 * than an exception a caller could swallow.
 */
export const assertGoldenDerivationIsImageOnly = (
  diff: GoldenStructuralDiff,
): readonly string[] => {
  if (!diff.ok) {
    return diff.failures.map((f) => `campaign-golden diff refused (${f.code}): ${f.message}`)
  }
  return diff.violations.map(
    (v) =>
      `campaign-golden derivation changed more than \`${CAMPAIGN_GOLDEN_MUTABLE_FIELD}\`: ` +
      `${v.code} at row ${v.index} ("${v.instanceId}") field \`${v.field}\` — ${v.detail}. ` +
      `${GOLDEN_DIFF_VIOLATION_REASONS[v.code]}`,
  )
}
