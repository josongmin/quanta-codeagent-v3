/**
 * CAPABILITY RECEIPT (TVH-11) — the schema, minting and validation. PURE.
 *
 * WHAT PROBLEM. Ordinary test files (thirteen at a128bc99d) each answered "is Chrome / python
 * with lancedb / typescript-language-server / ast-grep / lldb-dap here?" by
 * ASKING THE HOST, at module load, once per file. That is the same question
 * answered N times, at discovery time, by spawning real processes — several
 * without a timeout. The fix is one bounded producer per tier and an immutable
 * artifact the test modules READ.
 *
 * WHY A RECEIPT AND NOT AN ENV VAR. A capability answer is only valid for the
 * host state it was measured on. If the artifact does not bind what it was
 * measured against, a stale file from yesterday's checkout silently decides
 * today's run — the exact failure mode the exact-verification receipt already
 * fixed one level up. So the receipt binds:
 *
 *   - `head`        — the commit the probe ran at,
 *   - `policySha256`— the test policy / capability declaration in force,
 *   - `toolchainSha256` — `external-toolchain.ts`'s spawn-free fingerprint of
 *                     every gating binary (path + dev:ino + size + mtime).
 *
 * `bindingSha256` is the hash of those three. The consumer recomputes the
 * toolchain half LOCALLY (statSync only — no subprocess) and compares. A
 * mismatch is `blocked` BEFORE any test decides to do anything, which is the
 * property that matters: fail closed, and fail closed without spawning.
 *
 * ABSENCE IS A VALUE. A capability that was probed and found missing is
 * `unavailable`, which is NOT the same as `probe-timeout` (the host has it but
 * it wedged) and NOT the same as a capability nobody probed. Collapsing those
 * three is how "the tool is not installed" and "our integration is broken"
 * became indistinguishable in the first place.
 */

import { createHash } from "node:crypto"

export const CAPABILITY_RECEIPT_SCHEMA = "quanta.capability-receipt.v1" as const

/** Long enough for a whole tier, short enough that a laptop resume re-probes. */
export const DEFAULT_CAPABILITY_RECEIPT_TTL_MS = 60 * 60_000
export const MAX_CAPABILITY_RECEIPT_TTL_MS = 6 * 60 * 60_000
export const CAPABILITY_RECEIPT_FUTURE_SKEW_TOLERANCE_MS = 60_000

/** Where the runner hands the receipt path to every test process. */
export const CAPABILITY_RECEIPT_PATH_ENV = "QUANTA_CAPABILITY_RECEIPT"
/** Optional: the runner's own claim about what the receipt must be bound to. */
export const CAPABILITY_RECEIPT_BINDING_ENV = "QUANTA_CAPABILITY_BINDING"
/**
 * The digest of the receipt's VERDICTS, which is the only part of the receipt
 * allowed to move the shard cache identity.
 *
 * Lives beside its two siblings because the three are one contract: a worker
 * given some of them and not others reads an unbound or unidentified receipt.
 * `worker-home.ts` enforces all-or-nothing over exactly this set, and it cannot
 * do that while one third of the set lives in the producer.
 */
export const CAPABILITY_VERDICTS_ENV = "QUANTA_CAPABILITY_VERDICTS"

/**
 * The ids for which `blocked-missing` / `failed-setup` is a registered failing
 * test instead of a skip (grammar: `capabilityRequiredFor`). An operator or CI may
 * set it; the shard runner and `with-capability-receipt` widen it with every id
 * their receipt answered definitely (`definiteCapabilityIds`).
 */
export const CAPABILITY_REQUIRE_ENV = "QUANTA_REQUIRE_CAPABILITIES"

/**
 * The marker every capability outcome is written behind, in BOTH capability
 * systems.
 *
 * # Why it lives here and not next to one of its writers
 *
 * This repository grew two of them. `tests/_helpers/capability-lane.ts` decides
 * the `*-real-e2e` lanes from live `Bun.which` probes and reports every outcome
 * on a line starting with this prefix. `capability-receipt-consumer.ts` decides
 * the receipt-gated files and, MEASURED, reported NOTHING: the only
 * `[capability]` text in it was inside a throw. So a receipt lane that skipped
 * every case was textually identical to one that ran them — the precise defect
 * the lane helper's own docstring says it exists to remove, still open one
 * system over.
 *
 * Owning the prefix in the module both systems already import puts both halves
 * behind one `grep '^\[capability\]'`. That is NOT a complete tally: the receipt
 * consumer prints once per capability per module instance, which is per file
 * only under `--parallel`. The per-file account is the junit record
 * (`capabilityRecordName`).
 */
export const CAPABILITY_LINE_PREFIX = "[capability]"

