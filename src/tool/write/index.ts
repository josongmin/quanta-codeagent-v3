import { z } from "zod"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import { defineTool } from "../factory"
import { gitWriteGuardDeny } from "../git-write-guard-result"
import { guardWrite } from "../stale-read-guard"
import { captureToolDiff } from "../tool-diff-capture"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

/** ADR-0474 — stale-read-guard check for the write tool. Returns a failure
 *  `ToolResult` when the (existing) target was READ this session and externally
 *  modified since (mtime advanced), else `null`. No-op (null) when the guard is
 *  unwired (`ctx.readFileState` absent) or the file is new (no read baseline).
 *  Extracted to keep `execute` under the cognitive-complexity cap. */
const staleWriteGuard = async (
  fs: FileSystemPort,
  ctx: ToolContext,
  path: string,
  existed: boolean,
): Promise<ToolResult | null> => {
  if (ctx.readFileState === undefined || !existed) return null
  const cur = await fs.statFile(path, ctx.cwd)
  const guard = guardWrite(ctx.readFileState, cur.path, cur.mtimeMs)
  if (guard.ok) return null
  return {
    ok: false,
    output: guard.error.message,
    failure: { mode: "rejected", reason: "stale_read" },
  }
}

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  content: z.string().describe("Full file content to write"),
})

type Input = z.infer<typeof schema>

/** Build the `write` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link writeTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeWriteTool = (fs: FileSystemPort = defaultFileSystemPort): Tool<Input> =>
  defineTool<Input>({
    name: "write",
    // ADR-0410 — when-not-to-use clause. Mirrors Codex `apply_patch` and
    // Claude Code 2.1.138 `tools/Write.ts` patterns: name `edit` as the
    // partial-mutation alternative, and flag repeated writes to the same
    // file as an anti-pattern (the empirical regression signal).
    description:
      "Write a file, creating or fully overwriting it. Creates parent dirs. " +
      "Do NOT use write for partial mutation of an existing file — use `edit` " +
      "instead. Multiple consecutive writes to the same file is almost always " +
      "a wrong pattern (you are overwriting your own previous write); read the " +
      "current bytes and use `edit` instead.",
    inputSchema: schema,
    isReadOnly: () => false,
    // Mutates the filesystem; conservatively never run concurrently.
    isConcurrencySafe: () => false,
    // HITL secure-by-default (ADR-0020 follow-up): writing a workspace file is
    // a contained, reversible-in-VCS mutation — pre-approval covers it. Must
    // be explicit; the `inferToolTier` fallback for a mutating tool is
    // `always-confirm`, so omitting this opt-in would suddenly demand
    // per-write confirmation even in `bypass` mode.
    hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      // ADR-0091 git-write-protection: a write to `.git/{hooks,config,config.
      // worktree,info/attributes}` or `.vscode/**` is a code-execution / policy
      // -escape vector (git/editor auto-runs them). Static-deny BEFORE any fs
      // call, mirroring the FsJailError hard-stop posture below — never a
      // partial write. Default-OFF: when `ctx.gitWriteGuard` is unwired the
      // helper returns null and the path is byte-identical.
      const guardDeny = gitWriteGuardDeny(input.path, ctx)
      if (guardDeny) {
        yield guardDeny
        return
      }
      // Resolve relative paths against the session cwd, not process.cwd().
      // The jail check fires inside fileExists()/writeFile() BEFORE any bytes
      // are written, so a denied path is NEVER a partial write.
      try {
        const existed = await fs.fileExists(input.path, ctx.cwd)
        // ADR-0474 — block overwriting a file read earlier this session that was
        // externally modified since ("re-read first"). No-op when guard unwired.
        const stale = await staleWriteGuard(fs, ctx, input.path, existed)
        if (stale) {
          yield { type: "result", result: stale }
          return
        }
        // ADR-0440 — capture the pre-write bytes ONLY when the tool-diff sink is
        // wired AND this call is correlated (gate ON). Gate OFF ⇒ both undefined
        // ⇒ NO extra read, byte-identical legacy path. A new file's "before" is
        // the empty string. The read failing must never block the write, so it is
        // best-effort (a fresh/locked file just yields an empty before).
        const captureDiff = ctx.toolDiff !== undefined && ctx.toolCallId !== undefined
        let before = ""
        if (captureDiff && existed) {
          try {
            before = await fs.readFile(input.path, ctx.cwd)
          } catch {
            before = ""
          }
        }
        await fs.writeFile(input.path, input.content, ctx.cwd)
        if (captureDiff) captureToolDiff(ctx, before, input.content, input.path)
        const bytes = Buffer.byteLength(input.content, "utf8")
        yield {
          type: "result",
          result: {
            ok: true,
            output: `${existed ? "Overwrote" : "Created"} ${input.path} (${bytes} bytes)`,
          },
        }
      } catch (e) {
        if (e instanceof FsJailError) {
          yield {
            type: "result",
            result: {
              ok: false,
              output: e.message,
              failure: { mode: "permission_denied", path: input.path, isReadonly: false },
            },
          }
          return
        }
        throw e
      }
    },
  })

/** Default-port `write` tool used by the registry. */
export const writeTool: Tool<Input> = makeWriteTool()
