import { z } from "zod"
import { runtimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { createDefaultTemplateExpander, type ExpandContext, type ExpandError } from "./playbook"
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
 * Parse the caller-supplied `args` string into a NAMED context for the
 * Windsurf-style `{{ name }}` expander (ADR-0252). This is the ONLY source of
 * substitution values — nothing is invented. Each whitespace-separated token
 * shaped `key=value` becomes a context entry (`key` → the raw `value` string).
 *
 * Grammar (deliberately narrow, no heuristics):
 *  - a token is a `key=value` pair iff it contains `=` AND the substring before
 *    the FIRST `=` is a valid template identifier (`[A-Za-z_$][A-Za-z0-9_$]*`).
 *  - the value is everything after the first `=` (so `x=a=b` binds `x` → `a=b`).
 *  - tokens that are NOT `key=value` (bare positionals like `foo`) are IGNORED
 *    here — they remain available to the `$1`/`$ARGUMENTS` positional pass, so
 *    the two substitution surfaces never fight over the same token.
 *
 * Last-wins on a repeated key (mirrors the macro-registry `buildMacroRegistry`
 * collision rule). Returns a plain `Record` typed as {@link ExpandContext};
 * every value is a `string`, so the expander's number/boolean/object arms are
 * never reached from this source (author templates get verbatim string
 * substitution, which is the Windsurf CLI-arg contract).
 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export const parseKeyValueArgs = (args: string): ExpandContext => {
  const ctx: Record<string, string> = {}
  for (const tok of args.trim().split(/\s+/)) {
    if (tok === "") continue
    const eq = tok.indexOf("=")
    if (eq <= 0) continue
    const key = tok.slice(0, eq)
    if (!IDENT_RE.test(key)) continue
    ctx[key] = tok.slice(eq + 1)
  }
  return ctx
}

/** Result of {@link expandSkillTemplateVars}. `ok:false` carries the expander's
 *  typed short-circuit so the tool can surface a PRECISE authoring error to the
 *  model (an unknown `{{ x }}` is NEVER guessed / silently dropped). */
export type SkillTemplateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ExpandError }

/**
 * Run the ADR-0252 `{{ name }}` expander over a skill `body` using a context
 * parsed from `args` (see {@link parseKeyValueArgs}). Pure: no IO, no throw.
 * This is the genuine consumer of `createDefaultTemplateExpander` — the render
 * path the ADR/ledger flagged as the follow-up wire. Runs ALONGSIDE (not in
 * place of) the `$ARGUMENTS`/`$N` positional pass: named `key=value` vars vs
 * positional slots are two different author surfaces (Windsurf vs CC slash).
 */
export const expandSkillTemplateVars = (body: string, args: string): SkillTemplateResult => {
  const result = createDefaultTemplateExpander().expand(body, parseKeyValueArgs(args))
  return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
}

/** Human-readable one-liner for a {@link ExpandError} — surfaced to the model
 *  so an author can fix the template/args without the tool guessing a value. */
const renderExpandError = (e: ExpandError): string => {
  switch (e.kind) {
    case "unknown-variable":
      return `unknown template variable {{ ${e.name} }} at char ${e.position} — pass \`${e.name}=<value>\` in args (no value was guessed)`
    case "max-iterations":
      return `template expansion hit the iteration bound (${e.iterations})`
    case "recursive":
      return `template variable {{ ${e.name} }} is recursive`
  }
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
      // ADR-0252 — Windsurf `{{ name }}` named-var substitution. Gated
      // (`QUANTA_SKILL_TEMPLATE_VARS`, default-OFF) AND only when the caller
      // passed args. OFF or no-args ⇒ this branch is skipped entirely, so a
      // literal `{{ x }}` in a body emits verbatim exactly as today
      // (byte-identical). Runs BEFORE the positional pass so `$N`-inserted text
      // is never re-scanned for `{{}}` and vice-versa. An unknown variable
      // SHORT-CIRCUITS to an `ok:false` result carrying the expander's typed
      // error — the tool never guesses a value.
      let templated = skill.body
      if (input.args !== undefined && runtimeConfig().skillTemplateVars) {
        const expanded = expandSkillTemplateVars(skill.body, input.args)
        if (!expanded.ok) {
          yield {
            type: "result",
            result: {
              ok: false,
              output: `Skill '${want}' template error: ${renderExpandError(expanded.error)}`,
            },
          }
          return
        }
        templated = expanded.text
      }
      // §22.2 — interpolate `$ARGUMENTS`/`$N` ONLY when the caller supplied
      // args. Absent ⇒ body verbatim (byte-identical to every pre-feature
      // invocation, incl. bodies containing a literal `$ARGUMENTS`).
      const body =
        input.args !== undefined ? interpolateSkillArgs(templated, input.args) : templated
      yield {
        type: "result",
        result: { ok: true, output: `${scopingNote(skill)}\n\n${body}` },
      }
    },
  }
}
