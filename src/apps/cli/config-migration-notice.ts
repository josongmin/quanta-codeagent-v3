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
  importExternalConfig,
  type MigrationItemType,
  runConfigMigration,
} from "@/migration/external-config"
import { gateOn, runtimeConfig } from "@/shared"

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

/** Summarize a persist outcome into a one-line stderr notice, or undefined
 *  when nothing was written. */
const summarizeImport = (writtenTypes: readonly MigrationItemType[]): string | undefined => {
  const present = new Set(writtenTypes)
  const parts = TYPE_ORDER.filter((t) => present.has(t)).map((t) => LABEL[t])
  if (parts.length === 0) return undefined
  return `[quanta] imported Claude/Cursor config into your quanta config: ${parts.join(", ")}.\n`
}

/**
 * Run the gated, CONFIRMED config-migration IMPORT — detect+convert+PERSIST.
 *
 * This is the SEPARATE opt-in step the startup notice points to: the notice
 * only records `offered`; this actually WRITES the converted config into
 * quanta's live locations (`settings.json` permissions/hooks, `.mcp.json`,
 * `.quanta/agents`, `AGENTS.md`, `.quanta/rules`) and records `imported` so a
 * re-run is a no-op.
 *
 * Gated by BOTH `QUANTA_MIGRATE_CONFIG=1` (the feature) AND a CONFIRMED step
 * `QUANTA_MIGRATE_CONFIG_IMPORT=1` (the user opting in to actually write). With
 * either unset ⇒ no detect, no persist, byte-identical (default-OFF). NEVER
 * throws — an import must not derail startup. Returns a one-line stderr notice
 * describing what was written, or undefined when nothing was imported.
 */
export const runConfigMigrationImport = async (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> => {
  let migrateConfig: boolean
  try {
    migrateConfig = runtimeConfig().migrateConfig
  } catch {
    return undefined
  }
  // The persist is a SEPARATE confirmed opt-in beyond the feature gate.
  if (!migrateConfig || !gateOn(env, "QUANTA_MIGRATE_CONFIG_IMPORT")) return undefined
  try {
    const result = await importExternalConfig({
      enabled: true,
      homeDir: homedir(),
      projectDir: cwd,
    })
    if (!result.ran || result.throttled || !result.persisted) return undefined
    const writtenTypes = new Set<MigrationItemType>()
    for (const c of result.converted) {
      if (c.ok) writtenTypes.add(c.type)
    }
    return summarizeImport([...writtenTypes])
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget the CONFIRMED import + write a one-line notice to stderr.
 * Swallows everything. Default-OFF: with `QUANTA_MIGRATE_CONFIG_IMPORT` unset
 * this is a no-op (no detect, no disk touch).
 */
export const emitConfigMigrationImport = async (
  cwd: string,
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<void> => {
  const notice = await runConfigMigrationImport(cwd)
  if (notice !== undefined) err(notice)
}
