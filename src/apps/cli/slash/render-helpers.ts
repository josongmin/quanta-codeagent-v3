/**
 * CLI-03 — shared render helpers extracted from the monolithic
 * `slash-commands.ts` (ADR-0306). Two siblings consume them:
 *
 *   - {@link runSkillsRender} powers `/skills` + `/reload-skills` (one body,
 *     two registry entries differing only in the prefix). Lives here so the
 *     surface registry imports a single helper.
 *   - {@link truncateGraphemes} + {@link renderSkillRow} + {@link renderSkills}
 *     are the lower-level pieces — purely string-shaping, no I/O.
 *
 * Slice posture: zero cross-slice imports (`@/agent`, `@/llm`, `@/runner`,
 * `@/host` not needed). Only the surface `SkillRow` type from
 * `../slash-contract`, kept slim so the helpers remain reusable from any
 * surface that wires `ctx.skills`.
 */

import { errMessage } from "@/shared"
import type { SkillRow, SlashContext } from "../slash-contract"
/** Grapheme-cluster-aware truncator. Walks {@link Intl.Segmenter}'s grapheme
 *  boundaries so an emoji / combining-mark / high-plane char near the limit is
 *  never split (naive `slice(0, max-3) + "..."` can yield half a surrogate pair
 *  or split a ZWJ sequence). Returns `s` verbatim if `s.length <= max`.
 *  Reserves 3 chars for the `...` suffix. */
export const truncateGraphemes = (s: string, max: number): string => {
  if (s.length <= max) return s
  const limit = max - 3
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let acc = ""
  for (const { segment } of segmenter.segment(s)) {
    if (acc.length + segment.length > limit) break
    acc += segment
  }
  return `${acc}...`
}

/** Render an inventory row in the table-paddable form `/skills` and
 *  `/reload-skills` share. Truncates description to a one-line cap (100 chars
 *  incl. `...`) so REPL output stays scannable; the model still sees the full
 *  text via `buildSessionFeatures`. Multi-line ⇒ first line only (no body
 *  leak). Grapheme-aware truncation (no emoji / surrogate splitting). */
export const renderSkillRow = (s: SkillRow): string => {
  const desc1 = s.description.split("\n")[0] ?? ""
  const desc = truncateGraphemes(desc1, 100)
  const pathsTag =
    s.paths && s.paths.length > 0
      ? ` [paths: ${s.paths.slice(0, 3).join(", ")}${s.paths.length > 3 ? "…" : ""}]`
      : ""
  return `  ${s.name.padEnd(24)} ${desc}${pathsTag}\n`
}

export const renderSkills = (
  ctx: SlashContext,
  rows: readonly SkillRow[],
  prefix: string,
): void => {
  if (rows.length === 0) {
    ctx.out(`${prefix} (0 skills found)\n`)
    return
  }
  ctx.out(`${prefix} ${rows.length} skill${rows.length === 1 ? "" : "s"}:\n`)
  for (const r of rows) ctx.out(renderSkillRow(r))
}

/** Shared run-body for `/skills` and `/reload-skills`. Both commands take
 *  ZERO arguments (parity with Codex `forceReloadSkills`); extras error out
 *  for consistency with the rest of the BUILTINS (`/color foo bar` errors).
 *  Non-Error rejections from `ctx.skills()` are coerced via `String(e)` so the
 *  surfaced message never reads "undefined" (truly defensive, not just typed
 *  defensive). The two commands differ ONLY in the rendered prefix. */
export const runSkillsRender = async (
  name: string,
  args: readonly string[],
  ctx: SlashContext,
  prefix: string,
): Promise<number> => {
  if (args.length > 0) {
    ctx.err(`${name}: takes no arguments; got ${args.length}\n`)
    return 1
  }
  if (ctx.skills === undefined) {
    ctx.out(`${name}: not wired in this surface\n`)
    return 0
  }
  try {
    const rows = await ctx.skills()
    renderSkills(ctx, rows, prefix)
    return 0
  } catch (e) {
    const msg = errMessage(e)
    ctx.err(`${name}: discovery failed: ${msg}\n`)
    return 1
  }
}
