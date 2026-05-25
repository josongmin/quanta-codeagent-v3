/**
 * ADR-0282 — `InjectOpts` + `MemorySystemBlock` shapes.
 *
 * Closed-set, `readonly`. The kind filter uses OMIT semantics under
 * `exactOptionalPropertyTypes: true` — callers MUST NOT pass
 * `undefined` literally.
 *
 * No `@/llm` import — the slice owns a structural mirror of the
 * `SystemBlock` shape under the local name `MemorySystemBlock`. The
 * composition root translates one-to-one at the plug site.
 */

/** Options to {@link import("./port").CrossSessionInjector.selectForInject}. */
export interface InjectOpts {
  /** Hard cap on the SUM of selected entries' `rolloutSummary` byte
   *  lengths (UTF-8 byte count). When the next candidate would push
   *  the cumulative total past `maxBytes`, the injector STOPS — it
   *  does NOT skip to try a smaller subsequent entry (deterministic).
   *  `maxBytes <= 0` ⇒ return `[]`. */
  readonly maxBytes: number
  /** Optional kind filter — when present, only return entries whose
   *  first whitespace-delimited token of `rolloutSummary` matches one
   *  of the listed strings (case-sensitive). `kindFilter = []`
   *  (empty array) matches NOTHING — an explicit empty filter is a
   *  hard NO, NOT "no filter". Absent ⇒ no kind filter. OMIT
   *  semantics. */
  readonly kindFilter?: readonly string[]
}

/**
 * Structural mirror of `@/llm` `SystemBlock` — the memory slice MUST NOT
 * import `@/llm` (RFC §3.1 + biome override) so the renderer returns
 * this shape and the composition root copies it into a real
 * `SystemBlock` at the plug site.
 *
 * `cache` defaults to `true` at the renderer (cache-friendly cross-
 * session prefix). OMIT semantics under `exactOptionalPropertyTypes:
 * true`.
 */
export interface MemorySystemBlock {
  readonly type: "text"
  readonly text: string
  readonly cache?: boolean
}

/** Default `maxBytes` cap when the composition root does not override.
 *  8 KiB — well under any provider system-prompt budget; comfortable
 *  ceiling for ~10-20 promoted Stage 1 summaries. */
export const DEFAULT_INJECT_MAX_BYTES = 8_192

/** Section heading literal used by {@link import("./prompt-section").renderMemorySection}. */
export const MEMORY_SECTION_HEADER = "## Cross-session memory (auto)"
