import { homedir } from "node:os"
import { z } from "zod"
import { classifyPath } from "@/security"
import { runtimeConfig } from "@/shared"
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

/** B5 device guard — classify a FIFO / char-device / block-device target into a
 *  typed `rejected` ToolResult, or `null` for an ordinary regular file. Reading
 *  any of these BLOCKS the loop forever (FIFO with no writer / `/dev/random`) or
 *  dumps unbounded bytes — so `read` refuses BEFORE opening. Mirror of Claude
 *  Code's "device file would block or produce infinite output" rejection. */
const classifyDeviceFile = (
  info: { isFIFO: boolean; isCharacterDevice: boolean; isBlockDevice: boolean },
  path: string,
): ToolResult | null => {
  if (!(info.isFIFO || info.isCharacterDevice || info.isBlockDevice)) return null
  return {
    ok: false,
    output: `Cannot read ${path}: a device file would block or produce infinite output.`,
    failure: { mode: "rejected", reason: "device_file" },
  }
}

/** B5 binary sniff window. 8 KiB is the de-facto text/binary probe size git
 *  (`buffer_is_binary` scans the first ~8000 bytes) and most editors use: large
 *  enough that a NUL in the leading content of a binary (PNG/ZIP/ELF headers all
 *  carry a NUL in their first bytes) is seen, small enough that classifying a
 *  multi-gigabyte file never reads more than this prefix. Not a heuristic
 *  THRESHOLD — the binary signal is the PRESENCE of any NUL in this window. */
const BINARY_SNIFF_BYTES = 8192

/** B5 binary guard — sniff a bounded leading byte window for a NUL (`0x00`).
 *  A NUL never appears in normal UTF-8 / Latin-1 / UTF-16-LE-without-BOM text,
 *  so its presence is the standard binary discriminator. Returns a typed
 *  `rejected` ToolResult when the file is binary, else `null`. Skips the check
 *  entirely when the port does not expose `readFileBytes` (legacy in-memory
 *  fakes) — those callers keep the exact pre-guard text-read behavior. */
const classifyBinaryFile = async (
  fs: FileSystemPort,
  path: string,
  cwd: string,
): Promise<ToolResult | null> => {
  if (fs.readFileBytes === undefined) return null
  const head = await fs.readFileBytes(path, BINARY_SNIFF_BYTES, cwd)
  if (!head.includes(0x00)) return null
  return {
    ok: false,
    output:
      `Cannot read ${path}: this tool cannot read binary files. ` +
      "Use a dedicated tool (e.g. read_image) for non-text content.",
    failure: { mode: "rejected", reason: "binary_file" },
  }
}

/** B5 unreadable-target guard — the device check (pure, on the already-fetched
 *  stat) followed by the binary NUL sniff (a bounded byte read). Returns a typed
 *  `rejected` ToolResult for the FIRST tripped guard, or `null` for an ordinary
 *  text file. ORDER MATTERS: the device check runs BEFORE the byte read so we
 *  NEVER attempt the hanging `read()` on a FIFO to sniff it. Extracted out of
 *  `execute` so the generator stays under the lint complexity gate — the byte
 *  read may throw (TOCTOU unlink / jail escape), so `execute` wraps the call in
 *  the same `classifyFsError` catch it already uses for `readFile`. */
const classifyUnreadableTarget = async (
  fs: FileSystemPort,
  info: { isFIFO: boolean; isCharacterDevice: boolean; isBlockDevice: boolean },
  path: string,
  cwd: string,
): Promise<ToolResult | null> => {
  const device = classifyDeviceFile(info, path)
  if (device !== null) return device
  return classifyBinaryFile(fs, path, cwd)
}

/** Stat info shape used by the read pipeline (mirror of `@/storage`'s
 *  `FileInfo` as produced by the injected port). */
type StatInfo = Awaited<ReturnType<FileSystemPort["statFile"]>>

/** Discriminated outcome of the read pipeline: either a terminal `failure`
 *  ToolResult (already typed) OR the successfully resolved text plus the stat
 *  info `execute` needs for the stale-read mtime record. */
type ReadOutcome =
  | { kind: "failure"; result: ToolResult }
  | { kind: "ok"; text: string; info: StatInfo }

/** Run a fallible port call, mapping a recognized FS error (jail escape /
 *  ENOENT-ish) to a typed `failure` outcome and RE-THROWING anything else so
 *  the loop's generic-`error` normalization still applies. Centralizes the
 *  `classifyFsError`-or-throw pattern the three pipeline steps share. */
const runFsStep = async <T>(
  op: () => Promise<T>,
  path: string,
): Promise<{ kind: "value"; value: T } | { kind: "failure"; result: ToolResult }> => {
  try {
    return { kind: "value", value: await op() }
  } catch (e) {
    const classified = classifyFsError(e, path)
    if (classified === null) throw e
    return { kind: "failure", result: classified }
  }
}

/** The full read pipeline: stat → directory check → device+binary guard →
 *  text read. Returns a single {@link ReadOutcome}; the generator `execute`
 *  just relays it. Lives outside the generator so `execute` stays under the
 *  lint complexity gate. NEVER throws a recognized FS error (those become
 *  typed failures via {@link runFsStep}); a genuinely unknown error still
 *  propagates to the loop's catch (generic `error`). */
