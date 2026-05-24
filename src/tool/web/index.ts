/**
 * Web tool slice barrel (ADR-0127).
 *
 *   - `web_fetch` (always-on, no provider — fetches HTTPS URLs and returns
 *     HTML→Markdown). Tool factory exported as `webFetchTool({fetcher?})`
 *     so the production caller binds `globalThis.fetch` and tests inject a
 *     fake. Pure HTML→Markdown helper `htmlToMarkdown` (now turndown-backed,
 *     ADR-0183) re-exported for hellgate testing without spinning up a fake
 *     fetcher; configured `turndown` singleton exposed so callers can
 *     register custom rules (e.g. code-fence language hints, table plugin).
 *   - `web_search` (provider-gated — closed-port DI). Tool factory
 *     `webSearchTool(provider?)` returns a tool that gracefully degrades to
 *     ok:false "no provider wired" when `provider` is undefined, so the
 *     surface can stay registered without crashing the loop.
 *
 *  Registration: same posture as `read_image` (ADR-0126) — `web_fetch` is
 *  exported here but NOT added to `defaultTools` until the
 *  `MUTATING_TOOL_TABLE` (sibling-touched) absorbs the new entry. The
 *  `web_search` provider-gated tool is plumbed via `src/agent/tier1/
 *  web-search.ts` (caller-wired through `AgentConfig.webSearch.provider`).
 */

export { htmlToMarkdown, turndown } from "./html-to-markdown"
export {
  WEB_FETCH_DEFAULT_MAX_BYTES,
  WEB_FETCH_MAX_BYTES_CEILING,
  WEB_FETCH_MAX_OUTPUT,
  type WebFetchInput,
  type WebFetchOptions,
  webFetchInputSchema,
  webFetchTool,
} from "./fetch"
export {
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_QUERY_MAX,
  WEB_SEARCH_SNIPPET_MAX,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchProvider,
  webSearchInputSchema,
  webSearchTool,
} from "./search"
