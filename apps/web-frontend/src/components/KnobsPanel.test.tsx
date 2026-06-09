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

  it("renders the 'Not connected' error notice synchronously when there is no endpoint", () => {
    const html = renderToStaticMarkup(<KnobsPanel endpoint={null} onClose={() => undefined} />)
    // endpoint===null is known at render time (no fetch needed), so the error
    // state must show on FIRST paint — NOT a flash of loading that only an
    // unrun effect would correct. This is the endpoint-specific assertion the
    // prior version lacked (it asserted only panel/filter, identical to the
    // connected case).
    expect(html).toContain('data-testid="knobs-error"')
    expect(html).toContain("Not connected")
    expect(html).not.toContain('data-testid="knobs-loading"')
  })

  it("includes the search box and close control", () => {
    const html = renderToStaticMarkup(
      <KnobsPanel endpoint={{ httpUrl: "http://127.0.0.1:4096" }} onClose={() => undefined} />,
    )
    expect(html).toContain("Filter by key")
    expect(html).toContain('aria-label="Close settings"')
  })
})
