/**
 * CAPABILITY RECEIPT CONSUMER (TVH-11) — the test-module half.
 *
 * THE ONE RULE: this module never starts a process, never binds a socket,
 * never issues a network request. Everything it does is `readFileSync` of the
 * receipt the runner minted, plus `statSync` of already-resolved binaries (via
 * `external-toolchain.ts`, which is deliberately subprocess-free). That is what
 * makes importing a test file free again.
 *
 * ## Four verdicts, and why none of them may be silence
 *
 *   executed             — the capability is present; run the real assertions.
 *   skipped-unsupported  — the producer PROBED and the host does not have it.
 *   blocked-missing      — nobody probed: no receipt, an invalid receipt, or a
 *                          receipt bound to a different HEAD/policy/toolchain.
 *                          This is NOT "unsupported" and must never read as one.
 *   failed-setup         — the producer probed and the probe timed out or
 *                          errored. The host claims the capability and it does
 *                          not work: a fault, not an absence.
 *
 * Collapsing `blocked-missing` into `skipped-unsupported` is the exact bug this
 * ticket exists to kill — "the tool is missing" and "our gate never ran" printed the
 * same green. Under `QUANTA_REQUIRE_CAPABILITIES` (CI), `blocked` and
 * `failed-setup` THROW; locally they produce a VISIBLE skip carrying the
 * reason.
 *
 * ## Fail closed BEFORE any spawn
 *
 * Validation happens when the receipt is first read, which is before any test
 * body asks for a capability. A binding mismatch therefore cannot be discovered
 * after something has already been started.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_REQUIRE_ENV,
  type CapabilityFinding,
  type CapabilityReceipt,
  validateCapabilityReceipt,
} from "./capability-receipt"
import { externalToolchainFingerprint } from "./external-toolchain"

/**
 * THE SAME FOUR WORDS AS `tests/_helpers/capability-lane.ts`.
 *
 * That helper owns how a capability lane REPORTS its outcome to the required
 * aggregator (`quanta.capability-result.v1`). This module owns how a test LEARNS
 * whether the capability is there without probing for it. They are two halves of
 * one story and must not invent two vocabularies — a `CapabilityDecision` from
 * here is handed to `reportCapability` there with no translation, and
 * `tests/unit/_arch/module-load-effect-guard.test.ts` holds a compile-time
 * equality assertion between the two unions so a rename on either side is a
 * typecheck failure rather than a silent third dialect.
 */
export type CapabilityVerdict =
  | "executed"
  | "skipped-unsupported"
  | "blocked-missing"
  | "failed-setup"

export const CAPABILITY_VERDICTS: readonly CapabilityVerdict[] = [
  "executed",
  "skipped-unsupported",
  "blocked-missing",
  "failed-setup",
]

export interface CapabilityDecision {
  readonly capability: string
  readonly verdict: CapabilityVerdict
  readonly detail: string
  /** The winning candidate the producer resolved (interpreter path, adapter path). */
  readonly resolved?: string
  /** Ready to paste into a test/describe name so the runner log carries the reason. */
  readonly label: string
}

export type ReceiptLoad =
  | { readonly ok: true; readonly receipt: CapabilityReceipt; readonly path: string }
  | { readonly ok: false; readonly reason: string }

export interface ConsumerEnv {
  readonly [key: string]: string | undefined
}

const observedToolchainSha256 = (): string =>
  createHash("sha256").update(JSON.stringify(externalToolchainFingerprint())).digest("hex")

