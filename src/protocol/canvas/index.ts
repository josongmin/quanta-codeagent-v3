/**
 * ADR-0440 — Canvas protocol slice barrel.
 *
 * Sole import path for the canvas WS protocol types + codec helpers. Slice
 * fence: this module re-exports from `./messages`, which is SELF-CONTAINED
 * (no `@/agent/*` runtime, no CLI surface import).
 */

export type {
  ArtifactReadyMessage,
  CanvasMessage,
  CanvasMessageKind,
  CanvasWireEnvelope,
  ContextUsageMessage,
  DiffLineData,
  DiffLineType,
  ToolDiffMessage,
} from "./messages"
export {
  CANVAS_MESSAGE_KINDS,
  CANVAS_PROTOCOL_VERSION,
  decodeCanvasFrame,
  encodeCanvasFrame,
  isCanvasMessage,
  isCanvasMessageKind,
} from "./messages"
