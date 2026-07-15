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
 *
 * S2 unified-observability (jul-03, additive/append-only): the plan-mode + fleet
 * models — previously disjoint wire shapes (`plan.*` host-mirror messages, the
 * activity-spine `subagent` L0 roots) — FOLD into this ONE item-stream so a
 * surface renders every agent-interior concern from a single stream:
 *   - `plan`          ← a plan snapshot / delta (the DAG rides `completed.text`
 *                        as JSON: `TodoItem.dependencies` = blockedBy edges,
 *                        `assignee` = owner). A todo's `blocked` state is a
 *                        STATUS carried INSIDE the plan payload, NOT a 5th item
 *                        type (mirrors {@link StuckReason} on the activity spine).
 *   - `subagent`      ← an in-process subagent's lifecycle (bridged from the
 *                        activity-spine fleet rows, L0→L2 drilldown in the body).
 *   - `progressCard`  ← a typed `progress_update` triple (currentStep/summary).
 * These are APPEND-ONLY: an existing member is never renamed/removed, so both
 * wire planes (session.v1 `item.*`, web agent-state `item.*`) stay byte-stable
 * for the legacy members. The two planes carry `itemType` VERBATIM (they do not
 * switch on it), so a new member propagates to both with no transport edit.
 */
export type ItemStreamItemType =
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "tool"
  | "plan"
  | "subagent"
  | "progressCard"
  // jul-15 W2 (append-only) — an inter-agent / side-agent message surfaced to the
  // user (Codex "Sent from another task" parity). A `peer_message` AgentEvent folds
  // into ONE atomic `started`+`completed` item so every surface renders it from the
  // same stream. Attribution (from→to [kind] body) rides `completed.text`.
  | "peerMessage"

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
  // S2 unified-observability (append-only): the delta kinds for the folded
  // members. `plan.patch` ← an incremental plan delta (a `plan_updated`);
  // `subagent.progress` ← an in-flight subagent status/drilldown line;
  // `progressCard.step` ← a rolling `currentStep` update.
  | "plan.patch"
  | "subagent.progress"
  | "progressCard.step"
  // jul-15 W2 (append-only) — the delta kind for a `peerMessage` item. A surfaced
  // message is atomic (started+completed in one shot), so this kind exists only to
  // satisfy the 1:1 item→delta map; no incremental `delta` is emitted for it.
  | "peerMessage.text"

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

/**
 * S2 unified-observability (jul-03) — the plane-agnostic sink an out-of-band
 * producer (e.g. the fleet/subagent snapshot bridge) pushes {@link ItemStreamCore}s
 * onto. The two wire transports adapt their own carrier to this ONE shape:
 *   - web agent-state plane: `capture({ type: "item_stream", item })`
 *   - session.v1 plane:      `onEvent({ type: "item.stream", item })`
 * so a producer that does NOT ride the `AgentEvent` stream (the fleet lifecycle
 * is polled from the TaskRegistry, never an `AgentEvent`) still lands on the SAME
 * item taxonomy the projector-driven cores use. Pure port — no I/O, no slice dep.
 */
export interface ItemStreamSink {
  capture(item: ItemStreamCore): void
}

/** The 1:1 delta-kind for an item type (the kind a `delta` of that item carries). */
export const ITEM_DELTA_KIND_BY_ITEM_TYPE = {
  reasoning: "reasoning.text",
  commandExecution: "command.output",
  fileChange: "file.patch",
  tool: "tool.progress",
  plan: "plan.patch",
  subagent: "subagent.progress",
  progressCard: "progressCard.step",
  peerMessage: "peerMessage.text",
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
