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
  CAPABILITY_LINE_PREFIX,
  CAPABILITY_RECEIPT_BINDING_ENV,
  CAPABILITY_RECEIPT_PATH_ENV,
  CAPABILITY_REQUIRE_ENV,
  type CapabilityFinding,
  type CapabilityReceipt,
  capabilityRequiredFor,
  validateCapabilityReceipt,
} from "./capability-receipt"
import { externalToolchainFingerprint } from "./external-toolchain"

/**
 * THE SAME FOUR WORDS AS `tests/_helpers/capability-lane.ts`.
 *
 * That helper owns how a capability lane REPORTS its outcome to the required
 * aggregator (`quanta.capability-result.v2`). This module owns how a test LEARNS
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
 * One reported line per capability per process.
 *
 * Deduplicated because a file may ask twice (`debugpy-real-e2e` asks for five
 * capabilities and reads two of them at two sites), and a tally that
 * double-counts is not a tally.
 */
const reported = new Set<string>()

/** Tests that assert on the reported line must be able to ask again. */
export const __resetCapabilityReportingForTests = (): void => {
  reported.clear()
}

/**
 * Write the outcome where the aggregator can see it.
 *
 * # The defect
 *
 * This module reported NOTHING. Fifteen files gate on it; twelve of them
 * selected `describe.skip` on `blocked-missing` and exited 0 with no line, so a
 * receipt lane that executed nothing was byte-identical to one that executed
 * everything. `tests/_helpers/capability-lane.ts` had already written the
 * sentence explaining why that is unacceptable ("a job that skipped all 17
 * files used to be textually identical to one that ran them") and built
 * `reportCapability` for its own half of the corpus. This is the other half.
 *
 * The shape differs from the lane's on purpose: a receipt decision has no
 * group and no declaring file, so it reports `capability=` and `verdict=`
 * rather than inventing a `group=` the manifest would not know.
 */
const reportDecision = (decision: CapabilityDecision): CapabilityDecision => {
  if (reported.has(decision.capability)) return decision
  reported.add(decision.capability)
  const resolved = decision.resolved === undefined ? "" : ` resolved=${decision.resolved}`
  process.stdout.write(
    `${CAPABILITY_LINE_PREFIX} capability=${decision.capability} ` +
      `verdict=${decision.verdict} detail=${JSON.stringify(decision.detail)}${resolved}\n`,
  )
  return decision
}

/**
 * The call a test module makes. The only I/O is the one cached `readFileSync`
 * of the receipt, plus the one reported line the tally needs.
 */
export const capability = (name: string): CapabilityDecision =>
  reportDecision(decideFromReceipt(capabilityReceipt(), name))

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
  // Per capability, not per process: naming one id used to make every id strict.
  const strict = capabilityRequiredFor(decision.capability, env)
  if (strict && (decision.verdict === "blocked-missing" || decision.verdict === "failed-setup")) {
    throw new Error(
      `${CAPABILITY_LINE_PREFIX} "${decision.capability}" is ${decision.verdict} ` +
        `but ${CAPABILITY_REQUIRE_ENV} is set: ${decision.detail}`,
    )
  }
  return decision
}

/**
 * `true` only for `executed`. Every other verdict is a skip, never a pass — and
 * under the strictness switch, `blocked-missing` and `failed-setup` are not even
 * a skip.
 *
 * # Why the requirement is INSIDE the predicate
 *
 * `requireCapability` is the throw that makes a required-but-absent capability
 * red. MEASURED across the corpus: of the fifteen files that consume the
 * receipt, THREE call it — the three under `tests/contract/`, which have their
 * own `_guard.ts`. The other twelve call `canExecute` and nothing else, so
 * `QUANTA_REQUIRE_CAPABILITIES` was unreachable from 80% of its own consumers.
 * Arming it did nothing for them; they skipped, and reported a pass.
 *
 * Folding the requirement into the predicate is what makes it impossible to
 * consume the receipt and bypass strictness. A predicate that throws is
 * unusual; a strictness switch that twelve of fifteen call sites cannot see is
 * worse, and the alternative was twelve call-site edits that the thirteenth new
 * file would not know to make.
 *
 * Unset (the default, and every ordinary local run) this changes nothing.
 */
export const canExecute = (
  decision: CapabilityDecision,
  env: ConsumerEnv = process.env,
): boolean => {
  requireCapability(decision, env)
  return decision.verdict === "executed"
}

/** `describe.skipIf(...)`-friendly: skip unless the capability really executed. */
export const skipUnlessExecuted = (decision: CapabilityDecision): boolean => !canExecute(decision)
