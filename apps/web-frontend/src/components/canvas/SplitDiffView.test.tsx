import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { DiffLineData } from "../../types/protocol"
import { DiffView } from "./DiffView"
import { hunkToSplitRows, SplitDiffView } from "./SplitDiffView"
import { diffTokens } from "./tokens"

const lines: DiffLineData[] = [
  { type: "unchanged", content: "const a = 1", lineNumber: 1 },
  { type: "removed", content: "const b = 2", lineNumber: 2 },
  { type: "added", content: "const b = 3", lineNumber: 2 },
]

describe("hunkToSplitRows", () => {
  it("puts unchanged lines on BOTH sides", () => {
    const rows = hunkToSplitRows({
      lines: [{ type: "unchanged", content: "x" }],
      collapsed: false,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.left?.content).toBe("x")
    expect(rows[0]?.right?.content).toBe("x")
  })

  it("zips a removed↔added pair into one row (del LEFT, add RIGHT)", () => {
    const rows = hunkToSplitRows({
      lines: [
        { type: "removed", content: "old" },
        { type: "added", content: "new" },
      ],
      collapsed: false,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.left?.content).toBe("old")
    expect(rows[0]?.right?.content).toBe("new")
  })

  it("leaves an empty cell when the change is unpaired (more removals than adds)", () => {
    const rows = hunkToSplitRows({
      lines: [
        { type: "removed", content: "r1" },
        { type: "removed", content: "r2" },
        { type: "added", content: "a1" },
      ],
      collapsed: false,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.left?.content).toBe("r1")
    expect(rows[0]?.right?.content).toBe("a1")
    expect(rows[1]?.left?.content).toBe("r2")
    expect(rows[1]?.right).toBeUndefined()
  })
})

describe("SplitDiffView", () => {
  it("renders a side-by-side table with two cells (old + new) per row", () => {
    const html = renderToStaticMarkup(<SplitDiffView lines={lines} />)
    expect(html).toContain('aria-label="file diff (split)"')
    expect(html).toContain("table-fixed")
    // each row pairs an old-side cell with a new-side cell
    const oldCells = html.match(/old (added|removed|unchanged) line/g) ?? []
    const newCells = html.match(/new (added|removed|unchanged) line/g) ?? []
    expect(oldCells.length).toBeGreaterThan(0)
    expect(newCells.length).toBeGreaterThan(0)
  })

  it("renders old-side / new-side aria labels (meaning not color-only)", () => {
    const html = renderToStaticMarkup(<SplitDiffView lines={lines} />)
    expect(html).toContain('aria-label="old removed line"')
    expect(html).toContain('aria-label="new added line"')
  })

  it("paints add/remove backgrounds from tokens.ts", () => {
    const html = renderToStaticMarkup(<SplitDiffView lines={lines} />)
    expect(html).toContain(diffTokens.dark.insertedLine)
    expect(html).toContain(diffTokens.dark.removedLine)
  })

  it("folds a long unchanged run into a collapsed CollapsibleSection header", () => {
    const many: DiffLineData[] = [
      { type: "added", content: "head" },
      ...Array.from({ length: 12 }, (_, i) => ({
        type: "unchanged" as const,
        content: `mid${i}`,
      })),
      { type: "removed", content: "tail" },
    ]
    const html = renderToStaticMarkup(<SplitDiffView lines={many} contextLines={2} />)
    // the collapsed section advertises the folded line count + starts closed
    expect(html).toContain("unchanged line")
    expect(html).toContain('aria-expanded="false"')
  })

  it("renders an empty (non-throwing) container for empty lines", () => {
    const html = renderToStaticMarkup(<SplitDiffView lines={[]} />)
    expect(html).toContain('aria-label="file diff (split)"')
    // no hunk tables when there are no lines
    expect(html).not.toContain("table-fixed")
  })

  it("shows the truncated affordance", () => {
    const html = renderToStaticMarkup(<SplitDiffView lines={lines} truncated moreLines={9} />)
    expect(html).toContain("9 more lines")
  })
})

describe("DiffView mode prop (additive — inline default unchanged)", () => {
  it("mode='inline' (default) renders the original inline diff (regression anchor)", () => {
    const def = renderToStaticMarkup(<DiffView lines={lines} />)
    const explicit = renderToStaticMarkup(<DiffView lines={lines} mode="inline" />)
    // byte-identical: the new mode prop does not alter the inline output
    expect(def).toBe(explicit)
    expect(def).toContain('aria-label="file diff"')
    expect(def).not.toContain('aria-label="file diff (split)"')
    expect(def).not.toContain("table-fixed")
  })

  it("mode='split' delegates to SplitDiffView (side-by-side)", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} mode="split" />)
    expect(html).toContain('aria-label="file diff (split)"')
    expect(html).toContain("table-fixed")
    expect(html).toContain("old removed line")
    expect(html).toContain("new added line")
  })
})
