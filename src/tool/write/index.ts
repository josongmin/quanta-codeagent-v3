import { homedir } from "node:os"
import { z } from "zod"
import { classifyPath } from "@/security"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import { globWriteGuardEvent, writeBudgetDeny } from "../_shared/exfil-rail-guards"
import { freshHashNote, refreshStaleReadBaseline } from "../_shared/fresh-hash"
import { defineTool } from "../factory"
import { captureFileHistory } from "../file-history/capture"
import { gitWriteGuardDeny } from "../git-write-guard-result"
import { guardWrite } from "../stale-read-guard"
import { captureToolDiff } from "../tool-diff-capture"
import type { EditToolContext, Tool, ToolEvent, ToolResult } from "../types"

/** ADR-0474 — stale-read-guard check for the write tool. Returns a failure
 *  `ToolResult` when the (existing) target was READ this session and externally
 *  modified since (mtime advanced), else `null`. No-op (null) when the guard is
 *  unwired (`ctx.readFileState` absent) or the file is new (no read baseline).
 *  Extracted to keep `execute` under the cognitive-complexity cap. */
const staleWriteGuard = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
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

/** ATOMIC-by-default commit (LANE 1) — route the write commit through the
 *  port's crash-safe `writeFileAtomic` (temp+rename, mode-preserving) whenever
 *  the port provides it, falling back to the plain truncating `fs.writeFile`
 *  ONLY when the port lacks the atomic method (in-memory test fakes ⇒
 *  byte-identical on-disk result). This makes the hottest mutation path
 *  crash-safe: a throw mid-commit can never leave a torn / zero-length file
 *  under the final name. The file CONTENT result is identical on every path;
 *  only the write MECHANISM changed and an existing file's mode is preserved.
 *
 *  jun-6 tool-interrupt-behavior — the commit runs inside the OPTIONAL critical
 *  section so an in-flight ESC cannot tear a half-written file. `begin?.()` is
 *  undefined when the seam is unwired (the three OFF gates) ⇒ no behaviour
 *  change. The withheld abort (if any) is re-delivered at `end()` so the next
 *  phase boundary still aborts the turn. Extracted to keep `execute` under the
 *  biome cognitive-complexity cap. */
const commitWrite = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
  path: string,
  content: string,
): Promise<void> => {
  const cs = ctx.criticalSection?.begin()
  try {
    if (fs.writeFileAtomic !== undefined) {
      await fs.writeFileAtomic(path, content, ctx.cwd)
      return
    }
    await fs.writeFile(path, content, ctx.cwd)
  } finally {
    cs?.end()
  }
}

/** Static pre-fs denies for `write` (BEFORE any fs call, never a partial write):
 *  ADR-0091 git-write-protection THEN jun-6 exfil-rail (b) glob-in-write. Both
 *  default-OFF (unwired guard / flag absent ⇒ `null` ⇒ byte-identical). Extracted
 *  so `execute` stays under the biome cognitive-complexity cap. */
const writeStaticDeny = (path: string, ctx: EditToolContext): ToolEvent | null =>
  gitWriteGuardDeny(path, ctx) ?? globWriteGuardEvent(path, ctx)

/** Pre-commit denies for `write` (AFTER existence check, BEFORE commit): ADR-0474
 *  stale-read-guard THEN jun-6 exfil-rail (a) per-turn write-budget. Both
 *  default-OFF (`null` ⇒ byte-identical). Extracted so `execute` stays under the
 *  biome cognitive-complexity cap. */
const writePreCommitDeny = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
  path: string,
  existed: boolean,
): Promise<ToolResult | null> =>
  (await staleWriteGuard(fs, ctx, path, existed)) ?? writeBudgetDeny(ctx)

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
    // aug-23 audit — Layer-1 SOURCE CLASS. Pinned by
    // `tests/unit/tool-source-class-coverage-hellgate.test.ts`: a tool whose
    // input carries a filesystem path must declare this, or Layer-1's
    // whole-output substitution is structurally unreachable for it and a
    // `.env` body reaches the model verbatim (Layer-2 is format-based and
    // `.env` values match no format). Same one-liner `read` has used since
    // ADR-0078.
    classifySource: (input) => classifyPath(input.path, homedir()),
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
    // jun-6 tool-interrupt-behavior — `write` is an ATOMIC-intent applier: an
    // ESC that lands inside the FS-write window can leave a half-written file.
    // Declare `"block"` so the dispatch abort-router withholds the turn abort
    // ONLY while the rename/flush window below is open (`ctx.criticalSection`).
    // Default-OFF / byte-identical: inert unless the host wired the seam AND the
    // `QUANTA_TOOL_INTERRUPT_BLOCK` knob is on (see ToolInterruptPolicy).
    interruptBehavior: (): "block" => "block",

    async *execute(input: Input, ctx: EditToolContext): AsyncIterable<ToolEvent> {
      // Static pre-fs denies (git-write-protection + jun-6 glob-in-write guard).
      const staticDeny = writeStaticDeny(input.path, ctx)
      if (staticDeny) {
        yield staticDeny
        return
      }
      // Resolve relative paths against the session cwd, not process.cwd().
      // The jail check fires inside fileExists()/writeFile() BEFORE any bytes
      // are written, so a denied path is NEVER a partial write.
      try {
        const existed = await fs.fileExists(input.path, ctx.cwd)
        // ADR-0474 stale-read-guard + jun-6 exfil-rail (a) per-turn write-budget,
        // both AFTER the existence check and BEFORE the commit (a deny is never a
        // partial write). Default-OFF ⇒ `null` ⇒ byte-identical.
        const preCommitDeny = await writePreCommitDeny(fs, ctx, input.path, existed)
        if (preCommitDeny) {
          yield { type: "result", result: preCommitDeny }
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
        // jun-6 tool-interrupt-behavior — commit inside the OPTIONAL critical
        // section so an in-flight ESC cannot tear a half-written file (no-op
        // when the seam is unwired; byte-identical legacy path).
        await commitWrite(fs, ctx, input.path, input.content)
        if (captureDiff) captureToolDiff(ctx, before, input.content, input.path)
        // file_history_rewind — record the NEW bytes as a per-file version so
        // the model can later restore THIS exact state. No-op when the sink is
        // unwired (gate OFF ⇒ ctx.fileHistory absent ⇒ byte-identical).
        captureFileHistory(ctx, input.path, input.content)
        // jul-13 edit-fresh-hash (shared with edit/scripted_replace): refresh the
        // stale-read guard baseline to the just-written mtime AND advertise the
        // post-write sha256 so the model can chain an edit to this file without a
        // re-read. Both gated by ctx.editFreshHash ⇒ byte-identical when off.
        await refreshStaleReadBaseline(fs, ctx, { path: input.path, base: ctx.cwd }, input.content)
        const bytes = Buffer.byteLength(input.content, "utf8")
        yield {
          type: "result",
          result: {
            ok: true,
            output: `${existed ? "Overwrote" : "Created"} ${input.path} (${bytes} bytes)${freshHashNote(ctx, input.content)}`,
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
