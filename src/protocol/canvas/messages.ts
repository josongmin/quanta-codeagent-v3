/**
 * ADR-0440 — Canvas web-component WS protocol.
 *
 * Two closed messages over the existing WS wire so the web/Tauri surface can
 * render rich render-side canvas components (a `DiffView` for tool file
 * mutations + a segmented `UsageBar` for per-category context usage) WITHOUT
 * recomputing any diff math or token counts:
 *
 *   - `tool.diff`      — a single tool's file diff, already converted to the
 *                        render-side `DiffLineData[]` shape by the daemon
 *                        (the CLI diff math runs ONCE, daemon-side).
 *   - `context.usage`  — the latest per-category segmented token usage,
 *                        structurally identical to the CLI's
 *                        `SegmentedUsageView` (status-line.ts) — the daemon
 *                        serializes the view verbatim, no second heuristic.
 *
 * Slice fence (load-bearing): this module is SELF-CONTAINED — it imports NO
 * `@/agent/*` runtime and NO CLI surface module. `DiffLineData` is declared
 * here as the canonical render-side line shape (mirrors Cursor's
 * `cursor/canvas` `DiffViewProps.lines[]`). The daemon's emitter converts the
 * CLI `DiffOp[]` (diff-preview.ts) into `DiffLineData[]` BEFORE building a
 * frame; the frontend keeps a structural local copy of these shapes
 * (`apps/web-frontend/src/types/protocol.ts`), same copy-not-import pattern as
 * the observability protocol (ADR-0408).
 *
 * Default-OFF: these messages are only ever emitted when the composition root
 * injects the canvas ports (`QUANTA_WEB_CANVAS=1`). Absent that, no frame is
 * ever encoded ⇒ the frontend components render nothing ⇒ chat UI unchanged.
 */

/** Render-side diff line kind. Mirrors Cursor `cursor/canvas`
 *  `DiffLineType`. */
export type DiffLineType = "added" | "removed" | "unchanged"

/** A single render-side diff line. Mirrors Cursor `DiffLineData`. The daemon
 *  produces these from the CLI `DiffOp[]` — the web bundle never runs diff
 *  math. */
export interface DiffLineData {
  readonly type: DiffLineType
  readonly content: string
  /** Gutter line number (new-side for added/unchanged, old-side for removed).
   *  Optional so a binary / placeholder frame can omit it. */
  readonly lineNumber?: number
}

/** A tool's file diff, ready to render. The daemon has already applied the
 *  CLI caps (64 KiB/side, 200-line) and converted ops → lines. */
export interface ToolDiffMessage {
  readonly kind: "tool.diff"
  /** Correlates with the `tool.invoked` / `tool.completed` session events so
   *  the UI can attach the diff card to the right tool row. */
  readonly toolCallId: string
  /** Mutated path (used by the host card header + future syntax-highlight). */
  readonly path?: string
  /** Optional language override for future per-line highlight (v2). */
  readonly language?: string
  /** `true` ⇒ binary file; `lines` is empty and the UI shows a placeholder. */
  readonly binary?: boolean
  /** `true` ⇒ the diff was clipped to the CLI line cap; the UI shows a
   *  "… (N more lines)" affordance. */
  readonly truncated?: boolean
  /** Count of lines elided when `truncated` (0 when not clipped). */
  readonly moreLines?: number
  /** Pre-converted render-side lines. Empty for a binary frame. */
  readonly lines: readonly DiffLineData[]
  /** Additions / deletions, derived from the SAME ops — never re-counted
   *  on the web side. */
  readonly additions: number
  readonly deletions: number
  readonly emittedAt: number
}

/** The latest per-category segmented context usage. Structurally identical to
 *  the CLI `SegmentedUsageView` (status-line.ts) — the daemon serializes the
 *  loop's already-computed view verbatim. */
export interface ContextUsageMessage {
  readonly kind: "context.usage"
  readonly segments: readonly { readonly id: string; readonly tokens: number }[]
  readonly total: number
  readonly max: number
  readonly model?: string
  readonly emittedAt: number
}

/**
 * A2 — a rich artifact is READY to preview. The daemon emits this alongside the
 * session `artifact.ready` event (the SAME producer drain) so the Canvas surface
 * can render a preview card for a generated image / spreadsheet / document /
 * presentation WITHOUT a session-event round-trip. Carries ONLY the opaque
 * `quanta-artifact://<id>` locator (never the absolute fs path — the host's
 * jailed preview resolver serves the bytes read-only), the closed artifact kind,
 * the recorded mime type, and an optional human name.
 */
