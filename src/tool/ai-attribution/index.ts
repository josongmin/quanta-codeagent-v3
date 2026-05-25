/** ADR-0257 — barrel for the AI-attribution slice.
 *
 *  Public entry-point: composition roots / tool registration import from here;
 *  internal modules (`headless-stub`) stay reachable but barrel-free for the
 *  rest of the codebase.
 */

export { applyFilters, type HeadlessStubOptions, headlessStub } from "./headless-stub"
export type { AIAttributionSearch, SearchPortOpts } from "./port"
export {
  type AttributionMatch,
  LICENSES,
  type License,
  SEARCH_ERROR_KINDS,
  type SearchError,
  type SearchOpts,
  SNIPPET_MAX_BYTES,
} from "./types"
