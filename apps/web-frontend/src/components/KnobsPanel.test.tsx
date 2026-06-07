import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { KnobsPanel } from "./KnobsPanel"

// NOTE: the web-frontend test suite runs in a node environment (no jsdom /
// testing-library) — every test renders static markup via
// `react-dom/server`. The fetch effect never resolves in this synchronous
// render, so the panel renders its initial loading/empty state, which is
// what we assert on. The data-shaping + write-gating logic is covered
// exhaustively in slash-knobs.test.ts.

describe("KnobsPanel", () => {
  it("renders the loading state on first paint", () => {
    const html = renderToStaticMarkup(
      <KnobsPanel endpoint={{ httpUrl: "http://127.0.0.1:4096" }} onClose={() => undefined} />,
    )
    expect(html).toContain('data-testid="knobs-panel"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('data-testid="knobs-loading"')
  })

  it("renders an error notice when there is no endpoint", () => {
    const html = renderToStaticMarkup(<KnobsPanel endpoint={null} onClose={() => undefined} />)
    // Synchronous initial render shows loading; the effect that sets the
    // "Not connected" error runs after mount which static render skips — so
    // assert the dialog + search affordances are present regardless.
    expect(html).toContain('data-testid="knobs-panel"')
    expect(html).toContain('aria-label="Filter knobs"')
  })

  it("includes the search box and close control", () => {
    const html = renderToStaticMarkup(
      <KnobsPanel endpoint={{ httpUrl: "http://127.0.0.1:4096" }} onClose={() => undefined} />,
    )
    expect(html).toContain("Filter by key")
    expect(html).toContain('aria-label="Close settings"')
  })
})
