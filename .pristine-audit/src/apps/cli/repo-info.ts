/**
 * Repo identity helpers shared by the operator-facing slash commands
 * (`/version`, `/release-notes`, `/bug`). Pure + env-injectable so the slash
 * bodies stay testable without touching `process.env` or the network.
 *
 * Slice fence: leaf utility under `src/apps/cli`. Reads `package.json` from
 * disk (fs walk, mirroring `@/observability` `readPackageVersion`) rather than
 * importing the JSON across the repo root — keeps the module self-contained and
 * avoids pulling the manifest into the bundle.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Canonical GitHub web URL for this project. Overridable via
 *  `QUANTA_REPO_URL` (forks / mirrors). No trailing slash. */
const DEFAULT_REPO_URL = "https://github.com/josongmin/quanta-codeagent-v3"

/** Strip C0/C1 control bytes + DEL (so a repo-controlled `package.json` version
 *  or an env value can't smuggle ANSI/OSC terminal-escape sequences into the
 *  line we print — quanta opens untrusted repos and `/version` is documented as
 *  read-only-safe) and cap length. Mirrors the `sanitizeTitle` posture used by
 *  the notify/auto-title slices. */
const sanitizeLine = (s: string, max = 80): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control bytes
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, max)

/** Resolve the project's GitHub web URL. `QUANTA_REPO_URL` wins ONLY when it is
 *  a well-formed `https://` URL with a real host and NO query / fragment /
 *  userinfo — anything else (dangerous scheme `javascript:`/`file:`/`data:`,
 *  schemeless `https:evil`, empty host `https:///x`, or a `#frag`/`?q` that
 *  would swallow the appended `/issues/new?…` path) falls back to the default.
 *  The accepted override is returned in CANONICAL `origin + pathname` form (not
 *  the raw string) so callers can always append a path cleanly. */
export const repoUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.QUANTA_REPO_URL?.trim()
  if (override !== undefined && /^https:\/\//i.test(override)) {
    try {
      const u = new URL(override)
      // Require a dotted (FQDN) host — every real git web host is one
      // (github.com / gitlab.com / git.example.org). This rejects the
      // single-label hosts WHATWG happily produces from malformed input
      // (`https:///etc/passwd` → host `etc`, `https://evil` → host `evil`).
      if (
        u.hostname.includes(".") &&
        u.search === "" &&
        u.hash === "" &&
        u.username === "" &&
        u.password === ""
      ) {
        return `${u.origin}${u.pathname}`.replace(/\/+$/, "")
      }
    } catch {
      // malformed URL — fall through to the default
    }
  }
  return DEFAULT_REPO_URL
}

/** Walk up from `cwd` looking for a `package.json` with a non-empty string
 *  `version`. Bounded to 5 levels (mirrors the observability resolver). Returns
 *  `undefined` when not found / unparseable. */
const readPackageVersion = (start: string): string | undefined => {
  let dir = start
  for (let i = 0; i < 5; i += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
        const v = (parsed as { version?: unknown }).version
        if (typeof v === "string" && v.length > 0) return v
      }
    } catch {
      // not at this level — keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Resolve the CLI version string. Precedence: `QUANTA_VERSION` (build-time
 *  inject) > `package.json` version > `"unknown"`. Never throws. */
export const resolveVersion = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string => {
  const pinned = env.QUANTA_VERSION?.trim()
  if (pinned !== undefined && pinned.length > 0) return sanitizeLine(pinned)
  return sanitizeLine(readPackageVersion(cwd) ?? "unknown")
}

/** Optional short commit hash for the version line. `QUANTA_COMMIT` only —
 *  absent ⇒ `undefined` (no git shell-out from a read-only command). */
export const resolveCommit = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const c = env.QUANTA_COMMIT?.trim()
  return c !== undefined && c.length > 0 ? sanitizeLine(c).slice(0, 12) : undefined
}
