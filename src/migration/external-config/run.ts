/**
 * External-config migration ORCHESTRATION (H13).
 *
 * Ties Detect + Import + Throttle together into one pure-ish entry the startup
 * seam calls. Default-OFF: `enabled === false` ⇒ a byte-identical no-op (no
 * detect, no disk touch, no ledger). When enabled:
 *
 *   1. Detect external configs under home + project.
 *   2. If nothing is found, return early (no prompt, no ledger row).
 *   3. Compute the source key + consult the throttle ledger. Already-offered
 *      ⇒ `throttled:true`, NO converters run, NO re-offer.
 *   4. Otherwise run each item type's converter, record `offered` in the
 *      ledger (so the NEXT launch is throttled), and return the converted
 *      outputs for the surface to present.
 *
 * The function NEVER throws — a converter / ledger failure degrades to a
 * warning on the result. The surface (CLI startup) owns the actual prompt /
 * persistence of the converted quanta config; this slice only DETECTS,
 * CONVERTS, and THROTTLES (slice isolation — no `@/permission`, `@/mcp`, etc).
 */

import {
  convertAgentsMd,
  convertCursorRules,
  convertHooks,
  convertMcp,
  convertSettings,
  convertSubagents,
} from "./convert"
import { detectExternalConfigs } from "./detect"
import { isThrottled, loadMigrationLedger, recordDisposition, sourceKeyOf } from "./ledger"
import type {
  ConfigInventory,
  ConvertedItem,
  DetectedConfigItem,
  MigrationItemType,
  MigrationScope,
} from "./types"

/** Inputs to the orchestration. Every path injected (no env / homedir reads in
 *  the slice). `enabled` is the resolved knob value (`QUANTA_MIGRATE_CONFIG`). */
export interface RunConfigMigrationInput {
  readonly enabled: boolean
  readonly homeDir: string
  readonly projectDir: string
}

/** Result of one orchestration run. */
export interface RunConfigMigrationResult {
  /** False ⇒ the knob was off; nothing ran (byte-identical no-op). */
  readonly ran: boolean
  /** True ⇒ the source was already offered/imported/declined; suppressed. */
  readonly throttled: boolean
  /** The detect inventory (empty when nothing planted OR knob off). */
  readonly inventory: ConfigInventory
  /** Per-item converter outputs. Empty when throttled / nothing found / off. */
  readonly converted: readonly ConvertedItem[]
  /** The stable source key for this run (empty string when nothing found). */
  readonly sourceKey: string
}

const EMPTY_INVENTORY: ConfigInventory = { items: [], warnings: [] }

/** Run the right converter for one detected item. The cursor_rules + agents_md
 *  converters take a DIRECTORY (they reuse dir-scanning read-time loaders); the
 *  rest take the file path. `subagents`/`agents_md` may detect at a parent
 *  path — the converter handles the actual location. */
const convertItem = async (
  item: DetectedConfigItem,
  projectDir: string,
  homeDir: string,
): Promise<ConvertedItem> => {
  switch (item.type) {
    case "settings":
      return convertSettings(item.path)
    case "hooks":
      return convertHooks(item.path)
    case "mcp":
      return convertMcp(item.path)
    case "subagents":
      return convertSubagents(item.path)
    case "agents_md":
      return convertAgentsMd(item.path)
    case "cursor_rules":
      // glob-rules loader scans the rule DIRECTORY: use the scope root.
      return convertCursorRules(item.scope === "home" ? homeDir : projectDir)
  }
}

/**
 * Per-scope detect-convert-throttle. Returns the converted items for THIS scope
 * plus whether the scope was throttled. A scope with no items contributes
 * nothing. Recording `offered` is best-effort (a busy lock is swallowed).
 */
const runForScope = async (
  scope: MigrationScope,
  items: readonly DetectedConfigItem[],
  input: RunConfigMigrationInput,
): Promise<{ throttled: boolean; converted: ConvertedItem[]; sourceKey: string }> => {
  if (items.length === 0) return { throttled: false, converted: [], sourceKey: "" }
  const sourceKey = sourceKeyOf(scope, items)
  const ledger = await loadMigrationLedger(input.homeDir)
  if (isThrottled(ledger, sourceKey)) {
    return { throttled: true, converted: [], sourceKey }
  }
  const converted: ConvertedItem[] = []
  for (const item of items) {
    converted.push(await convertItem(item, input.projectDir, input.homeDir))
  }
  const itemTypes = [...new Set(items.map((i) => i.type))] as MigrationItemType[]
  // Best-effort throttle record so the NEXT launch is suppressed. A failed
  // write (busy lock) just means one extra prompt later — never a crash.
  await recordDisposition(input.homeDir, sourceKey, "offered", itemTypes).catch(() => false)
  return { throttled: false, converted, sourceKey }
}

/**
 * Detect + import competitor config, throttled. Default-OFF (knob false) ⇒
 * byte-identical no-op. NEVER throws.
 */
export const runConfigMigration = async (
  input: RunConfigMigrationInput,
): Promise<RunConfigMigrationResult> => {
  if (!input.enabled) {
    return {
      ran: false,
      throttled: false,
      inventory: EMPTY_INVENTORY,
      converted: [],
      sourceKey: "",
    }
  }
  let inventory: ConfigInventory
  try {
    inventory = await detectExternalConfigs({
      homeDir: input.homeDir,
      projectDir: input.projectDir,
    })
  } catch {
    // Detect is no-throw by contract, but belt-and-suspenders: a detect crash
    // must not derail startup.
    return { ran: true, throttled: false, inventory: EMPTY_INVENTORY, converted: [], sourceKey: "" }
  }
  if (inventory.items.length === 0) {
    return { ran: true, throttled: false, inventory, converted: [], sourceKey: "" }
  }
  // Partition by scope so home + project throttle independently (a project's
  // disposition must not suppress a different project, and vice-versa).
  const homeItems = inventory.items.filter((i) => i.scope === "home")
  const projectItems = inventory.items.filter((i) => i.scope === "project")
  const homeRun = await runForScope("home", homeItems, input)
  const projectRun = await runForScope("project", projectItems, input)

  const converted = [...homeRun.converted, ...projectRun.converted]
  // The run is "throttled" only when EVERY non-empty scope was throttled (i.e.
  // nothing new was offered). A mixed state (project new, home throttled) is
  // reported as not-throttled because the surface DOES have something to show.
  const scopes = [homeRun, projectRun].filter((r) => r.sourceKey !== "")
  const throttled = scopes.length > 0 && scopes.every((r) => r.throttled)
  // Surface the project source key when present (the common single-scope case),
  // else the home key.
  const sourceKey = projectRun.sourceKey !== "" ? projectRun.sourceKey : homeRun.sourceKey
  return { ran: true, throttled, inventory, converted, sourceKey }
}
