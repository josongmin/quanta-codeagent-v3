/**
 * External-agent import slice (ADR-0038, Cluster D Feature 4).
 *
 * Public re-exports for the migration slice. Slice isolation: only `@/
 * agent` (and the migration slice's own tests) may import from this index.
 */
export { contentSha256, wasAlreadyImported } from "./dedup";
export { detectExternalAgents, detectorContracts } from "./detector";
export { runImport, UnknownProviderRejectedError } from "./importer";
export { appendImportLog, ImportLogBusyError, importLogPath, loadImportLog, } from "./persistence";
export { claudeCodeTranslator, translatorFor, } from "./translators";
export { ALL_PROVIDERS, } from "./types";
