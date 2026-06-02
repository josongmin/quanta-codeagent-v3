import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { DiffLineData } from "../../types/protocol"
import { DiffView } from "./DiffView"
import { diffTokens } from "./tokens"

const lines: DiffLineData[] = [
  { type: "unchanged", content: "const a = 1", lineNumber: 1 },
  { type: "removed", content: "const b = 2", lineNumber: 2 },
  { type: "added", content: "const b = 3", lineNumber: 2 },
]

describe("DiffView", () => {
  it("renders added/removed/unchanged rows with the right backgrounds + aria", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} />)
    // aria labels carry meaning (not color-only)
    expect(html).toContain('aria-label="added line"')
    expect(html).toContain('aria-label="removed line"')
    expect(html).toContain('aria-label="unchanged line"')
    // backgrounds come from tokens.ts (dark default)
    expect(html).toContain(diffTokens.dark.insertedLine)
    expect(html).toContain(diffTokens.dark.removedLine)
    // accent strip colors present by default
    expect(html).toContain(diffTokens.dark.stripAdded)
    expect(html).toContain(diffTokens.dark.stripRemoved)
    // content rendered with +/- prefix
    expect(html).toContain("const b = 3")
  })

  it("hides the gutter when showLineNumbers=false", () => {
    const withGutter = renderToStaticMarkup(<DiffView lines={lines} showLineNumbers />)
    const noGutter = renderToStaticMarkup(<DiffView lines={lines} showLineNumbers={false} />)
    expect(withGutter).toContain("tabular-nums")
    // the gutter cell class is absent without line numbers
    expect(noGutter).not.toContain("w-10 select-none")
  })

  it("omits the accent strip when showAccentStrip=false", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} showAccentStrip={false} />)
    expect(html).not.toContain(diffTokens.dark.stripAdded)
  })

  it("drops colored gutter tint when coloredLineNumbers=false", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} coloredLineNumbers={false} />)
    expect(html).not.toContain("text-emerald-400")
    expect(html).not.toContain("text-rose-400")
  })

  it("applies the light theme tokens when theme='light'", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} theme="light" />)
    expect(html).toContain(diffTokens.light.insertedLine)
    expect(html).not.toContain(diffTokens.dark.insertedLine)
  })

  it("shows a 'more lines' affordance when truncated", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} truncated moreLines={42} />)
    expect(html).toContain("42 more lines")
  })

  it("renders an empty (non-throwing) table for empty lines", () => {
    const html = renderToStaticMarkup(<DiffView lines={[]} />)
    expect(html).toContain('aria-label="file diff"')
    expect(html).toContain("<table")
    expect(html).not.toContain("<tr")
  })
})
