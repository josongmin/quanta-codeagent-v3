/**
 * Working-state panel (catalog 대5 L4 WorkingState) — surface-only renderer.
 *
 * Why: `src/agent/working-state.ts` builds a per-session L3 scratchpad (owner
 * shortlist, hypothesis, blockers, next steps, deferred validation) that the
 * model mutates via the `update_working_state` meta-tool. The model SEES it
 * verbatim through `renderWorkingStateBlock` in its per-turn reminder — but
 * the USER has no window into it. This module is that window:
 *
 *   - {@link renderWorkingStatePanel} — full bordered box (`/state` body).
 *   - {@link formatWorkingStateTransient} — one-line status-bar overlay
 *     ("state: 2 blockers, 3 next steps").
 *   - {@link formatWorkingStateSummaryRow} — single line a turn-summary
 *     caller can splice into its existing rows.
 *
 * Slice discipline:
 *   - Lives in `src/apps/cli`. Imports `@/agent` for the `WorkingState` type
 *     ONLY (read-only — never mutates the snapshot) and `@/ui/ui-helpers` for
 *     box rendering + colours. No other side-channels.
 *   - No I/O. No env reads. No clock. Pure pure functions; callers (REPL,
 *     turn-summary, `/state`) decide WHEN to call them.
 *
 * Default-OFF parity:
 *   - When the snapshot is empty (or undefined), every renderer returns a
 *     sensible empty string / "(empty)" message so the surface can no-op
 *     without a branch.
 *   - Colour off ⇒ `@/ui/ui-helpers` already strips ANSI globally (see
 *     `ColorPolicyResolver`); we add no extra escapes of our own.
 */

import type { Blocker, NextStep, OwnerCandidate, SkillScopeView, WorkingState } from "@/agent"
import { cyan, dim, gray, green, red, renderBox, yellow } from "@/ui/ui-helpers"

/** Exported alias requested by the spec — the SAME shape `snapshot()` returns
 *  on a {@link WorkingStateSession}. We re-export under the spec name so a
 *  future schema migration (e.g. an immutable wrapper) can land here. */
export type WorkingStateSnapshot = WorkingState

/** Cap list lengths painted in the panel so a runaway model that filled the
 *  state with 200 next-steps does not blow the terminal. The trailing
 *  `… +N more` marker preserves the "n total" signal without the bulk. */
const MAX_OWNERS = 8
const MAX_BLOCKERS = 8
const MAX_NEXT_STEPS = 12
const MAX_DEFERRED = 6
/** Hard cap on any single line inside the panel — protects against a single
 *  pathological `what`/`reason` string blowing horizontal width. Truncated via
 *  a 1-char ellipsis (`…`) so visible width is exactly `MAX_LINE_LEN`. */
const MAX_LINE_LEN = 96
/** Cap on the transient status-bar text (terminal status-bar paints in a
 *  single row, no wrap). Defensive against huge counts (`9999`). */
const MAX_TRANSIENT_LEN = 80

const truncate = (s: string, max = MAX_LINE_LEN): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

const isEmpty = (snap: WorkingStateSnapshot): boolean =>
  snap.ownerShortlist.length === 0 &&
  (snap.hypothesis === undefined || snap.hypothesis.trim() === "") &&
  snap.blockers.length === 0 &&
  snap.nextStepQueue.length === 0 &&
  snap.deferredValidation.length === 0

/** Append `items` formatted by `fmt`, capped at `max` and tagged with
 *  `… +N more` when truncated. Caller is responsible for the section
 *  header — this only returns the rendered rows so multiple sections
 *  can share the same accumulator. `fmt` receives `(item, index)` so
 *  numbered lists (next steps) can paint `1. …`, `2. …`. */
const renderList = <T>(
  items: readonly T[],
  max: number,
  fmt: (t: T, idx: number) => string,
): string[] => {
  if (items.length === 0) return []
  const head = items.slice(0, max).map((item, idx) => fmt(item, idx))
  if (items.length > max) head.push(dim(`… +${items.length - max} more`))
  return head
}

const fmtOwner = (o: OwnerCandidate): string => truncate(`${o.file} — ${o.reason}`)
const fmtBlocker = (b: Blocker): string => truncate(`[${b.surface}] ${b.what}`)
const fmtNext = (n: NextStep, idx: number): string =>
  truncate(`${idx + 1}. ${n.what}${n.deferred ? dim(" (deferred)") : ""}`)
