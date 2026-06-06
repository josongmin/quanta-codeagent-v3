import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { runShell } from "@/runtime"
import { FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { ToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  path: z.string().optional().describe("Base directory (default cwd)"),
})

type Input = z.infer<typeof schema>

const MAX = 300

// Single-quote for the rg argv — mirrors `src/tool/grep`'s `sq()` so a pattern
// containing shell metacharacters is passed VERBATIM to ripgrep and cannot
// break out of the argument into the surrounding `bash -lc` command. The
// absolute/`..` escape check still runs BEFORE this (an escaping pattern is
// rejected, never quoted-and-run).
const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** A surviving glob hit: the base-relative path emitted by rg plus its mtime. */
type Survivor = { rel: string; mtimeMs: number }

/**
 * Re-jail and stat each raw rg hit. Defense in depth: a `**` crossing a symlink
 * can still yield a path that resolves OUT of the jail — every hit is re-jailed
 * against `cwd` and DROPPED if it escapes, so the engine swap does not weaken
 * the jail invariant. The surviving relative path is kept for output; its jailed
 * absolute path is stat'd for the mtime sort. A hit that vanished between
 * enumeration and stat (TOCTOU) is dropped — it is no longer a valid hit. An
 * `FsJailError` escaper is dropped; any OTHER error propagates (no swallowing).
 */
const collectSurvivors = async (
  rawHits: string[],
  base: string,
  cwd: string,
): Promise<Survivor[]> => {
  const survivors: Survivor[] = []
  for (const rel of rawHits) {
    let abs: string
    try {
      abs = resolveJailed(join(base, rel), cwd)
    } catch (e) {
      if (e instanceof FsJailError) continue
      throw e
    }
    let mtimeMs: number
    try {
      mtimeMs = (await Bun.file(abs).stat()).mtimeMs
    } catch {
      continue
    }
    survivors.push({ rel, mtimeMs })
  }
  return survivors
}

export const globTool = defineTool<Input>({
  name: "glob",
  description:
    "List files matching a glob pattern, relative to the base directory. " +
    "Respects `.gitignore`/`.ignore` (node_modules, dist, etc. are excluded) " +
    "and returns the most-recently-modified files first. " +
    "If the result is empty, NARROW with a more specific pattern or BROADEN " +
    "(e.g. `src/agent/*.ts` ↔ `src/**/*.ts`) before switching to a different " +
    "tool or asking the user to narrow down (ADR-0062).",
  inputSchema: schema,
  isReadOnly: () => true,
  // Read-only directory scan; no side effects, safe to parallelize.
  isConcurrencySafe: () => true,

  // A bounded directory scan is fast; no progress event needed.
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // S14: jail the base dir BEFORE handing it to ripgrep — otherwise
    // `path: "/Users/other"` would enumerate every file the process can read.
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
    // S14 (pattern channel): the `path` base is jailed above, but an ABSOLUTE
    // pattern ("/etc/*") or a "../" pattern would enumerate OUTSIDE the jail
    // entirely. Reject an escaping pattern up front, BEFORE it reaches the rg
    // argv (loud, mirrors the `path` jail) — a model-supplied traversal pattern
    // is invalid input, not a thing to silently re-scope.
    if (isAbsolute(input.pattern) || input.pattern.split(/[/\\]/).includes("..")) {
      yield {
        type: "result",
        result: { ok: false, output: `glob pattern escapes the workspace: ${input.pattern}` },
      }
      return
    }

    // Enumerate via ripgrep so `.gitignore`/`.ignore` are honored NATIVELY
    // (node_modules/, dist/ junk is excluded) — consistent with `src/tool/grep`,
    // which already shells to rg. `--files` lists files; `-g <pattern>` filters
    // to the glob. `--hidden` is intentionally OMITTED so dotfiles stay excluded
    // (matches the prior `dot:false` semantics). The pattern is single-quoted
    // (`sq`) so it reaches rg verbatim and cannot break out of the argv. We do
    // NOT pass a path argument: running rg with `cwd: base` makes it search the
    // jailed base and emit paths RELATIVE to it (an absolute path argument would
    // make rg print absolute paths, defeating the relative-output contract).
    const cmd = ["rg", "--files", "--color=never", "--null", "-g", sq(input.pattern)].join(" ")
    const r = await runShell(cmd, { cwd: base, signal: ctx.signal })

    // rg exits 1 with no stdout when nothing matched. Exit >1 is a real failure
    // (bad pattern, rg missing, …) — fail closed with a clear message. The repo
    // already depends on rg (the grep tool shells to it); a missing binary is an
    // environment error, surfaced rather than silently degrading to a partial
    // scan.
    if (r.exitCode === 1 && !r.stdout) {
      yield { type: "result", result: { ok: true, output: "(no files matched)" } }
      return
    }
    if (r.exitCode > 1 || r.timedOut) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: r.stderr.trim() || `glob enumeration failed (rg exit ${r.exitCode})`,
        },
      }
      return
    }

    // `--null` separates paths with NUL so a path containing a newline cannot
    // forge an extra entry. rg prints paths relative to the jailed `base` (cwd).
    const rawHits = r.stdout.split("\0").filter((p) => p.length > 0)

    // Re-jail + stat each hit (defense in depth; see `collectSurvivors`).
    const survivors = await collectSurvivors(rawHits, base, ctx.cwd)

    if (survivors.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no files matched)" } }
      return
    }

    // Most-recently-modified first (mtime DESCENDING). Ties broken by path with
    // a BYTE/code-unit compare (NOT localeCompare — locale ordering is
    // machine/ICU-dependent and would make the output non-deterministic across
    // environments). The cap is applied AFTER the sort, so the newest files
    // survive truncation.
    survivors.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    const more = survivors.length > MAX ? `\n… (truncated at ${MAX})` : ""
    const output =
      survivors
        .slice(0, MAX)
        .map((h) => h.rel)
        .join("\n") + more
    yield { type: "result", result: { ok: true, output } }
  },
})
