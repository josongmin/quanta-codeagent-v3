/**
 * External-agent session translators (ADR-0038, L4 promotion).
 *
 * A `SessionTranslator` reads ONE provider session transcript file off disk
 * and reconstructs it as v3 `Message[]`. Translators are pure with respect
 * to v3 state — they never write sessions; the importer owns persistence.
 * Each provider ships exactly one translator; unknown/stub providers return
 * an empty array (no throw) so the importer can count zero-translated rather
 * than halt.
 */
export {};
