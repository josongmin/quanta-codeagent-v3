/**
 * External-config migration slice (H13, jun-3-misc §3) — public barrel.
 *
 * Detect-and-import of competitor (Claude Code / Cursor) CONFIG artifacts into
 * quanta's format. Distinct from the parent `@/migration` session-transcript
 * import (ADR-0038/0430). Default-OFF behind `QUANTA_MIGRATE_CONFIG`.
 *
 * Surface adapters (`@/apps/cli`) import from here; the slice itself reuses the
 * read-time parsers `@/agent/repo-rules` + `@/agent/glob-rules` (no duplicated
 * parsing) and the parent slice's credential-safe `readImportFile`.
 */

export {
  type ConvertSkillsOptions,
  convertAgentsMd,
  convertCursorRules,
  convertHooks,
  convertMcp,
  convertMemory,
  convertSettings,
  convertSkillFile,
  convertSkills,
  convertSubagentFile,
  convertSubagents,
} from "./convert"
export { type DetectInput, detectExternalConfigs, detectProbes } from "./detect"
export {
  isThrottled,
  loadMigrationLedger,
  migrationLedgerPath,
  recordDisposition,
  sourceKeyOf,
} from "./ledger"
export {
  type ConfigWriteSync,
  defaultConfigWriteSync,
  type PersistConvertedInput,
  type PersistConvertedResult,
  persistConvertedItems,
} from "./persist"
export {
  type ImportExternalConfigResult,
  importExternalConfig,
  type RunConfigMigrationInput,
  type RunConfigMigrationResult,
  runConfigMigration,
} from "./run"
export {
  ALL_MIGRATION_ITEM_TYPES,
  type ConfigInventory,
  type ConvertedGlobRule,
  type ConvertedHook,
  type ConvertedItem,
  type ConvertedMcpServer,
  type ConvertedMemory,
  type ConvertedRepoRules,
  type ConvertedSettings,
  type ConvertedSkill,
  type ConvertedSubagent,
  type DetectedConfigItem,
  type MigrationDisposition,
  type MigrationItemType,
  type MigrationLedger,
  type MigrationLedgerEntry,
  type MigrationScope,
  type MigrationWarning,
  type SkillStagePort,
} from "./types"
