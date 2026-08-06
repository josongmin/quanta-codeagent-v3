/**
 * RFC-12 (deferred) SURFACE B — anchored-comment overlay over the diff.
 *
 * `node` env, static markup — same idiom as `DiffView.test.tsx`. Asserts:
 *   - default-OFF: NO `comments` prop ⇒ the render is byte-identical to the bare
 *     `DiffView` (no overlay rows, no `diff-anchor-comment`).
 *   - front-door: a real anchored comment overlays the row whose `lineNumber`
 *     matches its `anchor.line`, carrying verdict + category + summary.
 *   - the overlay lands on the NEW side (added/unchanged), never a `removed`
 *     line's old-side number.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { DiffAnchorComment, DiffLineData } from "../../types/protocol"
import { DiffView } from "./DiffView"

const lines: DiffLineData[] = [
  { type: "unchanged", content: "const a = 1", lineNumber: 1 },
  { type: "removed", content: "const b = 2", lineNumber: 2 },
  { type: "added", content: "const b = 3", lineNumber: 2 },
  { type: "added", content: "const c = 4", lineNumber: 3 },
]

const comments: DiffAnchorComment[] = [
  {
    line: 3,
    verdict: "confirmed",
    category: "null-deref",
    summary: "c may be used before assignment",
    severity: "error",
  },
]

describe("DiffView anchored comments — default-OFF (byte-identical)", () => {
  it("renders byte-identically when `comments` is absent", () => {
    const bare = renderToStaticMarkup(<DiffView lines={lines} />)
    const undef = renderToStaticMarkup(<DiffView lines={lines} comments={undefined} />)
    expect(undef).toEqual(bare)
    expect(bare).not.toContain("diff-anchor-comment")
  })

  it("renders byte-identically when `comments` is an empty array", () => {
    const bare = renderToStaticMarkup(<DiffView lines={lines} />)
    const empty = renderToStaticMarkup(<DiffView lines={lines} comments={[]} />)
    expect(empty).toEqual(bare)
  })
})

describe("DiffView anchored comments — front-door overlay", () => {
  it("overlays the comment on the matching (new-side) diff line", () => {
    const html = renderToStaticMarkup(<DiffView lines={lines} comments={comments} />)
    // an overlay row is emitted, anchored to line 3
    expect(html).toContain('data-testid="diff-anchor-comment"')
    expect(html).toContain('data-line="3"')
    // it carries the verdict + category + summary
    expect(html).toContain("confirmed")
    expect(html).toContain("null-deref")
    expect(html).toContain("c may be used before assignment")
  })

  it("does not overlay when no diff line matches the anchor line", () => {
    const html = renderToStaticMarkup(
      <DiffView lines={lines} comments={[{ line: 99, summary: "orphan" }]} />,
    )
    expect(html).not.toContain('data-testid="diff-anchor-comment"')
    expect(html).not.toContain("orphan")
  })

  it("anchors to the new side, not a removed line's old-side number", () => {
    // line 2 exists as BOTH a removed (old-side 2) and added (new-side 2) row;
    // the overlay must land on the added row only (one overlay, not two).
    const html = renderToStaticMarkup(
      <DiffView lines={lines} comments={[{ line: 2, summary: "on new side" }]} />,
    )
    const count = html.split('data-testid="diff-anchor-comment"').length - 1
    expect(count).toBe(1)
    expect(html).toContain("on new side")
  })

  it("renders a plausible verdict + no-verdict comment", () => {
    const html = renderToStaticMarkup(
      <DiffView
        lines={lines}
        comments={[
          { line: 1, verdict: "plausible", summary: "maybe off-by-one" },
          { line: 3, summary: "no verdict here" },
        ]}
      />,
    )
    expect(html).toContain("plausible")
    expect(html).toContain("maybe off-by-one")
    expect(html).toContain("no verdict here")
  })
})
