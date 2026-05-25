/**
 * Knob status-bar indicator — compact textual badge for the bottom status
 * row of the CLI REPL. Pure function over `KnobValueMap`.
 *
 * Rendering rules (chosen so common single-knob sessions stay readable AND
 * many-knob sessions don't blow past the status row's `cols - 1` cap that
 * `installStatusBar` enforces):
 *   - 0 active ⇒ empty string (caller composes as the no-knob baseline)
 *   - 1..3 active ⇒ inline list, `[knobs: a + b + c]` with per-value
 *     formatting:
 *       - boolean `true` / string `"on"` ⇒ bare id (`skills`)
 *       - number ⇒ `id:value` (`branch-search:3`)
 *       - otherwise ⇒ `id=value` (`persona=pragmatic`)
 *   - 4+ active ⇒ compact count, `[knobs: 5 active]` (the user can
 *     `/knobs show` for the detail).
 *
 * The map iteration order is the registration order of the framework's
 * `resolveKnobs` (which iterates the surface-filtered registry it was
 * passed). Tests verify both the small-list and large-list branches.
 */

import type { KnobValueMap } from "@/runner/knobs"

export const renderKnobStatusBar = (values: KnobValueMap): string => {
  const active = [...values]
  if (active.length === 0) return ""
  if (active.length <= 3) {
    return `[knobs: ${active.map(([id, v]) => formatKnob(id, v.value)).join(" + ")}]`
  }
  return `[knobs: ${active.length} active]`
}

const formatKnob = (id: string, value: unknown): string => {
  if (value === true || value === "on") return id
  if (typeof value === "number") return `${id}:${value}`
  return `${id}=${String(value)}`
}
