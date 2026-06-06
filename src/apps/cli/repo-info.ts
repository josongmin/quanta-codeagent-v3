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

/** Resolve the project's GitHub web URL. `QUANTA_REPO_URL` wins ONLY when it is
 *  a well-formed `https:` URL — a hostile/malformed override (`javascript:`,
 *  `file:`, `data:`, a bare host, or garbage) falls back to the default so the
 *  printed `/version`/`/bug` URL can never carry a dangerous scheme. Trailing
 *  slashes are stripped so callers can append paths. */
export const repoUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.QUANTA_REPO_URL?.trim()
  if (override !== undefined && override.length > 0) {
    try {
      if (new URL(override).protocol === "https:") return override.replace(/\/+$/, "")
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
  if (pinned !== undefined && pinned.length > 0) return pinned
  return readPackageVersion(cwd) ?? "unknown"
}

/** Optional short commit hash for the version line. `QUANTA_COMMIT` only —
 *  absent ⇒ `undefined` (no git shell-out from a read-only command). */
export const resolveCommit = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const c = env.QUANTA_COMMIT?.trim()
  return c !== undefined && c.length > 0 ? c.slice(0, 12) : undefined
}
