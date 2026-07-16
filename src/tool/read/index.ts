import { createHash } from "node:crypto"
import { homedir } from "node:os"
// Node's `util.TextDecoder` is typed to accept any string label; the Bun global
// `TextDecoder`'s `Bun.Encoding` type omits `utf-16le`/`utf-16be` (a bun-types
// gap — the runtime, backed by this same Node decoder, accepts them).
import { TextDecoder } from "node:util"
import { z } from "zod"
import { classifyPath } from "@/security"
import { escapeBoundary, runtimeConfig } from "@/shared"
import { defaultFileSystemPort, type FileSystemPort, FsJailError } from "@/storage"
import { defineTool } from "../factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { resolveEditBase } from "../worktree/cwd-override"
import { isNotebook, renderNotebook } from "./ipynb"
import { DEFAULT_OUTLINE_BUDGET, renderOutline } from "./outline"
import type { ReadOutlineParseFailure, ReadOutlineParserPort } from "./parser-port"

export type {
  ReadOutlineDecl,
  ReadOutlineParsedFile,
  ReadOutlineParserPort,
} from "./parser-port"

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

/** Per-line character cap (D8). A single minified-bundle line can be megabytes;
 *  unpageable (offset/limit are line-based, so it is all "line 1") and it
 *  floods the context window. We cap each RENDERED line and mark the elision
 *  in-band. 2000 matches Claude Code's `Read` per-line truncation budget — a
 *  line longer than this is almost always machine-generated, and 2000 chars is
 *  ample to recognise the line + pivot to `grep`/`offset`. */
const MAX_LINE_CHARS = 2000

/** Soft oversized-file budget (D8). When a file's estimated token footprint
 *  (chars/4 — same coarse proxy the rest of the agent uses for display) exceeds
 *  this, we PREPEND a non-blocking advisory nudging the model toward
 *  offset/limit or grep. We still return the content — this is advice, not a
 *  refusal (workflow must not break). 25000 tokens (~100k chars) is the point
 *  past which a whole-file dump meaningfully crowds the working context. */
const OVERSIZED_NUDGE_TOKENS = 25_000

/** Truncate `line` to at most `MAX_LINE_CHARS` code units WITHOUT splitting a
 *  UTF-16 surrogate pair, appending an in-band elision marker that reports how
 *  many code units were dropped. If the cap would land between a high and low
 *  surrogate we back off one unit so the pair stays intact (surrogate-safe per
 *  the repo's truncation guard). Short lines pass through verbatim. */
const truncateLine = (line: string): string => {
  if (line.length <= MAX_LINE_CHARS) return line
  let cut = MAX_LINE_CHARS
  // A high surrogate (U+D800..U+DBFF) at the last kept position has its low
  // partner just past the cut — back off one unit to keep the pair whole.
  const lastKept = line.charCodeAt(cut - 1)
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1
  const elided = line.length - cut
  return `${line.slice(0, cut)} … (+${elided} chars elided)`
}

/** Render the line-numbered slice for an `ok:true` read. Extracted so
 *  `execute` stays under the lint complexity gate (the typed-failure catches
 *  raised the in-line branch count beyond 15). Pure: no I/O, no schema. */
