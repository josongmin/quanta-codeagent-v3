/**
 * PMX-04 — the per-instance IMAGE FREEZE RECEIPT: one schema, two producers.
 *
 * Packet invariant 6: *"Every instance records source image reference, registry
 * digest, local image ID, and platform. Mutable tags alone are not replay
 * evidence."*
 *
 * ## Why the schema is its own module
 *
 * The receipt is produced in TWO places that must never disagree:
 *
 *  - LOCAL — `runProMaxImagePreflight` drives an injected Docker port directly;
 *  - REMOTE — the same preflight runs on the grading box and the receipt is
 *    TRANSPORTED back as bytes.
 *
 * The owner split says remote code "persists/transports the returned receipt; it
 * does not reproduce the checks with shell-output heuristics". That is only
 * enforceable if remote has no way to MAKE a receipt except by parsing one:
 * {@link parseProMaxImageFreezeReceipt} is fail-closed, refuses raw Docker text
 * outright, refuses a fault code it does not own, and refuses an `ok` flag that
 * disagrees with the fault list. A transport that wanted to classify a docker
 * error itself would have to invent a code — and the parser rejects it.
 *
 * Field names are snake_case because this interface IS the on-disk / on-wire
 * document, exactly as PMX-00's manifest is; there is deliberately no second
 * camelCase spelling for the same record to drift against.
 *
 * Pure: no Docker, no filesystem, no clock.
 */

import { errMessage } from "@/shared"

/** The platform a ProMax campaign is only reproducible on. */
export const PROMAX_REQUIRED_OS = "linux"
export const PROMAX_REQUIRED_ARCHITECTURE = "amd64"

/**
 * A DIGEST-ADDRESSED image reference: `<name>@sha256:<64 lowercase hex>`.
 *
 * Declared HERE, by the receipt schema owner, and imported by the golden
 * derivation — one definition of "pinned", so a gate cannot be satisfied by a
 * looser second spelling. Invariant 6's "mutable tags alone are not replay
 * evidence" is only checkable against a single rule.
 */
export const PROMAX_DIGEST_REFERENCE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

/** Is this reference content-addressed (as opposed to a mutable tag)? */
export const isDigestPinnedReference = (reference: string): boolean =>
  PROMAX_DIGEST_REFERENCE_RE.test(reference)

/** Invariant-6's per-instance record. */
export interface ProMaxImageRecord {
  readonly instance_id: string
  /** The upstream MUTABLE tag the corpus published. Recorded, never pulled. */
  readonly source_image_name: string
  /** `repo@sha256:…` — what was actually pulled and what the golden pins. */
  readonly registry_repo_digest: string
  /** The daemon-local image id (`sha256:…`) the digest resolved to. */
  readonly local_image_id: string
  readonly os: string
  readonly architecture: string
  /** ISO-8601 instant the record was resolved. */
  readonly resolved_at: string
}

/** The preflight steps, in execution order. A fault names the step it failed at. */
export type ProMaxPreflightStage =
  | "pull"
  | "inspect"
  | "verify"
  | "start"
  | "cp"
  | "exec"
  | "cleanup"

/**
 * Closed classification of every way an instance's image preflight can fail.
 * The ticket requires pull / start / cp / exec faults to be SEPARATELY
 * classified, which is why there is no shared `docker_failed`.
 */
export type ProMaxImageFaultCode =
  | "pull_failed"
  | "inspect_failed"
  | "inspect_unparseable"
  | "digest_mismatch"
  | "platform_unsupported"
  | "start_failed"
  | "cp_failed"
  | "exec_failed"
  | "sentinel_present"
  | "cleanup_failed"

/**
 * Human reason per code. `Record<ProMaxImageFaultCode, string>` is the
 * exhaustiveness lever: a new code that is not classified here is a COMPILE
 * error rather than an unexplained infra refusal in a campaign report.
 */
export const PROMAX_IMAGE_FAULT_REASONS: Record<ProMaxImageFaultCode, string> = {
  pull_failed: "the digest-pinned image could not be pulled from the registry",
  inspect_failed: "`docker image inspect` exited non-zero for the pulled image",
  inspect_unparseable: "`docker image inspect` output was not the expected JSON object",
  digest_mismatch: "the reference resolved to a repo digest the campaign manifest does not pin",
  platform_unsupported: "the image is not linux/amd64, which the pinned evaluator requires",
  start_failed: "a disposable container could not be started from the image",
  cp_failed: "`docker cp` did not deliver a file into the running container",
  exec_failed: "`docker exec` could not run a command inside the running container",
  sentinel_present:
    "the campaign-unique gold-sentinel target path already EXISTS in the image, which would let the sentinel patch apply and make the gold preflight vacuous",
  cleanup_failed: "the disposable container could not be removed (the cached image is kept)",
}