export interface ArtifactReadyMessage {
  readonly kind: "artifact.ready"
  /** Registry-minted artifact id — correlates with the `artifact.ready` session
   *  event's `ArtifactRef.artifactId`. */
  readonly artifactId: string
  /** Artifact kind (`image` / `spreadsheet` / `document` / `presentation` /
   *  `other`). Carried verbatim from the registry — the wire does not close the
   *  vocabulary so a future kind is forward-compatible. */
  readonly artifactKind: string
  readonly mimeType: string
  /** Opaque `quanta-artifact://<id>` reference the host resolves to jailed bytes.
   *  NEVER the absolute fs path (no path leak onto the wire). */
  readonly locator: string
  /** Optional human label (the registry `label`). */
  readonly name?: string
  readonly emittedAt: number
}

/** Closed discriminated union — every canvas message the wire carries. */
export type CanvasMessage = ToolDiffMessage | ContextUsageMessage | ArtifactReadyMessage

/** Closed enum of canvas message tags — keep in lock-step with the union. */
export const CANVAS_MESSAGE_KINDS = ["tool.diff", "context.usage", "artifact.ready"] as const

export type CanvasMessageKind = (typeof CANVAS_MESSAGE_KINDS)[number]

/** Tag guard for wire routing on the receive path. Does NOT deep-validate. */
export const isCanvasMessageKind = (value: unknown): value is CanvasMessageKind =>
  typeof value === "string" && (CANVAS_MESSAGE_KINDS as readonly string[]).includes(value)

/** Plain-object check (excludes arrays + nulls). */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const isToolDiffShape = (rec: Record<string, unknown>): boolean =>
  typeof rec.toolCallId === "string" &&
  Array.isArray(rec.lines) &&
  typeof rec.additions === "number" &&
  typeof rec.deletions === "number"

const isContextUsageShape = (rec: Record<string, unknown>): boolean =>
  Array.isArray(rec.segments) && typeof rec.total === "number" && typeof rec.max === "number"

/** A2 — minimal `artifact.ready` frame shape. The four load-bearing string
 *  fields (id / kind / mime / locator) must be present; `name` is optional and
 *  not checked here. */
const isArtifactReadyShape = (rec: Record<string, unknown>): boolean =>
  typeof rec.artifactId === "string" &&
  typeof rec.artifactKind === "string" &&
  typeof rec.mimeType === "string" &&
  typeof rec.locator === "string"

/** Per-kind shape check — a closed switch on the (already-validated) tag so a
 *  future kind added to {@link CANVAS_MESSAGE_KINDS} without a shape branch is a
 *  compile-visible gap here (exhaustiveness), not a silent accept. */
const isCanvasMessageShape = (kind: CanvasMessageKind, rec: Record<string, unknown>): boolean => {
  switch (kind) {
    case "tool.diff":
      return isToolDiffShape(rec)
    case "context.usage":
      return isContextUsageShape(rec)
    case "artifact.ready":
      return isArtifactReadyShape(rec)
  }
}

/** Best-effort structural guard. Returns true iff `value` has a recognised
 *  `kind` tag + the minimal per-kind shape. The encoder enforces full shape
 *  on emit; consumers treat unknown fields as forward-compatible. */
export const isCanvasMessage = (value: unknown): value is CanvasMessage => {
  if (!isPlainObject(value)) return false
  if (!isCanvasMessageKind(value.kind)) return false
  if (typeof value.emittedAt !== "number" || !Number.isFinite(value.emittedAt)) return false
  return isCanvasMessageShape(value.kind, value)
}

/* ------------------------------------------------------------------ */
/* Wire envelope helpers                                               */
/* ------------------------------------------------------------------ */

/** Wire envelope — mirrors the session/observability `{ version, kind,
 *  payload }` shape so any transport that routes session frames can route
 *  canvas frames without a separate decoder. */
export interface CanvasWireEnvelope {
  readonly version: string
  readonly kind: "canvas"
  readonly payload: CanvasMessage
}

/** Pinned version tag — bumped on a backward-incompatible change. Decoupled
 *  from the session/observability protocol versions on purpose. */
export const CANVAS_PROTOCOL_VERSION = "canvas.v1" as const

/** Encode a typed canvas message into a JSON wire frame. */
export const encodeCanvasFrame = (msg: CanvasMessage): string =>
  JSON.stringify({
    version: CANVAS_PROTOCOL_VERSION,
    kind: "canvas",
    payload: msg,
  } satisfies CanvasWireEnvelope)

/** Decode a wire frame into a canvas message, or return null on any shape
 *  mismatch. NO-THROW: callers log + drop on null. */
export const decodeCanvasFrame = (raw: unknown): CanvasMessage | null => {
  if (typeof raw !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (rec.kind !== "canvas") return null
  if (typeof rec.version !== "string" || rec.version.length === 0) return null
  // Gate the protocol version we claim to carry: a v2 emitter to a v1 consumer
  // would otherwise be read with the wrong schema and silently mis-rendered.
  if (rec.version !== CANVAS_PROTOCOL_VERSION) return null
  if (!isCanvasMessage(rec.payload)) return null
  return rec.payload
}
