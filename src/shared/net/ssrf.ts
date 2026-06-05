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

/** Decode the IPv4 embedded in two consecutive hextets (high:low) and run the
 *  v4 classifier. Used by every IPv6→IPv4 transition form (mapped/compat/
 *  translated/NAT64/6to4) so the SAME private/loopback/link-local verdict
 *  applies no matter which transition wrapper carried the address. */
const v4VerdictFromHextets = (hi: number, lo: number): string | null =>
  classifyV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])

/** Does the hextet array start with the given exact-value prefix? */
const hasPrefix = (hx: readonly number[], prefix: readonly number[]): boolean =>
  prefix.every((v, i) => hx[i] === v)

/** IPv6→IPv4 transition wrappers that embed a literal IPv4 address. Each MUST be
 *  classified by its embedded v4 octets — a string-prefix denylist (or even the
 *  mapped-only check) misses these, letting `[64:ff9b::7f00:1]` (NAT64 →
 *  loopback) and `[2002:a9fe:a9fe::]` (6to4 → 169.254.169.254 metadata) reach an
 *  internal service on a NAT64/6to4-enabled host (R6 audit — embedded-IPv4 SSRF
 *  bypass). `prefix` pins the wrapper's fixed hextets; `[hi,lo]` are the indices
 *  of the two hextets carrying the embedded v4 address. */
const EMBEDDED_V4_WRAPPERS: ReadonlyArray<{
  readonly label: string
  readonly prefix: readonly number[]
  readonly hi: number
  readonly lo: number
}> = [
  // ::ffff:a.b.c.d  (IPv4-mapped, ::ffff:0:0/96)
  { label: "IPv4-mapped", prefix: [0, 0, 0, 0, 0, 0xffff], hi: 6, lo: 7 },
  // ::ffff:0:a.b.c.d  (IPv4-translated, ::ffff:0:0/96 with the extra 0 group)
  { label: "IPv4-translated", prefix: [0, 0, 0, 0, 0xffff, 0], hi: 6, lo: 7 },
  // 64:ff9b::a.b.c.d  (NAT64 well-known prefix, 64:ff9b::/96)
  { label: "NAT64-embedded", prefix: [0x0064, 0xff9b, 0, 0, 0, 0], hi: 6, lo: 7 },
  // 2002:a.b.c.d::/16  (6to4)
  { label: "6to4-embedded", prefix: [0x2002], hi: 1, lo: 2 },
]

const mappedV4 = (hx: readonly number[]): string | null =>
  v4VerdictFromHextets(hx[6] ?? 0, hx[7] ?? 0)

