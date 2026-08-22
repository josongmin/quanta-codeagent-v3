/**
 * External-agent import slice (ADR-0038, Cluster D Feature 4).
 *
 * Public re-exports for the migration slice. Slice isolation: only `@/
 * agent` (and the migration slice's own tests) may import from this index.
 */

export {
  CredentialReadBannedError,
  contentSha256,
  contentSha256OfText,
  isCredentialPath,
  readImportFile,
  wasAlreadyImported,
} from "./dedup"
export { detectExternalAgents, detectorContracts } from "./detector"
export { type RunImportOptions, runImport, UnknownProviderRejectedError } from "./importer"
export {
  appendImportLog,
  defaultImportLogSync,
  ImportLogBusyError,
  type ImportLogSync,
  importLogPath,
  loadImportLog,
} from "./persistence"
export {
  claudeCodeTranslator,
  type SessionTranslator,
  type TranslatableProvider,
  translatorFor,
} from "./translators"
export {
  translateHooks,
  translateMcpServers,
  translateRules,
} from "./translators/claude-code-config"
export {
  ALL_PROVIDERS,
  type DetectedAgent,
  type ExternalAgentProvider,
  type ExternalSessionId,
  type ImportEvent,
  type ImportEventSink,
  type ImportLog,
  type ImportLogEntry,
  type ImportResult,
  type ImportStage,
  type TranslatedHook,
  type TranslatedMcpServer,
  type TranslatedRule,
  type TranslatedSession,
} from "./types"