const renderReadOk = (text: string, offset: number | undefined, limit: number): string => {
  // Split on `\r?\n` so a CRLF (Windows-authored) file does NOT leave a trailing
  // `\r` on every rendered line — a bare CR is terminal noise that pollutes the
  // model context (and the line count is identical to a `\n`-only split, so
  // offset/limit paging is unchanged). The body is re-joined with `\n`.
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = Math.min(lines.length, start + limit)
  const numbered = lines
    .slice(start, end)
    // D8: cap each rendered line so one giant (minified) line can't flood the
    // context. Truncation is surrogate-safe and marks the elision in-band.
    // M2 (RFC jun-7 Phase-2-FINAL W1, USER-LOCKED): a file whose CONTENT carries
    // a literal `<system-reminder>` / `</system-reminder>` token would, unescaped,
    // read into the model context indistinguishably from a GENUINE harness
    // reminder boundary — letting attacker-authored file content forge a reminder
    // close + trailing "system" instruction (prompt-injection). We defang ONLY
    // that boundary token (a single backslash wedged after the `<`, via the
    // canonical `@/shared` escaper — the SAME transform the agent-side
    // `escapeReminderBoundary` uses) so it can no longer terminate the harness's
    // real `<system-reminder>` wrapper downstream. Applied per-line AFTER the
    // surrogate-safe truncation so it sees the final rendered content; the
    // benign invariant holds (a line with no genuine boundary token is
    // byte-identical). NOT the broad default-OFF untrusted-envelope — this is the
    // narrow, always-on read-output defang the user locked in.
    .map((line, i) => `${start + i + 1}\t${escapeBoundary("system-reminder", truncateLine(line))}`)
    .join("\n")
  const note = end < lines.length ? `\n… (${lines.length - end} more lines, use offset)` : ""
  const body = numbered === "" ? "(empty file)" : numbered + note
  // D8 soft nudge: a large file gets a one-line advisory PREPENDED (non-blocking
  // — content still follows). Estimated via chars/4, the agent's coarse proxy.
  // Suppressed when the caller is ALREADY paging (`offset` set) — advising
  // "prefer offset/limit" to someone using offset is a false positive.
  if (offset === undefined && text.length / 4 > OVERSIZED_NUDGE_TOKENS) {
    return `… (large file — prefer offset/limit or grep to avoid flooding context)\n${body}`
  }
  return body
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
 *  THRESHOLD — the binary signal is the PRESENCE of any NUL in this window
 *  AFTER the BOM check (see {@link classifyEncoding}): a UTF-16 BOM marks a NUL-
 *  rich-but-textual file, so the BOM is consulted FIRST. */
const BINARY_SNIFF_BYTES = 8192

/** P15 (jun-7) — BOM-driven text encoding. A leading byte-order mark is a
 *  DETERMINISTIC encoding signal (not a heuristic): every Windows / .NET /
 *  PowerShell `>`-redirect text file emits one. We recognise the three decodable
 *  BOMs; anything else (incl. BOM-less UTF-16, which would need a heuristic
 *  alternating-NUL probe — deliberately NOT done, to avoid false-classifying a
 *  genuine binary as text) falls through to the plain-UTF-8 / NUL-binary path. */
type BomEncoding = "utf8-bom" | "utf16le" | "utf16be"

/** Detect a decodable BOM at the start of the sniff window. Returns `null` for
 *  no recognised BOM. The `FF FE 00 00` case is the UTF-32LE BOM (Unicode
 *  disambiguation rule) — we cannot decode UTF-32, so we return `null` and let
 *  it reach the binary guard rather than mis-decode it as UTF-16LE. Pure. */
const detectBomEncoding = (head: Uint8Array): BomEncoding | null => {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return "utf8-bom"
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    // FF FE 00 00 ⇒ UTF-32LE, not UTF-16LE — fall through (undecodable here).
    if (head.length >= 4 && head[2] === 0x00 && head[3] === 0x00) return null
    return "utf16le"
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return "utf16be"
  return null
}

/** Classification of the sniffed leading window: a recognised text BOM ⇒ text
 *  (with its encoding), a NUL with no text BOM ⇒ binary, otherwise plain UTF-8.
 *  `head === null` (port has no `readFileBytes` — legacy in-memory fakes) ⇒
 *  plain UTF-8 with the binary sniff unavailable, exactly the pre-guard
 *  behavior. `encoding: null` means decode with the default UTF-8 path. */
type EncodingClass = { kind: "binary" } | { kind: "text"; encoding: BomEncoding | null }

const classifyEncoding = (head: Uint8Array | null): EncodingClass => {
  if (head === null) return { kind: "text", encoding: null }
  const bom = detectBomEncoding(head)
  if (bom !== null) return { kind: "text", encoding: bom }
  // No text BOM: a NUL is the standard binary discriminator. (A NUL DOES appear
  // in UTF-16 text — which is exactly why the BOM is checked first above.)
  if (head.includes(0x00)) return { kind: "binary" }
  return { kind: "text", encoding: null }
}

/** Sniff the bounded leading window for the binary + BOM classification. Returns
 *  `null` when the port cannot read raw bytes (legacy fakes) — the caller then
 *  treats the file as plain UTF-8 (binary/BOM detection unavailable). May throw
 *  (TOCTOU unlink / jail escape); the caller wraps it in {@link runFsStep}. */
const sniffHead = async (
  fs: FileSystemPort,
  path: string,
  cwd: string,
): Promise<Uint8Array | null> => {
  if (fs.readFileBytes === undefined) return null
  return fs.readFileBytes(path, BINARY_SNIFF_BYTES, cwd)
}

/** Typed `binary_file` rejection (shared by the guard). */
const binaryRejected = (path: string): ToolResult => ({
  ok: false,
  output:
    `Cannot read ${path}: this tool cannot read binary files. ` +
    "Use a dedicated tool (e.g. read_image) for non-text content.",
  failure: { mode: "rejected", reason: "binary_file" },
})

/** jun-26 SE-audit: `read` materializes the WHOLE file into a JS string + a
 *  full line-array before paging — `offset`/`limit` do NOT bound the read. The
 *  agent autonomously picks paths, so a blind `read` of a large checked-in JSON
 *  dump / lockfile / minified bundle / log can exhaust the heap and crash the
 *  agent process. A file this large also cannot usefully fit the model's context,
 *  so we reject BEFORE the read with actionable advice instead of OOM-ing. */
const MAX_READ_BYTES = 10 * 1024 * 1024
const tooLargeRejected = (path: string, size: number): ToolResult => ({
  ok: false,
  output:
    `Cannot read ${path}: file is ${Math.round(size / (1024 * 1024))}MB, over the ` +
    `${MAX_READ_BYTES / (1024 * 1024)}MB read cap. Use grep/search to find the relevant ` +
    "lines, or read a specific region (this tool loads the whole file, so it cannot " +
    "stream a window of a file this large).",
  failure: { mode: "rejected", reason: "file_too_large" },
})

/** U+FEFF — the BOM code point as it appears in a DECODED string (explicit
 *  escape, not an invisible literal, so it survives copy/paste + future lints).
 *  Bun's `file.text()` usually consumes a UTF-8 BOM already, making the strip a
 *  no-op; we strip defensively for ports/runtimes that surface it. */
const UTF8_BOM = "\uFEFF"

/** Read the file content with the detected encoding. For UTF-16 (LE/BE) we read
 *  the full byte length the stat reported and decode with the matching
 *  `TextDecoder` — which strips the leading BOM (`ignoreBOM` defaults false) and
 *  is surrogate-correct. For UTF-8(-BOM) we keep the default `readFile`
 *  (UTF-8) path, stripping a leading BOM char if one survived the decode. The
 *  UTF-16 branch only runs when a BOM was detected from a non-null head, so
 *  `readFileBytes` is guaranteed present there. May throw; wrapped by the caller
 *  in {@link runFsStep}. */
const readTextByEncoding = async (
  fs: FileSystemPort,
  path: string,
  cwd: string,
  size: number,
  encoding: BomEncoding | null,
): Promise<string> => {
  if (encoding === "utf16le" || encoding === "utf16be") {
    // `size` from stat bounds the read; a non-`readFileBytes` port never reaches
    // here (encoding would be null), so the assertion is sound.
    const bytes = await (fs.readFileBytes as NonNullable<FileSystemPort["readFileBytes"]>)(
      path,
      size,
      cwd,
    )
    const label = encoding === "utf16le" ? "utf-16le" : "utf-16be"
    return new TextDecoder(label).decode(bytes)
  }
  const text = await fs.readFile(path, cwd)
  return encoding === "utf8-bom" && text.startsWith(UTF8_BOM) ? text.slice(1) : text
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
  // ticket-11 (P8 worktree edit-fence) — resolve the effective FS target so READ
  // is fenced to the worktree exactly like `edit`/`bash`. When a session worktree
  // is active, a RELATIVE path resolves against the worktree dir; an ABSOLUTE
  // path STILL jails to the SESSION root (the worktree is a relative-cwd
  // override, NOT a trust-boundary redefinition). Absent worktree ⇒
  // `{ path: input.path, base: ctx.cwd }` (byte-identical legacy). Recording the
  // resolved `info.path` into `readFileState` (in `execute`) under the WORKTREE
  // path is what keeps the stale-read guard sound: a later `edit` stats the SAME
  // worktree path, so read/edit agree on file identity (pre-fix read recorded the
  // SESSION path while edit stat'd the worktree path → guardWrite saw "unread").
  const target = resolveEditBase(input.path, ctx.cwd, ctx.activeWorktree)
  // ENOENT classification: a missing file / jail escape becomes a TYPED failure
  // (closes the absorb-#2 gap for read). `statFile` runs first. The error-display
  // path stays `input.path` (what the model typed); the FS op uses the resolved
  // target.path + target.base (worktree-aware path, session jail base).
  const stat = await runFsStep(() => fs.statFile(target.path, target.base), input.path)
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

  // B5 device guard — a FIFO / device file would BLOCK the loop forever or dump
  // unbounded bytes. PURE (on the already-fetched stat); runs BEFORE any byte
  // read so we NEVER attempt the hanging read() on a FIFO to sniff it.
  const device = classifyDeviceFile(info, input.path)
  if (device !== null) return { kind: "failure", result: device }

  // jun-26 SE-audit — reject an oversized file BEFORE the whole-file read so a
  // blind `read` of a huge data dump / lockfile cannot OOM the agent process.
  if (info.size > MAX_READ_BYTES) {
    return { kind: "failure", result: tooLargeRejected(input.path, info.size) }
  }

  // P15 + B5 — sniff the bounded leading window ONCE for BOTH the BOM (encoding)
  // and the binary NUL discriminator. ORDER: a UTF-16 BOM marks a NUL-rich-but-
  // textual file, so the BOM is consulted before the NUL check (pre-fix, UTF-16
  // text was wrongly rejected as binary). The byte read may throw on a TOCTOU
  // unlink / jail escape — classified the same way as `readFile`.
  const headStep = await runFsStep(() => sniffHead(fs, target.path, target.base), input.path)
  if (headStep.kind === "failure") return headStep
  const cls = classifyEncoding(headStep.value)
  if (cls.kind === "binary") {
    return { kind: "failure", result: binaryRejected(input.path) }
  }

  // Content read by detected encoding (UTF-16 → decode with the matching
  // TextDecoder; UTF-8(-BOM) → the default text read). Belt-and-braces: an
  // in-flight unlink between `statFile()` and the read surfaces ENOENT here too;
  // FsJail is re-checked inside the port and stays a permission_denied. Same
  // classifier so the typed mapping holds on TOCTOU.
  const read = await runFsStep(
    () => readTextByEncoding(fs, target.path, target.base, info.size, cls.encoding),
    input.path,
  )
  if (read.kind === "failure") return read
  return { kind: "ok", text: maybeRenderNotebook(input.path, read.value), info }
}

/** jun-6 (ADR-0481) — cell-aware `.ipynb` render, applied AFTER the text read.
 *  EXTENSION-GATED: `isNotebook` is false for every non-`.ipynb` path, so this
 *  returns the raw `text` UNCHANGED — every other read is byte-identical. For a
 *  `.ipynb`, `renderNotebook` returns the cell-numbered, base64-stripped view,
 *  or `null` on a corrupt/non-nbformat notebook ⇒ we fall back to the raw text
 *  (still readable as JSON). NEVER throws. `offset`/`limit` then page the
 *  RENDERED text in `renderReadOk` exactly as for a raw file, and the H9
 *  dedup record (hashed over this RENDERED text, so an outputs-knob flip that
 *  changes the render also changes the hash) is unaffected. */
/** Per-cell-output char budget for the `.ipynb` render (NOT a whole-file cap).
 *  Basis: a notebook can carry MANY cells × outputs, so each individual stream /
 *  text-plain / traceback output is sub-budgeted to keep one pathological cell
 *  from dominating, AFTER which the WHOLE rendered document is still subject to
 *  the outer `capToolOutput` ceiling (`DEFAULT_TOOL_OUTPUT_MAX = 200_000`,
 *  `tool/output-spill.ts`). 2_000 ≈ 1% of that whole-tool ceiling — generous for
 *  a single output (a typical printed DataFrame / traceback is far smaller) yet
 *  bounded so 100 cells cannot each emit a megabyte. Truncation is signalled
 *  in-band by `renderNotebook` (the `… (+N chars elided)` marker), never silent.
 *  Named (not a bare literal) so the basis is auditable; a future knob would add
 *  it here, but it is intentionally NOT a knob today — it is a defensive bound
 *  the model never needs to tune, and the outer cap is the operator-tunable one
 *  (`QUANTA_TOOL_OUTPUT_MAX`). */
const IPYNB_PER_OUTPUT_MAX_CHARS = 2_000

const maybeRenderNotebook = (path: string, text: string): string => {
  if (!isNotebook(path)) return text
  const rendered = renderNotebook(text, {
    includeOutputs: runtimeConfig().ipynbIncludeOutputs,
    maxOutputChars: IPYNB_PER_OUTPUT_MAX_CHARS,
  })
  return rendered ?? text
}

/** H9 — the compact `file_unchanged` sentinel rendered in place of full content
 *  when an identical-range re-read finds byte-identical content. It is UNAMBIGUOUS
 *  (names the path + the exact range + the reason) and ACTIONABLE: the model is
 *  told the content is byte-identical to its prior read and should re-use that,
 *  so it never needs the bytes re-sent. Deterministic (pure function of its
 *  inputs — no clock, no randomness). */
const renderFileUnchanged = (path: string, offset: number, limit: number): string =>
  `file_unchanged: ${path} (offset ${offset}, limit ${limit}) — ` +
  "content identical to your prior read of this exact range; re-using it."

/** H9 content-truth (UUX-6-07) — SHA-1 hex digest of the just-read text. The
 *  dedup verdict is keyed on the CONTENT, not the mtime: pre-fix, an
 *  mtime-preserving content rewrite (same-second write + `utimes` reset, build
 *  tools that restore timestamps, symlink retargets to an equal-mtime file)
 *  served the model a STALE `file_unchanged` verdict. The read pipeline reads
 *  the WHOLE file before this point regardless (the dedup saves TOKENS sent to
 *  the model, not disk IO), so hashing the bytes we already hold is the entire
 *  extra cost — measured (bun, arm64): ~0.03 ms @ 1 KB, ~0.1 ms @ 100 KB,
 *  ~30 ms at the 10 MB `MAX_READ_BYTES` ceiling (comparable to the read+decode
 *  such a file already paid, and only when the knob is ON) (SHA-1 via
 *  node:crypto, the repo's
 *  established non-security digest dependency; collision resistance beyond
 *  accidental is not required — this is a cache key, same trust class as git's
 *  own SHA-1 object ids). DESIGN CHOICE (documented): always read + hash +
 *  compare — no (path,size,mtime) fast-path to skip hashing; profiling shows
 *  the hash is noise next to the read itself, and the triple-fast-path can be
 *  layered on later without changing this contract. Hashing the FULL text
 *  (not the rendered window) preserves the old mtime-era granularity exactly:
 *  the mtime was a whole-file signal too, so hit/miss behavior only differs
 *  where the mtime LIED. */
const hashReadContent = (text: string): string =>
  createHash("sha1").update(text, "utf8").digest("hex")

/** H9 — the full read-side dedup step: hash the JUST-READ text, short-circuit
 *  with the `file_unchanged` ToolResult when (and ONLY when) the H9 knob is ON,
 *  the dedup state is wired, and the EXACT (path, offset, limit) range was
 *  already read this run with the SAME content hash; otherwise (re)record the
 *  hash and return `null` (⇒ caller renders full content). Any miss — knob off
 *  (zero hashing, byte-identical), no state, never read, different range, or
 *  changed content EVEN when the mtime was preserved (content-truth, UUX-6-07)
 *  — yields `null`, never a stale short-circuit; a hash MATCH is truthful by
 *  construction (the model already holds these exact bytes). NO-THROW. Keeps
 *  `execute` under the lint complexity gate. */
const tryReadDedup = (
  ctx: ToolContext,
  path: string,
  offset: number,
  limit: number,
  text: string,
): ToolResult | null => {
  if (!runtimeConfig().readDedup) return null
  const state = ctx.readFileState
  if (state === undefined) return null
  const contentHash = hashReadContent(text)
  const recorded = state.recordedRangeHash(path, offset, limit)
  // Strict hash equality is the closed dedup signal.
  if (recorded === contentHash) {
    return { ok: true, output: renderFileUnchanged(path, offset, limit) }
  }
  // Full content path — (re)record this range's content hash so the NEXT
  // identical re-read of identical bytes short-circuits.
  state.recordReadRange(path, offset, limit, contentHash)
  return null
}

/** RFC jun-6 — try the outline render. Returns a `ToolResult` ONLY when the
 *  caller requested `outline:true`, the `QUANTA_READ_OUTLINE` knob is on, a
 *  parser is wired, AND the parse succeeds for a supported language. On ANY
 *  miss (knob off, no parser, unsupported language, parse error) returns a
 *  typed fallback reason so the caller can prepend a specific `(no outline:
 *  …)` note to the normal line-range read. NO-THROW. */
type OutlineAttempt =
  | { readonly kind: "rendered"; readonly result: ToolResult }
  | { readonly kind: "fallback"; readonly reason: string }

const fallbackReason = (reason: ReadOutlineParseFailure): string => {
  switch (reason) {
    case "unsupported-language":
      return "unsupported language"
    case "missing-grammar":
      return "missing parser grammar"
    case "no-grammar":
      return "unsupported language or missing parser grammar"
    case "parse-error":
      return "source parse failed"
  }
}

const tryRenderOutline = async (
  parser: ReadOutlineParserPort | undefined,
  path: string,
  text: string,
  budget: number | undefined,
): Promise<OutlineAttempt> => {
  if (!runtimeConfig().readOutline) return { kind: "fallback", reason: "outline disabled" }
  if (parser === undefined) return { kind: "fallback", reason: "parser unavailable" }
  let outcome: Awaited<ReturnType<ReadOutlineParserPort["parse"]>>
  try {
    outcome = await parser.parse(path, text)
  } catch {
    return { kind: "fallback", reason: "source parse failed" }
  }
  if (!outcome.ok) return { kind: "fallback", reason: fallbackReason(outcome.reason) }
  const body = renderOutline(text, outcome.parsed, budget ?? DEFAULT_OUTLINE_BUDGET)
  return { kind: "rendered", result: { ok: true, output: body } }
}

const renderOutlineFallbackNote = (reason: string): string =>
  `(no outline: ${reason}; showing line-range read)\n`

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  // `offset` is a 1-based line index: it must be a non-negative integer.
  // `limit` is a line COUNT: it must be a positive integer. A `limit:0` or a
  // negative value previously produced an empty slice that surfaced the
  // "(empty file)" sentinel on a NON-empty file (misleading). Reject such
  // values at the schema boundary with a clear validation error instead.
  offset: z.number().int().min(0).optional().describe("1-based line to start from"),
  limit: z.number().int().positive().optional().describe("Max lines to read (default 2000)"),
  // RFC jun-6 — collapsed signatures+structure view. Inert (line-range read)
  // unless the QUANTA_READ_OUTLINE knob is on AND a parser is wired AND the
  // language is supported; otherwise gracefully degrades to a normal read.
  outline: z
    .boolean()
    .optional()
    .describe("Return a collapsed signatures+structure view instead of raw lines"),
  outlineBudget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max chars for the outline (default ~4000)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_LIMIT = 2000

/** Build the `read` tool against an injected {@link FileSystemPort} (#13).
 *  `fs` defaults to the real `@/storage`-backed port, so the exported
 *  {@link readTool} is byte-identical to the pre-port direct-call version;
 *  tests pass an in-memory port for isolation. */
export const makeReadTool = (
  fs: FileSystemPort = defaultFileSystemPort,
  parser?: ReadOutlineParserPort,
): Tool<Input> =>
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

      // RFC jun-6 — outline mode. When `outline:true` is requested AND served
      // (knob on + parser wired + supported language + clean parse), return the
      // collapsed signatures view INSTEAD of the line-range. It bypasses H9
      // dedup (a different view of the same range) and prepends a `(no outline:
      // …)` note when the request could not be served (degrades to the normal
      // read below). NO-THROW. Inert (this whole block skipped) when `outline`
      // is unset ⇒ every non-outline read is byte-identical.
      let outlineFallbackReason: string | undefined
      if (input.outline === true) {
        const attempt = await tryRenderOutline(
          parser,
          outcome.info.path,
          outcome.text,
          input.outlineBudget,
        )
        if (attempt.kind === "rendered") {
          yield { type: "result", result: attempt.result }
          return
        }
        outlineFallbackReason = attempt.reason
      }

      // H9 read-side dedup — the EFFECTIVE range is the resolved (offset, limit)
      // pair `renderReadOk` actually slices on, so an implicit `limit` dedups
      // against an explicit one that resolves to the same window. Keyed by the
      // RESOLVED absolute path (`outcome.info.path`) — the SAME identity the
      // mtime record uses — so the dedup map and the freshness map agree on
      // which file a re-read refers to. Content-truth (UUX-6-07): the verdict
      // compares a hash of the JUST-READ text (the file is always read; the
      // dedup saves tokens, not IO), computed ONCE here and only when the knob
      // is on AND the state is wired — the gate-off path does zero hashing and
      // stays byte-identical.
      const effOffset = input.offset ?? 1
      const effLimit = input.limit ?? DEFAULT_LIMIT
      const deduped = tryReadDedup(ctx, outcome.info.path, effOffset, effLimit, outcome.text)
      if (deduped !== null) {
        yield { type: "result", result: deduped }
        return
      }
      // When `outline:true` was requested but could not be served, prepend the
      // explicit degrade note so the model knows why it got line-ranges.
      const outlineNote =
        outlineFallbackReason !== undefined ? renderOutlineFallbackNote(outlineFallbackReason) : ""
      yield {
        type: "result",
        result: {
          ok: true,
          output: outlineNote + renderReadOk(outcome.text, input.offset, effLimit),
        },
      }
    },
  })

/** Default-port `read` tool used by the registry. */
export const readTool: Tool<Input> = makeReadTool()
