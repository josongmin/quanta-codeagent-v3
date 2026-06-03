import { homedir } from "node:os"
import { z } from "zod"
import { classifyPath } from "@/security"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import { defineTool } from "../factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

/** Recognise the two file-missing shapes the injected {@link FileSystemPort}
 *  raises: (a) the OS `ENOENT` (errno -2) from `stat()` via `@/storage`'s
 *  Node-backed path, and (b) the explicit `File not found:` Error the same
 *  service.ts throws from its `Bun.file.exists()` branch in `readFile`. An
 *  in-memory port may use either shape; both converge here so `read` can
 *  surface a typed `not_found` instead of letting the throw escape the loop. */
const isFileNotFoundError = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const obj = e as { code?: unknown; message?: unknown }
  if (obj.code === "ENOENT") return true
  if (typeof obj.message === "string" && /file not found/i.test(obj.message)) return true
  return false
}

/** Classify an error raised by the {@link FileSystemPort} into a typed
 *  `ToolResult` (`permission_denied` for FsJail escapes, `not_found` for
 *  ENOENT-ish shapes). Returns `null` when the error is none of the above —
 *  the caller re-throws (the loop normalizes anything past this surface into a
 *  generic `error` failure via `dispatchTool`'s catch). Extracted out of
 *  `execute` so the generator stays under the lint complexity gate. */
const classifyFsError = (e: unknown, path: string): ToolResult | null => {
  if (e instanceof FsJailError) {
    return {
      ok: false,
      output: e.message,
      failure: { mode: "permission_denied", path, isReadonly: false },
    }
  }
  if (isFileNotFoundError(e)) {
    return {
      ok: false,
      output: `File not found: ${path}`,
      failure: { mode: "not_found", path },
    }
  }
  return null
}

/** Render the line-numbered slice for an `ok:true` read. Extracted so
 *  `execute` stays under the lint complexity gate (the typed-failure catches
 *  raised the in-line branch count beyond 15). Pure: no I/O, no schema. */
const renderReadOk = (text: string, offset: number | undefined, limit: number): string => {
  const lines = text.split("\n")
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = Math.min(lines.length, start + limit)
  const numbered = lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join("\n")
  const note = end < lines.length ? `\n… (${lines.length - end} more lines, use offset)` : ""
  return numbered === "" ? "(empty file)" : numbered + note
}

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  // `offset` is a 1-based line index: it must be a non-negative integer.
  // `limit` is a line COUNT: it must be a positive integer. A `limit:0` or a
  // negative value previously produced an empty slice that surfaced the
  // "(empty file)" sentinel on a NON-empty file (misleading). Reject such
  // values at the schema boundary with a clear validation error instead.
  offset: z.number().int().min(0).optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to read (default 2000)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_LIMIT = 2000

/** Build the `read` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link readTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeReadTool = (fs: FileSystemPort = defaultFileSystemPort): Tool<Input> =>
  defineTool<Input>({
    name: "read",
    description:
      "Read a text file. Returns content with 1-based line numbers (`<n>\\t<line>`). " +
      "Use offset/limit for large files.",
    inputSchema: schema,
    isReadOnly: () => true,
    // Pure read of a single file: no side effects, safe to run concurrently.
    isConcurrencySafe: () => true,
    // PR-2 self-audit fix (ADR-0078): DECLARED source-class classifier. Pre-fix
    // this lived as a hard-coded `PATH_TOOL_NAMES` set in `dispatch.ts`; now the
    // tool that touches the filesystem path declares its own classification —
    // a future `view_file`/`open_file`/MCP-`fs.read` tool opts into Layer-1
    // redaction by implementing this same method.
    classifySource: (input) => classifyPath(input.path, homedir()),

    // A single file read is fast; no progress event needed.
    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      // Resolve relative paths against the session cwd, not process.cwd().
      // read is read-only but STILL jailed: an unguarded absolute
      // `/etc/passwd` or `../../.ssh/id_rsa` is denied by default. Catch the
      // jail escape and surface ok:false — never an uncaught throw.
      //
      // ENOENT classification: a missing file is a TYPED `not_found` failure
      // (closes the absorb-#2 gap for read: pre-fix `statFile()` raised the
      // raw OS error and `read` re-threw past the loop). Surfaced via
      // `errno: -2` (POSIX) and the Bun.file-backed `File not found:` text
      // path the inner port uses — both branches converge on `not_found`.
      let info: Awaited<ReturnType<typeof fs.statFile>>
      try {
        info = await fs.statFile(input.path, ctx.cwd)
      } catch (e) {
        const classified = classifyFsError(e, input.path)
        if (classified === null) throw e
        yield { type: "result", result: classified }
        return
      }
      if (info.isDirectory) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `${input.path} is a directory`,
            failure: { mode: "not_found", path: input.path },
          },
        }
        return
      }

      // Belt-and-braces: an in-flight unlink between `statFile()` and
      // `readFile()` would surface ENOENT here too; FsJail is re-checked
      // inside readFile() and stays a permission_denied. Same classifier so
      // the typed-failure mapping holds on TOCTOU.
      let text: string
      try {
        text = await fs.readFile(input.path, ctx.cwd)
      } catch (e) {
        const classified = classifyFsError(e, input.path)
        if (classified === null) throw e
        yield { type: "result", result: classified }
        return
      }
      // ADR-0474 — record the read-time mtime (keyed by the RESOLVED absolute
      // path so a later write/edit, which stats the same abs path, matches).
      // No-op when the guard is off (ctx.readFileState absent).
      ctx.readFileState?.record(info.path, info.mtimeMs)
      yield {
        type: "result",
        result: {
          ok: true,
          output: renderReadOk(text, input.offset, input.limit ?? DEFAULT_LIMIT),
        },
      }
    },
  })

/** Default-port `read` tool used by the registry. */
export const readTool: Tool<Input> = makeReadTool()
