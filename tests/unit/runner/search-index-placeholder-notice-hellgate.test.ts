/**
 * Honesty repair hellgate (structural audit R-A-adversarial) — the search index's
 * NON-SEMANTIC hash-BoW placeholder (out-of-box: `QUANTA_INDEX=on` but no embedding
 * provider) was a SILENT degradation: `search_codebase` advertised a semantic
 * capability it did not have, with no operator-facing signal (only a metric label).
 * `placeholderEmbedderNotice` maps the resolved provider label to a one-shot
 * operator warning so the placeholder is surfaced, not hidden.
 *
 * MUTATION: invert the provider-label check ⇒ a real provider warns / the
 * placeholder stays silent ⇒ these rails go RED.
 */

import { describe, expect, test } from "bun:test"
import { placeholderEmbedderNotice } from "@/runner/assemble/search-pipeline"

describe("search-index placeholder honesty notice", () => {
  test("the hash-BoW placeholder label ⇒ a warn notice that names the degradation + the fix", () => {
    const notice = placeholderEmbedderNotice("legacy:hash-embed")
    expect(notice).not.toBeNull()
    expect(notice?.severity).toBe("warn")
    expect(notice?.source).toBe("search-index")
    expect(notice?.message).toContain("NON-SEMANTIC placeholder")
    // the operator is told HOW to get real semantic search
    expect(notice?.hint ?? "").toMatch(/API_KEY|QUANTA_EMBED_PROVIDER/)
  })

  test("a REAL embedding provider ⇒ NO notice (paired control — no false alarm)", () => {
    expect(placeholderEmbedderNotice("openai")).toBeNull()
    expect(placeholderEmbedderNotice("voyage")).toBeNull()
    expect(placeholderEmbedderNotice("cohere")).toBeNull()
  })
})