/**
 * The skipped test a consumer registers, in the ASKING file, for a decision that
 * did not execute.
 *
 * The stdout line is printed once per capability per `bun test` process, and
 * nothing read it: `capability-result` took `blockedMissing` and `failedSetup`
 * from command-line flags no lane passed, so the aggregator's two hard-failure
 * checks could not fire. A junit testcase is attributed to its file and read by
 * the reducers that already read that junit: `capability-result` in the three CI
 * capability lanes, and the shard runner's campaign summary.
 */
export const capabilityRecordName = (capability: string, verdict: string, detail: string): string =>
  // One line. MEASURED on Bun 1.3.14: a newline in a test name is written into
  // the junit as `name="&#10;[capability] RECORD …"`, the record no longer starts
  // with its prefix, and a `failed-setup` whose detail quoted a multi-line error
  // was counted as an ordinary skip.
  `${CAPABILITY_LINE_PREFIX} RECORD ${capability} ${verdict}: ${detail.replace(/\p{Cc}+/gu, " ")}`

/**
 * The subject a `*-real-e2e` lane GROUP is recorded under.
 *
 * `tests/_helpers/capability-lane.ts` decides groups, not receipt ids, and a
 * group id never contains a space, so `group <id>` cannot be read as a receipt id.
 * The two id spaces are also held disjoint by `module-load-effect-guard`.
 */
export const laneGroupSubject = (group: string): string => `group ${group}`

/** Is a record's subject a lane GROUP (`laneGroupSubject`) rather than a receipt id? */
export const isLaneGroupSubject = (subject: string): boolean => subject.startsWith("group ")

/** A subject: a receipt id, or `group <id>` (`laneGroupSubject`). */
const SUBJECT = "((?:group )?\\S+)"

export const parseCapabilityRecordName = (
  name: string,
): { readonly capability: string; readonly verdict: string } | undefined => {
  const prefix = `${CAPABILITY_LINE_PREFIX} RECORD `
  if (!name.startsWith(prefix)) return undefined
  const match = new RegExp(`^${SUBJECT} ([a-z-]+): `, "u").exec(name.slice(prefix.length))
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { capability: match[1], verdict: match[2] }
}

/**
 * The failing test a REQUIRED capability registers: a receipt id
 * (`capability-receipt-consumer`) or a lane group (`capability-lane`).
 */
export const capabilityRequiredFailureName = (capability: string, verdict: string): string =>
  `${CAPABILITY_LINE_PREFIX} REQUIRED ${capability} is ${verdict}`

/** The failing test a REQUIRED contract dependency registers (`tests/contract/_guard.ts`). */
export const contractRequiredFailureName = (dependency: string): string =>
  `[contract] REQUIRED ${dependency} is unavailable`

/**
 * A REQUIRED failure, whichever system registered it, as the record it is.
 *
 * It was counted as an EXECUTED case: a file whose only real case was skipped
 * showed `executedCases: 2`, the failure satisfied the group's executed floor,
 * and the artifact said `blocked=0`. The job still failed through its exit
 * code, so the artifact contradicted the job it described.
 */
export const parseRequiredFailureName = (
  name: string,
): { readonly capability: string; readonly verdict: string } | undefined => {
  const capabilityMatch = new RegExp(
    `^\\[capability\\] REQUIRED ${SUBJECT} is ([a-z-]+)$`,
    "u",
  ).exec(name)
  if (capabilityMatch?.[1] !== undefined && capabilityMatch[2] !== undefined) {
    return { capability: capabilityMatch[1], verdict: capabilityMatch[2] }
  }
  const contractMatch = /^\[contract\] REQUIRED (.+) is unavailable$/u.exec(name)
  return contractMatch?.[1] === undefined
    ? undefined
    : { capability: contractMatch[1], verdict: "blocked-missing" }
}

/**
 * Is `id` REQUIRED to have actually been exercised?
 *
 * # One name, one grammar
 *
 * There were two names for this switch and neither was set anywhere:
 * `QUANTA_REQUIRE_CAPABILITIES` (read by the receipt consumer, where ANY
 * non-empty value made EVERY capability strict) and `QUANTA_REQUIRE_CAPABILITY`
 * (read by the `*-real-e2e` lane helper, where the value was `1` or a
 * comma-separated group list). So the rule "a blocked capability must be RED in a
 * required job" was off in both dialects, and setting either one armed half the
 * corpus with the wrong grammar.
 *
 *   unset / "" / "0" / "false" / "no" / "off"  -> nothing is required
 *   "1" / "true" / "yes" / "on"                -> everything is required
 *   "a,b"                                      -> exactly `a` and `b` are required
 *
 * (case-insensitive). `REQUIRE_CONTRACT` reads the same words through
 * `switchWord`: it treated `true` as strict while this switch treated it as the
 * one capability named "true", and merging then produced `git,true`.
 *
 * The list form is the reason this is a function and not a boolean: naming one
 * capability used to make all of them strict, which is a different run than the
 * operator asked for.
 */
