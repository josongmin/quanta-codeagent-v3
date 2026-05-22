import { homedir } from "node:os"
import { z } from "zod"
import { classifyPath } from "@/security"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  offset: z.number().optional().describe("1-based line to start from"),
  limit: z.number().optional().describe("Max lines to read (default 2000)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_LIMIT = 2000

/** Build the `read` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link readTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeReadTool = (fs: FileSystemPort = defaultFileSystemPort): Tool<Input> => ({
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
    let info: Awaited<ReturnType<typeof fs.statFile>>
    try {
      info = await fs.statFile(input.path, ctx.cwd)
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
    if (info.isDirectory) {
      yield { type: "result", result: { ok: false, output: `${input.path} is a directory` } }
      return
    }

    const text = await fs.readFile(input.path, ctx.cwd)
    const lines = text.split("\n")
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT))
    const numbered = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n")

    const note = end < lines.length ? `\n… (${lines.length - end} more lines, use offset)` : ""
    yield {
      type: "result",
      result: { ok: true, output: numbered === "" ? "(empty file)" : numbered + note },
    }
  },
})

/** Default-port `read` tool used by the registry. */
export const readTool: Tool<Input> = makeReadTool()