const embeddedV4Verdict = (hx: readonly number[]): string | null => {
  // ::a.b.c.d (IPv4-compat) — first 5 hextets 0, group 6 == 0, address non-zero.
  // Handled separately because its "prefix" is the ABSENCE of 0xffff and it must
  // not swallow the all-zero (::) / loopback (::1) cases already verdicted above.
  if (
    hx.slice(0, 5).every((x) => x === 0) &&
    hx[5] === 0 &&
    ((hx[6] ?? 0) !== 0 || (hx[7] ?? 0) !== 0)
  ) {
    const r = mappedV4(hx)
    if (r !== null) return `IPv4-compat ${r}`
  }
  for (const w of EMBEDDED_V4_WRAPPERS) {
    if (!hasPrefix(hx, w.prefix)) continue
    const r = v4VerdictFromHextets(hx[w.hi] ?? 0, hx[w.lo] ?? 0)
    if (r !== null) return `${w.label} ${r}`
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
  // Deprecated site-local fec0::/10 (RFC 3879) — still routes internally on
  // legacy stacks; deny defensively alongside fe80::/10 link-local.
  if ((first & 0xffc0) === 0xfec0) return "site-local (fec0::/10)"
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
  // `.trim()` first — a leading/trailing space otherwise defeats both the v4 and
  // localhost/v6 classification, allowing " 127.0.0.1" through (R3 audit [9]).
  // Strip a trailing FQDN root dot — `localhost.` / `127.0.0.1.` resolve to the
  // same host and must not bypass the deny (edge audit bug #1).
  const h = stripZone(stripBrackets(hostname.trim().toLowerCase()))
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

/** Max redirect hops we follow before giving up — matches the WHATWG fetch
 *  default of 20 only loosely; 5 is the common "enough for legit CDNs, short
 *  enough to bound a redirect-loop attack" ceiling. */
export const SSRF_MAX_REDIRECTS = 5

/** Thrown internally when a hop fails the guard. Carries a `reason` so the
 *  caller can surface a typed deny without re-parsing the message. */
export class SsrfGuardError extends Error {
  constructor(
    message: string,
    readonly hostname: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = "SsrfGuardError"
  }
}

/** Resolve a hostname to its IP literals. Injected so tests can drive rebinding
 *  scenarios deterministically; the default uses the platform DNS resolver. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

/** Default resolver — node DNS, all A/AAAA records. Lazily imported so the pure
 *  classifier half of this module carries no node:dns dependency for callers
 *  that only use {@link classifyHost}. */
const defaultResolveHost: HostResolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises")
  const records = await lookup(hostname, { all: true })
  return records.map((r) => r.address)
}

/** Validate a single (post-redirect) URL: https-only + structural SSRF deny +
 *  (for DNS names) resolved-IP check. Throws {@link SsrfGuardError} on rejection.
 *  Shared by the initial fetch and every redirect hop so a 30x to an internal
 *  address cannot bypass the pre-flight host check (the original SSRF-redirect
 *  bypass). Async because the DNS-rebinding layer resolves the name. */
const assertUrlSafe = async (url: URL, resolveHost: HostResolver): Promise<void> => {
  // http→https downgrade and all non-https schemes (file:, data:, gopher:, …)
  // are rejected — a redirect must not escape TLS.
  if (url.protocol !== "https:") {
    throw new SsrfGuardError(
      `redirect to non-https URL rejected (got ${url.protocol})`,
      url.hostname,
      "non_https_redirect",
    )
  }
  const deny = classifyHost(url.hostname)
  if (deny !== null) {
    throw new SsrfGuardError(`SSRF denied: ${url.hostname} — ${deny}`, url.hostname, deny)
  }
  // DNS-rebinding layer: a public NAME (not an IP literal — those are already
  // verdicted above) is resolved and EVERY returned address is structurally
  // re-checked. This catches the realistic attack — an attacker pointing their
  // domain's A/AAAA record straight at 169.254.169.254 / 127.0.0.1 / RFC1918 —
  // which the hostname check alone cannot see. (A full TOCTOU rebind that flips
  // the record between this resolve and fetch's own connect still needs IP
  // pinning, which Bun's `fetch` cannot express; that residue is documented on
  // fetchWithSsrfGuard.) Resolver ERRORS fail-OPEN: a transient DNS failure must
  // not break a legitimate fetch (fetch would fail the same way), and the
  // literal-host check already ran — we are only ADDING rejections here.
  if (isIpLiteral(url.hostname)) return
  let addresses: readonly string[]
  try {
    addresses = await resolveHost(url.hostname)
  } catch {
    return
  }
  for (const addr of addresses) {
    const ipDeny = classifyHost(addr)
    if (ipDeny !== null) {
      throw new SsrfGuardError(
        `SSRF denied: ${url.hostname} resolves to ${addr} — ${ipDeny}`,
        url.hostname,
        `dns_rebind_${ipDeny}`,
      )
    }
  }
}

/**
 * Redirect-safe `fetch`: follows up to {@link SSRF_MAX_REDIRECTS} hops with
 * `redirect:"manual"`, re-running the https-only + structural SSRF host check
 * on EVERY hop (including the resolved `Location`). This closes the
 * redirect-bypass where a public URL 30x-redirects to 169.254.169.254 /
 * 127.0.0.1 / RFC1918 — `redirect:"follow"` would have reached the internal
 * service before any host check ran.
 *
 * The caller is expected to have already validated `initialUrl` via the same
 * predicate; we re-validate it here too so the helper is safe in isolation.
 *
 * On any guard violation throws {@link SsrfGuardError} (caught by the tool's
 * fetch phase and mapped to a typed `ok:false`). A redirect response with no
 * `Location` header is treated as a hard failure (malformed).
 *
 * DNS-rebinding: each hop now ALSO resolves the hostname and structurally
 * re-checks every returned A/AAAA address (via the injected {@link HostResolver},
 * default node DNS), so a name that resolves straight to a private/loopback/
 * metadata IP is rejected — not just literal-IP redirects. RESIDUAL: a true
 * TOCTOU rebind that flips the record between this resolve and `fetch`'s own
 * connect is still possible because Bun's global `fetch` exposes no `lookup`/
 * dispatcher hook to pin the validated IP at connect time; closing that needs a
 * custom dispatcher and is tracked as a separate ADR.
 */
export const fetchWithSsrfGuard = async (
  fetcher: typeof fetch,
  initialUrl: string,
  init: RequestInit & { signal: AbortSignal },
  opts: { resolveHost?: HostResolver } = {},
): Promise<Response> => {
  const resolveHost = opts.resolveHost ?? defaultResolveHost
  let current = new URL(initialUrl)
  await assertUrlSafe(current, resolveHost)
  for (let hop = 0; hop <= SSRF_MAX_REDIRECTS; hop++) {
    const res = await fetcher(current.toString(), { ...init, redirect: "manual" })
    // 3xx with a Location is a redirect under redirect:"manual" — re-guard.
    // (304 Not Modified / 300 Multiple Choices without Location are NOT
    // redirects we follow; they fall through to the non-redirect return.)
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location")
    if (!isRedirect) return res
    if (hop === SSRF_MAX_REDIRECTS) {
      throw new SsrfGuardError(
        `too many redirects (> ${SSRF_MAX_REDIRECTS})`,
        current.hostname,
        "too_many_redirects",
      )
    }
    const location = res.headers.get("location")
    if (location === null || location === "") {
      throw new SsrfGuardError("redirect with no Location", current.hostname, "no_location")
    }
    // Resolve relative Location against the CURRENT (post-redirect) URL.
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new SsrfGuardError(
        `redirect to malformed Location: ${location}`,
        current.hostname,
        "malformed_location",
      )
    }
    await assertUrlSafe(next, resolveHost)
    current = next
  }
  // Unreachable: the loop either returns a non-redirect response or throws on
  // the final hop. Present to satisfy the type checker.
  throw new SsrfGuardError("redirect handling exhausted", current.hostname, "exhausted")
}
