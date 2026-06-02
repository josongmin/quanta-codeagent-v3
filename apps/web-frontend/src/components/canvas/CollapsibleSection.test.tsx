import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CollapsibleSection } from "./CollapsibleSection"
import { Swatch } from "./Swatch"

// NOTE: the web-frontend test suite has no DOM environment (no jsdom /
// testing-library — every test uses react-dom/server `renderToStaticMarkup`).
// SSR renders the INITIAL render only, which for this uncontrolled component is
// the CLOSED state — exactly the contract we most need to pin
// (collapsible-section.d.ts:33 "always starts closed"). The interactive
// chevron toggle is `useState`-driven and verified by manual/integration use;
// these tests seal the closed-default + header-slot structure.

describe("CollapsibleSection", () => {
  it("starts CLOSED: children are not in the initial markup (d.ts:33 contract)", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="Conversation">
        <span>SECRET_BODY_CONTENT</span>
      </CollapsibleSection>,
    )
    expect(html).not.toContain("SECRET_BODY_CONTENT")
    // the disclosure button reports the closed state to AT
    expect(html).toContain('aria-expanded="false"')
  })

  it("renders the title next to the chevron", () => {
    const html = renderToStaticMarkup(<CollapsibleSection title="Tools" />)
    expect(html).toContain("Tools")
    expect(html).toContain("▶")
  })

  it("renders the optional count after the title", () => {
    const html = renderToStaticMarkup(<CollapsibleSection title="Tools" count={4} />)
    expect(html).toContain("4")
  })

  it("renders the leading slot (e.g. a Swatch) before the title", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="Tools" leading={<Swatch color="purple" />} />,
    )
    expect(html).toContain('data-swatch-color="purple"')
  })

  it("renders the trailing slot (token readout / badge)", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection title="Tools" trailing={<span>12.3k</span>} />,
    )
    expect(html).toContain("12.3k")
  })

  it("does not throw with empty children", () => {
    expect(() => renderToStaticMarkup(<CollapsibleSection title="Empty" />)).not.toThrow()
  })

  it("wires aria-controls to the body id for the disclosure relationship", () => {
    const html = renderToStaticMarkup(<CollapsibleSection title="X">body</CollapsibleSection>)
    expect(html).toContain("aria-controls=")
  })
})
