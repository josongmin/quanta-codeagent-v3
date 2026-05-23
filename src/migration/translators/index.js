/**
 * Translator registry (ADR-0038, L4 promotion).
 *
 * Maps each translatable provider to its `SessionTranslator`. Claude Code is
 * the first real implementation; cursor/aider are stub translators that
 * return `[]` until their on-disk transcript formats are absorbed (tracked as
 * a follow-up — the importer treats an empty translation as a zero-message
 * session, NOT a halt, so a stub provider imports cleanly with count 0).
 */
import { claudeCodeTranslator } from "./claude-code";
/** Stub translator: returns `[]` for any file. Used for providers whose
 *  transcript format is not yet absorbed. */
const stubTranslator = {
    async translateFromFile() {
        return [];
    },
};
const TRANSLATORS = Object.freeze({
    claude_code: claudeCodeTranslator,
    cursor: stubTranslator,
    aider: stubTranslator,
});
/** Resolve the translator for a provider. Always defined for a
 *  `TranslatableProvider` (stub for not-yet-absorbed providers). */
export const translatorFor = (provider) => TRANSLATORS[provider];
export { claudeCodeTranslator } from "./claude-code";
