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
import { resolveMemoryDirPathsUnder } from "@/memory/consolidate/paths"
import { resolveMemoryHome } from "@/memory/store-path"
import {
  type ConvertedItem,
  importExternalConfig,
  type MigrationItemType,
  runConfigMigration,
} from "@/migration/external-config"
import { gateOn, runtimeConfig } from "@/shared"
import { quantaHomeDirFrom } from "@/shared/quanta-home"
import { discoverSystemSkills } from "@/skill"
import {
  composeImportSkillStage,
  type ImportSkillReview,
  importSkillsDir,
} from "./config-migration-skill-stage"

/** Order item types appear in the notice (stable, deterministic). */
const TYPE_ORDER: readonly MigrationItemType[] = [
  "agents_md",
  "settings",
  "hooks",
  "mcp",
  "subagents",
  "cursor_rules",
  "skills",
  "memory",
]

/** Human label for an item type in the notice. */
const LABEL: Readonly<Record<MigrationItemType, string>> = {
  agents_md: "repo-rules (CLAUDE.md/AGENTS.md)",
  settings: "permissions (settings.json)",
  hooks: "hooks",
  mcp: "MCP servers",
  subagents: "subagents",
  cursor_rules: "Cursor rules",
  skills: "skills (staged for review)",
  memory: "memory (→ raw_memories.md)",
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
    // UUX-4-15 (jul-10 W4) — the old copy claimed "one-click migration"; the
    // real config import needs the SECOND opt-in env (QUANTA_MIGRATE_CONFIG_
    // IMPORT=1) on a restart. Say the actual steps.
    return (
      `[quanta] found importable Claude/Cursor config: ${summary}. ` +
      `Run \`quanta session import claude_code\` to import sessions; ` +
      `to import the config above, restart with QUANTA_MIGRATE_CONFIG_IMPORT=1 ` +
      `(this notice won't repeat).\n`
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
 * throws — an import must not derail startup.
 *
 * Returns `{ notice, review }`:
 *   - `notice` — a one-line stderr summary of what was STAGED, or undefined when
 *     nothing was imported.
 *   - `review` — the review/approve surface bound to the SAME approval machine +
 *     artifact port + staging store the import staged into. Present iff a skill
 *     was actually staged (`review.list()` non-empty). The operator surface
 *     (`/skills review`) consumes it to approve→promote (hash-verified) or
 *     deny→drop. Absent (undefined) when no skill staged ⇒ nothing to review.
 *
 * The staging store + approval machine live for THIS process (production omits a
 * durable store); a proposal not reviewed before exit is simply re-staged on the
 * next gated import. NO live-dir write happens except on an explicit approve.
 */
export interface ConfigMigrationImportResult {
  readonly notice?: string
  /** The review surface bound to the staged proposals — present iff a skill was
   *  staged this run. */
  readonly review?: ImportSkillReview
}

export const runConfigMigrationImport = async (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  // Injected home dir (test seam) — production resolves `os.homedir()`. NOTE:
  // `os.homedir()` ignores `process.env.HOME` under Bun, so a test that only
  // sets HOME could NOT observe the real staging dir (a vacuous fail-safe rail);
  // this param lets a test drive the SAME dir the wire actually stages into.
  homeDir: string = homedir(),
): Promise<ConfigMigrationImportResult> => {
  let migrateConfig: boolean
  try {
    migrateConfig = runtimeConfig().migrateConfig
  } catch {
    return {}
  }
  // The persist is a SEPARATE confirmed opt-in beyond the feature gate.
  if (!migrateConfig || !gateOn(env, "QUANTA_MIGRATE_CONFIG_IMPORT")) return {}
  try {
    const home = homeDir
    // RFC03-def wire — compose the REAL imported-skill staging port (CAS artifact
    // + approval machine) + the review/approve surface + the pinned system-skill
    // name set so a startup skill import STAGES through approval instead of
    // failing closed (silent drop). The staging port's CAS jail root is the live
    // `<home>/.quanta/skills` dir; an imported skill that would SHADOW a system
    // skill is refused at convert time using the discovered system names.
    // `discoverSystemSkills` is a cheap read of the bundled dir (no user IO); an
    // empty set is safe (nothing to shadow). We THREAD the `review` surface out
    // so the operator can approve→promote (the loop is closed, not dark).
    const { stage, review } = composeImportSkillStage(importSkillsDir(home))
    const systemSkillNames = new Set((await discoverSystemSkills()).map((s) => s.name))
    // The directory the consolidator reads — the SAME decision the store and
    // session-memory-auto make — so an import is never appended where memory is not read.
    const memoryDir = resolveMemoryDirPathsUnder(
      resolveMemoryHome({ quantaHome: quantaHomeDirFrom(env), osHomeDir: home }).home,
    ).root
    const result = await importExternalConfig({
      enabled: true,
      homeDir: home,
      projectDir: cwd,
      skillStage: stage,
      systemSkillNames,
      memoryDir,
    })
    if (!result.ran || result.throttled || !result.persisted) return {}
    const writtenTypes = new Set<MigrationItemType>()
    for (const c of result.converted) {
      if (c.ok) writtenTypes.add(c.type)
    }
    const notice = summarizeImport([...writtenTypes])
    // Only surface the review when a skill actually staged (pending non-empty) —
    // otherwise there is nothing to review (byte-identical to before for a
    // non-skill import).
    const staged = review.list().length > 0
    return {
      ...(notice !== undefined ? { notice } : {}),
      ...(staged ? { review } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Fire-and-forget the CONFIRMED import + write a one-line notice to stderr.
 * Swallows everything. Default-OFF: with `QUANTA_MIGRATE_CONFIG_IMPORT` unset
 * this is a no-op (no detect, no disk touch) and returns `undefined`.
 *
 * Returns the review/approve surface (bound to the staged proposals) when a
 * skill was staged this run, so the REPL surface can thread it into the slash
 * ctx (`/skills review`). `undefined` when nothing staged ⇒ `/skills review`
 * prints "not wired" (byte-identical default-OFF).
 */
export const emitConfigMigrationImport = async (
  cwd: string,
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<ImportSkillReview | undefined> => {
  const { notice, review } = await runConfigMigrationImport(cwd)
  if (notice !== undefined) err(notice)
  return review
}