/** A strictness switch's value as a word, or `undefined` when it is a list. */
export const switchWord = (value: string | undefined): "off" | "all" | undefined => {
  const raw = (value ?? "").trim().toLowerCase()
  if (["", "0", "false", "no", "off"].includes(raw)) return "off"
  if (["1", "true", "yes", "on"].includes(raw)) return "all"
  return undefined
}

export const capabilityRequiredFor = (
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const word = switchWord(env[CAPABILITY_REQUIRE_ENV])
  if (word !== undefined) return word === "all"
  const raw = (env[CAPABILITY_REQUIRE_ENV] ?? "").trim()
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .includes(id)
}

/**
 * The ids a receipt answered DEFINITELY — present or absent — which are the ones
 * a campaign may safely require.
 *
 * A requirement only fires on `blocked-missing` or `failed-setup`. For an id the
 * receipt answered `available` or `unavailable`, a worker that HAS the receipt
 * sees `executed` or `skipped-unsupported` and never fires; the only way it can
 * fire is a worker that did NOT get the receipt. So arming exactly these ids turns
 * "the receipt was lost on the way to a worker" from a silent skip into a named
 * failure, without ever reddening a campaign whose receipt arrives. `probe-timeout`
 * and `probe-error` are left unarmed, so a slow host is not red locally or in a
 * campaign — the campaign PRINTS its `failed-setup` records instead. In the three
 * CI capability lanes a `failed-setup` record does fail `required`: there the
 * lane's whole job is to have the capability, and a probe that could not answer
 * means it did not verify.
 */
export const definiteCapabilityIds = (receipt: {
  readonly capabilities: Readonly<Record<string, { readonly status: string }>>
}): readonly string[] =>
  Object.entries(receipt.capabilities)
    .filter(([, finding]) => finding.status === "available" || finding.status === "unavailable")
    .map(([id]) => id)
    .sort()

/** An operator's own `QUANTA_REQUIRE_CAPABILITIES` is widened, never replaced or narrowed. */
export const mergeRequiredCapabilities = (
  existing: string | undefined,
  ids: readonly string[],
): string => {
  const word = switchWord(existing)
  if (word === "all") return "1"
  const current =
    word === "off"
      ? []
      : (existing ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
  return [...new Set([...current, ...ids])].sort().join(",")
}

export type CapabilityStatus = "available" | "unavailable" | "probe-timeout" | "probe-error"

export const CAPABILITY_STATUSES: readonly CapabilityStatus[] = [
  "available",
  "unavailable",
  "probe-timeout",
  "probe-error",
]

export interface CapabilityFinding {
  readonly status: CapabilityStatus
  /** Human detail: which candidate won, or why none did. */
  readonly detail: string
  /** The winning candidate (an interpreter path, an `lldb-dap` path, …). */
  readonly resolved?: string
  readonly probeMs: number
}

export interface CapabilityBinding {
  readonly head: string
  readonly policySha256: string
  readonly toolchainSha256: string
}

export interface CapabilityReceipt extends CapabilityBinding {
  readonly schema: typeof CAPABILITY_RECEIPT_SCHEMA
  readonly bindingSha256: string
  readonly tier: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly deadlineMs: number
  readonly capabilities: Readonly<Record<string, CapabilityFinding>>
}

export type ReceiptValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

export const capabilityBindingSha256 = (binding: CapabilityBinding): string =>
  sha256(`${binding.head}\n${binding.policySha256}\n${binding.toolchainSha256}\n`)

export interface MintCapabilityReceiptInput {
  readonly binding: CapabilityBinding
  readonly tier: string
  readonly capabilities: Readonly<Record<string, CapabilityFinding>>
  readonly deadlineMs: number
  readonly issuedAtMs?: number
  readonly ttlMs?: number
}

export const mintCapabilityReceipt = (input: MintCapabilityReceiptInput): CapabilityReceipt => {
  const ttlMs = input.ttlMs ?? DEFAULT_CAPABILITY_RECEIPT_TTL_MS
  // Minting cannot produce a receipt the validator would reject on duration:
  // one rule, enforced at both ends, so the two cannot drift apart.
  if (ttlMs <= 0 || ttlMs > MAX_CAPABILITY_RECEIPT_TTL_MS) {
    throw new Error(
      `refusing to mint a capability receipt with ttl ${ttlMs}ms (maximum ${MAX_CAPABILITY_RECEIPT_TTL_MS}ms)`,
    )
  }
  if (input.tier.trim().length === 0) throw new Error("refusing to mint a receipt with no tier")
  const issuedAtMs = input.issuedAtMs ?? Date.now()
  return {
    schema: CAPABILITY_RECEIPT_SCHEMA,
    ...input.binding,
    bindingSha256: capabilityBindingSha256(input.binding),
    tier: input.tier,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ttlMs,
    deadlineMs: input.deadlineMs,
    // A SNAPSHOT. The producer keeps writing into its map when a probe answers
    // after the total deadline, and the receipt it had already returned — and
    // written, and armed the switch from — moved with it.
    capabilities: { ...input.capabilities },
  }
}

const isFinding = (value: unknown): value is CapabilityFinding => {
  if (typeof value !== "object" || value === null) return false
  const f = value as Record<string, unknown>
  return (
    CAPABILITY_STATUSES.includes(f.status as CapabilityStatus) &&
    typeof f.detail === "string" &&
    typeof f.probeMs === "number" &&
    (f.resolved === undefined || typeof f.resolved === "string")
  )
}

const validateShape = (receipt: Partial<CapabilityReceipt>): ReceiptValidation => {
  if (receipt.schema !== CAPABILITY_RECEIPT_SCHEMA) {
    return { ok: false, reason: `receipt schema is not ${CAPABILITY_RECEIPT_SCHEMA}` }
  }
  for (const field of [
    "head",
    "policySha256",
    "toolchainSha256",
    "bindingSha256",
    "tier",
  ] as const) {
    const value = receipt[field]
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, reason: `receipt field "${field}" is missing` }
    }
  }
  if (typeof receipt.capabilities !== "object" || receipt.capabilities === null) {
    return { ok: false, reason: "receipt has no capabilities map" }
  }
  for (const [name, finding] of Object.entries(receipt.capabilities)) {
    if (!isFinding(finding))
      return { ok: false, reason: `capability "${name}" has an invalid shape` }
  }
  return { ok: true }
}

