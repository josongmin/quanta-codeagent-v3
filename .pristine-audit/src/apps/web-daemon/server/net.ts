/**
 * `@/apps/web-daemon/server/net` — reachable-interface resolution.
 *
 * Computes the set of host addresses a client could actually reach this daemon
 * at (loopback + each non-internal interface when bound to a wildcard) so the
 * `/network` route can advertise every usable `ws://` / `http://` URL.
 */

import { networkInterfaces } from "node:os"

/** IPv6 literals need brackets in URLs (RFC 3986 §3.2.2). */
export const formatHost = (address: string, family: "IPv4" | "IPv6"): string =>
  family === "IPv6" ? `[${address}]` : address

export interface ReachableIp {
  readonly label: string
  readonly family: "IPv4" | "IPv6"
  readonly address: string
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
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === ""
  const loopback: ReachableIp =
    bind === "::" || bind === "::1"
      ? { label: "loopback", family: "IPv6", address: "::1" }
      : { label: "loopback", family: "IPv4", address: "127.0.0.1" }
  if (!wildcard && bind !== "0.0.0.0") {
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
  const out: ReachableIp[] = [loopback]
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (list === undefined) continue
    for (const entry of list) {
      if (entry.internal) continue
      if (entry.family !== "IPv4" && entry.family !== "IPv6") continue
      // Drop IPv6 link-local — `fe80::%en0` URLs aren't broadly usable.
      if (entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80")) {
        continue
      }
      out.push({
        label: name,
        family: entry.family,
        address: entry.address,
      })
    }
  }
  return out
}
