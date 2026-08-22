/**
 * `/version` (+ `/release-notes`) — operator transparency (§23.3).
 *
 * `/version` prints the resolved CLI version (and short commit when
 * `QUANTA_COMMIT` is set) plus the platform string. `/release-notes` prints a
 * pointer to the GitHub releases page — TEXT ONLY, no network call (quanta is
 * not a hosted product, so there is no changelog endpoint to fetch).
 *
 * Both are read-only, additive slash commands: registering them changes no
 * existing command, and they never throw (version resolution falls back to
 * "unknown"). Env/cwd are injected so the bodies are testable.
 */

import { repoUrl, resolveCommit, resolveVersion } from "./repo-info"
import type { SlashCommand, SlashContext } from "./slash-contract"

export interface VersionDeps {
  /** Process env (injected for tests). Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** cwd for the package.json walk (injected for tests). */
  readonly cwd?: string
  /** Explicit version override. When set, bypasses the `QUANTA_VERSION` env /
   *  cwd package.json walk entirely. The top-level `--version` flag passes the
   *  BUNDLED `QUANTA_VERSION` const (the same build-time-baked value the welcome
   *  banner shows) so the flag reports the real build version regardless of the
   *  user's cwd — the cwd walk is unreliable outside the quanta repo. */
  readonly version?: string
}

/** Build the `/version` line(s). Pure: returns the rendered string so tests
 *  assert it without capturing stdout. */
export const renderVersion = (deps: VersionDeps = {}): string => {
  const env = deps.env ?? process.env
  const version = deps.version ?? resolveVersion(env, deps.cwd ?? process.cwd())
  const commit = resolveCommit(env)
  const head = commit !== undefined ? `quanta ${version} (${commit})` : `quanta ${version}`
  return `${head}\n${process.platform}-${process.arch} · ${repoUrl(env)}`
}

export const buildVersionCmd = (deps: VersionDeps = {}): SlashCommand => ({
  name: "/version",
  describe: "Show the CLI version, platform, and repository URL",
  category: "help",
  async run(_args, ctx: SlashContext) {
    ctx.out(`${renderVersion(deps)}\n`)
    return 0
  },
})

export const buildReleaseNotesCmd = (deps: VersionDeps = {}): SlashCommand => ({
  name: "/release-notes",
  describe: "Show where to find release notes (GitHub releases)",
  category: "help",
  async run(_args, ctx: SlashContext) {
    const env = deps.env ?? process.env
    const version = resolveVersion(env, deps.cwd ?? process.cwd())
    ctx.out(`quanta ${version}\nRelease notes: ${repoUrl(env)}/releases\n`)
    return 0
  },
})

/** Ready-to-register commands wired to the real env/cwd. */
export const versionCmd = buildVersionCmd()
export const releaseNotesCmd = buildReleaseNotesCmd()
