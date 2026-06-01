/**
 * Pure egress decision (ADR-0428).
 *
 * Given a target host, the static allowlist, and the live amend-set, decide
 * allow / deny / amended-allow + a reason. This is the SINGLE place the proxy
 * adapter consults — keeping the adapter free of policy logic and trivially
 * testable in isolation.
 *
 * Decision order (fail-closed):
 *   1. SSRF literal-IP guard — block private/loopback/link-local/metadata
 *      addresses BEFORE any allowlist check, so an allowlisted *name* can never
 *      tunnel to an internal address via a literal-IP authority.
 *   2. Base allowlist (`isHostAllowed`) ⇒ `allow`.
 *   3. Live amendment ⇒ `amended-allow`.
 *   4. Otherwise ⇒ `deny`.
 *
 * Reuses TWO existing security primitives (no re-implementation — the ADR-0427
 * R1 audit de-triplicated SSRF into one module; we do not re-fork it):
 *   - `@/runtime/network-allowlist#isHostAllowed` — the exact allow predicate
 *     the tool-arg dispatch guard uses, so socket- and arg-level agree.
 *   - `@/shared/net/ssrf#classifyHost` — the canonical structural IP classifier
 *     (handles octal/hex IPv4, IPv4-mapped/-compat IPv6, zone ids, `localhost`,
 *     FQDN root dot — strictly more robust than a string-prefix check).
 */

import { isHostAllowed } from "@/runtime/network-allowlist"
import { classifyHost } from "@/shared/net/ssrf"
import type { NetworkPolicyAmendment } from "./amendment"
import { METADATA_IPV4 } from "./ssrf"
import type { ProxyDecisionKind } from "./types"

export interface EgressDecision {
  readonly decision: ProxyDecisionKind
  readonly reason: string
}

export interface DecideInput {
  /** Bare host the client asked for (lowercased by the caller). */
  readonly host: string
  /** Immutable base allow-set. */
  readonly allowlist: readonly string[]
  /** Live, revocable amend-set. */
  readonly amendments: NetworkPolicyAmendment
}

export const decideEgress = (input: DecideInput): EgressDecision => {
  const { host, allowlist, amendments } = input

  // 1. SSRF guard — fail closed on literal internal addresses. The cloud
  // metadata endpoint gets a dedicated reason (it is the highest-value target);
  // everything else delegates to the canonical structural classifier.
  if (host.trim() === METADATA_IPV4) {
    return {
      decision: "deny",
      reason: `SSRF: cloud metadata endpoint (${METADATA_IPV4}) is categorically blocked`,
    }
  }
  const ssrf = classifyHost(host)
  if (ssrf !== null) {
    return { decision: "deny", reason: `SSRF: ${ssrf} address (${host}) blocked` }
  }

  // 2. Base allowlist.
  if (isHostAllowed(host, allowlist)) {
    return { decision: "allow", reason: `host '${host}' permitted by base allowlist` }
  }

  // 3. Runtime amendment (post-approval).
  const amended = amendments.lookup(host)
  if (amended !== null) {
    return {
      decision: "amended-allow",
      reason: `host '${host}' permitted by amendment (scope=${amended.scope}): ${amended.reason}`,
    }
  }

  // 4. Fail closed.
  return {
    decision: "deny",
    reason: `host '${host}' not in allow-set (base size=${allowlist.length}); not amended`,
  }
}
