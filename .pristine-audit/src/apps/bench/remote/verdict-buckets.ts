import type { FullRemoteResult } from "./box-session"

export interface VerdictBuckets {
  readonly resolved: Set<string>
  readonly unresolved: Set<string>
  readonly errored: Set<string>
  readonly emptyPatch: Set<string>
}

type VerdictBucketName = keyof VerdictBuckets

const removeFromAllBuckets = (buckets: VerdictBuckets, id: string): void => {
  buckets.resolved.delete(id)
  buckets.unresolved.delete(id)
  buckets.errored.delete(id)
  buckets.emptyPatch.delete(id)
}

const placeIntoBucket = (buckets: VerdictBuckets, bucket: VerdictBucketName, id: string): void => {
  removeFromAllBuckets(buckets, id)
  buckets[bucket].add(id)
}

// If a malformed report repeats the same instance across multiple verdict arrays,
// keep one deterministic truth: later/stronger buckets win within the attempt,
// and a later attempt can overwrite an earlier attempt's bucket.
type VerdictField = "resolved" | "unresolved" | "errored" | "emptyPatch"

const VERDICT_PRECEDENCE: readonly [VerdictBucketName, VerdictField][] = [
  ["emptyPatch", "emptyPatch"],
  ["errored", "errored"],
  ["unresolved", "unresolved"],
  ["resolved", "resolved"],
]

export const absorbFullRemoteResult = (
  buckets: VerdictBuckets,
  result: Pick<FullRemoteResult, VerdictField>,
): void => {
  for (const [bucket, field] of VERDICT_PRECEDENCE) {
    for (const id of result[field] ?? []) placeIntoBucket(buckets, bucket, id)
  }
}
