/** ADR-0257 — closed port for the AI-attribution search adapter.
 *
 *  The tool layer (`src/tool/ai_attribution.ts`) consumes this port; concrete
 *  adapters (BigCode / Sourcegraph / GitHub Code Search) implement it. The
 *  port is `Result`-shaped (no thrown errors): a misbehaving network call
 *  becomes `{ ok:false, error: { kind:"search-failed", cause } }` so the tool
 *  can map to a stable `ToolResult`.
 *
 *  Plane-clean: imports only `@/shared` (`Result`) + `./types`. NO `@/agent`,
 *  NO `@/runtime` — adapter authors live in their own slice and inject this
 *  port at composition root. */

import type { Result } from "@/shared"
import type { AttributionMatch, SearchError, SearchOpts } from "./types"

/** Per-call options the port consumes. `signal` is OPTIONAL; when present and
 *  fired the adapter SHOULD resolve with `{ ok:false, error:{ kind:"aborted" }}`. */
export interface SearchPortOpts extends SearchOpts {
  readonly signal?: AbortSignal
}

/** The closed port every adapter implements. `search` is the single method —
 *  takes a code snippet + optional filters / abort and resolves with a
 *  `Result<AttributionMatch[], SearchError>`. NEVER throws past the caller. */
export interface AIAttributionSearch {
  search(snippet: string, opts?: SearchPortOpts): Promise<Result<AttributionMatch[], SearchError>>
}
