/**
 * Browser tool — navigation URL guard (ADR-0427, strengthen #2; R1 audit fixes
 * [1][15][16]).
 *
 * Default-ON, in code: every `browser_navigate` URL is checked for
 *  - protocol (http/https only — `javascript:`/`data:`/`file:`/`blob:` denied),
 *  - SSRF via the canonical STRUCTURAL classifier in `@/shared/net/ssrf`
 *    (handles IPv4-mapped IPv6, `::1`, link-local, ULA — not just string
 *    prefixes), and
 *  - optionally DNS: when a `DnsResolver` is injected, a public-looking NAME that
 *    resolves to a private/loopback/link-local address is denied (closes the
 *    "name → private IP" hole; full rebinding pinning is out of scope — see note).
 *
 * SSRF logic is no longer copied here — it lives once in `@/shared/net/ssrf`.
 */

import { lookup } from "node:dns/promises"
import { classifyHost, isIpLiteral } from "@/shared/net/ssrf"

export type NavGuardResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string }

/** Injected DNS seam — resolve a hostname to its IP strings. Default-absent: the
 *  literal classifier still runs; only NAME→private detection needs this. The
 *  production wire passes a node-backed resolver; tests inject a fake. */
export interface DnsResolver {
  lookup(hostname: string): Promise<readonly string[]>
}

/** Production DNS resolver (node) — returns every resolved address so the guard
 *  can reject a name whose ANY address is private. The composition root injects
 *  this; tests inject a fake. */
export const nodeDnsResolver: DnsResolver = {
  async lookup(hostname: string): Promise<readonly string[]> {
    const records = await lookup(hostname, { all: true })
    return records.map((r) => r.address)
  },
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

/**
 * Parse + gate a navigation target. Async because the DNS step (when a resolver
 * is supplied) is async. Fail-closed: unparseable URL, disallowed protocol,
 * private literal, or a name resolving to a private address ⇒ denied.
 *
 * NOTE on DNS rebinding: classifying at guard time closes the common
 * name→private hole, but the browser re-resolves independently, so a TOCTOU
 * rebind is still theoretically possible. True defense requires pinning the
 * resolved address into the connection — deferred (documented limitation).
 */
export const guardNavigationUrl = async (
  raw: string,
  resolver?: DnsResolver,
): Promise<NavGuardResult> => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `invalid url: ${raw}` }
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `protocol not allowed: ${url.protocol} (only http/https)` }
  }
  const literal = classifyHost(url.hostname)
  if (literal !== null) return { ok: false, reason: literal }
  // A public IP literal is allowed; a DNS name may still resolve to a private IP.
  if (isIpLiteral(url.hostname)) return { ok: true, url }
  if (resolver !== undefined) {
    let addrs: readonly string[]
    try {
      addrs = await resolver.lookup(url.hostname)
    } catch {
      return { ok: false, reason: `dns resolution failed for ${url.hostname}` }
    }
    for (const addr of addrs) {
      const verdict = classifyHost(addr)
      if (verdict !== null) {
        return { ok: false, reason: `${url.hostname} resolves to ${addr} — ${verdict}` }
      }
    }
  }
  return { ok: true, url }
}
