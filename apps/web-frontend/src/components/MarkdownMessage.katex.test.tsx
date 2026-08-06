/**
 * RFC-12 (deferred) SURFACE A — KaTeX display-math render.
 *
 * `node` env (no DOM) — the same static-markup idiom as the other canvas render
 * tests. Since there is no DOM, `katex.render` never runs in-test; we assert the
 * DOM-free render SHAPE instead:
 *
 *   - Gate OFF (default): a `$$…$$` message renders through the ordinary markdown
 *     path with the `$$` delimiters INTACT as plain text — byte-identical to the
 *     pre-RFC-12 render. NO `katex-display` host is emitted.
 *   - Gate ON: the `rich-markers` katex segment routes through the lazy
 *     `KatexDisplay`, which (DOM-free) emits a `data-katex-source` host carrying
 *     the verbatim `$$…$$` source (katex swaps it to typeset math on the client).
 *
 * The gate is `import.meta.env.VITE_QUANTA_KATEX`; we stub it per-test with
 * `vi.stubEnv` so the default-OFF byte-identity is proven WITHOUT a real katex
 * install (which is intentionally absent).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { KatexDisplay } from "./canvas/KatexDisplay"
import { MarkdownMessage } from "./MarkdownMessage"

const MATH = "Euler: $$a^2+b^2=c^2$$ done"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("MarkdownMessage — KaTeX gate OFF (default, byte-identical)", () => {
  it("renders $$…$$ as plain text with delimiters intact; no katex host", () => {
    vi.stubEnv("VITE_QUANTA_KATEX", "")
    const html = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    // The raw display-math delimiters survive verbatim as prose.
    expect(html).toContain("$$a^2+b^2=c^2$$")
    // No lazy katex host is mounted.
    expect(html).not.toContain("data-katex-source")
    expect(html).not.toContain("katex-display")
  })

  it("is byte-identical to a message with no math when the gate is OFF", () => {
    vi.stubEnv("VITE_QUANTA_KATEX", "")
    // Two independent renders of the SAME input are stable (no segmentation
    // churn) — the gate-OFF path is a single verbatim segment.
    const a = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    const b = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    expect(a).toEqual(b)
  })

  it("gate-OFF markup equals gate-UNSET (no VITE_QUANTA_KATEX) markup", () => {
    // Explicit env absent (never set) vs env="" — both the default-OFF path.
    vi.stubEnv("VITE_QUANTA_KATEX", "")
    const off = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    vi.stubEnv("VITE_QUANTA_KATEX", "0")
    const disabled = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    expect(off).toEqual(disabled)
    // And a plain (no-math) message is unaffected either way.
    const plainA = renderToStaticMarkup(<MarkdownMessage text="hello **world**" />)
    vi.stubEnv("VITE_QUANTA_KATEX", "1")
    const plainB = renderToStaticMarkup(<MarkdownMessage text="hello **world**" />)
    expect(plainA).toEqual(plainB)
  })
})

describe("MarkdownMessage — KaTeX gate ON (front-door)", () => {
  it("routes the $$…$$ segment through the lazy KatexDisplay host", async () => {
    vi.stubEnv("VITE_QUANTA_KATEX", "1")
    // Suspense + lazy: the Suspense FALLBACK (the plain markdown of the katex
    // source) renders synchronously in static markup, so assert the fallback
    // carries the verbatim source and the surrounding prose still renders.
    const html = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    expect(html).toContain("Euler:")
    expect(html).toContain("done")
    // The katex source is present (via the Suspense fallback = MarkdownBody of
    // the `$$…$$` source segment).
    expect(html).toContain("a^2+b^2=c^2")
  })

  it("segments a katex message into text + katex + text runs", () => {
    vi.stubEnv("VITE_QUANTA_KATEX", "1")
    const html = renderToStaticMarkup(<MarkdownMessage text={MATH} />)
    // Surrounding prose renders on both sides of the math.
    expect(html).toContain("Euler:")
    expect(html).toContain("done")
  })
})

describe("KatexDisplay — the lazy renderer (front-door)", () => {
  it("emits a katex host carrying the verbatim source (katex swaps it client-side)", () => {
    // DOM-free static render: the useEffect (katex.render) never fires, so the
    // host renders with the verbatim source child + data-katex-source attr —
    // exactly the seam katex overwrites on the client.
    const html = renderToStaticMarkup(<KatexDisplay body="a^2+b^2=c^2" source="$$a^2+b^2=c^2$$" />)
    expect(html).toContain("data-katex-source")
    expect(html).toContain("$$a^2+b^2=c^2$$")
    expect(html).toContain('data-testid="katex-display"')
  })
})
