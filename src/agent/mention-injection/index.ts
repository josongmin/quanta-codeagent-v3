/**
 * ADR-0325 / ADR-0418 — `src/agent/mention-injection/` barrel.
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
 *   - `parseMentions(text)`                — pure 5-kind parser (ADR-0418).
 *   - `MentionResolverPort`                — closed async resolver port.
 *   - `buildInjectionFragments(...)`       — async port consumer (parallel).
 *   - `createSymbolResolver(...)`          — ADR-0418 `@symbol` resolver.
 *   - `emitMentionEvents(...)`             — ADR-0320 store consumer.
 *   - `buildMentionInjectionMessages(...)` — ADR-0321-style inject builder.
 *
 * (The `@file` resolver factory lives in `@/agent/plugin-app-resolver`,
 * alongside the composite resolver that wires it.)
 */

export { emitMentionEvents } from "./event-emitter"
export { buildMentionInjectionMessages } from "./inject-messages"
export { parseMentions } from "./parser"
export type { MentionResolverPort, MentionResolverResult } from "./resolver"
export { buildInjectionFragments } from "./resolver"
export type {
  SymbolHit,
  SymbolLookupLspPort,
  SymbolLookupSemanticPort,
  SymbolResolverConfig,
  SymbolResolverPriority,
} from "./symbol-resolver"
export { createSymbolResolver } from "./symbol-resolver"
export type { InjectionFragment, MentionKind, ParsedMention } from "./types"
