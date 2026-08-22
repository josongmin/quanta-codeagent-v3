/**
 * RFC-12 (deferred) SURFACE B — anchored-comment FEEDER (daemon-side).
 *
 * The web overlay (`apps/web-frontend/src/components/canvas/DiffView.tsx`
 * `comments` prop + `DiffView.anchors.test.tsx`) already RENDERS anchored review
 * comments, and the web mirror `ToolDiffMessage.anchors?` already CARRIES them.
 * But until this feeder the DAEMON never PROJECTED a `ReviewFinding` anchor onto
 * `ToolDiffMessage.anchors`, so the overlay stayed EMPTY end-to-end.
 *
 * This hellgate pins the daemon feeder across the WHOLE wire the front-door
 * uses:
 *
 *     ReviewFinding{anchor,verdict,category,shortSummary}   (@/tool/git)
 *       └─ reviewFindingsToAnchors(...)   (canvas-tool-diff-source, pure)
 *            └─ CapturedToolDiff.anchors
 *                 └─ source fan-out → sinks bridge → emitter.feedToolDiff
 *                      └─ buildToolDiffMessage → ToolDiffMessage.anchors
 *                           └─ decodeCanvasFrame → the web DiffAnchorComment shape
 *
 * Asserts:
 *   - RED (pre-feeder): a diff WITH review anchors emits a `ToolDiffMessage`
 *     with NO `anchors` — the overlay stays empty. (Now GREEN: anchors present.)
 *   - front-door: a real `ReviewFinding` with an `anchor` flows daemon → wire
 *     with the right `line` (new-side) + `verdict` + `category` + `summary`.
 *   - no-anchor byte-identical: a capture with NO anchors emits a frame with the
 *     `anchors` key ABSENT (JSON byte-identical to the pre-RFC-12 diff).
 *   - red-on-injection: dropping the projection ⇒ `anchors` absent ⇒ overlay
 *     empty (the exact regression this feeder guards).
 */

import { describe, expect, test } from "bun:test"
import { createCanvasEmitter, type ToolDiffInput } from "@/apps/web-daemon/canvas-emitter"
import {
  type CapturedToolDiff,
  createCanvasToolDiffSource,
  reviewFindingsToAnchors,
} from "@/apps/web-daemon/canvas-tool-diff-source"
import { decodeCanvasFrame, type ToolDiffMessage } from "@/protocol/canvas"
import type { ReviewFinding } from "@/tool/git/review-diff"

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const BEFORE = "const a = 1\nconst b = 2\n"
const AFTER = "const a = 1\nconst b = 3\nconst c = 4\n"

/** A real anchored finding — the reviewer bound it to new-side line 3. */
const anchoredFinding = (): ReviewFinding => ({
  file: "src/x.ts",
  line: 3,
  severity: "error",
  what: "c may be used before assignment",
  verdict: "confirmed",
  category: "null-deref",
  shortSummary: "c may be used before assignment",
  anchor: {
    path: "src/x.ts",
    line: 3,
    hunkId: "h1",
    beforeHash: "deadbeef",
    afterHash: "cafef00d",
  },
})

/** Drain every encoded frame the emitter sends into an array. */
const captureFrames = (): { readonly frames: string[]; readonly ws: { send(f: string): void } } => {
  const frames: string[] = []
  return { frames, ws: { send: (f: string): void => void frames.push(f) } }
}

const decodeToolDiff = (frame: string): ToolDiffMessage => {
  const msg = decodeCanvasFrame(frame)
  expect(msg?.kind).toBe("tool.diff")
  return msg as ToolDiffMessage
}

/* ------------------------------------------------------------------ */
/* Pure projection: ReviewFinding → DiffAnchorComment                  */
/* ------------------------------------------------------------------ */

