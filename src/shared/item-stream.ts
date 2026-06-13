/**
 * T01 — `item/*` fine-grained streaming protocol (CORE contract).
 *
 * Codex's app-server streams a turn's INTERIOR as discrete *items*: an
 * `item/started` → 0..N typed deltas → `item/completed`. quanta's wire is
 * turn-granular; this module is the dependency-free CORE that both wire planes
 * (session.v1 `item.*` events AND the web agent-state `item.*` messages) share so
 * the two transports cannot drift apart in shape.
 *
 * SINGLE SOURCE OF TRUTH: the projector that turns the existing in-proc
 * `AgentEvent` stream into these cores lives in `@/stream/item-stream-projector`
 * (it needs the `AgentEvent` union, which `@/shared` may not import — slice
 * isolation). This file owns ONLY the closed taxonomy + the pure tool-class
 * classifier + the gate, none of which depend on a slice.
 *
 * Default-OFF: {@link itemStreamEnabled} (`QUANTA_ITEM_STREAM`) governs whether
 * the projector is instantiated at the wiring seams. Unset ⇒ no projector ⇒ no
 * item cores ⇒ byte-identical legacy on BOTH planes.
 */
import { gateOn } from "./env-flag"

/** Lifecycle phase of an item. Closed 3-state — Codex `started`/delta/`completed`. */
export type ItemStreamPhase = "started" | "delta" | "completed"

/**
 * The KIND of interior item. Closed union. `reasoning` ← extended-thinking
 * deltas; `commandExecution` ← an exec-class tool (shell); `fileChange` ← an
 * edit/patch-class tool; `tool` ← any other tool (the neutral fallback so an
 * unrecognised tool is NEVER mislabelled as exec/patch — see
 * {@link classifyToolItemType}).
 */
export type ItemStreamItemType = "reasoning" | "commandExecution" | "fileChange" | "tool"

/**
 * The KIND of a delta payload. Closed union, 1:1 derivable from the owning
 * item's {@link ItemStreamItemType}, but carried explicitly so a consumer can
 * branch on the delta alone without joining back to the `started`. Mirrors the
 * Codex subtypes `item/reasoning/textDelta`, `item/commandExecution/outputDelta`,
 * `item/fileChange/patchUpdated`.
 */
export type ItemStreamDeltaKind =
  | "reasoning.text"
  | "command.output"
  | "file.patch"
  | "tool.progress"

/** An item opened. `index` is monotonic across ALL items in a turn-stream. */
export interface ItemStreamStarted {
  readonly phase: "started"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly index: number
}

/** An incremental delta for an OPEN item. */
export interface ItemStreamDelta {
  readonly phase: "delta"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly deltaKind: ItemStreamDeltaKind
  readonly delta: string
}

/** An item closed. `text` is the accumulated delta body flushed at completion
 *  (absent when the item produced no deltas). */
export interface ItemStreamCompleted {
  readonly phase: "completed"
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  readonly text?: string
}

/** Closed discriminated union — every item core the projector emits. */
export type ItemStreamCore = ItemStreamStarted | ItemStreamDelta | ItemStreamCompleted

/** The 1:1 delta-kind for an item type (the kind a `delta` of that item carries). */
export const ITEM_DELTA_KIND_BY_ITEM_TYPE = {
  reasoning: "reasoning.text",
  commandExecution: "command.output",
  fileChange: "file.patch",
  tool: "tool.progress",
} as const satisfies Record<ItemStreamItemType, ItemStreamDeltaKind>

/**
 * Closed, curated tool-name → item-type classifier. These names mirror the
 * canonical tool registrations (`src/tool/apply-patch.ts`, the `bash`/`edit`/
 * `write` tools). An unrecognised name falls back to the neutral `tool` item so
 * a tool is NEVER mislabelled as exec/patch (no floating heuristic — an explicit
 * curated set, the same posture as the dispatch-layer tool-class sets).
 *
 * Follow-up (logged, not silent): the principled end-state is for each tool to
 * DECLARE its item class (like `isReadOnly`/`classifySource`) so the projector
 * need not know names. Until then this curated map is the SSOT.
 */
export const ITEM_TYPE_BY_TOOL_NAME = {
  bash: "commandExecution",
  shell: "commandExecution",
  edit: "fileChange",
  apply_patch: "fileChange",
  write: "fileChange",
  multi_edit: "fileChange",
} as const satisfies Record<string, ItemStreamItemType>

/** Classify a tool name into its item type; unrecognised ⇒ neutral `tool`. */
export const classifyToolItemType = (toolName: string): ItemStreamItemType =>
  (ITEM_TYPE_BY_TOOL_NAME as Record<string, ItemStreamItemType | undefined>)[toolName] ?? "tool"

export const ITEM_STREAM_FLAG = "QUANTA_ITEM_STREAM"

/** Default-OFF opt-in check via the `@/shared` gate SSOT. */
export const itemStreamEnabled = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, ITEM_STREAM_FLAG)
