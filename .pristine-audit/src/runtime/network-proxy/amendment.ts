/**
 * Network policy amendment store (ADR-0428).
 *
 * A runtime API to add a host to the LIVE allow-set AFTER an approval — pairs
 * conceptually with the Guardian post-denial flow (a denied egress can be
 * approved, then re-attempted). Amendments are:
 *   - SCOPED: each amendment carries an opaque `scope` token (e.g. a turn id /
 *     approval id) so a caller can revoke a batch atomically.
 *   - REVOCABLE: `revoke(host)` removes one; `revokeScope(scope)` removes all
 *     amendments tagged with that scope. Revocation is fail-closed — once a
 *     host is revoked it is no longer allowed unless re-amended.
 *
 * Amendments layer ON TOP of the static allowlist; they never remove a base
 * entry (the base allowlist is immutable). A host added by amendment is
 * reported by the proxy as `amended-allow` (vs `allow` for a base hit), which
 * the decision log distinguishes.
 *
 * Pure, in-memory, deterministic apart from the injected clock. No I/O.
 */

export interface AmendmentRecord {
  readonly host: string
  readonly scope: string
  readonly reason: string
  readonly at: number
}

export interface AmendInput {
  /** Bare host (or `*.suffix`) to add to the live allow-set. Lowercased. */
  readonly host: string
  /** Opaque grouping token for batch revocation. */
  readonly scope: string
  /** Why this host was approved (recorded for audit / decision log). */
  readonly reason?: string
}

/**
 * Live, revocable amend-set. Construction takes a clock so tests are
 * deterministic. NOT thread-shared mutable global — one instance per proxy.
 */
export class NetworkPolicyAmendment {
  private readonly byHost = new Map<string, AmendmentRecord>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Add (or refresh) an amendment for `host`. Idempotent on host. */
  amend(input: AmendInput): AmendmentRecord {
    const host = input.host.trim().toLowerCase()
    const rec: AmendmentRecord = Object.freeze({
      host,
      scope: input.scope,
      reason: input.reason ?? "amended after approval",
      at: this.now(),
    })
    this.byHost.set(host, rec)
    return rec
  }

  /** Is `host` currently amended into the allow-set? `host` is matched with the
   *  same exact/`*.suffix` semantics as the base allowlist so an amended
   *  wildcard covers subdomains. */
  isAmended(host: string): boolean {
    return this.lookup(host) !== null
  }

  /** Return the amendment record covering `host`, or `null`. */
  lookup(host: string): AmendmentRecord | null {
    const h = host.trim().toLowerCase()
    const exact = this.byHost.get(h)
    if (exact !== undefined) return exact
    for (const rec of this.byHost.values()) {
      if (rec.host.startsWith("*.")) {
        const suffix = rec.host.slice(1)
        if (h.endsWith(suffix) && h.length > suffix.length) return rec
      }
    }
    return null
  }

  /** Revoke a single host. Returns true if one was removed. */
  revoke(host: string): boolean {
    return this.byHost.delete(host.trim().toLowerCase())
  }

  /** Revoke every amendment tagged with `scope`. Returns the count removed. */
  revokeScope(scope: string): number {
    let n = 0
    for (const [host, rec] of this.byHost) {
      if (rec.scope === scope) {
        this.byHost.delete(host)
        n += 1
      }
    }
    return n
  }

  /** Snapshot of current amendments (for diagnostics). */
  list(): readonly AmendmentRecord[] {
    return Array.from(this.byHost.values())
  }
}