const resolveReadOutcome = async (
  fs: FileSystemPort,
  input: Input,
  ctx: ToolContext,
): Promise<ReadOutcome> => {
  // ENOENT classification: a missing file / jail escape becomes a TYPED failure
  // (closes the absorb-#2 gap for read). `statFile` runs first.
  const stat = await runFsStep(() => fs.statFile(input.path, ctx.cwd), input.path)
  if (stat.kind === "failure") return stat
  const info = stat.value
  if (info.isDirectory) {
    return {
      kind: "failure",
      result: {
        ok: false,
        output: `${input.path} is a directory`,
        failure: { mode: "not_found", path: input.path },
      },
    }
  }

  // B5 device + binary guard — reject a FIFO / device file (would BLOCK the
  // loop forever or dump unbounded bytes) and binary content (would token-
  // explode the transcript) BEFORE the text read. The bounded byte sniff may
  // throw on a TOCTOU unlink / jail escape — classified the same way.
  const guard = await runFsStep(
    () => classifyUnreadableTarget(fs, info, input.path, ctx.cwd),
    input.path,
  )
  if (guard.kind === "failure") return guard
  if (guard.value !== null) return { kind: "failure", result: guard.value }

  // Belt-and-braces: an in-flight unlink between `statFile()` and `readFile()`
  // surfaces ENOENT here too; FsJail is re-checked inside readFile() and stays
  // a permission_denied. Same classifier so the typed mapping holds on TOCTOU.
  const read = await runFsStep(() => fs.readFile(input.path, ctx.cwd), input.path)
  if (read.kind === "failure") return read
  return { kind: "ok", text: read.value, info }
}

/** H9 — the compact `file_unchanged` sentinel rendered in place of full content
 *  when an identical-range re-read finds an unchanged mtime. It is UNAMBIGUOUS
 *  (names the path + the exact range + the reason) and ACTIONABLE: the model is
 *  told the content is byte-identical to its prior read and should re-use that,
 *  so it never needs the bytes re-sent. Deterministic (pure function of its
 *  inputs — no clock, no randomness). */
const renderFileUnchanged = (path: string, offset: number, limit: number): string =>
  `file_unchanged: ${path} (offset ${offset}, limit ${limit}) — ` +
  "content identical to your prior read of this exact range; re-using it."

/** H9 — try the read-side dedup short-circuit. Returns the `file_unchanged`
 *  ToolResult when (and ONLY when) the H9 knob is ON, the dedup state is wired,
 *  and the EXACT (path, offset, limit) range was already read this run with a
 *  mtime that still === the current on-disk mtime. Returns `null` (⇒ caller
 *  renders + records full content) on ANY difference: knob off, no state, never
 *  read, different range, or an advanced/regressed mtime. NO-THROW, pure aside
 *  from the injected state read. Keeps `execute` under the lint complexity gate. */
const tryReadDedup = (
  ctx: ToolContext,
  path: string,
  offset: number,
  limit: number,
  currentMtimeMs: number,
): ToolResult | null => {
  if (!runtimeConfig().readDedup) return null
  const state = ctx.readFileState
  if (state === undefined) return null
  const recorded = state.recordedRangeMtime(path, offset, limit)
  // Strict equality is the closed dedup signal: a mtime that ADVANCED (external
  // write) OR regressed (restore/skew) is NOT identical, so we fall through to a
  // full content re-read AND re-record below — never a stale short-circuit.
  if (recorded === undefined || recorded !== currentMtimeMs) return null
  return { ok: true, output: renderFileUnchanged(path, offset, limit) }
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

    // A single file read is fast; no progress event needed. The whole
    // stat → guards → read pipeline lives in {@link resolveReadOutcome}; the
    // generator just relays its single terminal result (keeps `execute` under
    // the lint complexity gate — the typed-failure catches would otherwise
    // push the branch count well past 15).
    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const outcome = await resolveReadOutcome(fs, input, ctx)
      if (outcome.kind === "failure") {
        yield { type: "result", result: outcome.result }
        return
      }
      // ADR-0474 — record the read-time mtime (keyed by the RESOLVED absolute
      // path so a later write/edit, which stats the same abs path, matches).
      // No-op when the guard is off (ctx.readFileState absent). UNCHANGED by H9.
      ctx.readFileState?.record(outcome.info.path, outcome.info.mtimeMs)

      // H9 read-side dedup — the EFFECTIVE range is the resolved (offset, limit)
      // pair `renderReadOk` actually slices on, so an implicit `limit` dedups
      // against an explicit one that resolves to the same window. Keyed by the
      // RESOLVED absolute path (`outcome.info.path`) — the SAME identity the
      // mtime record uses — so the dedup map and the freshness map agree on
      // which file a re-read refers to.
      const effOffset = input.offset ?? 1
      const effLimit = input.limit ?? DEFAULT_LIMIT
      const deduped = tryReadDedup(
        ctx,
        outcome.info.path,
        effOffset,
        effLimit,
        outcome.info.mtimeMs,
      )
      if (deduped !== null) {
        yield { type: "result", result: deduped }
        return
      }
      // Full content path — (re)record this range's mtime so the NEXT identical
      // re-read with an unchanged mtime short-circuits. No-op (no allocation)
      // when the H9 knob is off OR the dedup state is absent.
      if (runtimeConfig().readDedup) {
        ctx.readFileState?.recordReadRange(
          outcome.info.path,
          effOffset,
          effLimit,
          outcome.info.mtimeMs,
        )
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: renderReadOk(outcome.text, input.offset, effLimit),
        },
      }
    },
  })

/** Default-port `read` tool used by the registry. */
export const readTool: Tool<Input> = makeReadTool()
