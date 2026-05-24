/**
 * Web search provider barrel (ADR-0133).
 *
 *   - `braveSearchProvider` — primary, REST-backed, requires an API key.
 *   - `duckduckgoSearchProvider` — fallback, no key required, LIMITED
 *     (Instant Answer endpoint, not a full web search).
 *
 * Consumers wire one of these into `AgentConfig.webSearch.provider` per
 * ADR-0127. Importing this barrel directly keeps the providers OFF the
 * default tool fence — hosts that don't want web search pull in no
 * provider code at all (tree-shake / dead-code-elim friendly).
 */

export {
  BRAVE_DEFAULT_ENDPOINT,
  BraveSearchError,
  type BraveSearchOpts,
  braveSearchProvider,
} from "./brave"
export {
  DDG_DEFAULT_ENDPOINT,
  type DuckDuckGoSearchOpts,
  duckduckgoSearchProvider,
} from "./duckduckgo"
// ADR-0142 — env-var-driven provider factory. Caller-wired convenience for
// composition roots that want "Brave if key set, DDG if QUANTA_WEB_SEARCH_DUCKDUCKGO=1,
// else undefined". Explicit `AgentConfig.webSearch.provider` always wins.
export { providerFromEnv } from "./from-env"
