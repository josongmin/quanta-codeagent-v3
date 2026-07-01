/** Narrows `unknown` to a plain object record (excludes `null` and arrays).
 *
 *  The canonical form of a guard that was hand-rolled identically in ~15 files
 *  before consolidation (jul-2 DRY pass). Use this for validating parsed/foreign
 *  data (JSON, LLM output, MCP payloads) before reading fields. NOTE the array
 *  exclusion: `isRecord([])` is `false` — a divergent copy that omitted the
 *  `!Array.isArray` check treated arrays as records, which is exactly the drift
 *  this consolidation removes. If you need arrays-count-as-object semantics,
 *  write that check inline; do not weaken this shared guard. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
