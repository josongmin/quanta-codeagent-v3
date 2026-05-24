/**
 * `providerFromEnv` — env-var → `WebSearchProvider` factory (ADR-0142).
 *
 * Closes the caller-wire loop for ADR-0127 (port) / ADR-0133 (providers):
 * the providers are shipped (`./brave`, `./duckduckgo`) and the
 * `AgentConfig.webSearch.provider` slot exists, but a host that just wants
 * "if a key is set, use Brave; else nothing" had to write its own boot
 * snippet. This helper IS that snippet — a single import the composition
 * root can call.
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `./brave`, `./duckduckgo`, `../search` (port type).
 *     NO `@/agent`, `@/llm`, `@/permission`, `@/storage` — same fence the
 *     providers themselves observe.
 *   - DI seam: `env` argument lets tests inject a controlled snapshot.
 *     Defaults to `process.env` so the production caller stays one-line.
 *
 * Precedence (documented + sealed by the hellgate):
 *   1. `BRAVE_SEARCH_API_KEY` non-empty   → Brave provider (primary).
 *   2. `QUANTA_WEB_SEARCH_DUCKDUCKGO==="1"` → DuckDuckGo provider (fallback,
 *      LIMITED — see `./duckduckgo.ts` header).
 *   3. otherwise                          → `undefined` (no provider wired;
 *      `webSearchTool` will gracefully degrade to ok:false at call time).
 *
 * Brave wins over DDG by design: Brave is the higher-quality provider, and
 * a caller that has both env vars set almost certainly meant the Brave key
 * to win (DDG is a "no key needed" fallback signal, not a co-equal choice).
 *
 * EXPLICIT wiring of a specific provider via `AgentConfig.webSearch.provider`
 * always takes precedence over this helper — the composition root chooses
 * whether to call `providerFromEnv()` or pass a hand-built provider.
 */

import type { WebSearchProvider } from "../search"
import { braveSearchProvider } from "./brave"
import { duckduckgoSearchProvider } from "./duckduckgo"

/** Pick a web-search provider from env vars. Caller wires this when they
 *  want a "just works" default; explicit wiring of a specific provider
 *  takes precedence in `AgentConfig.webSearch.provider`.
 *
 *  Returns `undefined` when no env var is set — the caller can pass this
 *  straight into `AgentConfig.webSearch.provider` (which itself is
 *  optional), leaving the slot unwired and the tool to degrade gracefully.
 */
export const providerFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): WebSearchProvider | undefined => {
  const braveKey = env.BRAVE_SEARCH_API_KEY
  if (braveKey !== undefined && braveKey.length > 0) {
    return braveSearchProvider({ apiKey: braveKey })
  }
  if (env.QUANTA_WEB_SEARCH_DUCKDUCKGO === "1") {
    return duckduckgoSearchProvider()
  }
  return undefined
}
