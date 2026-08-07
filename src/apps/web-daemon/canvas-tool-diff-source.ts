/**
 * ADR-0440 wire-finish — canvas tool-diff source (web-daemon side).
 *
 * The agent's dispatch seam surfaces an optional {@link ToolDiffSink} onto the
 * `ToolContext`; a file-mutating tool (`write`/`edit`) calls `capture(...)` with
 * the full pre/post file text it ALREADY has after a successful mutation. This
 * source is the daemon-side concrete sink: the composition root wires its
 * `sink` into `AgentConfig.onToolDiff`, and every WS connection subscribes so
 * its per-connection canvas emitter forwards a `tool.diff` frame via
 * `feedToolDiff(...)`.
 *
 * NO recompute: the captured before/after strings are fanned out VERBATIM; the
 * line-diff math + caps + binary probe run ONCE per connection inside
 * `feedToolDiff` (the emitter), never here. There is NO `latest()`
 * snapshot-on-connect for diffs (unlike usage): a diff is a point-in-time
 * mutation event — a fresh connection renders diffs from the next mutation
 * forward, it does not replay history.
 *
 * Default-OFF: the composition root only constructs this when
 * `QUANTA_WEB_CANVAS=1`. Absent that, `onToolDiff` is never wired ⇒ no tool
 * captures anything ⇒ no `tool.diff` frame ⇒ chat UI unchanged, byte-identical.
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and only references the
 * duck-typed capture shape (mirrored from `@/tool`'s `ToolDiffSink`); it never
 * imports `@/agent/loop` or `@/apps/cli`. The `@/tool` slice never imports this
 * — the composition root is the only bridge.
 *
 * DOF-40 — fail-closed: a throwing subscriber is ISOLATED (siblings still
 * fed) but the failure is now OBSERVABLE via the optional `onSubscriberError`
 * seam, not silently starved. Default-OFF byte-identical: no observer ⇒
 * legacy swallow.
 */

import type { DiffAnchorComment } from "@/protocol/canvas"
import type { ReviewFinding } from "@/tool/git/review-diff"
import { type CanvasSourceOptions, fanOutIsolated } from "./canvas-fanout"

/** A captured tool mutation: the full pre/post file text + correlation id. */
export interface CapturedToolDiff {
  readonly toolCallId: string
  readonly before: string
  readonly after: string
  readonly path?: string
  /** RFC-12 (deferred) SURFACE B — anchored review comments already projected
   *  from this diff's `ReviewFinding` anchors via {@link reviewFindingsToAnchors}
   *  onto the render-side new line. ADDITIVE + OPTIONAL: absent (a non-review
   *  mutation — the `write`/`edit` capture path) ⇒ the emitter serializes NO
   *  `anchors` key ⇒ byte-identical to the pre-RFC-12 `tool.diff` frame. */
  readonly anchors?: readonly DiffAnchorComment[]
}

/**
 * RFC-12 (deferred) SURFACE B — project the agent-emitted `ReviewFinding[]` of a
 * reviewed diff onto the render-side {@link DiffAnchorComment[]} the web DiffView
 * overlay consumes. PURE (no I/O) — REUSES the existing `ReviewFinding` /
 * `review-anchor` output, it does NOT define a second finding schema.
 *
 * Only findings that ARE anchored (`finding.anchor` present) AND whose anchor
 * targets THIS diff's `path` overlay — an un-anchored blob comment or a
 * cross-file finding is dropped (it has no diff line to land on). The comment's
 * `line` is the ANCHOR's validated new-side line (NOT `finding.line`, which the
 * reviewer may report loosely); `summary` is the reviewer's `shortSummary`, else
 * the finding body (`what`). The anchor's hashes / `hunkId` (an apply-target
 * concern) never cross to the render wire. Verdict / category / severity ride
 * only when present (`exactOptionalPropertyTypes`).
 */
export const reviewFindingsToAnchors = (
  findings: readonly ReviewFinding[],
  diffPath: string,
): readonly DiffAnchorComment[] => {
  const anchors: DiffAnchorComment[] = []
  for (const f of findings) {
    const anchor = f.anchor
    // Only anchored findings targeting THIS diff's file can overlay a line.
    if (anchor === undefined || anchor.path !== diffPath) continue
    anchors.push({
      line: anchor.line,
      summary: f.shortSummary ?? f.what,
      ...(f.verdict !== undefined ? { verdict: f.verdict } : {}),
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
    })
  }
  return anchors
}

export interface CanvasToolDiffSourceHandle {
  /** Wire into `AgentConfig.onToolDiff`. Fans the capture out to subscribers. */
  readonly sink: { capture(input: CapturedToolDiff): void }
  /** Subscribe to subsequent captures. Returns an unsubscribe closure. */
  readonly subscribe: (handler: (diff: CapturedToolDiff) => void) => () => void
  /** Cumulative count of subscriber deliveries that THREW (health signal). */
  readonly failureCount: () => number
}

/** Create a fresh canvas tool-diff source. One per daemon (shared across the
 *  daemon's connections, like the shared session + usage source). */
export const createCanvasToolDiffSource = (
  opts: CanvasSourceOptions = {},
): CanvasToolDiffSourceHandle => {
  const subscribers = new Set<(diff: CapturedToolDiff) => void>()
  let failures = 0
  return {
    sink: {
      capture: (input) => {
        // Isolate throws (siblings + the already-written file are safe) AND
        // surface them via the optional observer. Absent observer ⇒ legacy
        // swallow (byte-identical).
        failures += fanOutIsolated(subscribers, input, opts.onSubscriberError)
      },
    },
    subscribe: (handler) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    failureCount: () => failures,
  }
}
