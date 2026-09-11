import { chooseShardTestTimeoutMs } from "./test-shard-plan"

/**
 * The per-test timeout is a SAFETY value and must keep following host load.
 * It is not an identity value.
 *
 * MEASURED DEFECT (2026-09-12): the runner put `sha256(String(testTimeoutMs))`
 * into `executionPolicyDigest`, and `chooseShardTestTimeoutMs` returns
 * 120,000 / 240,000 / 300,000 depending on the 1-minute load average. So the
 * same commit, the same files and the same toolchain produced three different
 * chunk identities depending only on how busy the box was when the campaign
 * started — every chunk missed because a neighbour process woke up.
 *
 * What belongs in the identity is the POLICY: which formula, which base,
 * which cap. What belongs in the receipt as a compatibility field is the
 * instance value plus the longest case actually observed under it, so the
 * lookup can prove a narrower budget would still have been met.
 */
export const TEST_TIMEOUT_POLICY_VERSION = "v1" as const

export interface TimeoutPolicy {
  readonly version: typeof TEST_TIMEOUT_POLICY_VERSION
  readonly baseMs: number
  readonly maxMs: number
  readonly formula: string
}

/**
 * Read OUT OF the implementation rather than restated beside it.
 *
 * `BASE_TEST_TIMEOUT_MS` / `MAX_TEST_TIMEOUT_MS` are module-private in
 * `test-shard-plan.ts`. Probing the exported function at zero load and at
 * saturating load recovers exactly those two numbers, so a change to either
 * constant moves this digest — where a copied literal would silently drift and
 * replay greens earned under a different cap.
 */
export const currentTimeoutPolicy = (
  choose: (cpu: { loadAverage1m: number; cpuCount: number }) => number = chooseShardTestTimeoutMs,
): TimeoutPolicy => ({
  version: TEST_TIMEOUT_POLICY_VERSION,
  baseMs: choose({ loadAverage1m: 0, cpuCount: 1 }),
  maxMs: choose({ loadAverage1m: Number.MAX_SAFE_INTEGER, cpuCount: 1 }),
  formula: "min(maxMs, baseMs * ceil(load1m / (2 * cpus)))",
})

export const timeoutPolicySha256 = (policy: TimeoutPolicy = currentTimeoutPolicy()): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(policy)).digest("hex")

export type TimeoutCompatibility =
  | { readonly kind: "compatible"; readonly reason: "widened" | "within-observed" | "unchanged" }
  | { readonly kind: "incompatible"; readonly reason: "narrowed-below-observed" }

/**
 * A green receipt proves every case COMPLETED. Under a longer budget it still
 * would have; under a shorter one it would have only if every case finished
 * inside the shorter budget — which the receipt's own longest observed case
 * answers. Both directions of an ordinary load-band move therefore hit, and a
 * genuinely unsafe narrowing (a case that ran past the new cap) misses.
 */
export const timeoutCompatibility = (input: {
  readonly receiptTestTimeoutMs: number
  readonly receiptMaxObservedCaseMs: number
  readonly expectedTestTimeoutMs: number
}): TimeoutCompatibility => {
  if (input.expectedTestTimeoutMs === input.receiptTestTimeoutMs) {
    return { kind: "compatible", reason: "unchanged" }
  }
  if (input.expectedTestTimeoutMs > input.receiptTestTimeoutMs) {
    return { kind: "compatible", reason: "widened" }
  }
  if (
    input.receiptMaxObservedCaseMs >= 0 &&
    input.receiptMaxObservedCaseMs < input.expectedTestTimeoutMs
  ) {
    return { kind: "compatible", reason: "within-observed" }
  }
  return { kind: "incompatible", reason: "narrowed-below-observed" }
}