const fmtDeferred = (d: { rail: string; reason: string }): string =>
  truncate(`${d.rail}: ${d.reason}`)

/** Posture is not a stored field on {@link WorkingState} — we infer it from
 *  the live mix. The spec asks for `Posture: investigating` etc. as a header
 *  so the user sees what mode the agent thinks it is in. Order matters:
 *  blockers dominate (something is in the way) over progress (next-steps
 *  pending) over hypothesis (still framing) over idle. */
const inferPosture = (snap: WorkingStateSnapshot): string => {
  if (snap.blockers.length > 0) return "blocked"
  if (snap.nextStepQueue.length > 0) return "executing"
  if (snap.hypothesis !== undefined && snap.hypothesis.trim() !== "") return "investigating"
  if (snap.ownerShortlist.length > 0) return "scoping"
  return "idle"
}

const postureColor = (posture: string): ((s: string) => string) => {
  switch (posture) {
    case "blocked":
      return red
    case "executing":
      return cyan
    case "investigating":
      return yellow
    case "scoping":
      return gray
    default:
      return dim
  }
}

/** Indent for continuation rows under a labelled section header (12 visible
 *  chars to match the widest label "Hypothesis:" + 1 space). */
const CONT_INDENT = "            "

/** Append a labelled section's rendered rows into `acc`. The first row sits
 *  next to the label ("Next steps: 1. …"), subsequent rows are indented to
 *  visually nest under it. `bullet` optionally prepends a marker (e.g. `red("•")`)
 *  before each row — used for blockers / deferred. Empty `rows` ⇒ no-op. */
const pushSection = (
  acc: string[],
  label: string,
  rows: readonly string[],
  bullet?: string,
): void => {
  if (rows.length === 0) return
  const tag = bullet !== undefined ? `${bullet} ` : ""
  const first = rows[0]
  if (first === undefined) return
  acc.push(`${dim(label)} ${tag}${first}`)
  for (const r of rows.slice(1)) acc.push(`${CONT_INDENT}${tag}${r}`)
}

/** Build the body lines (everything between the title border and the
 *  bottom border) for the panel. Extracted so {@link renderWorkingStatePanel}
 *  stays under the cognitive-complexity budget — the body is straight-line
 *  composition of section helpers. Caller passes a non-empty snapshot. */
const buildPanelLines = (snap: WorkingStateSnapshot): string[] => {
  const lines: string[] = []
  const posture = inferPosture(snap)
  lines.push(`${dim("Posture:")}    ${postureColor(posture)(posture)}`)
  if (snap.hypothesis !== undefined && snap.hypothesis.trim() !== "") {
    lines.push(`${dim("Hypothesis:")} ${truncate(snap.hypothesis.trim())}`)
  }
  pushSection(lines, "Next steps:", renderList(snap.nextStepQueue, MAX_NEXT_STEPS, fmtNext))
  pushSection(lines, "Blockers:  ", renderList(snap.blockers, MAX_BLOCKERS, fmtBlocker), red("•"))
  pushSection(lines, "Owners:    ", renderList(snap.ownerShortlist, MAX_OWNERS, fmtOwner))
  pushSection(
    lines,
    "Deferred:  ",
    renderList(snap.deferredValidation, MAX_DEFERRED, fmtDeferred),
    yellow("⏸"),
  )
  return lines
}

/** Render the panel `/state` (or any surface) paints when the user wants to
 *  see the current working state. Empty snapshot ⇒ a single dim line so the
 *  caller still knows the panel was reached but is not noisy. */
export const renderWorkingStatePanel = (snap: WorkingStateSnapshot | undefined): string => {
  if (snap === undefined || isEmpty(snap)) {
    return renderBox([dim("(working state is empty)")], {
      title: "Working state",
      titleStyle: cyan,
      padX: 2,
      minInner: 36,
    })
  }
  return renderBox(buildPanelLines(snap), {
    title: "Working state",
    titleStyle: cyan,
    padX: 2,
    minInner: 48,
  })
}

/** Compact one-line transient for a status-bar overlay. Empty ⇒ `""` so
 *  the caller can skip painting without a branch. Caps the printed length
 *  so a wide terminal doesn't get a runaway row from `9999×` counters. */
