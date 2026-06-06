/**
 * `file_history_rewind` — per-file session-snapshot list/restore tool.
 *
 * Claude `tengu_file_history_rewind_*` parity: restore a SPECIFIC file to an
 * earlier version captured during THIS session (the per-path timeline kept by
 * {@link FileHistoryStore}), distinct from the workspace-wide shadow-ODB rewind
 * and from message-level rewind.
 *
 *   - `op:"list"`   → enumerate the recorded versions for `path` (read-only).
 *   - `op:"restore"`→ write a prior version's bytes back through the jailed FS
 *                     port (DESTRUCTIVE on that one file).
 *
 * Closed-port DI: the store + FS writer are injected. The path is JAILED via
 * the SAME `@/storage#resolveJailed` chokepoint `read`/`write` use, so a
 * `../escape` path is rejected BEFORE any store lookup or FS write — keys are
 * always the jailed absolute path, matching what the capture sink recorded.
 *
 * Output contract: every failure collapses to an `ok:false` ToolResult whose
 * `output` begins with a stable code (`not_found:`, `no_history:`,
 * `bad_path:`). Non-typed throws bubble (programmer-bug convention).
 *
 * Plane-clean: imports only `@/storage`, `./store`, `../factory`, `../types`,
 * `zod` — no `@/agent`, no `@/permission`.
 */

import { z } from "zod"
import { type FileSystemPort, FsJailError, resolveJailed } from "@/storage"
import { defineTool } from "../factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import type { FileHistoryStore } from "./store"

const schema = z.object({
  op: z
    .enum(["list", "restore"])
    .describe(
      "'list' enumerates recorded versions for path; 'restore' writes a prior version back.",
    ),
  path: z
    .string()
    .min(1)
    .describe("File path (absolute or relative to cwd) whose history to act on."),
  version: z
    .number()
    .int()
    .optional()
    .describe(
      "REQUIRED for op='restore': the version ordinal (from list) to restore. Ignored for 'list'.",
    ),
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 4_000

/** Render the `list` output — one line per version, newest LAST (oldest-first,
 *  matching `store.list`). Truncates the body at MAX_OUTPUT so a huge history
 *  can't blow the model context. */
const renderList = (
  path: string,
  versions: ReadonlyArray<{ version: number; recordedAt: number; byteLength: number }>,
): string => {
  if (versions.length === 0) return `no_history: ${path} has no recorded versions this session.`
  const lines = versions.map(
    (v) => `  v${v.version}  ${v.byteLength} bytes  recordedAt=${v.recordedAt}`,
  )
  const head = `${versions.length} version(s) for ${path} (oldest first):\n${lines.join("\n")}`
  if (head.length <= MAX_OUTPUT) return head
  return `${head.slice(0, MAX_OUTPUT)}… (truncated)`
}

/** Build the `file_history_rewind` tool against an injected store + FS port.
 *  `fs` defaults nowhere here — the host wires both so the tool is only
 *  registered when `QUANTA_FILE_HISTORY` is on (default-OFF; absent ⇒ the model
 *  never sees the tool, byte-identical). */
export const makeFileHistoryRewindTool = (
  store: FileHistoryStore,
  fs: FileSystemPort,
): Tool<Input> =>
  defineTool<Input>({
    name: "file_history_rewind",
    description:
      "List or restore PER-FILE session snapshots. The harness records a file's bytes on each " +
      "write/edit this session; 'list' shows the versions for a path, 'restore' writes a chosen " +
      "version back (DESTRUCTIVE on that one file — re-read after if unsure). This is per-FILE " +
      "undo, distinct from shadow_rewind (whole-workspace) and message rewind. Paths are jailed " +
      "to the workspace.",
    inputSchema: schema,
    // 'list' is read-only; 'restore' mutates. The tool as a whole can mutate,
    // so it is NOT read-only and never concurrency-batched.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // Destructive on the named file when restoring — ALWAYS confirm (same posture
    // as shadow_rewind / shadow_restore_partial: a silent overwrite of a file the
    // user just edited has real cost). 'list' also rides this tier; the HITL gate
    // is cheap for a read and the conservative default is correct for the tool's
    // worst-case op.
    hitlTier: () => "always-confirm",

    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        yield {
          type: "result",
          result: { ok: false, output: `invalid input: ${parsed.error.message}` },
        }
        return
      }
      if (ctx.signal.aborted) {
        yield { type: "result", result: { ok: false, output: "aborted before start" } }
        return
      }
      // JAIL the path through the SAME chokepoint read/write use — a `../escape`
      // (or absolute-outside-cwd) path is rejected BEFORE any store lookup or FS
      // write. The branded result is the absolute key the capture sink recorded
      // under (the sink resolves identically), so list/restore key-match regardless
      // of relative-vs-absolute spelling.
      let key: string
      try {
        key = resolveJailed(parsed.data.path, ctx.cwd)
      } catch (e) {
        if (e instanceof FsJailError) {
          yield {
            type: "result",
            result: {
              ok: false,
              output: `bad_path: ${e.message}`,
              failure: { mode: "permission_denied", path: parsed.data.path, isReadonly: false },
            },
          }
          return
        }
        throw e
      }

      if (parsed.data.op === "list") {
        yield {
          type: "result",
          result: { ok: true, output: renderList(parsed.data.path, store.list(key)) },
        }
        return
      }

      // op === "restore"
      const result = await restore(store, fs, ctx, key, parsed.data)
      yield { type: "result", result }
    },
  })

/** Restore a prior version's bytes back through the jailed FS port. Extracted
 *  to keep `execute` under the biome cognitive-complexity cap. */
const restore = async (
  store: FileHistoryStore,
  fs: FileSystemPort,
  ctx: ToolContext,
  key: string,
  input: Input,
): Promise<ToolResult> => {
  if (input.version === undefined) {
    return {
      ok: false,
      output: "bad_path: op='restore' requires a 'version' (see list).",
      failure: { mode: "rejected", reason: "missing version" },
    }
  }
  const versions = store.list(key)
  if (versions.length === 0) {
    return {
      ok: false,
      output: `no_history: ${input.path} has no recorded versions this session.`,
      failure: { mode: "not_found", path: input.path },
    }
  }
  const target = store.get(key, input.version)
  if (target === undefined) {
    const have = versions.map((v) => `v${v.version}`).join(", ")
    return {
      ok: false,
      output: `not_found: ${input.path} has no version v${input.version} (have: ${have}).`,
      failure: { mode: "not_found", path: input.path },
    }
  }
  try {
    // Write through the SAME FS port write/edit use — jailed again inside
    // writeFile (defense in depth; the key was already jailed). The key is the
    // absolute jailed path, so passing it with no baseDir is correct.
    await fs.writeFile(key, target.content, ctx.cwd)
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        ok: false,
        output: `bad_path: ${e.message}`,
        failure: { mode: "permission_denied", path: input.path, isReadonly: false },
      }
    }
    throw e
  }
  return {
    ok: true,
    output: `Restored ${input.path} to v${target.version} (${target.byteLength} bytes, recordedAt=${target.recordedAt}).`,
  }
}
