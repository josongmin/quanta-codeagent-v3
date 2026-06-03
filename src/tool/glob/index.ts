import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { ToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  path: z.string().optional().describe("Base directory (default cwd)"),
})

type Input = z.infer<typeof schema>

const MAX = 300

export const globTool = defineTool<Input>({
  name: "glob",
  description:
    "List files matching a glob pattern, relative to the base directory. " +
    "If the result is empty, NARROW with a more specific pattern or BROADEN " +
    "(e.g. `src/agent/*.ts` ↔ `src/**/*.ts`) before switching to a different " +
    "tool or asking the user to narrow down (ADR-0062).",
  inputSchema: schema,
  isReadOnly: () => true,
  // Read-only directory scan; no side effects, safe to parallelize.
  isConcurrencySafe: () => true,

  // A bounded directory scan is fast; no progress event needed.
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // S14: jail the base dir BEFORE handing to Bun.Glob.scan — otherwise
    // `path: "/Users/other"` would return every file the process can read.
    // Default is the jail root itself (cwd), which is trivially in-jail.
    let base: string
    try {
      base = input.path !== undefined ? resolveJailed(input.path, ctx.cwd) : ctx.cwd
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
    // S14 (pattern channel): the `path` base is jailed above, but Bun.Glob would
    // otherwise honor an ABSOLUTE pattern ("/etc/*") or a "../" pattern and scan
    // OUTSIDE the jail entirely. Reject an escaping pattern up front (loud, mirrors
    // the `path` jail) — a model-supplied traversal pattern is invalid input, not a
    // thing to silently re-scope.
    if (isAbsolute(input.pattern) || input.pattern.split(/[/\\]/).includes("..")) {
      yield {
        type: "result",
        result: { ok: false, output: `glob pattern escapes the workspace: ${input.pattern}` },
      }
      return
    }
    const glob = new Bun.Glob(input.pattern)
    const hits: string[] = []
    for await (const file of glob.scan({ cwd: base, onlyFiles: true, dot: false })) {
      // Defense in depth: a `**` cross or a symlink inside the tree could still
      // yield an out-of-jail path. Re-jail every emitted hit against ctx.cwd and
      // DROP any that escape (it is out of the tool's read scope by contract).
      try {
        resolveJailed(join(base, file), ctx.cwd)
      } catch (e) {
        if (e instanceof FsJailError) continue
        throw e
      }
      hits.push(file)
      if (hits.length >= MAX + 1) break
    }
    if (hits.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no files matched)" } }
      return
    }
    hits.sort()
    const more = hits.length > MAX ? `\n… (truncated at ${MAX})` : ""
    yield { type: "result", result: { ok: true, output: hits.slice(0, MAX).join("\n") + more } }
  },
})
