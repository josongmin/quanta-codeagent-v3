/**
 * ADR-0325 — `src/agent/mention-injection/` barrel.
 *
 * Mention-driven explicit context injection. Sibling to ADR-0321's
 * snapshot-diff producer; both feed the same ADR-0320 typed-history
 * store + the same per-turn prompt inject seam.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`. Callers
 * reach the slice via the explicit `@/agent/mention-injection` path
 * once a wire-up ADR lands.
 *
 * Closed-port surface:
 *   - `parseMentions(text)`                — pure parser.
 *   - `MentionResolverPort`                — closed 3-method port.
 *   - `buildInjectionFragments(...)`       — port consumer.
 *   - `emitMentionEvents(...)`             — ADR-0320 store consumer.
 *   - `buildMentionInjectionMessages(...)` — ADR-0321-style inject builder.
 */

export { emitMentionEvents } from "./event-emitter"
export { buildMentionInjectionMessages } from "./inject-messages"
export { parseMentions } from "./parser"
export type { MentionResolverPort, MentionResolverResult } from "./resolver"
export { buildInjectionFragments } from "./resolver"
export type { InjectionFragment, MentionKind, ParsedMention } from "./types"
