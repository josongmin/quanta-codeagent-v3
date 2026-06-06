/**
 * jun-6 (Codex skill-creator parity) — an AGENT-CALLABLE tool that SCAFFOLDS a
 * new skill, VALIDATES its frontmatter + size, and INSTALLS it through an
 * injected writer port.
 *
 * Gap closed: the skill ecosystem could DISCOVER + INVOKE skills (`discover.ts`,
 * `createSkillTool`) and READ bundled resources (`skill-resources.ts`), but had
 * no way for the model to AUTHOR one. Codex ships a `skill-creator` that writes
 * `<dir>/<name>/SKILL.md`; this is the v3 equivalent.
 *
 * Pipeline (all pure except the final write through the port):
 *   1. SCAFFOLD — render a canonical SKILL.md from the typed input
 *      ({@link renderSkillMarkdown}). Kebab-case frontmatter, `---` fences,
 *      author body.
 *   2. VALIDATE — run the rendered frontmatter back through the SAME
 *      `SkillFrontmatterSchema` discovery uses, so an invalid skill is rejected
 *      with the schema's own message (no second, drifting validator). Also
 *      enforce the byte-size cap ({@link MAX_SKILL_SIZE_BYTES}) BEFORE writing
 *      (a model could emit a megabyte body — reject, don't slurp).
 *   3. INSTALL — write `<name>/SKILL.md` via the injected {@link SkillWriterPort}.
 *      The port owns the FS jail + path safety; this slice never touches `fs`
 *      directly (closed-port DI, slice-isolated, unit-testable with a fake).
 *
 * SECURITY / SAFETY:
 *   - The skill `name` is re-validated against the kebab-case regex BEFORE it is
 *     used as a path segment, so a `../escape` or absolute path can never reach
 *     the writer (defence-in-depth atop whatever jail the port enforces).
 *   - The writer port is REQUIRED; absent ⇒ the tool is never registered
 *     (default-OFF at the composition root). No port can be reached without an
 *     operator opt-in knob (`QUANTA_SKILL_CREATOR`).
 *
 * Pure functions never throw; the tool surfaces every failure as a typed
 * `{ ok:false, output }` result (the discovery + size validators already use the
 * explicit-result idiom, so there is no try/catch noise on the happy path).
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import {
  SkillCategorySchema,
  SkillFrontmatterSchema,
  SkillStabilitySchema,
} from "./skill-frontmatter"
import { MAX_SKILL_SIZE_BYTES } from "./skill-size"

/** Re-validated kebab-case skill name (mirrors `SkillFrontmatterSchema.name`).
 *  Load-bearing for path safety: a name that fails this can never be used as a
 *  directory segment. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const schema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Kebab-case skill name (e.g. `pdf-extract`). Becomes <name>/SKILL.md."),
  description: z.string().min(1).describe("One-line description of what the skill does."),
  body: z
    .string()
    .min(1)
    .describe("The SKILL.md markdown body (the instructions the model follows)."),
  userInvocable: z
    .boolean()
    .optional()
    .describe("Whether a user can invoke this skill via a slash command. Default true."),
  allowedTools: z
    .array(z.string().min(1))
    .optional()
    .describe("Advisory tool allowlist for the skill. Default [] (none declared)."),
  category: SkillCategorySchema.optional().describe('"skill" (default) or "extension".'),
  stability: SkillStabilitySchema.optional().describe(
    '"experimental" (default), "stable", or "deprecated".',
  ),
})

type Input = z.infer<typeof schema>

/** A typed scaffold object ready for {@link renderSkillMarkdown}. Carries the
 *  body alongside the frontmatter fields. */
interface ScaffoldFields {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly userInvocable: boolean
  readonly allowedTools: readonly string[]
  readonly category: "skill" | "extension"
  readonly stability: "experimental" | "stable" | "deprecated"
}

/** Apply defaults to the optional input fields (Codex defaults: user-invocable,
 *  no tool allowlist, experimental skill). Pure. */
const withDefaults = (input: Input): ScaffoldFields => ({
  name: input.name,
  description: input.description,
  body: input.body,
  userInvocable: input.userInvocable ?? true,
  allowedTools: input.allowedTools ?? [],
  category: input.category ?? "skill",
  stability: input.stability ?? "experimental",
})

/** Quote a YAML scalar that needs it (contains `:` or leading/trailing space or
 *  a `#`). Conservative — when in doubt, double-quote. Pure. */
