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
  // RFC-06 F4 — a MANAGEMENT-projected row that is effectively disabled (durable
  // user disable or admin ban) is tagged so the CLI list agrees with the live
  // runtime view. Absent on active rows ⇒ byte-identical to the pre-F4 row.
  const disabledTag =
    s.disabled === true ? ` [disabled${s.disableReason ? `: ${s.disableReason}` : ""}]` : ""
  return `  ${s.name.padEnd(24)} ${desc}${pathsTag}${disabledTag}\n`
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

/**
 * RFC03-def — `/skills review` sub-command body: list PENDING staged imported
 * skill proposals, or approve/deny one by id. The review surface (`ctx.skillReview`)
 * is bound to the SAME approval machine + artifact port + staging store a gated
 * startup config-migration IMPORT staged into.
 *
 *   /skills review              — list PENDING staged proposals
 *   /skills review approve <id> — hash-verified CAS promote (writes live SKILL.md)
 *   /skills review deny <id>    — drop (no live write)
 *
 * Security: approve is the ONLY live-dir write path; it runs the existing CAS
 * `promote` (hash re-verify + realpath jail + atomic), fail-closed on any miss.
 * Absent the surface (no import staged this run) ⇒ "no staged skill proposals"
 * + exit 0 (default-OFF byte-identical). NEVER promotes on a bare `review`.
 */
/** The review surface shape `/skills review` consumes (narrowed from ctx). */
type SkillReviewSurface = NonNullable<SlashContext["skillReview"]>

/** `/skills review` (no id) — list PENDING staged proposals. */
const listStagedProposals = (name: string, ctx: SlashContext, review: SkillReviewSurface): 0 => {
  const pending = review.list()
  if (pending.length === 0) {
    ctx.out(`${name} review: no pending staged skill proposals\n`)
    return 0
  }
  ctx.out(`${name} review: ${pending.length} pending:\n`)
  for (const p of pending) {
    ctx.out(`  ${p.id}  ${p.name}  → ${p.targetPath}  [${p.artifactHash.slice(0, 12)}…]\n`)
  }
  ctx.out(`Use "${name} review approve <id>" or "${name} review deny <id>".\n`)
  return 0
}

/** `/skills review approve <id>` — hash-verified CAS promote (the ONLY write). */
const approveProposal = async (
  name: string,
  ctx: SlashContext,
  review: SkillReviewSurface,
  id: string,
): Promise<number> => {
  const res = await review.approve(id)
  if (res.ok) {
    ctx.out(`${name} review: approved "${res.name}" — promoted to ${res.path}\n`)
    return 0
  }
  ctx.err(`${name} review: approve refused (${res.reason}): ${res.detail}\n`)
  return 1
}

/** `/skills review deny <id>` — drop (no live write). */
const denyProposal = (
  name: string,
  ctx: SlashContext,
  review: SkillReviewSurface,
  id: string,
): number => {
  const res = review.deny(id)
  if (res.ok) {
    ctx.out(`${name} review: denied ${id} — dropped (no live write)\n`)
    return 0
  }
  ctx.err(`${name} review: deny refused (${res.reason})\n`)
  return 1
}

const runSkillsReview = async (
  name: string,
  args: readonly string[],
  ctx: SlashContext,
): Promise<number> => {
  const review = ctx.skillReview
  if (review === undefined) {
    ctx.out(`${name} review: no staged skill proposals\n`)
    return 0
  }
  const sub = args[1]
  if (sub === undefined) return listStagedProposals(name, ctx, review)
  if (sub !== "approve" && sub !== "deny") {
    ctx.err(`${name} review: unknown sub-command "${sub}" (expected approve|deny)\n`)
    return 1
  }
  const id = args[2]
  if (id === undefined || args.length > 3) {
    ctx.err(`${name} review: "${sub}" needs exactly one <id>\n`)
    return 1
  }
  return sub === "approve"
    ? approveProposal(name, ctx, review, id)
    : denyProposal(name, ctx, review, id)
}

/** Shared run-body for `/skills` and `/reload-skills`. Both commands take
 *  ZERO positional arguments for the inventory render (parity with Codex
 *  `forceReloadSkills`); extras error out. `/skills review …` is a distinct
 *  sub-command routed FIRST (RFC03-def staged-proposal review/approve).
 *  Non-Error rejections from `ctx.skills()` are coerced via `errMessage` so the
 *  surfaced message never reads "undefined". The two commands differ ONLY in the
 *  rendered prefix. */
export const runSkillsRender = async (
  name: string,
  args: readonly string[],
  ctx: SlashContext,
  prefix: string,
): Promise<number> => {
  // RFC03-def — `/skills review …` staged-proposal review/approve sub-command.
  // Only on the `/skills` command (not `/reload-skills`).
  if (name === "/skills" && args[0] === "review") {
    return runSkillsReview(name, args, ctx)
  }
  if (args.length > 0) {
    ctx.err(`${name}: takes no arguments; got ${args.length}\n`)
    return 1
  }
  // RFC-06 F4 — `/reload-skills` in a live session routes through the shared
  // authority's `sync()` (re-read the durable disabled set + republish) and
  // renders the returned revision, NOT an independent disk re-scan. Absent the
  // authority-backed hook (the one-shot shell path) ⇒ fall through to the
  // {@link SlashContext.skills} re-scan below (byte-identical pre-F4).
  if (name === "/reload-skills" && ctx.reloadSkills !== undefined) {
    try {
      const { rows, revision } = await ctx.reloadSkills()
      renderSkills(ctx, rows, revision !== undefined ? `${prefix} rev ${revision} —` : prefix)
      return 0
    } catch (e) {
      ctx.err(`${name}: reload failed: ${errMessage(e)}\n`)
      return 1
    }
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