const validateTiming = (receipt: CapabilityReceipt, nowMs: number): ReceiptValidation => {
  if (!Number.isFinite(receipt.issuedAtMs) || !Number.isFinite(receipt.expiresAtMs)) {
    return { ok: false, reason: "receipt timestamps are invalid" }
  }
  const ttlMs = receipt.expiresAtMs - receipt.issuedAtMs
  if (ttlMs <= 0) return { ok: false, reason: "receipt expires at or before it was issued" }
  // Checked BEFORE expiry on purpose: a receipt whose `expiresAtMs` was edited
  // to +30 days is not "expired", which is exactly why believing that field
  // alone was the hole.
  if (ttlMs > MAX_CAPABILITY_RECEIPT_TTL_MS) {
    return { ok: false, reason: `receipt ttl ${ttlMs}ms exceeds the maximum` }
  }
  if (receipt.issuedAtMs > nowMs + CAPABILITY_RECEIPT_FUTURE_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: "receipt was issued in the future — clock skew" }
  }
  if (receipt.expiresAtMs <= nowMs) return { ok: false, reason: "receipt has expired" }
  return { ok: true }
}

export interface ValidateCapabilityReceiptOptions {
  /** Recomputed locally by the consumer, with no subprocess. */
  readonly observedToolchainSha256: string
  /** The runner's declared binding, when it declared one. */
  readonly expectedBindingSha256?: string
  readonly nowMs?: number
}

export const validateCapabilityReceipt = (
  receipt: Partial<CapabilityReceipt>,
  options: ValidateCapabilityReceiptOptions,
): ReceiptValidation => {
  const shape = validateShape(receipt)
  if (!shape.ok) return shape
  const full = receipt as CapabilityReceipt
  const timing = validateTiming(full, options.nowMs ?? Date.now())
  if (!timing.ok) return timing
  // The receipt's own binding hash must agree with the fields it carries, or
  // the fields were edited after minting.
  const recomputed = capabilityBindingSha256(full)
  if (recomputed !== full.bindingSha256) {
    return {
      ok: false,
      reason: "receipt bindingSha256 does not match its own head/policy/toolchain",
    }
  }
  if (full.toolchainSha256 !== options.observedToolchainSha256) {
    return {
      ok: false,
      reason: `toolchain fingerprint moved since the probe (receipt ${full.toolchainSha256.slice(0, 12)}, host ${options.observedToolchainSha256.slice(0, 12)})`,
    }
  }
  if (
    options.expectedBindingSha256 !== undefined &&
    options.expectedBindingSha256 !== full.bindingSha256
  ) {
    return { ok: false, reason: "receipt binding does not match the binding the runner declared" }
  }
  return { ok: true }
}