const yamlScalar = (s: string): string => {
  const needsQuote = /[:#]|^\s|\s$|^$/.test(s)
  if (!needsQuote) return s
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Render a canonical SKILL.md from typed fields. Frontmatter order is fixed +
 * deterministic so two identical inputs always produce byte-identical output
 * (replay-friendly). The body is appended verbatim after a blank line. Pure.
 */
export const renderSkillMarkdown = (fields: ScaffoldFields): string => {
  const toolsLine =
    fields.allowedTools.length === 0
      ? "allowedTools: []"
      : `allowedTools:\n${fields.allowedTools.map((t) => `  - ${yamlScalar(t)}`).join("\n")}`
  const fm = [
    "---",
    `name: ${yamlScalar(fields.name)}`,
    `description: ${yamlScalar(fields.description)}`,
    `userInvocable: ${fields.userInvocable}`,
    toolsLine,
    `category: ${fields.category}`,
    `stability: ${fields.stability}`,
    "---",
  ].join("\n")
  // Trim a leading newline off the body so the blank line between fence + body
  // is exactly one (deterministic).
  return `${fm}\n\n${fields.body.replace(/^\n+/, "")}\n`
}

/** Validate the SCAFFOLDED fields against the SAME schema discovery uses, so an
 *  invalid skill is rejected with the schema's own message. Returns the first
 *  error string, or `null` when valid. Pure. */
export const validateScaffold = (fields: ScaffoldFields): string | null => {
  const parsed = SkillFrontmatterSchema.safeParse({
    name: fields.name,
    description: fields.description,
    userInvocable: fields.userInvocable,
    allowedTools: [...fields.allowedTools],
    category: fields.category,
    stability: fields.stability,
  })
  if (parsed.success) return null
  const first = parsed.error.issues[0]
  return first
    ? `${first.path.join(".") || "frontmatter"}: ${first.message}`
    : "invalid frontmatter"
}

/** Outcome of a write attempt. The port reports success/failure explicitly so
 *  the tool never has to catch. */
export type SkillWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Closed port: persist `<name>/SKILL.md`. The composition root injects an
 * implementation that owns the FS jail (writes under the user/repo skills
 * directory) and path safety. `relPath` is always `<name>/SKILL.md` with a
 * pre-validated kebab-case `<name>`. The port MUST NOT throw — it returns a
 * typed result so the tool can surface a clean failure.
 */
export interface SkillWriterPort {
  write(relPath: string, content: string): Promise<SkillWriteResult>
}

/**
 * Build the `skill_create` tool. The writer port is REQUIRED — the composition
 * root only constructs (and registers) this when the operator opts in
 * (`QUANTA_SKILL_CREATOR`), so absent ⇒ the tool is never on the menu
 * (default-OFF, byte-identical default surface).
 */
export const createSkillCreatorTool = (writer: SkillWriterPort): Tool<Input> => {
  return {
    name: "skill_create",
    description:
      "Author a new skill: scaffold its SKILL.md from the given frontmatter + " +
      "body, validate it against the skill schema and size cap, and install it " +
      "under the skills directory. The skill becomes discoverable next session.",
    inputSchema: schema,
    // Writes a file ⇒ NOT read-only, and order-sensitive (two creates of the
    // same name race), so NOT concurrency-safe.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,

    async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const fields = withDefaults(input)

      // 0. PATH SAFETY — re-validate the name before it is ever a path segment.
      if (!NAME_RE.test(fields.name)) {
        yield {
          type: "result",
          result: { ok: false, output: `Invalid skill name "${fields.name}": must be kebab-case.` },
        }
        return
      }

      // 1. SCAFFOLD.
      const markdown = renderSkillMarkdown(fields)

      // 2a. VALIDATE frontmatter against the discovery schema.
      const invalid = validateScaffold(fields)
      if (invalid !== null) {
        yield {
          type: "result",
          result: { ok: false, output: `Skill validation failed — ${invalid}` },
        }
        return
      }

      // 2b. SIZE cap — reject BEFORE writing (a megabyte body must not be slurped
      // onto disk; `MAX_SKILL_SIZE_BYTES` is the same cap discovery enforces).
      const bytes = Buffer.byteLength(markdown, "utf8")
      if (bytes > MAX_SKILL_SIZE_BYTES) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `Skill too large: ${bytes} bytes exceeds the ${MAX_SKILL_SIZE_BYTES}-byte cap.`,
          },
        }
        return
      }

      // 3. INSTALL through the injected port. The port is contractually no-throw
      // (returns a typed result), but a buggy / hostile adapter (an EACCES that
      // escapes, a programmer bug) must NEVER reject this iterator — the Tool
      // contract requires exactly ONE terminal result. Wrap defensively and map a
      // thrown port to a typed `error` result (mirrors permission_propose_pattern).
      const relPath = `${fields.name}/SKILL.md`
      let written: SkillWriteResult
      try {
        written = await writer.write(relPath, markdown)
      } catch (e) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: "Skill install failed: writer port threw unexpectedly.",
            failure: {
              mode: "error",
              modelVisibleError: "skill_create failed: the writer port threw.",
              clientVisibleError: e instanceof Error ? e.message : String(e),
            },
          },
        }
        return
      }
      if (!written.ok) {
        yield {
          type: "result",
          result: { ok: false, output: `Skill install failed: ${written.reason}` },
        }
        return
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `Created skill "${fields.name}" at ${written.path} (${bytes} bytes). It is discoverable next session.`,
        },
      }
    },
  }
}