/** Runtime drift guard companion — pins the table in the other direction. */
export const PROMAX_IMAGE_FAULT_CODES = Object.keys(
  PROMAX_IMAGE_FAULT_REASONS,
) as readonly ProMaxImageFaultCode[]

const FAULT_CODE_SET: ReadonlySet<string> = new Set(PROMAX_IMAGE_FAULT_CODES)

export interface ProMaxImageFault {
  readonly instance_id: string
  readonly code: ProMaxImageFaultCode
  readonly stage: ProMaxPreflightStage
  readonly message: string
  /** The EXACT argv that produced the fault — replay evidence, invariant 5. */
  readonly argv: readonly string[]
  readonly exit_code: number
}

/** A campaign artifact identified by path AND content digest. */
export interface ProMaxArtifactDigest {
  readonly path: string
  readonly sha256: string
}

export interface ProMaxImageFreezeReceipt {
  readonly receipt_version: 1
  readonly campaign_id: string
  readonly upstream_git_commit: string
  readonly required_platform: { readonly os: string; readonly architecture: string }
  /** The VERIFIED source golden document the derivation started from. */
  readonly golden_source: ProMaxArtifactDigest
  /** The derived `campaign-golden.json` the evaluator will actually read. */
  readonly golden_derived: ProMaxArtifactDigest
  readonly images: readonly ProMaxImageRecord[]
  readonly faults: readonly ProMaxImageFault[]
  /** DERIVED (`faults.length === 0`), never independently authored. */
  readonly ok: boolean
}

export type ProMaxImageReceiptFailureCode =
  | "receipt_unparseable"
  | "receipt_field_invalid"
  | "fault_code_unknown"
  | "ok_inconsistent"

export interface ProMaxImageReceiptFailure {
  readonly code: ProMaxImageReceiptFailureCode
  readonly message: string
}

export type ProMaxImageReceiptParse =
  | { readonly ok: true; readonly receipt: ProMaxImageFreezeReceipt }
  | { readonly ok: false; readonly failures: readonly ProMaxImageReceiptFailure[] }

export const serializeProMaxImageFreezeReceipt = (r: ProMaxImageFreezeReceipt): string =>
  JSON.stringify(r, null, 2)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""

const IMAGE_RECORD_FIELDS = [
  "instance_id",
  "source_image_name",
  "registry_repo_digest",
  "local_image_id",
  "os",
  "architecture",
  "resolved_at",
] as const

const readImageRecords = (
  value: unknown,
  sink: ProMaxImageReceiptFailure[],
): readonly ProMaxImageRecord[] => {
  if (!Array.isArray(value)) {
    sink.push({ code: "receipt_field_invalid", message: "`images` is not an array" })
    return []
  }
  const out: ProMaxImageRecord[] = []
  value.forEach((raw, i) => {
    if (!isRecord(raw)) {
      sink.push({ code: "receipt_field_invalid", message: `images[${i}] is not an object` })
      return
    }
    for (const field of IMAGE_RECORD_FIELDS) {
      if (!nonBlank(raw[field])) {
        sink.push({
          code: "receipt_field_invalid",
          message: `images[${i}].${field} is absent, blank, or not a string`,
        })
        return
      }
    }
    out.push({
      instance_id: String(raw.instance_id),
      source_image_name: String(raw.source_image_name),
      registry_repo_digest: String(raw.registry_repo_digest),
      local_image_id: String(raw.local_image_id),
      os: String(raw.os),
      architecture: String(raw.architecture),
      resolved_at: String(raw.resolved_at),
    })
  })
  return out
}

