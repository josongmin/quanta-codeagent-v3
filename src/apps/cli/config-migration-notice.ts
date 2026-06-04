/**
 * CLI surface adapter — H13 external-config migration STARTUP NOTICE.
 *
 * The minimal, gated startup seam that runs the `@/migration/external-config`
 * detect+convert flow and surfaces a ONE-LINE stderr notice when competitor
 * (Claude Code / Cursor) config is found AND not throttled. Import is opt-in:
 * the notice tells the user how to act; this seam does NOT mutate quanta config.
 *
 * Default-OFF: `runtimeConfig().migrateConfig` is the gate (`QUANTA_MIGRATE_
 * CONFIG=1`). Unset ⇒ `runConfigMigration({ enabled:false })` returns a no-op
 * result and we emit nothing — byte-identical startup. NEVER throws: any
 * failure is swallowed (a migration NOTICE must not derail the REPL).
 *
 * This file is the surface boundary: the `@/migration/external-config` slice is
 * env-free + homedir-free (every path injected), so the CLI resolves `homeDir`
 * (`os.homedir()`) + `projectDir` (the session cwd) and the knob HERE.
 */

import { homedir } from "node:os"
import {
  type ConvertedItem,
  type MigrationItemType,
  runConfigMigration,
} from "@/migration/external-config"
import { runtimeConfig } from "@/shared"

/** Order item types appear in the notice (stable, deterministic). */
const TYPE_ORDER: readonly MigrationItemType[] = [
  "agents_md",
  "settings",
  "hooks",
  "mcp",
  "subagents",
  "cursor_rules",
]

/** Human label for an item type in the notice. */
const LABEL: Readonly<Record<MigrationItemType, string>> = {
  agents_md: "repo-rules (CLAUDE.md/AGENTS.md)",
  settings: "permissions (settings.json)",
  hooks: "hooks",
  mcp: "MCP servers",
  subagents: "subagents",
  cursor_rules: "Cursor rules",
}

/** Count the OK converted items, grouped by type, for the notice summary. */
const summarize = (converted: readonly ConvertedItem[]): string => {
  const present = new Set<MigrationItemType>()
  for (const c of converted) {
    if (c.ok) present.add(c.type)
  }
  const parts = TYPE_ORDER.filter((t) => present.has(t)).map((t) => LABEL[t])
  return parts.join(", ")
}

/**
 * Run the gated config-migration detect+convert and return a one-line notice
 * string to write to stderr, or `undefined` when there is nothing to surface
 * (knob off / nothing found / throttled / all converters empty). Pure of side
 * effects beyond the slice's own throttle-ledger write. NEVER throws.
 */
export const buildConfigMigrationNotice = async (cwd: string): Promise<string | undefined> => {
  let migrateConfig: boolean
  try {
    migrateConfig = runtimeConfig().migrateConfig
  } catch {
    return undefined
  }
  if (!migrateConfig) return undefined
  try {
    const result = await runConfigMigration({
      enabled: true,
      homeDir: homedir(),
      projectDir: cwd,
    })
    if (!result.ran || result.throttled) return undefined
    const summary = summarize(result.converted)
    if (summary === "") return undefined
    return (
      `[quanta] found importable Claude/Cursor config: ${summary}. ` +
      `Run \`quanta session import claude_code\` to import sessions; ` +
      `config above is available for one-click migration (this notice won't repeat).\n`
    )
  } catch {
    // A migration notice must never derail startup.
    return undefined
  }
}

/**
 * Fire-and-forget: build + write the notice to stderr. Swallows everything.
 * The REPL calls this once, post-setup, BEFORE the loop. When the knob is off
 * this is a no-op (the slice short-circuits without touching disk).
 */
export const emitConfigMigrationNotice = async (
  cwd: string,
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<void> => {
  const notice = await buildConfigMigrationNotice(cwd)
  if (notice !== undefined) err(notice)
}
