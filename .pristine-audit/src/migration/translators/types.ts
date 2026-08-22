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

import type { Message } from "@/llm"
import type { ExternalAgentProvider } from "../types"

/** A provider that the importer knows how to translate. `unknown` is never
 *  routed here — the importer rejects it upstream. */
export type TranslatableProvider = Exclude<ExternalAgentProvider, "unknown">

/** Reads a single session transcript file and returns it as v3 Messages.
 *  Implementations MUST be defensive: a malformed line/object is skipped,
 *  not thrown — a translator only throws when the file itself is unreadable
 *  (the importer treats a throw as a halt-on-error condition for that run). */
export interface SessionTranslator {
  translateFromFile(jsonlPath: string, provider: TranslatableProvider): Promise<Message[]>
}
