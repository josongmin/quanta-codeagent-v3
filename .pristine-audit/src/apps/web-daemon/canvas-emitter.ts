/**
 * ADR-0440 — Canvas emitter (web-daemon side).
 *
 * Push-based companion to the observability emitter. Two seams the agent loop
 * already exercises feed this emitter; it converts the ALREADY-COMPUTED data
 * into a render-side canvas frame and forwards it over an injected WS-like
 * sink:
 *
 *   - `feedToolDiff(...)`  ← a tool file mutation (before/after text). Runs the
 *                            CLI line-LCS ONCE (`diffOps` from diff-preview.ts)
 *                            + the CLI caps (64 KiB/side, 200-line) + the CLI
 *                            binary probe, then converts ops → `DiffLineData[]`
 *                            via the lossless {@link diffOpsToLines} adapter and
 *                            emits a `tool.diff` frame.
 *   - `feedUsage(view)`    ← the loop's already-computed `ContextUsageBreakdown`
 *                            (status-line.ts), serialized VERBATIM into a
 *                            `context.usage` frame. NO second token heuristic.
 *
 * Default-OFF: with no sink the emitter is a no-op (the composition root only
 * injects a sink when `QUANTA_WEB_CANVAS=1`). NO-THROW: a throwing `ws.send` is
 * swallowed so a dead socket never breaks a turn.
 *
 * Slice fence: imports the structured diff helpers + caps from the
 * surface-agnostic `@/runner/diff-ops` slice (diff math is daemon-side, NEVER
 * re-run in the web bundle) and the protocol codec from `@/protocol/canvas`.
 * The usage view is the loop's `ContextUsageBreakdown` (`@/agent/context`),
 * which is structurally the segmented view. NO `@/apps/*`, NO `@/agent/loop`.
 */

import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import {
  type ArtifactReadyMessage,
  type CanvasMessage,
  type ContextUsageMessage,
  type DiffAnchorComment,
  type DiffLineData,
  encodeCanvasFrame,
  type ToolDiffMessage,
} from "@/protocol/canvas"
import type { ArtifactRef } from "@/protocol/session"
import { diffOps, isBinary, resolveEnvCaps } from "@/runner/diff-ops"
import { errMessage } from "@/shared"

/* ------------------------------------------------------------------ */
/* Lossless adapters (daemon-side; pure)                              */
/* ------------------------------------------------------------------ */

const KIND_TO_TYPE = {
  keep: "unchanged",
  del: "removed",
  add: "added",
} as const satisfies Record<"keep" | "del" | "add", DiffLineData["type"]>

/**
 * Lossless `DiffOp[]` → `DiffLineData[]`. Pure form-conversion — the diff math
 * is NOT re-run here (`diffOps` produced the ops). Gutter numbering mirrors a
 * unified diff: added/unchanged advance + show the NEW-side number; removed
 * advances + shows the OLD-side number.
 */
export const diffOpsToLines = (
  ops: readonly { readonly kind: "keep" | "del" | "add"; readonly line: string }[],
): DiffLineData[] => {
  let oldNo = 0
  let newNo = 0
  return ops.map((op) => {
    const type = KIND_TO_TYPE[op.kind]
    if (op.kind === "del") {
      oldNo += 1
      return { type, content: op.line, lineNumber: oldNo }
    }
    if (op.kind === "add") {
      newNo += 1
      return { type, content: op.line, lineNumber: newNo }
    }
    oldNo += 1
    newNo += 1
    return { type, content: op.line, lineNumber: newNo }
  })
}

/** Additions / deletions from the SAME ops — never re-counted on the web side. */
export const diffOpStats = (
  ops: readonly { readonly kind: "keep" | "del" | "add" }[],
): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const op of ops) {
    if (op.kind === "add") additions += 1
    else if (op.kind === "del") deletions += 1
  }
  return { additions, deletions }
}

/* ------------------------------------------------------------------ */
/* Sink + handle                                                       */
/* ------------------------------------------------------------------ */

/** WS-like send sink — every existing daemon transport (Bun.serve socket /
 *  unit test stub) satisfies it. */
export interface CanvasSink {
  send(frame: string): void
}

export interface CanvasEmitterOptions {
  /** WS-like sink (recommended — the codec runs inside). */
  readonly ws?: CanvasSink
  /** Pre-encoded-message sink (for transports adding their own envelope). */
  readonly send?: (msg: CanvasMessage) => void
  /** Per-side content byte cap. Default: CLI `resolveEnvCaps().maxBytes`. */
  readonly maxBytes?: number
  /** Visible diff-line cap. Default: CLI `resolveEnvCaps().maxLines`. */
  readonly maxLines?: number
  /** Clock seam (default `Date.now`). */
  readonly now?: () => number
  /**
   * DOF-40 fail-closed seam. Invoked when a LIVE-connection `ws.send` /
   * `send` THROWS (a dead socket). The throw is still isolated (the turn is
   * never broken) but is now SURFACED here instead of silently swallowed.
   * Absent ⇒ legacy swallow (byte-identical default-OFF). The observer
   * itself is guarded — a throwing observer never breaks the turn.
   */
  readonly onSendError?: (err: { readonly error: unknown; readonly message: string }) => void
}

/** A tool file mutation to render. `before`/`after` are the full pre/post text
 *  (the daemon already has them at the tool seam). `binary` short-circuits to a
 *  placeholder frame. */
