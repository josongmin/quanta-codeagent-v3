import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { Skill, SkillEffort } from "./types"

const schema = z.object({
  name: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
  args: z
    .string()
    .max(8_000)
    .optional()
    .describe(
      "Optional arguments to interpolate into the skill body: `$ARGUMENTS` is " +
        "replaced with the whole string, `$1`/`$2`/… with whitespace-split " +
        "positionals. Omit for skills that take no arguments.",
    ),
})

type Input = z.infer<typeof schema>

/**
 * Interpolate `$ARGUMENTS` / `$1`…`$N` placeholders in a skill body with the
 * caller-supplied argument string (Claude Code `.claude/commands/*.md`
 * parity). `$ARGUMENTS` → the whole (trimmed) string; `$N` → the Nth
 * whitespace-split positional (1-indexed), out-of-range → `""`.
 *
 * Two safety properties:
 *  - **Inert**: the result is injected as PROMPT CONTEXT, never executed, so
 *    shell metacharacters in `args` are plain text. `String.replace` does not
 *    re-scan inserted text, so an arg of `"$1"` can never trigger a second
 *    substitution.
 *  - **Byte-identical opt-out**: this is called ONLY when the caller passed
 *    `args` (see {@link createSkillTool}). An absent `args` returns the body
 *    verbatim, so every pre-existing invocation — and any body that happens to
 *    contain a literal `$ARGUMENTS` — is unchanged.
 */
export const interpolateSkillArgs = (body: string, args: string): string => {
  const all = args.trim()
  const positionals = all.split(/\s+/).filter((t) => t !== "")
  // SINGLE pass over the body: one regex alternation handles both placeholder
  // kinds, so text inserted by a `$ARGUMENTS` expansion is NEVER re-scanned for
  // `$N` (a chained `.replace().replace()` WOULD re-scan it — that was a real
  // double-substitution bug). `\b` after `$ARGUMENTS` prevents matching
  // `$ARGUMENTSX`. `d` is the captured digits for the `$N` branch, undefined
  // for the `$ARGUMENTS` branch.
  return body.replace(/\$ARGUMENTS\b|\$(\d+)/g, (_m, d?: string) => {
    if (d === undefined) return all
    const idx = Number(d)
    return idx >= 1 && idx <= positionals.length ? (positionals[idx - 1] ?? "") : ""
  })
}

/**
 * The author-declared tool allowlist for a skill, if any. Discovery resolves
 * this from strict `allowedTools:` first, then legacy `tools:` for older
 * skills. An explicit empty list is significant: it means "no tools allowed"
 * and must survive into the host enforcement seam.
 */
export const skillToolAllowlist = (s: Skill): string[] | undefined =>
  s.tools !== undefined ? s.tools : undefined

/**
 * Read seam for the author-declared `model:` override on a skill, if any.
 * Symmetric companion to {@link skillToolAllowlist}: the skill slice does NOT
 * swap the model — that is a turn-loop concern. This helper is what a host
 * (CLI, daemon) calls when it wants to honour the advisory; without it,
 * authors had to reach for `skill.model` directly and risk drift if the
 * field name ever changed. Promotes the catalog row 6.2 `model` scoping from
 * pure advisory (L2) to advisory + enforceable seam (L3) — the host owns
 * actual enforcement.
 *
 * Returns `undefined` when no override is declared. `exactOptionalProperty
 * Types`-safe: never returns an explicit `undefined` for `s.model = ""`.
 */
export const skillModelOverride = (s: Skill): string | undefined =>
  typeof s.model === "string" && s.model.length > 0 ? s.model : undefined

/**
 * Read seam for the author-declared `effort:` override on a skill, if any.
 * Companion to {@link skillModelOverride}: same advisory→seam upgrade for the
 * `effort` axis. Honours the union `low | medium | high | max | number`; a
 * numeric `0` is a valid override (e.g. "no extended thinking"), so the
 * defined-check is on `=== undefined`, not falsy.
 */