const readFaults = (
  value: unknown,
  sink: ProMaxImageReceiptFailure[],
): readonly ProMaxImageFault[] => {
  if (!Array.isArray(value)) {
    sink.push({ code: "receipt_field_invalid", message: "`faults` is not an array" })
    return []
  }
  const out: ProMaxImageFault[] = []
  value.forEach((raw, i) => {
    if (!isRecord(raw)) {
      sink.push({ code: "receipt_field_invalid", message: `faults[${i}] is not an object` })
      return
    }
    if (!nonBlank(raw.code) || !FAULT_CODE_SET.has(raw.code)) {
      // The load-bearing half of the owner split: a transport that wanted to
      // classify raw Docker output itself would have to invent a code here.
      sink.push({
        code: "fault_code_unknown",
        message: `faults[${i}].code ${JSON.stringify(raw.code)} is not a ProMax image fault code — image classification is owned by harness/promax, not by transport or report code`,
      })
      return
    }
    if (!nonBlank(raw.instance_id) || !nonBlank(raw.stage) || typeof raw.message !== "string") {
      sink.push({
        code: "receipt_field_invalid",
        message: `faults[${i}] is missing instance_id / stage / message`,
      })
      return
    }
    if (!Array.isArray(raw.argv) || !raw.argv.every((t) => typeof t === "string")) {
      sink.push({ code: "receipt_field_invalid", message: `faults[${i}].argv is not a string[]` })
      return
    }
    if (typeof raw.exit_code !== "number") {
      sink.push({
        code: "receipt_field_invalid",
        message: `faults[${i}].exit_code is not a number`,
      })
      return
    }
    out.push({
      instance_id: raw.instance_id,
      code: raw.code as ProMaxImageFaultCode,
      stage: raw.stage as ProMaxPreflightStage,
      message: raw.message,
      argv: raw.argv as readonly string[],
      exit_code: raw.exit_code,
    })
  })
  return out
}

const readArtifactDigest = (
  value: unknown,
  label: string,
  sink: ProMaxImageReceiptFailure[],
): ProMaxArtifactDigest => {
  if (!isRecord(value) || !nonBlank(value.path) || !nonBlank(value.sha256)) {
    sink.push({
      code: "receipt_field_invalid",
      message: `\`${label}\` must carry a non-blank path and sha256`,
    })
    return { path: "", sha256: "" }
  }
  return { path: value.path, sha256: value.sha256 }
}

/**
 * Parse a receipt document. FAIL-CLOSED — a consumer that wants image records
 * must narrow on `ok === true`, so there is no route from unvalidated bytes to a
 * campaign receipt.
 */
export const parseProMaxImageFreezeReceipt = (text: string): ProMaxImageReceiptParse => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          code: "receipt_unparseable",
          message: `image-freeze receipt bytes are not valid JSON: ${errMessage(err)}`,
        },
      ],
    }
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      failures: [
        { code: "receipt_unparseable", message: "image-freeze receipt is not a JSON object" },
      ],
    }
  }

  const failures: ProMaxImageReceiptFailure[] = []
  if (value.receipt_version !== 1) {
    failures.push({
      code: "receipt_field_invalid",
      message: `receipt_version must be 1, got ${JSON.stringify(value.receipt_version)}`,
    })
  }
  if (!nonBlank(value.campaign_id)) {
    failures.push({ code: "receipt_field_invalid", message: "campaign_id is absent or blank" })
  }
  if (!nonBlank(value.upstream_git_commit)) {
    failures.push({
      code: "receipt_field_invalid",
      message: "upstream_git_commit is absent or blank",
    })
  }
  const platform = value.required_platform
  if (!isRecord(platform) || !nonBlank(platform.os) || !nonBlank(platform.architecture)) {
    failures.push({
      code: "receipt_field_invalid",
      message: "required_platform must carry os and architecture",
    })
  }
  const goldenSource = readArtifactDigest(value.golden_source, "golden_source", failures)
  const goldenDerived = readArtifactDigest(value.golden_derived, "golden_derived", failures)
  const images = readImageRecords(value.images, failures)
  const faults = readFaults(value.faults, failures)
  // Consistency is judged against the DECLARED fault list, not the successfully
  // parsed one: a document whose fault was rejected for an unknown code must
  // report THAT, not a second, derivative "ok disagrees" refusal.
  const declaredFaultCount = Array.isArray(value.faults) ? value.faults.length : faults.length
  if (typeof value.ok !== "boolean") {
    failures.push({ code: "receipt_field_invalid", message: "`ok` is not a boolean" })
  } else if (value.ok !== (declaredFaultCount === 0)) {
    failures.push({
      code: "ok_inconsistent",
      message: `\`ok\` is ${value.ok} but the receipt carries ${declaredFaultCount} fault(s) — the flag is DERIVED from the fault list and may not be authored independently`,
    })
  }

  if (failures.length > 0) return { ok: false, failures }
  return {
    ok: true,
    receipt: {
      receipt_version: 1,
      campaign_id: String(value.campaign_id),
      upstream_git_commit: String(value.upstream_git_commit),
      required_platform: {
        os: String((platform as Record<string, unknown>).os),
        architecture: String((platform as Record<string, unknown>).architecture),
      },
      golden_source: goldenSource,
      golden_derived: goldenDerived,
      images,
      faults,
      ok: value.ok === true,
    },
  }
}

