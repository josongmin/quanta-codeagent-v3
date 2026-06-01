/**
 * Canonical SSRF host classifier (ADR-0427 R1 audit — single source of truth).
 *
 * Prefix-string matching on `url.hostname` is bypassable: WHATWG `URL`
 * normalizes decimal/hex/octal IPv4 (2130706433 → 127.0.0.1) so those ARE
 * caught, but IPv4-mapped IPv6 (`::ffff:127.0.0.1` → `::ffff:7f00:1`), `::1`,
 * link-local `fe80::/10`, and ULA `fc00::/7` are NOT. This module classifies
 * the host STRUCTURALLY (parse the IP literal, normalize IPv4-mapped/compat,
 * CIDR-check) so all forms resolve to the same verdict.
 *
 * `classifyHost` returns a deny reason for private/loopback/link-local/metadata
 * literals, or `null` when the host is a PUBLIC IP literal OR a DNS name (a name
 * needs resolution — see the navigation guard's DNS step). Pure + synchronous.
 */

const parseV4Octets = (host: string): readonly number[] | null => {
  const parts = host.split(".")
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

const classifyV4 = (octets: readonly number[]): string | null => {
  const [a, b] = octets as [number, number, number, number]
  if (a === 127) return "loopback (127/8)"
  if (a === 10) return "private (10/8)"
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16/12)"
  if (a === 192 && b === 168) return "private (192.168/16)"
  if (a === 169 && b === 254) return "link-local (169.254/16)"
  if (a === 0) return "unspecified (0/8)"
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT (100.64/10)"
  return null
}

const parseHextets = (s: string): number[] | null => {
  if (s === "") return []
  const out: number[] = []
  for (const part of s.split(":")) {
    if (part === "") return null
    if (part.includes(".")) {
      // embedded dotted IPv4 (last group of a mapped/compat address)
      const v4 = parseV4Octets(part)
      if (v4 === null) return null
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    out.push(Number.parseInt(part, 16))
  }
  return out
}

/** Expand an IPv6 literal to its 8 hextets, or null if not a valid v6 literal. */
const expandV6 = (host: string): number[] | null => {
  const halves = host.split("::")
  if (halves.length > 2) return null
  if (halves.length === 2) {
    const left = parseHextets(halves[0] ?? "")
    const right = parseHextets(halves[1] ?? "")
    if (left === null || right === null) return null
    const fill = 8 - left.length - right.length
    if (fill < 0) return null
    return [...left, ...new Array<number>(fill).fill(0), ...right]
  }
  const single = parseHextets(host)
  return single !== null && single.length === 8 ? single : null
}

const mappedV4 = (hx: readonly number[]): string | null => {
  const a = (hx[6] ?? 0) >> 8
  const b = (hx[6] ?? 0) & 0xff
  const c = (hx[7] ?? 0) >> 8
  const d = (hx[7] ?? 0) & 0xff
  return classifyV4([a, b, c, d])
}

// IPv4-mapped (`::ffff:a.b.c.d`) / -compat (`::a.b.c.d`) embedded-address verdict.
const embeddedV4Verdict = (hx: readonly number[]): string | null => {
  if (!hx.slice(0, 5).every((x) => x === 0)) return null
  if (hx[5] === 0xffff) {
    const r = mappedV4(hx)
    return r !== null ? `IPv4-mapped ${r}` : null
  }
  if (hx[5] === 0 && ((hx[6] ?? 0) !== 0 || (hx[7] ?? 0) !== 0)) {
    const r = mappedV4(hx)
    if (r !== null) return `IPv4-compat ${r}`
  }
  return null
}

const classifyV6 = (host: string): string | null => {
  const hx = expandV6(host)
  if (hx === null) return null
  if (hx.every((x, i) => (i < 7 ? x === 0 : x === 1))) return "loopback (::1)"
  if (hx.every((x) => x === 0)) return "unspecified (::)"
  const embedded = embeddedV4Verdict(hx)
  if (embedded !== null) return embedded
  const first = hx[0] ?? 0
  if ((first & 0xffc0) === 0xfe80) return "link-local (fe80::/10)"
  if ((first & 0xfe00) === 0xfc00) return "ULA (fc00::/7)"
  return null
}

/** True when `hostname` (already lowercased, brackets stripped) is an IP literal
 *  (v4 dotted or v6) rather than a DNS name. */
export const isIpLiteral = (hostname: string): boolean => {
  const bare = normalizeHost(hostname)
  return bare.includes(":") || parseV4Octets(bare) !== null
}

const stripBrackets = (h: string): string =>
  h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h

// Strip an IPv6 zone/scope id (`fe80::1%eth0`) — without this the `%`-suffixed
// form fails to parse and slips through as ALLOWED (R2 audit [13]). No legit DNS
// name contains `%`, so this is safe for the name path too.
const stripZone = (h: string): string => {
  const i = h.indexOf("%")
  return i >= 0 ? h.slice(0, i) : h
}

const normalizeHost = (hostname: string): string => {
  // Strip a trailing FQDN root dot — `localhost.` / `127.0.0.1.` resolve to the
  // same host and must not bypass the deny (edge audit bug #1).
  const h = stripZone(stripBrackets(hostname.toLowerCase()))
  return h.endsWith(".") ? h.slice(0, -1) : h
}

/**
 * Deny reason for an SSRF-unsafe host, or null if allowed-as-literal / a DNS
 * name (names are classified post-resolution by the caller). Accepts a raw
 * `URL.hostname` (lowercased + bracket-stripped here, defensively).
 */
export const classifyHost = (hostname: string): string | null => {
  const bare = normalizeHost(hostname)
  if (bare === "localhost" || bare.endsWith(".localhost")) return "localhost denied"
  if (bare.includes(":")) return classifyV6(bare)
  const v4 = parseV4Octets(bare)
  if (v4 !== null) return classifyV4(v4)
  return null // DNS name — needs resolution
}

/** Back-compat alias: the legacy `ssrfDeny(hostname)` signature. */
export const ssrfDeny = classifyHost
