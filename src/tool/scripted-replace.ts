import { z } from "zod"
import { FsJailError, fileExists, readFile, writeFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "./types"

/**
 * Phase 4 SOTA++ absorption — `scripted_replace` (Codex
 * `tool-routing-and-triggering.md`: "patch is for local + stable context;
 * scripted replace is for duplicated blocks, bulk substitution, or patch
 * context mismatch"). Sibling of `edit` — same FS-jail discipline + atomic
 * write — but optimized for the duplicated/bulk case where `edit` would either
 * refuse as ambiguous or be too noisy to use one-occurrence-at-a-time.
 *
 * Default-OFF posture: the tool is registered, but the LLM only routes to it
 * when the prompt / strategy-hint surface explicitly calls for it. No behavior
 * change for sessions that never invoke it.
 */
const schema = z.object({
  file: z.string().describe("File path (absolute or relative to cwd)"),
  pattern: z.string().describe("Literal substring by default; a JS regex source when isRegex=true"),
  replacement: z
    .string()
    .describe("Replacement string. In regex mode, `$1`/`$&` capture refs are honoured."),
  count: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on number of replacements. Omit ⇒ replace ALL matches."),
  isRegex: z
    .boolean()
    .optional()
    .describe("Interpret `pattern` as a JS regex source (compiled with the `g` flag)."),
})

type Input = z.infer<typeof schema>

/** Escape every regex metacharacter so a literal substring is safe to drop
 *  into a `RegExp` constructor. */
const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

interface ApplyOutcome {
  ok: boolean
  message: string
  next?: string
  replacements?: number
}

/** Pure replacement core. Returns the new source plus the count actually
 *  applied, or an `ok:false` outcome with a clear message. Extracted from the
 *  tool body so tests / callers can exercise it without filesystem I/O. */
export const applyScriptedReplace = (
  source: string,
  input: Pick<Input, "pattern" | "replacement" | "count" | "isRegex">,
): ApplyOutcome => {
  if (input.pattern === "") {
    return { ok: false, message: "pattern must not be empty" }
  }
  let regex: RegExp
  try {
    const body = input.isRegex === true ? input.pattern : escapeForRegex(input.pattern)
    regex = new RegExp(body, "g")
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `invalid regex: ${reason}` }
  }
  const cap = input.count ?? Number.POSITIVE_INFINITY
  let applied = 0
  // String.prototype.replace with a function callback gives us a per-match
  // hook that can both COUNT and ENFORCE the cap; passing the raw replacement
  // string would honour `$1` automatically but couldn't be capped.
  const next = source.replace(regex, (...args) => {
    if (applied >= cap) return args[0] as string
    applied += 1
    // Expand `$&` / `$1`..`$9` against the actual match. `replace`'s function
    // form does NOT auto-expand, so we do it explicitly to keep parity with
    // the documented behaviour.
    return expandReplacement(input.replacement, args)
  })
  if (applied === 0) {
    return { ok: false, message: `pattern not found in file` }
  }
  return { ok: true, message: `Replaced ${applied} occurrence(s)`, next, replacements: applied }
}

/** Expand `$&` (whole match) and `$1`..`$9` (capture groups) against the
 *  `replace` callback's argument tuple. `$$` escapes a literal `$`. */
const expandReplacement = (template: string, args: unknown[]): string => {
  // Args layout: [match, p1, p2, ..., offset, string, groups?]
  const match = String(args[0])
  // Find where the offset/string slots start: scan from the end for the first
  // number — that is the offset. Capture groups precede it.
  let offsetIdx = args.length - 1
  while (offsetIdx >= 0 && typeof args[offsetIdx] !== "number") offsetIdx -= 1
  const groups: string[] = []
  for (let i = 1; i < offsetIdx; i++) {
    const g = args[i]
    groups.push(g === undefined ? "" : String(g))
  }
  let out = ""
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch !== "$" || i === template.length - 1) {
      out += ch
      continue
    }
    const nxt = template[i + 1]
    if (nxt === "$") {
      out += "$"
      i += 1
    } else if (nxt === "&") {
      out += match
      i += 1
    } else if (nxt !== undefined && nxt >= "1" && nxt <= "9") {
      const idx = Number(nxt) - 1
      out += groups[idx] ?? ""
      i += 1
    } else {
      out += ch
    }
  }
  return out
}

export const scriptedReplaceTool: Tool<Input> = {
  name: "scripted_replace",
  description:
    "Bulk substring/regex substitution across a file. Use when `edit` reports duplicated matches or context mismatch.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates the filesystem; never run concurrently.
  isConcurrencySafe: () => false,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    try {
      // Pre-check existence so the error message is descriptive rather than
      // surfacing the raw `File not found` from readFile.
      if (!(await fileExists(input.file, ctx.cwd))) {
        yield { type: "result", result: { ok: false, output: `File not found: ${input.file}` } }
        return
      }
      const source = await readFile(input.file, ctx.cwd)
      const r = applyScriptedReplace(source, input)
      if (!r.ok || r.next === undefined) {
        yield { type: "result", result: { ok: false, output: r.message } }
        return
      }
      await writeFile(input.file, r.next, ctx.cwd)
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${input.file}: ${r.message} (replacements=${r.replacements})`,
        },
      }
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
  },
}