export interface ToolDiffInput {
  readonly toolCallId: string
  readonly before: string
  readonly after: string
  readonly path?: string
  readonly language?: string
  /** Force a binary placeholder (e.g. the caller already knows it's binary). */
  readonly binary?: boolean
  /** RFC-12 (deferred) SURFACE B — anchored review comments already projected
   *  from the diff's `ReviewFinding` anchors (`reviewFindingsToAnchors` in
   *  `canvas-tool-diff-source.ts`) onto the new-side line. ADDITIVE + OPTIONAL:
   *  absent / empty ⇒ NO `anchors` key on the emitted frame (byte-identical to a
   *  non-review diff). Present + non-empty ⇒ overlaid on the DiffView. */
  readonly anchors?: readonly DiffAnchorComment[]
}

export interface CanvasEmitterHandle {
  /** Convert + emit a `tool.diff` frame for a tool file mutation. */
  readonly feedToolDiff: (input: ToolDiffInput) => void
  /** Serialize + emit a `context.usage` frame from the loop's segmented view. */
  readonly feedUsage: (view: ContextUsageBreakdown) => void
  /** A2 — map a session `ArtifactRef` (the SAME producer drain that emits the
   *  `artifact.ready` session event) to an `artifact.ready` Canvas frame. */
  readonly feedArtifactReady: (ref: ArtifactRef) => void
  /** Stop emitting (idempotent). After this every feed is a no-op. */
  readonly stop: () => void
  /** DOF-40 — cumulative count of send throws surfaced/swallowed (health). */
  readonly sendFailureCount: () => number
}

/**
 * A2 — lossless `ArtifactRef` → `ArtifactReadyMessage`. Pure form-conversion:
 * the ref's OPAQUE `quanta-artifact://<id>` locator is carried VERBATIM (never
 * an fs path — the host's jailed preview resolver serves the bytes read-only),
 * and the closed artifact kind + mime type are the ref's own. `name` rides only
 * when present (`exactOptionalPropertyTypes`). The registry already minted the
 * ref on the producer drain — this map re-shapes it for the Canvas transport, it
 * does NOT re-derive any field.
 */
const buildArtifactReadyMessage = (ref: ArtifactRef, now: number): ArtifactReadyMessage => ({
  kind: "artifact.ready",
  artifactId: ref.artifactId,
  artifactKind: ref.kind,
  mimeType: ref.mimeType,
  locator: ref.locator,
  ...(ref.name !== undefined ? { name: ref.name } : {}),
  emittedAt: now,
})

const buildToolDiffMessage = (
  input: ToolDiffInput,
  caps: { maxBytes: number; maxLines: number },
  now: number,
): ToolDiffMessage => {
  const binary =
    input.binary === true ||
    isBinary(input.before) ||
    isBinary(input.after) ||
    input.before.length > caps.maxBytes ||
    input.after.length > caps.maxBytes
  // SURFACE B — only carry the `anchors` key when the diff HAS review anchors;
  // an absent / empty projection leaves the key OFF the frame so a non-review
  // diff is byte-identical to the pre-RFC-12 wire (data-driven, no gate knob).
  const anchorPart =
    input.anchors !== undefined && input.anchors.length > 0 ? { anchors: input.anchors } : {}
  const base = {
    kind: "tool.diff" as const,
    toolCallId: input.toolCallId,
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    emittedAt: now,
  }
  if (binary) {
    return { ...base, binary: true, lines: [], additions: 0, deletions: 0, ...anchorPart }
  }
  const ops = diffOps(input.before, input.after)
  const allLines = diffOpsToLines(ops)
  const { additions, deletions } = diffOpStats(ops)
  const truncated = allLines.length > caps.maxLines
  const lines = truncated ? allLines.slice(0, caps.maxLines) : allLines
  return {
    ...base,
    lines,
    additions,
    deletions,
    ...(truncated ? { truncated: true, moreLines: allLines.length - caps.maxLines } : {}),
    ...anchorPart,
  }
}

const buildUsageMessage = (view: ContextUsageBreakdown, now: number): ContextUsageMessage => ({
  kind: "context.usage",
  // Serialize VERBATIM — the loop already computed every count.
  segments: view.segments.map((s) => ({ id: s.id, tokens: s.tokens })),
  total: view.total,
  max: view.max,
  ...(view.model !== undefined ? { model: view.model } : {}),
  emittedAt: now,
})

/**
 * Mint a canvas emitter. With neither `ws` nor `send` the emitter is a no-op
 * (gate OFF). NO-THROW: a throwing sink is swallowed.
 */
export const createCanvasEmitter = (opts: CanvasEmitterOptions = {}): CanvasEmitterHandle => {
  const env = resolveEnvCaps()
  const caps = {
    maxBytes: opts.maxBytes ?? env.maxBytes,
    maxLines: opts.maxLines ?? env.maxLines,
  }
  const now = opts.now ?? Date.now
  let stopped = false
  let sendFailures = 0

  const emit = (msg: CanvasMessage): void => {
    if (stopped) return
    try {
      if (opts.send !== undefined) opts.send(msg)
      if (opts.ws !== undefined) opts.ws.send(encodeCanvasFrame(msg))
    } catch (error) {
      // Dead/throwing sink — the turn is NEVER broken by a bad socket. DOF-40:
      // the failure is now SURFACED (count + optional observer) rather than
      // unconditionally silent. The observer itself is guarded.
      sendFailures += 1
      if (opts.onSendError !== undefined) {
        try {
          opts.onSendError({ error, message: errMessage(error) })
        } catch {
          // observer threw — swallow (turn safety is load-bearing).
        }
      }
    }
  }

  return {
    feedToolDiff: (input) => {
      if (stopped) return
      emit(buildToolDiffMessage(input, caps, now()))
    },
    feedUsage: (view) => {
      if (stopped) return
      emit(buildUsageMessage(view, now()))
    },
    feedArtifactReady: (ref) => {
      if (stopped) return
      emit(buildArtifactReadyMessage(ref, now()))
    },
    stop: () => {
      stopped = true
    },
    sendFailureCount: () => sendFailures,
  }
}
