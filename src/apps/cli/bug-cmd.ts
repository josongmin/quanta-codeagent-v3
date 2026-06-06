/**
 * `/bug [summary]` — feedback affordance (§23.4).
 *
 * quanta is not a hosted product, so there is no telemetry endpoint to POST
 * to. Instead `/bug` renders a PREFILLED GitHub "new issue" URL (title from the
 * args, body seeded with the version + platform) for the operator to open.
 *
 * Hard guarantees:
 *  - **No network**: the command only builds and prints a string. Nothing is
 *    sent anywhere.
 *  - **Injection-safe URL**: title/body are `encodeURIComponent`-escaped, so a
 *    summary containing `&`, `#`, quotes, or newlines cannot break the query
 *    string or smuggle extra params.
 */

import { repoUrl, resolveVersion } from "./repo-info"
import type { SlashCommand, SlashContext } from "./slash-contract"

export interface BugDeps {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
}

/** Build the operator-facing `/bug` output (pure). The returned string is what
 *  the command prints — a one-line note plus the prefilled issue URL. */
export const renderBug = (args: readonly string[], deps: BugDeps = {}): string => {
  const env = deps.env ?? process.env
  const version = resolveVersion(env, deps.cwd ?? process.cwd())
  const summary = args.join(" ").trim()
  const title = summary.length > 0 ? summary : "Bug report"
  const body = [
    "## Describe the bug",
    summary.length > 0 ? summary : "<describe what happened>",
    "",
    "## Environment",
    `- quanta: ${version}`,
    `- platform: ${process.platform}-${process.arch}`,
  ].join("\n")
  const url = `${repoUrl(env)}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  return `File a bug on GitHub (nothing was sent automatically):\n${url}`
}

export const buildBugCmd = (deps: BugDeps = {}): SlashCommand => ({
  name: "/bug",
  describe: "Print a prefilled GitHub issue URL for filing a bug (no data is sent)",
  category: "help",
  async run(args, ctx: SlashContext) {
    ctx.out(`${renderBug(args, deps)}\n`)
    return 0
  },
})

/** Ready-to-register `/bug` command wired to the real env/cwd. */
export const bugCmd = buildBugCmd()
