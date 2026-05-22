/**
 * Network allowlist — RFC may-22 ci-bot mode.
 *
 * Propositional outbound host check. Used by the ci-bot mode policy lever
 * `network: { kind: "allowlist"; hosts: readonly string[] }` to decide whether
 * a subprocess (typically `gh`, `curl`, `npm`) is talking to a permitted host.
 *
 * Design:
 *   - The signal is purely the URL/host string — NO counts, NO thresholds.
 *   - Allowlist is an exact host match OR a `*.suffix` wildcard for subdomains.
 *   - Caller decides what to DO with a denial (deny tool call, log, etc.) —
 *     this module only answers the boolean question "is this host allowed?".
 *
 * Default allowlist for ci-bot is small and audited:
 *   - api.github.com, github.com, raw.githubusercontent.com — gh CLI
 *   - registry.npmjs.org, registry.yarnpkg.com — package installs
 *   - pypi.org, files.pythonhosted.org — Python packages
 *   - codeload.github.com, objects.githubusercontent.com — git clone
 * Operator can extend via mode policy or override entirely.
 */

/** Canonical default allowlist for ci-bot. Operator can replace via
 *  `ModePolicy.network` lever. */
export const CI_BOT_DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "*.githubusercontent.com",
])

/** Extract the bare hostname from a URL string. Returns `null` for non-URLs
 *  or unparseable inputs — caller treats `null` as "not in allowlist". */
const hostOf = (urlOrHost: string): string | null => {
  if (!urlOrHost) return null
  // Bare host (no scheme) — return as-is, lowercased.
  if (!urlOrHost.includes("://")) return urlOrHost.trim().toLowerCase() || null
  try {
    return new URL(urlOrHost).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Match a host against a single allowlist entry. Entries beginning with
 *  `*.` match any subdomain of the suffix; otherwise an exact match. */
const matches = (host: string, entry: string): boolean => {
  const e = entry.toLowerCase()
  if (e.startsWith("*.")) {
    const suffix = e.slice(1) // ".example.com"
    return host === suffix.slice(1) || host.endsWith(suffix)
  }
  return host === e
}

/** Propositional check: is `urlOrHost` permitted by `allowlist`?
 *  Empty allowlist ⇒ deny everything (no implicit allow). */
export const isHostAllowed = (urlOrHost: string, allowlist: readonly string[]): boolean => {
  const host = hostOf(urlOrHost)
  if (host === null) return false
  for (const entry of allowlist) {
    if (matches(host, entry)) return true
  }
  return false
}

/** Render a denial reason string for diagnostics. */
export const denialReason = (urlOrHost: string, allowlist: readonly string[]): string => {
  const host = hostOf(urlOrHost) ?? "<unparseable>"
  return (
    `host '${host}' not in network allowlist (size=${allowlist.length}). ` +
    `add it via ModePolicy.network.hosts or use a different mode.`
  )
}
