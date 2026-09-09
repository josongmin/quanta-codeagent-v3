import { describe, expect, test } from "bun:test"
import {
  type ExecutionIdentity,
  executionPolicyDigest,
  sameExecutionIdentity,
  type VerificationExecutionPolicy,
  v1ReceiptIsMiss,
} from "../../../tools/dev/verification-execution-policy"

const policy = (over: Partial<VerificationExecutionPolicy> = {}): VerificationExecutionPolicy => ({
  version: "v2",
  runnerIdentity: "bun-1.3.14",
  intraParallel: 2,
  timeoutPolicyDigest: "t".repeat(64),
  isolationPolicyDigest: "i".repeat(64),
  environmentDigest: "e".repeat(64),
  cacheMode: "read-write",
  ...over,
})

const identity = (over: Partial<ExecutionIdentity> = {}): ExecutionIdentity => ({
  schema: "quanta.test-shard-success.v2",
  treeSha256: "a".repeat(64),
  suite: "full",
  manifestSha256: "b".repeat(64),
  shardFileCount: 2,
  shardFilesSha256: "c".repeat(64),
  toolchainSha256: "d".repeat(64),
  testEnvSha256: "e".repeat(64),
  executionPolicySha256: executionPolicyDigest(policy()),
  ...over,
})

describe("verification-execution-policy", () => {
  test("key order does not change the digest", () => {
    const left = executionPolicyDigest(policy({ intraParallel: 8, cacheMode: "off" }))
    const right = executionPolicyDigest({
      cacheMode: "off",
      environmentDigest: "e".repeat(64),
      intraParallel: 8,
      isolationPolicyDigest: "i".repeat(64),
      runnerIdentity: "bun-1.3.14",
      timeoutPolicyDigest: "t".repeat(64),
      version: "v2",
    })
    expect(left).toBe(right)
  })

  test("intraParallel 1/2/8 are mutually miss", () => {
    const widths = [1, 2, 8] as const
    const digests = widths.map((intraParallel) => executionPolicyDigest(policy({ intraParallel })))
    expect(new Set(digests).size).toBe(3)
    for (const width of widths) {
      const left = identity({
        executionPolicySha256: executionPolicyDigest(policy({ intraParallel: width })),
      })
      for (const other of widths) {
        const right = identity({
          executionPolicySha256: executionPolicyDigest(policy({ intraParallel: other })),
        })
        expect(sameExecutionIdentity(left, right)).toBe(width === other)
      }
    }
  })

  test("timeout digest change misses", () => {
    const left = identity()
    const right = identity({
      executionPolicySha256: executionPolicyDigest(policy({ timeoutPolicyDigest: "x".repeat(64) })),
    })
    expect(sameExecutionIdentity(left, right)).toBe(false)
  })

  test("v1 schema is an explicit miss", () => {
    expect(v1ReceiptIsMiss("quanta.test-shard-success.v1")).toBe(true)
    expect(v1ReceiptIsMiss("quanta.test-shard-success.v2")).toBe(false)
  })

  test("identical v2 policy hits", () => {
    expect(sameExecutionIdentity(identity(), identity())).toBe(true)
  })
})
