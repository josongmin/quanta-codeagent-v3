import { createHash } from "node:crypto"

export type CacheMode = "off" | "read-write"

export interface VerificationExecutionPolicy {
  readonly version: "v2"
  readonly runnerIdentity: string
  readonly intraParallel: number
  readonly timeoutPolicyDigest: string
  readonly isolationPolicyDigest: string
  readonly environmentDigest: string
  readonly cacheMode: CacheMode
}

const canonical = (policy: VerificationExecutionPolicy): string =>
  JSON.stringify({
    cacheMode: policy.cacheMode,
    environmentDigest: policy.environmentDigest,
    intraParallel: policy.intraParallel,
    isolationPolicyDigest: policy.isolationPolicyDigest,
    runnerIdentity: policy.runnerIdentity,
    timeoutPolicyDigest: policy.timeoutPolicyDigest,
    version: policy.version,
  })

export const executionPolicyDigest = (policy: VerificationExecutionPolicy): string =>
  createHash("sha256").update(canonical(policy)).digest("hex")

export interface ExecutionIdentity {
  readonly schema: "quanta.test-shard-success.v2"
  readonly treeSha256: string
  readonly suite: string
  readonly manifestSha256: string
  readonly shardFileCount: number
  readonly shardFilesSha256: string
  readonly toolchainSha256: string
  readonly testEnvSha256: string
  readonly executionPolicySha256: string
}

export const sameExecutionIdentity = (left: ExecutionIdentity, right: ExecutionIdentity): boolean =>
  left.schema === right.schema &&
  left.treeSha256 === right.treeSha256 &&
  left.suite === right.suite &&
  left.manifestSha256 === right.manifestSha256 &&
  left.shardFileCount === right.shardFileCount &&
  left.shardFilesSha256 === right.shardFilesSha256 &&
  left.toolchainSha256 === right.toolchainSha256 &&
  left.testEnvSha256 === right.testEnvSha256 &&
  left.executionPolicySha256 === right.executionPolicySha256

export const v1ReceiptIsMiss = (schema: string): boolean =>
  schema !== "quanta.test-shard-success.v2"
