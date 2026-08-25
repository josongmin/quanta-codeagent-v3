/**
 * The durable resume RECEIPT — the fail-closed gate that separates "bytes were
 * uploaded best-effort" from "this run is safe to resume from".
 *
 * Upload of segments may be best-effort (a swallowed PUT failure must not kill a
 * live run). But resume ELIGIBILITY must be strict: a run that lost any upload
 * sets `degraded=true`, and {@link isResumeEligible} then refuses it — better to
 * re-run than to silently resume from a hole. A missing receipt is likewise
 * ineligible. This is the B3 contract from the spot-resume design doc.
 */
import type { RemoteBackend } from "./backend"

export interface ResumeSecurityReceipt {
  schema: "quanta.resume-security.v1"
  bucket: string
  keyPrefix: string
  kmsKeyArn: string
  principalArn: string
  retentionDays: number
  prefixLeastPrivilege: true
  publicAccessBlocked: true
  verifiedAt: string
}

export interface ResumeReceipt {
  /** Authoritative resume key, e.g. `<campaign-id>/<instance-id>`. */
  key: string
  /** Campaign this receipt belongs to. */
  campaignId: string
  /** Instance (iid) this receipt belongs to. */
  instanceId: string
  /** Highest segment seq durably written. */
  latestSeq: number
  /** True ⇒ an upload was lost ⇒ NOT resume-eligible (fail-closed). */
  degraded: boolean
  updatedAt: string
  /** Live AWS policy/KMS/lifecycle attestation for this exact prefix. */
  security?: ResumeSecurityReceipt
  /** Free-form correlation (runId / attempt / iid …). */
  meta?: Record<string, unknown>
}

/** Non-empty string field guard. */
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Strict structural validator: `true` ONLY for a well-formed receipt object —
 * every required field present and correctly typed. Used both to reject
 * malformed reads ({@link readReceipt}) and as the structural half of the
 * fail-closed eligibility gate ({@link isResumeEligible}). NOTE: this validates
 * SHAPE, not the `degraded` value — a structurally-valid degraded:true receipt
 * is a valid receipt that is NOT eligible.
 */
export const isValidReceipt = (x: unknown): x is ResumeReceipt => {
  if (x === null || typeof x !== "object") return false
  const r = x as Record<string, unknown>
  if (typeof r.degraded !== "boolean") return false
  if (!Number.isInteger(r.latestSeq) || (r.latestSeq as number) < 0) return false
  if (!isNonEmptyString(r.key)) return false
  if (!isNonEmptyString(r.campaignId)) return false
  if (!isNonEmptyString(r.instanceId)) return false
  if (!isNonEmptyString(r.updatedAt)) return false
  return true
}

const RECEIPT_PATH = (key: string): string => `${key}/resume-state.json`

export const writeReceipt = async (
  backend: RemoteBackend,
  key: string,
  receipt: ResumeReceipt,
): Promise<void> => {
  await backend.put(RECEIPT_PATH(key), JSON.stringify(receipt))
}

/**
 * Read the receipt. Missing → undefined; malformed JSON → undefined. NEVER
 * throws on absence or corruption — a resume gate must treat an unreadable
 * receipt as "not eligible", not crash the requeue path.
 */
export const readReceipt = async (
  backend: RemoteBackend,
  key: string,
): Promise<ResumeReceipt | undefined> => {
  const raw = await backend.get(RECEIPT_PATH(key))
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  // Validate SHAPE after parse — never blind-cast. A valid-JSON-but-wrong-shape
  // blob (mistyped/missing required fields) is treated as unreadable ⇒ undefined.
  return isValidReceipt(parsed) ? parsed : undefined
}

/**
 * FAIL-CLOSED resume gate. The ONLY path to `true` is a present, structurally
 * well-formed receipt whose `degraded` is the strict boolean `false`. Any
 * deviation — absent receipt, missing/mistyped field, `degraded` truthy/absent/
 * the string "false", non-integer or negative `latestSeq`, empty required
 * string — returns `false`. Better to re-run than resume from a hole.
 *
 * Accepts `unknown` (not just a typed `ResumeReceipt`) so a blind-cast caller
 * cannot smuggle a degraded/malformed object past the gate.
 */
export const isResumeEligible = (receipt: unknown): boolean => {
  if (!isValidReceipt(receipt)) return false
  return receipt.degraded === false
}

export const sameResumeSecurity = (
  actual: ResumeSecurityReceipt | undefined,
  expected: ResumeSecurityReceipt,
): boolean =>
  actual !== undefined &&
  actual.schema === expected.schema &&
  actual.bucket === expected.bucket &&
  actual.keyPrefix === expected.keyPrefix &&
  actual.kmsKeyArn === expected.kmsKeyArn &&
  actual.principalArn === expected.principalArn &&
  actual.retentionDays === expected.retentionDays &&
  actual.prefixLeastPrivilege === true &&
  actual.publicAccessBlocked === true