/**
 * The RECORD half of the pre-spend gate: every frozen record must be
 * content-addressed and must sit on the platform the receipt itself requires.
 *
 * Both clauses exist because a fault-free receipt is not the same thing as a
 * REPRODUCIBLE one. A freeze that recorded `repo:tag` for every instance carries
 * no faults at all — it simply never resolved a digest — and a record whose
 * `os`/`architecture` disagree with the receipt's own `required_platform` is a
 * self-contradicting document that a fault list cannot express.
 */
const auditImageRecords = (receipt: ProMaxImageFreezeReceipt): readonly string[] => {
  const problems: string[] = []
  const required = receipt.required_platform
  const seen = new Set<string>()
  for (const image of receipt.images) {
    if (seen.has(image.instance_id)) {
      problems.push(
        `instance "${image.instance_id}" has more than one image record — a campaign instance resolves to exactly one image`,
      )
    }
    seen.add(image.instance_id)
    if (!isDigestPinnedReference(image.registry_repo_digest)) {
      problems.push(
        `instance "${image.instance_id}" froze "${image.registry_repo_digest}", which is a MUTABLE TAG, not a digest pin ` +
          "(`name@sha256:<64 hex>`) — the pinned evaluator's own `docker pull` could serve different bytes on the next run",
      )
    }
    if (image.os !== required.os || image.architecture !== required.architecture) {
      problems.push(
        `instance "${image.instance_id}" resolved to platform ${image.os}/${image.architecture}, which CONTRADICTS ` +
          `the receipt's own required platform ${required.os}/${required.architecture}`,
      )
    }
  }
  return problems
}

/**
 * The gate a MODEL run passes through, BEFORE a single token is spent.
 *
 * `assignedInstanceIds` is REQUIRED, not optional. It used to default away, and
 * a caller that omitted it silently got fault-checking with NO coverage check —
 * i.e. the 170/170 requirement was satisfied by not asking. Making the parameter
 * mandatory turns that omission into a COMPILE error.
 *
 * Coverage is checked in BOTH directions: an assigned instance with no image is
 * an unfrozen launch, and a frozen image for an UNASSIGNED instance means the
 * freeze and the selection disagree about what this campaign is — which is
 * exactly how a receipt from another campaign gets accepted as this one's
 * evidence.
 */
export const assertImageFreezeReadyForModelLaunch = (
  receipt: ProMaxImageFreezeReceipt,
  assignedInstanceIds: readonly string[],
): void => {
  if (receipt.faults.length > 0) {
    const detail = receipt.faults
      .map((f) => `${f.instance_id}: ${f.code} at ${f.stage} — ${f.message}`)
      .join("; ")
    throw new Error(
      `bench: ProMax image freeze is not launch-ready — ${receipt.faults.length} fault(s): ${detail}. ` +
        "REFUSING to spend model tokens against an unreproducible image set.",
    )
  }

  const problems: string[] = []
  const required = receipt.required_platform
  if (
    required.os !== PROMAX_REQUIRED_OS ||
    required.architecture !== PROMAX_REQUIRED_ARCHITECTURE
  ) {
    // Checked FIRST and separately: without it, the per-record contradiction
    // check below is defeated by lowering the requirement instead of fixing the
    // images.
    problems.push(
      `the receipt declares required_platform ${required.os}/${required.architecture}, but ProMax is only ` +
        `reproducible on ${PROMAX_REQUIRED_OS}/${PROMAX_REQUIRED_ARCHITECTURE} — a receipt may not lower its own bar`,
    )
  }
  problems.push(...auditImageRecords(receipt))

  const frozen = new Set(receipt.images.map((i) => i.instance_id))
  const assigned = new Set(assignedInstanceIds)
  const missing = assignedInstanceIds.filter((id) => !frozen.has(id))
  if (missing.length > 0) {
    problems.push(
      `the freeze covers ${frozen.size}/${assigned.size} assigned instance(s); no image record for: ${missing.join(", ")}`,
    )
  }
  const unassigned = [...frozen].filter((id) => !assigned.has(id))
  if (unassigned.length > 0) {
    problems.push(
      `the freeze carries image record(s) for instance(s) this campaign never assigned: ${unassigned.join(", ")} — ` +
        "the freeze and the selection disagree about what this campaign is",
    )
  }

  if (problems.length === 0) return
  throw new Error(
    `bench: ProMax image freeze is not launch-ready — ${problems.length} problem(s): ` +
      `${problems.join("; ")}. REFUSING to spend model tokens against an unreproducible image set.`,
  )
}
