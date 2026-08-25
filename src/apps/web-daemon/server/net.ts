/**
 * `@/apps/web-daemon/server/net` — reachable-interface resolution.
 *
 * Computes the set of host addresses a client could actually reach this daemon
 * at (loopback + each non-internal interface when bound to a wildcard) so the
 * `/network` route can advertise every usable `ws://` / `http://` URL.
 */

import { type NetworkInterfaceInfo, networkInterfaces } from "node:os"

/** IPv6 literals need brackets in URLs (RFC 3986 §3.2.2). */
export const formatHost = (address: string, family: "IPv4" | "IPv6"): string =>
  family === "IPv6" ? `[${address}]` : address

export interface ReachableIp {
  readonly label: string
  readonly family: "IPv4" | "IPv6"
  readonly address: string
}

/** The three bind spellings that mean "listen on every interface": IPv4 ANY,
 *  IPv6 ANY, and the empty string (Bun/Node treat `""` as unspecified). One
 *  unit because the wildcard question is asked in exactly one place now — the
 *  original spelled it twice (`!wildcard && bind !== "0.0.0.0"`, whose second
 *  conjunct is implied by the first and so never changed an answer). */
const isWildcardBind = (bind: string): boolean => bind === "0.0.0.0" || bind === "::" || bind === ""

/** The loopback entry that belongs with THIS bind. A unit because "which
 *  loopback family" is a decision about the bind string alone (v6 bind ⇒ `::1`,
 *  everything else ⇒ `127.0.0.1`) and is needed by BOTH the fixed-bind arm and
 *  the wildcard arm. */
const loopbackFor = (bind: string): ReachableIp =>
  bind === "::" || bind === "::1"
    ? { label: "loopback", family: "IPv6", address: "::1" }
    : { label: "loopback", family: "IPv4", address: "127.0.0.1" }

/** A bind to ONE specific address: the reachable set is fixed without touching
 *  the interface table. A unit because it is the whole non-wildcard answer —
 *  loopback-only for the three loopback spellings, else loopback + the bind
 *  itself (family inferred from the presence of a colon). */
const fixedBindTargets = (bind: string, loopback: ReachableIp): readonly ReachableIp[] => {
  if (bind === "127.0.0.1" || bind === "::1" || bind === "localhost") {
    return [loopback]
  }
  return [
    loopback,
    {
      label: "bind",
      family: bind.includes(":") ? "IPv6" : "IPv4",
      address: bind,
    },
  ]
}

/** The per-entry admission filter, in the original order: internal interfaces
 *  are not client-reachable, a family we do not model is skipped, and IPv6
 *  link-local is dropped because its zone-id suffix is not URL-safe. One unit
 *  because it is a single yes/no question about one interface entry — and it is
 *  where the nesting surcharge lived (three guards, three levels deep). */
const externalIpFrom = (name: string, entry: NetworkInterfaceInfo): ReachableIp | null => {
  if (entry.internal) return null
  if (entry.family !== "IPv4" && entry.family !== "IPv6") return null
  // Drop IPv6 link-local — `fe80::%en0` URLs aren't broadly usable.
  if (entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80")) {
    return null
  }
  return { label: name, family: entry.family, address: entry.address }
}

/** Walk the OS interface table in declaration order and keep what a client can
 *  reach. A unit because it is the only part that talks to the OS; the caller
 *  then only has to prepend loopback. */
const enumerateExternalIps = (): readonly ReachableIp[] => {
  const out: ReachableIp[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (list === undefined) continue
    for (const entry of list) {
      const ip = externalIpFrom(name, entry)
      if (ip !== null) out.push(ip)
    }
  }
  return out
}

/**
 * Resolve which interfaces a client could actually reach this daemon at.
 *
 * - `127.0.0.1` / `::1` / `localhost` bind ⇒ only loopback is reachable.
 * - `0.0.0.0` / `::` bind ⇒ every non-internal interface plus loopback.
 * - Specific IP bind ⇒ just that IP (loopback added only if same machine).
 *
 * IPv6 link-local (`fe80::*`) is dropped — its zone-id suffix isn't safe
 * inside a URL.
 */
export const collectReachableIps = (bind: string): readonly ReachableIp[] => {
  const loopback = loopbackFor(bind)
  if (!isWildcardBind(bind)) return fixedBindTargets(bind, loopback)
  return [loopback, ...enumerateExternalIps()]
}
