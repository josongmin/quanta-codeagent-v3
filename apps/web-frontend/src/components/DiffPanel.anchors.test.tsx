/**
 * RFC-12 (deferred) SURFACE B — DiffPanel forwards `ToolDiffMessage.anchors` to
 * the DiffView overlay (the wiring seam from the web-facing diff message to the
 * render). `node` env, static markup.
 *
 *   - default-OFF: a message WITHOUT `anchors` renders byte-identically to the
 *     pre-RFC-12 panel (no overlay row).
 *   - front-door: a message WITH `anchors` overlays the matching diff line.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ToolDiffMessage } from "../types/protocol"
import { DiffPanel } from "./DiffPanel"

const base: ToolDiffMessage = {
  kind: "tool.diff",
  toolCallId: "t1",
  path: "src/x.ts",
  lines: [
    { type: "unchanged", content: "const a = 1", lineNumber: 1 },
    { type: "added", content: "const b = 2", lineNumber: 2 },
  ],
  additions: 1,
  deletions: 0,
  emittedAt: 0,
}

describe("DiffPanel — SURFACE B anchor forwarding", () => {
  it("is byte-identical when the message carries no anchors", () => {
    const withField = renderToStaticMarkup(<DiffPanel diff={base} />)
    const withUndef = renderToStaticMarkup(<DiffPanel diff={{ ...base, anchors: undefined }} />)
    expect(withUndef).toEqual(withField)
    expect(withField).not.toContain("diff-anchor-comment")
  })

  it("overlays the anchored comment when the message carries anchors", () => {
    const html = renderToStaticMarkup(
      <DiffPanel
        diff={{
          ...base,
          anchors: [{ line: 2, verdict: "confirmed", category: "logic", summary: "wrong value" }],
        }}
      />,
    )
    expect(html).toContain('data-testid="diff-anchor-comment"')
    expect(html).toContain('data-line="2"')
    expect(html).toContain("wrong value")
    expect(html).toContain("logic")
  })
})