export const skillEffortOverride = (s: Skill): SkillEffort | undefined =>
  s.effort === undefined ? undefined : s.effort

/**
 * One-line human-readable summary of the scoping a skill *declares*. These are
 * ADVISORY metadata the skill author wrote in frontmatter — they are NOT an
 * enforced sandbox. Nothing in this slice (or, currently, the host) restricts
 * tool/model/effort based on them; a host must opt in via the enforcement seam
 * ({@link skillToolAllowlist}). The wording is deliberately phrased so neither
 * the model nor a reader concludes a guarantee is in force.
 */
export const scopingNote = (s: Skill): string => {
  const parts: string[] = []
  if (s.tools !== undefined) {
    parts.push(`tools: ${s.tools.length === 0 ? "[]" : s.tools.join(", ")}`)
  }
  if (s.model) parts.push(`model: ${s.model}`)
  if (s.effort !== undefined) parts.push(`effort: ${String(s.effort)}`)
  return parts.length === 0
    ? "[skill scope] none declared"
    : `[skill scope] author-declared (advisory, not enforced): ${parts.join(" | ")}`
}

/**
 * The `Skill` tool. Input `{ name }`; on execute it returns the matched skill's
 * markdown BODY as the tool result `output` so the model proceeds with those
 * instructions in context, prefixed with a one-line note of any
 * tool/model/effort scoping the skill *declares*.
 *
 * Honesty note: the declared `tools`/`model`/`effort` scope is ADVISORY only.
 * This slice does not, and cannot from here, restrict tool access, swap the
 * model, or change effort — those are turn-loop concerns. A host that wants
 * real enforcement must read {@link skillToolAllowlist} (and `skill.model` /
 * `skill.effort`) and apply them itself when activating a skill. Until a host
 * does that, the scope shown in the result and on the {@link Skill} type is
 * informational metadata, not a sandbox guarantee.
 */
/**
 * ADR-0457 — one catalogue row for the skill listing. Surfaces the codex
 * ECOSYSTEM frontmatter additively:
 *   - `argumentHint` (e.g. `[scope]`) is appended after the name: `rr [scope]`.
 *   - `shortDescription` (guaranteed-short `metadata.short-description`) is
 *     preferred over the potentially-long `description` when present.
 * A skill declaring neither renders byte-identical to the pre-0457 row
 * (`- name: description`).
 */
export const skillCatalogueRow = (s: Skill): string => {
  const head = s.argumentHint ? `${s.name} ${s.argumentHint}` : s.name
  const blurb = s.shortDescription ?? s.description
  return `- ${head}: ${blurb}`
}

export const createSkillTool = (skills: Skill[]): Tool<Input> => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const catalogue = skills.map(skillCatalogueRow).join("\n")

  return {
    name: "Skill",
    description:
      "Invoke a named skill: its instructions are injected into your context so " +
      "you can proceed with them. Available skills:\n" +
      (catalogue === "" ? "(none discovered)" : catalogue),
    inputSchema: schema,
    isReadOnly: () => true,
    // Returns static skill text; no observable interaction with other calls.
    isConcurrencySafe: () => true,

    async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const want = input.name.trim().replace(/^\//, "") // tolerate a "/foo" form
      const skill = byName.get(want)
      if (!skill) {
        const names = [...byName.keys()].join(", ") || "(none)"
        yield {
          type: "result",
          result: { ok: false, output: `Unknown skill: ${want}. Available: ${names}` },
        }
        return
      }
      // §22.2 — interpolate `$ARGUMENTS`/`$N` ONLY when the caller supplied
      // args. Absent ⇒ body verbatim (byte-identical to every pre-feature
      // invocation, incl. bodies containing a literal `$ARGUMENTS`).
      const body =
        input.args !== undefined ? interpolateSkillArgs(skill.body, input.args) : skill.body
      yield {
        type: "result",
        result: { ok: true, output: `${scopingNote(skill)}\n\n${body}` },
      }
    },
  }
}
