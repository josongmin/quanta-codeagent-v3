import type { ObjectiveVerificationPort, ReconcileOutcome } from "./criteria/ports"
import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveReadPort } from "./ports"

export type ObjectiveFreshness =
  | { readonly kind: "fresh" }
  | { readonly kind: "invalidated" }
  | { readonly kind: "source-unavailable"; readonly reason: string }
  | { readonly kind: "cap-exceeded"; readonly reason: string }
  | { readonly kind: "freshness-unresolved" }

export interface ObjectiveFreshRead {
  readonly domain: ObjectiveDomainSnapshot
  readonly freshness: ObjectiveFreshness
}

export const objectiveFreshnessFromReconcile = (outcome: ReconcileOutcome): ObjectiveFreshness => {
  switch (outcome.kind) {
    case "fresh":
    case "no-objective":
      return { kind: "fresh" }
    case "invalidated":
      return { kind: "invalidated" }
    case "source-unavailable":
    case "cap-exceeded":
      return { kind: outcome.kind, reason: outcome.reason }
    case "freshness-unresolved":
      return { kind: "freshness-unresolved" }
  }
}

/** Canonical operator read: reconcile first, then read the post-reconcile domain. */
export const reconcileObjectiveRead = async (
  read: ObjectiveReadPort,
  verifier: ObjectiveVerificationPort | undefined,
  threadId: string,
): Promise<ObjectiveFreshRead> => {
  if (verifier === undefined) {
    return { domain: read.readDomain(threadId), freshness: { kind: "freshness-unresolved" } }
  }
  try {
    const freshness = objectiveFreshnessFromReconcile(await verifier.reconcile(threadId))
    return { domain: read.readDomain(threadId), freshness }
  } catch {
    return { domain: read.readDomain(threadId), freshness: { kind: "freshness-unresolved" } }
  }
}