describe("reviewFindingsToAnchors — projects ReviewFinding anchors onto the new-side line", () => {
  test("maps anchor.line (new-side) + verdict + category + shortSummary → DiffAnchorComment", () => {
    const anchors = reviewFindingsToAnchors([anchoredFinding()], "src/x.ts")
    expect(anchors).toEqual([
      {
        line: 3,
        verdict: "confirmed",
        category: "null-deref",
        summary: "c may be used before assignment",
        severity: "error",
      },
    ])
  })

  test("uses the anchor.line, NOT finding.line, when both present", () => {
    const f = anchoredFinding()
    // finding.line says 3 but the ANCHOR (validated new-side line) says 2.
    const anchors = reviewFindingsToAnchors(
      [{ ...f, line: 99, anchor: { ...f.anchor!, line: 2 } }],
      "src/x.ts",
    )
    expect(anchors[0]?.line).toBe(2)
  })

  test("falls back to `what` when shortSummary is absent", () => {
    const f = anchoredFinding()
    const { shortSummary: _drop, ...noSummary } = f
    const anchors = reviewFindingsToAnchors([noSummary], "src/x.ts")
    expect(anchors[0]?.summary).toBe("c may be used before assignment")
  })

  test("SKIPS a finding with NO anchor (only anchored findings overlay)", () => {
    const f = anchoredFinding()
    const { anchor: _drop, ...noAnchor } = f
    expect(reviewFindingsToAnchors([noAnchor], "src/x.ts")).toEqual([])
  })

  test("SKIPS a finding whose anchor path != the diff path (wrong file)", () => {
    const f = anchoredFinding()
    const anchors = reviewFindingsToAnchors(
      [{ ...f, anchor: { ...f.anchor!, path: "other/file.ts" } }],
      "src/x.ts",
    )
    expect(anchors).toEqual([])
  })

  test("omits verdict/category when absent (an un-dispositioned finding still overlays)", () => {
    const f = anchoredFinding()
    const { verdict: _v, category: _c, ...bare } = f
    const anchors = reviewFindingsToAnchors([bare], "src/x.ts")
    expect(anchors).toEqual([
      { line: 3, summary: "c may be used before assignment", severity: "error" },
    ])
  })
})

/* ------------------------------------------------------------------ */
/* Emitter: ToolDiffInput.anchors → ToolDiffMessage.anchors            */
/* ------------------------------------------------------------------ */

describe("canvas emitter — projects captured anchors onto ToolDiffMessage.anchors (front-door)", () => {
  test("a diff WITH review anchors emits ToolDiffMessage.anchors with the right line+verdict+category", () => {
    const { frames, ws } = captureFrames()
    const emitter = createCanvasEmitter({ ws, now: () => 111 })
    const anchors = reviewFindingsToAnchors([anchoredFinding()], "src/x.ts")
    const input: ToolDiffInput = { toolCallId: "t1", before: BEFORE, after: AFTER, anchors }
    emitter.feedToolDiff(input)

    expect(frames).toHaveLength(1)
    const msg = decodeToolDiff(frames[0]!)
    expect(msg.anchors).toEqual([
      {
        line: 3,
        verdict: "confirmed",
        category: "null-deref",
        summary: "c may be used before assignment",
        severity: "error",
      },
    ])
  })

  test("no-anchor diff: the `anchors` key is ABSENT (JSON byte-identical to pre-RFC-12)", () => {
    const withAnchors = captureFrames()
    const withoutAnchors = captureFrames()
    const now = (): number => 222
    createCanvasEmitter({ ws: withoutAnchors.ws, now }).feedToolDiff({
      toolCallId: "t1",
      before: BEFORE,
      after: AFTER,
    })
    createCanvasEmitter({ ws: withAnchors.ws, now }).feedToolDiff({
      toolCallId: "t1",
      before: BEFORE,
      after: AFTER,
      anchors: [],
    })
    // An empty anchors array must NOT serialize an `anchors` key — absent by
    // default, byte-identical to a diff that never had review anchors.
    expect(JSON.parse(withoutAnchors.frames[0]!).payload).not.toHaveProperty("anchors")
    expect(JSON.parse(withAnchors.frames[0]!).payload).not.toHaveProperty("anchors")
    // And the two frames are byte-identical.
    expect(withAnchors.frames[0]).toBe(withoutAnchors.frames[0])
  })

  test("red-on-injection: DROPPING the anchors from the input ⇒ overlay empty (no anchors on the wire)", () => {
    const { frames, ws } = captureFrames()
    const emitter = createCanvasEmitter({ ws, now: () => 333 })
    // The regression: the projection is dropped — feedToolDiff gets no anchors.
    const input: ToolDiffInput = { toolCallId: "t1", before: BEFORE, after: AFTER }
    emitter.feedToolDiff(input)
    const msg = decodeToolDiff(frames[0]!)
    expect(msg.anchors).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* Full daemon wire: source → sinks bridge shape → emitter             */
/* ------------------------------------------------------------------ */

describe("canvas tool-diff source — CapturedToolDiff carries anchors through the fan-out", () => {
  test("a captured diff WITH anchors fans out to a subscriber with the anchors intact", () => {
    const source = createCanvasToolDiffSource()
    const received: CapturedToolDiff[] = []
    source.subscribe((d) => received.push(d))
    const anchors = reviewFindingsToAnchors([anchoredFinding()], "src/x.ts")
    source.sink.capture({
      toolCallId: "t1",
      before: BEFORE,
      after: AFTER,
      path: "src/x.ts",
      anchors,
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.anchors).toEqual(anchors)
  })
})