/** No subprocess, no network — `readFileSync` and `statSync` only. */
export const loadCapabilityReceipt = (
  env: ConsumerEnv = process.env,
  readText: (path: string) => string = (p) => readFileSync(p, "utf8"),
  nowMs: number = Date.now(),
): ReceiptLoad => {
  const path = env[CAPABILITY_RECEIPT_PATH_ENV]
  if (path === undefined || path.trim().length === 0) {
    return {
      ok: false,
      reason: `no capability receipt: ${CAPABILITY_RECEIPT_PATH_ENV} is unset — the tier runner did not produce one`,
    }
  }
  let parsed: Partial<CapabilityReceipt>
  try {
    parsed = JSON.parse(readText(path)) as Partial<CapabilityReceipt>
  } catch (error) {
    return { ok: false, reason: `capability receipt at ${path} is unreadable: ${String(error)}` }
  }
  const expectedBindingSha256 = env[CAPABILITY_RECEIPT_BINDING_ENV]
  const validation = validateCapabilityReceipt(parsed, {
    observedToolchainSha256: observedToolchainSha256(),
    ...(expectedBindingSha256 === undefined ? {} : { expectedBindingSha256 }),
    nowMs,
  })
  if (!validation.ok)
    return { ok: false, reason: `capability receipt at ${path}: ${validation.reason}` }
  return { ok: true, receipt: parsed as CapabilityReceipt, path }
}

/** One read per process. The receipt is immutable, so caching it is not a race. */
let cached: ReceiptLoad | undefined
export const capabilityReceipt = (): ReceiptLoad => {
  if (cached === undefined) cached = loadCapabilityReceipt()
  return cached
}

/** Tests that install a synthetic receipt must be able to clear the cache. */
export const __resetCapabilityReceiptCacheForTests = (): void => {
  cached = undefined
}

const verdictOfFinding = (finding: CapabilityFinding): CapabilityVerdict => {
  // A closed union classified exhaustively: adding a status without deciding
  // its verdict is a type error, not a silent default.
  const byStatus: Record<CapabilityFinding["status"], CapabilityVerdict> = {
    available: "executed",
    unavailable: "skipped-unsupported",
    "probe-timeout": "failed-setup",
    "probe-error": "failed-setup",
  }
  return byStatus[finding.status]
}

export const decideFromReceipt = (load: ReceiptLoad, capability: string): CapabilityDecision => {
  if (!load.ok) {
    return {
      capability,
      verdict: "blocked-missing",
      detail: load.reason,
      label: `blocked-missing: ${capability} — ${load.reason}`,
    }
  }
  const finding = load.receipt.capabilities[capability]
  if (finding === undefined) {
    return {
      capability,
      verdict: "blocked-missing",
      detail: `the receipt (tier ${load.receipt.tier}) does not carry "${capability}" — nobody probed it`,
      label: `blocked-missing: ${capability} — not in the receipt`,
    }
  }
  const verdict = verdictOfFinding(finding)
  return {
    capability,
    verdict,
    detail: finding.detail,
    ...(finding.resolved === undefined ? {} : { resolved: finding.resolved }),
    label: `${verdict}: ${capability} — ${finding.detail}`,
  }
}

/**
 * The call a test module makes. Pure with respect to the host; the only I/O is
 * the one cached `readFileSync` of the receipt.
 */
export const capability = (name: string): CapabilityDecision =>
  decideFromReceipt(capabilityReceipt(), name)

/**
 * CI contract, mirroring `tests/contract/_guard.ts`: when the environment
 * PROMISES the capabilities, a `blocked-missing` or `failed-setup` is a
 * provisioning failure and must be loud. Locally it is a visible skip.
 *
 * Absence (`skipped-unsupported`) never throws and never passes — the caller
 * turns it into a runner-visible skip.
 */
export const requireCapability = (
  decision: CapabilityDecision,
  env: ConsumerEnv = process.env,
): CapabilityDecision => {
  const strict = (env[CAPABILITY_REQUIRE_ENV] ?? "").length > 0
  if (strict && (decision.verdict === "blocked-missing" || decision.verdict === "failed-setup")) {
    throw new Error(
      `[capability] "${decision.capability}" is ${decision.verdict} but ${CAPABILITY_REQUIRE_ENV} is set: ${decision.detail}`,
    )
  }
  return decision
}

/** `true` only for `executed`. Every other verdict is a skip, never a pass. */
export const canExecute = (decision: CapabilityDecision): boolean => decision.verdict === "executed"

/** `describe.skipIf(...)`-friendly: skip unless the capability really executed. */
export const skipUnlessExecuted = (decision: CapabilityDecision): boolean => !canExecute(decision)