export const formatWorkingStateTransient = (snap: WorkingStateSnapshot | undefined): string => {
  if (snap === undefined || isEmpty(snap)) return ""
  const parts: string[] = []
  if (snap.blockers.length > 0) {
    parts.push(`${snap.blockers.length} blocker${snap.blockers.length === 1 ? "" : "s"}`)
  }
  if (snap.nextStepQueue.length > 0) {
    parts.push(
      `${snap.nextStepQueue.length} next step${snap.nextStepQueue.length === 1 ? "" : "s"}`,
    )
  }
  if (snap.ownerShortlist.length > 0) {
    parts.push(`${snap.ownerShortlist.length} owner${snap.ownerShortlist.length === 1 ? "" : "s"}`)
  }
  if (snap.deferredValidation.length > 0) {
    parts.push(
      `${snap.deferredValidation.length} deferred validation${
        snap.deferredValidation.length === 1 ? "" : "s"
      }`,
    )
  }
  if (parts.length === 0) {
    // hypothesis-only snapshot — surface the posture so the bar shows
    // SOMETHING when state is non-empty but has no countable fields.
    return truncate(`[state updated: ${inferPosture(snap)}]`, MAX_TRANSIENT_LEN)
  }
  return truncate(`[state updated: ${parts.join(", ")}]`, MAX_TRANSIENT_LEN)
}

/** Single-row format suitable for splicing into a turn-summary box. Empty
 *  snapshot ⇒ `""` (the caller drops the row). Uses the same posture +
 *  count tokens as the transient so the two surfaces never disagree. */
export const formatWorkingStateSummaryRow = (snap: WorkingStateSnapshot | undefined): string => {
  if (snap === undefined || isEmpty(snap)) return ""
  const posture = inferPosture(snap)
  const parts: string[] = [postureColor(posture)(posture)]
  if (snap.blockers.length > 0) parts.push(red(`${snap.blockers.length}×blocker`))
  if (snap.nextStepQueue.length > 0) parts.push(`${snap.nextStepQueue.length}×next`)
  if (snap.deferredValidation.length > 0) {
    parts.push(yellow(`${snap.deferredValidation.length}×deferred`))
  }
  return `${cyan("◈ state:")} ${parts.join(" · ")}`
}

/** Cap the number of tool names painted in the skill-scope panel so a wide
 *  allowlist (or a huge hidden set) does not blow the terminal. The trailing
 *  `… +N more` marker preserves the total signal. */
const MAX_SCOPE_TOOLS = 24

/**
 * ADR-0512 P3 — render the active skill's tool-availability partition for
 * `/state`. Answers the user's "왜 이 도구가 없지?": which tools the CURRENTLY-
 * active skill scoped IN (the model sees + can call) vs OUT (the model never
 * sees them, so it can't fumble into a red error).
 *
 * `view` is the read-only {@link SkillScopeView} the surface threads from the
 * live `skillGate` (reuse of `buildSkillScopeView`). Returns `""` when there is
 * NOTHING to show — no view (slot absent ⇒ v2 OFF / skill-less session) OR a
 * view with no active skill (`activeSkill === null`, gate armed-but-no-scope).
 * The `/state` caller appends a non-empty result, so an empty string keeps the
 * panel BYTE-IDENTICAL to the working-state-only render.
 */
export const renderSkillScopePanel = (view: SkillScopeView | undefined): string => {
  if (view === undefined || view.activeSkill === null) return ""
  const lines: string[] = []
  lines.push(`${dim("Active skill:")} ${cyan(truncate(view.activeSkill))}`)
  const visible = renderList([...view.visibleTools], MAX_SCOPE_TOOLS, (t) => green(truncate(t)))
  pushSection(lines, "Visible:    ", visible)
  if (view.hiddenTools.length > 0) {
    const hiddenNames = view.hiddenTools
      .slice(0, MAX_SCOPE_TOOLS)
      .map((t) => dim(truncate(t)))
      .join(", ")
    const more =
      view.hiddenTools.length > MAX_SCOPE_TOOLS
        ? dim(` … +${view.hiddenTools.length - MAX_SCOPE_TOOLS} more`)
        : ""
    lines.push(
      `${dim("Hidden:")}     ${gray(`${view.hiddenTools.length} scoped out`)} ${hiddenNames}${more}`,
    )
  }
  return renderBox(lines, {
    title: "Skill scope",
    titleStyle: cyan,
    padX: 2,
    minInner: 48,
  })
}

/** Internal helpers exported for unit-test drilling — NOT part of the
 *  public callable surface. The renderers above are the only stable
 *  exports. */
export const __internal = Object.freeze({
  inferPosture,
  isEmpty,
  truncate,
  MAX_LINE_LEN,
  MAX_TRANSIENT_LEN,
})
